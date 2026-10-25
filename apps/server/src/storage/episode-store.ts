import { randomUUID } from 'node:crypto';
import { createReadStream, type Dirent } from 'node:fs';
import { appendFile, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import {
  type EpisodeBatch,
  type EpisodeCreate,
  type EpisodeDetailResponse,
  type EpisodeEvent,
  EpisodeEventSchema,
  type EpisodeFinish,
  EpisodeFinishSchema,
  type EpisodeMeta,
  EpisodeMetaSchema,
  type EpisodeSummary,
  type FrameRecord,
} from '@clio/protocol';
import { z } from 'zod';
import { isSafeId, isSafeMediaName, newEpisodeId } from '../ids';
import { describeError, type Logger } from '../log';
import {
  countLines,
  exists,
  isMissing,
  lastLineEnd,
  readJson,
  toNdjson,
  writeJsonAtomic,
} from './files';
import { KeyedMutex } from './keyed-mutex';

// <root>/<episodeId>/ meta.json, frames.ndjson, events.ndjson, objects.ndjson, observations.ndjson,
// batches.json, finish.json, media/<name>. See docs/data-format.md. Every write to one episode runs
// under that episode's mutex, so concurrent batches append whole and the seq bookkeeping never loses
// an update. Episodes recorded before observations.ndjson existed have no such file; it reads as
// empty.

export const NDJSON_FILES = ['frames', 'events', 'objects', 'observations'] as const;
export type NdjsonFile = (typeof NDJSON_FILES)[number];

export type BatchResult = 'appended' | 'duplicate' | 'not_found' | 'finished';
export type MediaResult =
  | { status: 'written'; bytes: number }
  | { status: 'not_found' }
  | { status: 'too_large' };

const BookkeepingSchema = z.object({
  received: z.array(z.number().int()),
  gaps: z.array(z.number().int()),
});
export type Bookkeeping = z.infer<typeof BookkeepingSchema>;

/** A seq jump beyond this is a client bug; the batch is kept but the gaps are not listed. */
const MAX_RECORDED_GAP = 10_000;

/** Pure: bookkeeping after receiving `seq` (lists skipped seqs as gaps, fills late arrivals). */
export function recordSeq(book: Bookkeeping, seq: number): Bookkeeping {
  const max = book.received.at(-1) ?? -1;
  const gaps = book.gaps.filter((g) => g !== seq);
  if (seq - max - 1 <= MAX_RECORDED_GAP) for (let s = max + 1; s < seq; s++) gaps.push(s);
  return {
    received: [...book.received, seq].sort((a, b) => a - b),
    gaps: gaps.sort((a, b) => a - b),
  };
}

export interface EpisodeStoreOptions {
  now?: () => Date;
  rand?: () => number;
  logger?: Logger;
}

interface LineCount {
  ino: number;
  size: number;
  mtimeMs: number;
  lines: number;
}

export class EpisodeStore {
  readonly #root: string;
  readonly #now: () => Date;
  readonly #rand: (() => number) | undefined;
  readonly #logger: Logger | undefined;
  readonly #mutex = new KeyedMutex();
  readonly #lineCounts = new Map<string, LineCount>();

  constructor(root: string, options: EpisodeStoreOptions = {}) {
    this.#root = root;
    this.#now = options.now ?? (() => new Date());
    this.#rand = options.rand;
    this.#logger = options.logger;
  }

  #path(id: string, ...rest: string[]): string {
    return join(this.#root, id, ...rest);
  }

  async exists(id: string): Promise<boolean> {
    return isSafeId(id) && exists(this.#path(id, 'meta.json'));
  }

  async create(input: EpisodeCreate): Promise<EpisodeMeta> {
    await mkdir(this.#root, { recursive: true });
    for (let attempt = 0; attempt < 10; attempt++) {
      const now = this.#now();
      const episodeId = newEpisodeId(now, this.#rand);
      try {
        await mkdir(this.#path(episodeId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      const meta = EpisodeMetaSchema.parse({ ...input, episodeId, createdAt: now.toISOString() });
      for (const file of NDJSON_FILES) await writeFile(this.#path(episodeId, `${file}.ndjson`), '');
      await writeJsonAtomic(
        this.#path(episodeId, 'batches.json'),
        { received: [], gaps: [] },
        false,
      );
      // meta.json last: its presence means the episode is complete on disk.
      await writeJsonAtomic(this.#path(episodeId, 'meta.json'), meta);
      return meta;
    }
    throw new Error('Could not allocate a unique episode id');
  }

  appendBatch(id: string, batch: EpisodeBatch): Promise<BatchResult> {
    return this.#mutex.run(id, async () => {
      if (!(await this.exists(id))) return 'not_found';
      const book = (await this.#readBookkeeping(id)) ?? { received: [], gaps: [] };
      // A retried batch is acknowledged even after finish: the client only wants its ack.
      if (book.received.includes(batch.seq)) return 'duplicate';
      if (await exists(this.#path(id, 'finish.json'))) return 'finished';
      if (batch.frames.length)
        await appendFile(this.#path(id, 'frames.ndjson'), toNdjson(batch.frames));
      if (batch.events.length)
        await appendFile(this.#path(id, 'events.ndjson'), toNdjson(batch.events));
      if (batch.objects.length) {
        await appendFile(this.#path(id, 'objects.ndjson'), toNdjson(batch.objects));
      }
      if (batch.observations.length) {
        await appendFile(this.#path(id, 'observations.ndjson'), toNdjson(batch.observations));
      }
      const max = book.received.at(-1) ?? -1;
      if (batch.seq - max - 1 > MAX_RECORDED_GAP) {
        this.#logger?.warn(
          `Episode ${id}: seq jumped from ${max} to ${batch.seq}; gaps not listed`,
        );
      }
      await writeJsonAtomic(this.#path(id, 'batches.json'), recordSeq(book, batch.seq), false);
      return 'appended';
    });
  }

  finish(id: string, finish: EpisodeFinish): Promise<'ok' | 'not_found'> {
    return this.#mutex.run(id, async () => {
      if (!(await this.exists(id))) return 'not_found';
      await writeJsonAtomic(this.#path(id, 'finish.json'), finish);
      return 'ok';
    });
  }

  /**
   * Byte sizes of the named files of an episode (`frames.ndjson`, or `media/<name>`), leaving out
   * those that do not exist. Taken under the episode lock, so a size never counts half of an append.
   */
  fileSizes(id: string, names: readonly string[]): Promise<Map<string, number>> {
    if (!isSafeId(id) || !names.every(isEpisodeFile)) {
      throw new Error(`Unsafe episode path: ${id}/{${names.join(',')}}`);
    }
    return this.#mutex.run(id, async () => {
      const sizes = new Map<string, number>();
      for (const name of names) {
        try {
          sizes.set(name, (await stat(this.#path(id, name))).size);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      return sizes;
    });
  }

  /** The names of an episode's media files, sorted; none when it has no media/. */
  async listMedia(id: string): Promise<string[]> {
    if (!isSafeId(id)) return [];
    let entries: Dirent[];
    try {
      entries = await readdir(this.#path(id, 'media'), { withFileTypes: true });
    } catch (error) {
      if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
      throw error;
    }
    // An upload in progress is a hidden temp file, which isSafeMediaName refuses.
    return entries
      .filter((e) => e.isFile() && isSafeMediaName(e.name))
      .map((e) => e.name)
      .sort();
  }

  /** Streams `body` to media/<name> through a temp file, so a failed upload leaves nothing. */
  async writeMedia(
    id: string,
    name: string,
    body: AsyncIterable<Uint8Array> | null,
    maxBytes: number,
  ): Promise<MediaResult> {
    if (!(await this.exists(id))) return { status: 'not_found' };
    const dir = this.#path(id, 'media');
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${randomUUID()}.part`);
    try {
      const handle = await open(tmp, 'wx');
      let bytes = 0;
      try {
        for await (const chunk of body ?? []) {
          bytes += chunk.byteLength;
          if (bytes > maxBytes) break;
          await handle.write(chunk);
        }
      } finally {
        await handle.close();
      }
      if (bytes > maxBytes) {
        await rm(tmp, { force: true });
        return { status: 'too_large' };
      }
      await rename(tmp, join(dir, name));
      return { status: 'written', bytes };
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  async readMeta(id: string): Promise<EpisodeMeta | null> {
    if (!isSafeId(id)) return null;
    let raw: unknown;
    try {
      raw = await readJson(this.#path(id, 'meta.json'));
    } catch (error) {
      this.#logger?.warn(`Episode ${id}: unreadable meta.json (${describeError(error)})`);
      return null;
    }
    if (raw === undefined) return null;
    const parsed = EpisodeMetaSchema.safeParse(raw);
    if (!parsed.success) {
      this.#logger?.warn(`Episode ${id}: meta.json does not match the schema; skipped`);
      return null;
    }
    return parsed.data;
  }

  async list(): Promise<EpisodeSummary[]> {
    let names: string[];
    try {
      const entries = await readdir(this.#root, { withFileTypes: true });
      names = entries.filter((e) => e.isDirectory() && isSafeId(e.name)).map((e) => e.name);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const summaries: EpisodeSummary[] = [];
    for (const name of names) {
      const meta = await this.readMeta(name);
      if (meta) summaries.push(await this.#summary(meta));
    }
    // Newest first; ids sort by creation second, createdAt adds the milliseconds.
    return summaries.sort((a, b) =>
      a.createdAt === b.createdAt
        ? compare(b.episodeId, a.episodeId)
        : compare(b.createdAt, a.createdAt),
    );
  }

  async get(id: string): Promise<EpisodeDetailResponse | null> {
    const meta = await this.readMeta(id);
    if (!meta) return null;
    const finish = await this.#readFinish(id);
    const detail: EpisodeDetailResponse = {
      meta,
      summary: await this.#summary(meta, finish),
      finish: finish.value,
    };
    // Left out when batches.json is missing: an unknown count is not "nothing arrived".
    const book = await this.#readBookkeeping(id);
    if (book) {
      detail.batches = {
        received: book.received.length,
        gaps: book.gaps,
        lastSeq: book.received.at(-1) ?? null,
      };
    }
    return detail;
  }

  /**
   * The complete lines of an NDJSON file from byte `from` on, as a byte stream, or null for an
   * unknown episode. `end` is the settled size cut back to its last newline, so it is always a line
   * boundary: passing it back as `from` reads only what was appended since, which is how a viewer
   * follows a live episode. A partial last line (a crash mid-append) is served only once it is
   * whole. If the file shrank below `from`, `end` comes back smaller than `from`. A file the
   * episode does not have (observations.ndjson in an older episode) reads as empty, with `end` 0.
   */
  async openNdjson(
    id: string,
    file: NdjsonFile,
    from = 0,
  ): Promise<{ stream: ReadableStream<Uint8Array>; end: number } | null> {
    if (!(await this.exists(id))) return null;
    const path = this.#path(id, `${file}.ndjson`);
    const size = await this.#settledSize(id, path);
    const end = await lastLineEnd(path, from < size ? from : 0, size);
    const stream =
      from >= end ? Readable.from([]) : createReadStream(path, { start: from, end: end - 1 });
    return { stream: Readable.toWeb(stream) as ReadableStream<Uint8Array>, end };
  }

  async readFrames(id: string): Promise<FrameRecord[]> {
    const records = await this.#readNdjson(id, 'frames');
    // Validated at ingest; a full re-parse of every hand sample would be slow, so only guard t.
    return records.filter(
      (r): r is FrameRecord => typeof (r as FrameRecord | null)?.t === 'number',
    );
  }

  async readEvents(id: string): Promise<EpisodeEvent[]> {
    const events: EpisodeEvent[] = [];
    for (const record of await this.#readNdjson(id, 'events')) {
      const parsed = EpisodeEventSchema.safeParse(record);
      if (parsed.success) events.push(parsed.data);
    }
    return events;
  }

  async #readNdjson(id: string, file: NdjsonFile): Promise<unknown[]> {
    const path = this.#path(id, `${file}.ndjson`);
    const size = await this.#settledSize(id, path);
    if (size === 0) return [];
    const records: unknown[] = [];
    let corrupt = 0;
    const lines = createInterface({
      input: createReadStream(path, { start: 0, end: size - 1 }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      if (line === '') continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        corrupt++;
      }
    }
    if (corrupt) this.#logger?.warn(`Episode ${id}: skipped ${corrupt} corrupt ${file} lines`);
    return records;
  }

  /** File size taken under the episode lock, so readers never see half of an append. */
  #settledSize(id: string, path: string): Promise<number> {
    return this.#mutex.run(id, async () => {
      try {
        return (await stat(path)).size;
      } catch (error) {
        if (isMissing(error)) return 0;
        throw error;
      }
    });
  }

  /** null when batches.json is missing, unreadable or not bookkeeping. */
  async #readBookkeeping(id: string): Promise<Bookkeeping | null> {
    try {
      const parsed = BookkeepingSchema.safeParse(await readJson(this.#path(id, 'batches.json')));
      if (parsed.success) return parsed.data;
    } catch (error) {
      this.#logger?.warn(`Episode ${id}: unreadable batches.json (${describeError(error)})`);
    }
    return null;
  }

  async #readFinish(id: string): Promise<{ exists: boolean; value: EpisodeFinish | null }> {
    let raw: unknown;
    try {
      raw = await readJson(this.#path(id, 'finish.json'));
    } catch {
      return { exists: true, value: null };
    }
    if (raw === undefined) return { exists: false, value: null };
    const parsed = EpisodeFinishSchema.safeParse(raw);
    return { exists: true, value: parsed.success ? parsed.data : null };
  }

  async #summary(
    meta: EpisodeMeta,
    finish?: { exists: boolean; value: EpisodeFinish | null },
  ): Promise<EpisodeSummary> {
    const id = meta.episodeId;
    const f = finish ?? (await this.#readFinish(id));
    return {
      episodeId: id,
      createdAt: meta.createdAt,
      mode: meta.mode,
      procedureId: meta.procedure?.id ?? null,
      finished: f.exists,
      outcome: f.value?.outcome ?? null,
      durationMs: f.value?.durationMs ?? null,
      frameCount: await this.#lineCount(this.#path(id, 'frames.ndjson')),
      eventCount: await this.#lineCount(this.#path(id, 'events.ndjson')),
    };
  }

  /**
   * Line counts are cached per file. The files only grow, so a grown file costs only its new bytes
   * and listing stays cheap while a long recording is written. A file that shrank or was replaced
   * (a new inode) is counted again from the start.
   */
  async #lineCount(path: string): Promise<number> {
    let info: { ino: number; size: number; mtimeMs: number };
    try {
      info = await stat(path);
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
    const { ino, size, mtimeMs } = info;
    const cached = this.#lineCounts.get(path);
    if (cached?.ino === ino && cached.size === size && cached.mtimeMs === mtimeMs) {
      return cached.lines;
    }
    const lines =
      cached?.ino === ino && size > cached.size
        ? cached.lines + (await countLines(path, cached.size, size))
        : await countLines(path, 0, size);
    this.#lineCounts.set(path, { ino, size, mtimeMs, lines });
    return lines;
  }
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** One of an episode's own files (`meta.json`) or one of its media files (`media/<name>`). */
function isEpisodeFile(name: string): boolean {
  return name.startsWith('media/') ? isSafeMediaName(name.slice('media/'.length)) : isSafeId(name);
}
