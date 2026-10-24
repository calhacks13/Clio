import {
  ApiPaths,
  type EpisodeDetailResponse,
  EpisodeDetailResponseSchema,
  EpisodeListResponseSchema,
  type EpisodeSummary,
} from '@clio/protocol';
import type { z } from 'zod';
import { NdjsonDecoder } from './episode-data';

// The viewer's reads from the Clio server, same origin (the Vite dev server proxies /api).

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

// Not `fetch` itself: called as a method it would run with the wrong `this` and throw.
const browserFetch: Fetch = (input, init) => fetch(input, init);

async function getJson<S extends z.ZodType>(
  url: string,
  schema: S,
  fetchFn: Fetch,
  signal?: AbortSignal,
): Promise<z.output<S>> {
  const res = await fetchFn(url, { cache: 'no-store', signal });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return schema.parse(await res.json());
}

export async function listEpisodes(fetchFn = browserFetch): Promise<EpisodeSummary[]> {
  return (await getJson(ApiPaths.episodes, EpisodeListResponseSchema, fetchFn)).episodes;
}

export function getEpisode(
  id: string,
  signal?: AbortSignal,
  fetchFn = browserFetch,
): Promise<EpisodeDetailResponse> {
  return getJson(ApiPaths.episode(id), EpisodeDetailResponseSchema, fetchFn, signal);
}

/**
 * Follows one of an episode's NDJSON files: every read returns only the records appended since the
 * previous one (the server's `?from=` byte offset), so a live episode is never downloaded twice.
 */
export class NdjsonTail {
  #from = 0;

  constructor(
    readonly url: string,
    private readonly fetchFn: Fetch = browserFetch,
  ) {}

  /** Bytes consumed so far. */
  get offset(): number {
    return this.#from;
  }

  /**
   * All or nothing: the offset moves only once the whole body has arrived, and each read decodes
   * on its own, so a read that fails partway leaves no half line behind and the retry asks for the
   * same bytes again.
   */
  async read(signal?: AbortSignal): Promise<unknown[]> {
    const res = await this.fetchFn(`${this.url}?from=${this.#from}`, { cache: 'no-store', signal });
    if (!res.ok) throw new Error(`${this.url}: HTTP ${res.status}`);
    const decoder = new NdjsonDecoder();
    const records: unknown[] = [];
    let bytes = 0;
    /** Bytes up to the end of the last whole line; a trailing partial line is read again. */
    let whole = 0;
    const reader = res.body?.getReader();
    for (;;) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) break;
      // 0x0a never occurs inside a multi-byte UTF-8 character, so this is a line boundary.
      const newline = chunk.value.lastIndexOf(0x0a);
      if (newline >= 0) whole = bytes + newline + 1;
      bytes += chunk.value.byteLength;
      // A long recording is many thousands of lines: push one by one, never spread.
      for (const record of decoder.push(chunk.value)) records.push(record);
    }
    const next = Number(res.headers.get('x-next-from') ?? Number.NaN);
    this.#from = Number.isSafeInteger(next) ? next : this.#from + whole;
    return records;
  }
}

/** The three NDJSON channels of one episode. */
export function episodeTails(id: string, fetchFn = browserFetch) {
  return {
    frames: new NdjsonTail(ApiPaths.episodeFrames(id), fetchFn),
    events: new NdjsonTail(ApiPaths.episodeEvents(id), fetchFn),
    objects: new NdjsonTail(ApiPaths.episodeObjects(id), fetchFn),
  };
}
