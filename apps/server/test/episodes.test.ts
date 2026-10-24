import {
  appendFile,
  cp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  ApiErrorSchema,
  ApiPaths,
  EpisodeDetailResponseSchema,
  EpisodeListResponseSchema,
} from '@clio/protocol';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS } from '../src/deps';
import { recordSeq } from '../src/storage/episode-store';
import { countLines, lastLineEnd } from '../src/storage/files';
import {
  entered,
  episodeCreate,
  finishBody,
  frame,
  framesEvery,
  objectTrack,
  observation,
} from './fixtures';
import { type Harness, harness, ndjsonLines, sequence, steppingClock, tempDir } from './harness';

// Passes through, so a test can see which byte ranges the store counts.
vi.mock('../src/storage/files', async (importOriginal) => {
  const files = await importOriginal<typeof import('../src/storage/files')>();
  return { ...files, countLines: vi.fn(files.countLines) };
});
const countLinesSpy = vi.mocked(countLines);

const ID = 'ep-20261024-031502-abcz';
const SHIRT_FOLD = join(import.meta.dirname, '../../../fixtures/episodes/synthetic-shirt-fold');

async function fixedHarness(extra: Parameters<typeof harness>[0] = {}) {
  return harness({
    now: steppingClock('2026-10-24T03:15:02.123Z'),
    rand: sequence(0.29, 0.31, 0.34, 0.99),
    ...extra,
  });
}

async function create(h: Harness, body = episodeCreate()): Promise<string> {
  const res = await h.request('POST', ApiPaths.episodes, body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { episodeId: string }).episodeId;
}

async function errorOf(res: Response) {
  return ApiErrorSchema.parse(await res.json()).error;
}

async function listed(h: Harness) {
  return EpisodeListResponseSchema.parse(await (await h.request('GET', ApiPaths.episodes)).json())
    .episodes;
}

async function detail(h: Harness, id: string) {
  const res = await h.request('GET', ApiPaths.episode(id));
  expect(res.status).toBe(200);
  return EpisodeDetailResponseSchema.parse(await res.json());
}

/** One `?from=` read: the decoded lines and the offset the server says to pass next. */
async function readFrom(h: Harness, path: string, from?: number) {
  const res = await h.request('GET', from === undefined ? path : `${path}?from=${from}`);
  expect(res.status).toBe(200);
  return { lines: ndjsonLines(await res.text()), next: Number(res.headers.get('x-next-from')) };
}

const lineOf = (record: unknown) => `${JSON.stringify(record)}\n`;

describe('POST /api/episodes', () => {
  it('assigns an id and createdAt and writes the episode layout', async () => {
    const h = await fixedHarness();
    const res = await h.request('POST', ApiPaths.episodes, episodeCreate());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ episodeId: ID });

    expect(JSON.parse(await h.readData('episodes', ID, 'meta.json'))).toEqual({
      ...episodeCreate(),
      episodeId: ID,
      createdAt: '2026-10-24T03:15:02.123Z',
    });
    expect(await h.readData('episodes', ID, 'frames.ndjson')).toBe('');
    expect(await h.readData('episodes', ID, 'events.ndjson')).toBe('');
    expect(await h.readData('episodes', ID, 'objects.ndjson')).toBe('');
    expect(await h.readData('episodes', ID, 'observations.ndjson')).toBe('');
    expect(JSON.parse(await h.readData('episodes', ID, 'batches.json'))).toEqual({
      received: [],
      gaps: [],
    });
  });

  it('rejects an invalid body with the validation issues', async () => {
    const h = await fixedHarness();
    const res = await h.request('POST', ApiPaths.episodes, { ...episodeCreate(), mode: 'party' });
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe('validation_failed');
    expect(error.message).toMatch(/mode/);
    expect(error.details).toMatchObject({ issues: [{ path: 'mode' }] });
  });

  it('rejects malformed JSON', async () => {
    const h = await fixedHarness();
    const res = await h.request('POST', ApiPaths.episodes, '{"schema":', {
      'content-type': 'application/json',
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('invalid_json');
  });
});

describe('POST /api/episodes/:id/batches', () => {
  it('appends frames, events and objects as NDJSON lines', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const res = await h.request('POST', ApiPaths.episodeBatches(id), {
      seq: 0,
      frames: [frame(0), frame(11)],
      events: [entered(0, 'lay-flat')],
      objects: [objectTrack(5)],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: false });

    const frames = await h.readData('episodes', id, 'frames.ndjson');
    expect(frames.endsWith('\n')).toBe(true);
    expect(ndjsonLines(frames)).toEqual([frame(0), frame(11)]);
    expect(ndjsonLines(await h.readData('episodes', id, 'events.ndjson'))).toEqual([
      entered(0, 'lay-flat'),
    ]);
    expect(ndjsonLines(await h.readData('episodes', id, 'objects.ndjson'))).toEqual([
      objectTrack(5),
    ]);
    expect(JSON.parse(await h.readData('episodes', id, 'batches.json'))).toEqual({
      received: [0],
      gaps: [],
    });
  });

  it('acknowledges a repeated seq without appending it again', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const batch = { seq: 0, frames: [frame(0)], events: [] };
    await h.request('POST', ApiPaths.episodeBatches(id), batch);
    const again = await h.request('POST', ApiPaths.episodeBatches(id), batch);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect(ndjsonLines(await h.readData('episodes', id, 'frames.ndjson'))).toHaveLength(1);
  });

  it('records skipped seqs as gaps and fills them when they arrive late', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const post = (seq: number) =>
      h.request('POST', ApiPaths.episodeBatches(id), {
        seq,
        frames: [frame(seq * 100)],
        events: [],
      });
    await post(0);
    await post(3);
    expect(JSON.parse(await h.readData('episodes', id, 'batches.json'))).toEqual({
      received: [0, 3],
      gaps: [1, 2],
    });
    await post(1);
    expect(JSON.parse(await h.readData('episodes', id, 'batches.json'))).toEqual({
      received: [0, 1, 3],
      gaps: [2],
    });
    const ts = ndjsonLines(await h.readData('episodes', id, 'frames.ndjson')).map(
      (f) => (f as { t: number }).t,
    );
    expect(ts).toEqual([0, 300, 100]);
  });

  it('defaults objects to an empty list', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const res = await h.request('POST', ApiPaths.episodeBatches(id), {
      seq: 0,
      frames: [],
      events: [entered(0, 'a')],
    });
    expect(res.status).toBe(200);
    expect(await h.readData('episodes', id, 'objects.ndjson')).toBe('');
  });

  it('never interleaves concurrent batches or loses a seq', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const seqs = Array.from({ length: 20 }, (_, i) => i);
    const results = await Promise.all(
      seqs.map((seq) =>
        h.request('POST', ApiPaths.episodeBatches(id), {
          seq,
          frames: [frame(seq * 1000), frame(seq * 1000 + 1), frame(seq * 1000 + 2)],
          events: [],
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(seqs.map(() => 200));
    expect(JSON.parse(await h.readData('episodes', id, 'batches.json'))).toEqual({
      received: seqs,
      gaps: [],
    });
    const ts = ndjsonLines(await h.readData('episodes', id, 'frames.ndjson')).map(
      (f) => (f as { t: number }).t,
    );
    expect(ts).toHaveLength(60);
    for (let i = 0; i < 60; i += 3) {
      const base = ts[i] ?? -1;
      expect([ts[i + 1], ts[i + 2]]).toEqual([base + 1, base + 2]);
    }
  });

  it('answers 404 for an unknown episode and 400 for an unsafe id', async () => {
    const h = await fixedHarness();
    const batch = { seq: 0, frames: [], events: [] };
    const missing = await h.request('POST', ApiPaths.episodeBatches('ep-nope'), batch);
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe('not_found');
    const unsafe = await h.request('POST', '/api/episodes/..%2F..%2Fetc/batches', batch);
    expect(unsafe.status).toBe(400);
    expect((await errorOf(unsafe)).code).toBe('invalid_id');
  });

  it('rejects an invalid batch', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const res = await h.request('POST', ApiPaths.episodeBatches(id), {
      seq: -1,
      frames: [],
      events: [],
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('validation_failed');
  });

  it('refuses new batches once the episode is finished, but still acks duplicates', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    await h.request('POST', ApiPaths.episodeBatches(id), { seq: 0, frames: [], events: [] });
    await h.request('POST', ApiPaths.episodeFinish(id), finishBody());
    const late = await h.request('POST', ApiPaths.episodeBatches(id), {
      seq: 1,
      frames: [],
      events: [],
    });
    expect(late.status).toBe(409);
    expect((await errorOf(late)).code).toBe('episode_finished');
    const retry = await h.request('POST', ApiPaths.episodeBatches(id), {
      seq: 0,
      frames: [],
      events: [],
    });
    expect(await retry.json()).toEqual({ ok: true, duplicate: true });
  });

  it('answers 413 when a batch is larger than the limit', async () => {
    const h = await fixedHarness({ limits: { batchBytes: 1000 } });
    const id = await create(h);
    const res = await h.request('POST', ApiPaths.episodeBatches(id), {
      seq: 0,
      frames: framesEvery(10, 0, 40),
      events: [],
    });
    expect(res.status).toBe(413);
    expect((await errorOf(res)).code).toBe('payload_too_large');
    expect(DEFAULT_LIMITS.batchBytes).toBe(25 * 1024 * 1024);
  });

  it('keeps a batch after an absurd seq jump but does not list millions of gaps', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    await h.request('POST', ApiPaths.episodeBatches(id), { seq: 0, frames: [], events: [] });
    const res = await h.request('POST', ApiPaths.episodeBatches(id), {
      seq: 5_000_000,
      frames: [frame(1)],
      events: [],
    });
    expect(await res.json()).toEqual({ ok: true, duplicate: false });
    expect(JSON.parse(await h.readData('episodes', id, 'batches.json'))).toEqual({
      received: [0, 5_000_000],
      gaps: [],
    });
    expect(h.logger.lines).toContain(
      `warn Episode ${id}: seq jumped from 0 to 5000000; gaps not listed`,
    );
  });
});

describe('recordSeq', () => {
  it('lists skipped seqs as gaps up to a sane jump', () => {
    expect(recordSeq({ received: [0, 1], gaps: [] }, 4)).toEqual({
      received: [0, 1, 4],
      gaps: [2, 3],
    });
    expect(recordSeq({ received: [0], gaps: [] }, 10_001)).toEqual({
      received: [0, 10_001],
      gaps: Array.from({ length: 10_000 }, (_, i) => i + 1),
    });
    expect(recordSeq({ received: [0], gaps: [] }, 10_002)).toEqual({
      received: [0, 10_002],
      gaps: [],
    });
  });
});

describe('POST /api/episodes/:id/finish', () => {
  it('writes finish.json and lets a second finish overwrite it', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const first = await h.request('POST', ApiPaths.episodeFinish(id), finishBody());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect(JSON.parse(await h.readData('episodes', id, 'finish.json'))).toEqual(finishBody());

    await h.request('POST', ApiPaths.episodeFinish(id), finishBody({ outcome: 'aborted' }));
    expect(JSON.parse(await h.readData('episodes', id, 'finish.json'))).toEqual(
      finishBody({ outcome: 'aborted' }),
    );
  });

  it('validates the body and the episode', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const bad = await h.request('POST', ApiPaths.episodeFinish(id), { outcome: 'done' });
    expect(bad.status).toBe(400);
    const missing = await h.request('POST', ApiPaths.episodeFinish('ep-nope'), finishBody());
    expect(missing.status).toBe(404);
  });
});

describe('PUT /api/episodes/:id/media/:name', () => {
  it('streams the raw body into media/<name>', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0xff]);
    const res = await h.request('PUT', ApiPaths.episodeMedia(id, 'egocentric.webm'), bytes, {
      'content-type': 'video/webm',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: 'egocentric.webm', bytes: 6 });
    const written = await readFile(join(h.dataDir, 'episodes', id, 'media', 'egocentric.webm'));
    expect([...written]).toEqual([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0xff]);
  });

  it('rejects unsafe names and unknown episodes', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const unsafe = await h.request('PUT', `/api/episodes/${id}/media/.env`, 'x');
    expect(unsafe.status).toBe(400);
    expect((await errorOf(unsafe)).code).toBe('invalid_name');
    const missing = await h.request('PUT', ApiPaths.episodeMedia('ep-nope', 'a.webm'), 'x');
    expect(missing.status).toBe(404);
  });

  it('answers 413 past the media limit and leaves no partial file', async () => {
    const h = await fixedHarness({ limits: { mediaBytes: 4 } });
    const id = await create(h);
    const res = await h.request('PUT', ApiPaths.episodeMedia(id, 'audio.webm'), 'too many bytes');
    expect(res.status).toBe(413);
    expect(await readdir(join(h.dataDir, 'episodes', id, 'media'))).toEqual([]);
  });
});

describe('GET /api/episodes', () => {
  it('lists episodes newest first with summaries computed from the files', async () => {
    const h = await harness({
      now: steppingClock('2026-10-24T03:15:02.000Z', 60_000),
      rand: sequence(0.5),
    });
    const older = await create(h);
    const newer = await create(h, episodeCreate({ mode: 'free', procedure: null }));
    await h.request('POST', ApiPaths.episodeBatches(older), {
      seq: 0,
      frames: framesEvery(10, 0, 30),
      events: [entered(0, 'a'), entered(20, 'b')],
    });
    await h.request('POST', ApiPaths.episodeFinish(older), finishBody({ durationMs: 30 }));

    const res = await h.request('GET', ApiPaths.episodes);
    expect(res.status).toBe(200);
    const body = EpisodeListResponseSchema.parse(await res.json());
    expect(body.episodes).toEqual([
      {
        episodeId: newer,
        createdAt: '2026-10-24T03:16:02.000Z',
        mode: 'free',
        procedureId: null,
        finished: false,
        outcome: null,
        durationMs: null,
        frameCount: 0,
        eventCount: 0,
      },
      {
        episodeId: older,
        createdAt: '2026-10-24T03:15:02.000Z',
        mode: 'record_demo',
        procedureId: 'shirt-fold',
        finished: true,
        outcome: 'completed',
        durationMs: 30,
        frameCount: 4,
        eventCount: 2,
      },
    ]);
    expect([older, newer]).toEqual(['ep-20261024-031502-iiii', 'ep-20261024-031602-iiii']);
  });

  it('is empty before anything was recorded', async () => {
    const h = await fixedHarness();
    expect(await (await h.request('GET', ApiPaths.episodes)).json()).toEqual({ episodes: [] });
  });

  it('counts only the bytes appended since the last listing', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const path = join(h.dataDir, 'episodes', id, 'frames.ndjson');
    const size = async () => (await stat(path)).size;
    const post = (seq: number, fromT: number) =>
      h.request('POST', ApiPaths.episodeBatches(id), {
        seq,
        frames: framesEvery(10, fromT, fromT + 20),
        events: [],
      });
    const countedRanges = async () => {
      countLinesSpy.mockClear();
      const frameCount = (await listed(h))[0]?.frameCount;
      const ranges = countLinesSpy.mock.calls.filter(([p]) => p === path).map(([, ...r]) => r);
      return { frameCount, ranges };
    };

    await post(0, 0);
    const first = await size();
    expect(await countedRanges()).toEqual({ frameCount: 3, ranges: [[0, first]] });

    await post(1, 30);
    const second = await size();
    expect(await countedRanges()).toEqual({ frameCount: 6, ranges: [[first, second]] });

    expect(await countedRanges()).toEqual({ frameCount: 6, ranges: [] });
  });

  it('counts a shrunk or replaced file again from the start', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const path = join(h.dataDir, 'episodes', id, 'frames.ndjson');
    await h.request('POST', ApiPaths.episodeBatches(id), {
      seq: 0,
      frames: framesEvery(10, 0, 40),
      events: [],
    });
    expect((await listed(h))[0]?.frameCount).toBe(5);

    await writeFile(path, lineOf(frame(0)) + lineOf(frame(10)));
    expect((await listed(h))[0]?.frameCount).toBe(2);

    // Larger than before, under a new inode: the old count says nothing about its first bytes.
    const tmp = join(h.dataDir, 'episodes', id, 'replacement.tmp');
    await writeFile(tmp, lineOf({ t: 0 }).repeat(1000));
    await rename(tmp, path);
    countLinesSpy.mockClear();
    expect((await listed(h))[0]?.frameCount).toBe(1000);
    expect(countLinesSpy).toHaveBeenCalledWith(path, 0, (await stat(path)).size);
  });

  it('counts only complete lines', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const path = join(h.dataDir, 'episodes', id, 'frames.ndjson');
    const line = lineOf(frame(20));
    await h.request('POST', ApiPaths.episodeBatches(id), {
      seq: 0,
      frames: [frame(0), frame(10)],
      events: [],
    });
    await appendFile(path, line.slice(0, 25));
    expect((await listed(h))[0]?.frameCount).toBe(2);
    await appendFile(path, line.slice(25));
    expect((await listed(h))[0]?.frameCount).toBe(3);
  });
});

describe('countLines and lastLineEnd', () => {
  it('count and find newlines inside a byte range only', async () => {
    const dir = await tempDir();
    const path = join(dir, 'lines.txt');
    await writeFile(path, 'ab\ncd\nef');
    expect(await countLines(path)).toBe(2);
    expect(await countLines(path, 0, 3)).toBe(1);
    expect(await countLines(path, 3, 8)).toBe(1);
    expect(await countLines(path, 6, 8)).toBe(0);
    expect(await countLines(path, 4, 4)).toBe(0);
    expect(await countLines(join(dir, 'missing.txt'))).toBe(0);

    expect(await lastLineEnd(path, 0, 8)).toBe(6);
    expect(await lastLineEnd(path, 0, 6)).toBe(6);
    expect(await lastLineEnd(path, 0, 5)).toBe(3);
    expect(await lastLineEnd(path, 4, 5)).toBe(4);
    expect(await lastLineEnd(path, 0, 2)).toBe(0);
    expect(await lastLineEnd(path, 0, 0)).toBe(0);
  });

  it('finds the last newline far before the end', async () => {
    const path = join(await tempDir(), 'long.txt');
    const head = `${'x'.repeat(10)}\n`;
    await writeFile(path, head + 'y'.repeat(100_000));
    expect(await lastLineEnd(path, 0, head.length + 100_000)).toBe(head.length);
    expect(await lastLineEnd(path, head.length, head.length + 100_000)).toBe(head.length);
  });
});

describe('GET /api/episodes/:id', () => {
  it('returns meta, summary and finish', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    await h.request('POST', ApiPaths.episodeFinish(id), finishBody());
    const res = await h.request('GET', ApiPaths.episode(id));
    expect(res.status).toBe(200);
    const body = EpisodeDetailResponseSchema.parse(await res.json());
    expect(body.meta.episodeId).toBe(ID);
    expect(body.summary).toMatchObject({ episodeId: ID, finished: true, frameCount: 0 });
    expect(body.finish).toEqual(finishBody());
  });

  it('reports finish as null while recording, and 404 for unknown ids', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const res = await h.request('GET', ApiPaths.episode(id));
    expect(EpisodeDetailResponseSchema.parse(await res.json()).finish).toBeNull();
    expect((await h.request('GET', ApiPaths.episode('ep-nope'))).status).toBe(404);
  });

  it('reports which batches arrived, with the gaps so far', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    expect((await detail(h, id)).batches).toEqual({ received: 0, gaps: [], lastSeq: null });
    const post = (seq: number) =>
      h.request('POST', ApiPaths.episodeBatches(id), { seq, frames: [frame(seq)], events: [] });
    await post(0);
    await post(3);
    await post(0);
    expect((await detail(h, id)).batches).toEqual({ received: 2, gaps: [1, 2], lastSeq: 3 });
    await post(2);
    expect((await detail(h, id)).batches).toEqual({ received: 3, gaps: [1], lastSeq: 3 });
  });

  it('reports shirt-fold as complete: 12 batches received and no gaps', async () => {
    const h = await fixedHarness();
    const id = 'ep-synthetic-shirt-fold';
    await cp(SHIRT_FOLD, join(h.dataDir, 'episodes', id), { recursive: true });
    const linesIn = async (file: string) =>
      ndjsonLines(await readFile(join(SHIRT_FOLD, file), 'utf8')).length;

    const body = await detail(h, id);
    expect(body.batches).toEqual({ received: 12, gaps: [], lastSeq: 11 });
    expect(body.finish?.batches).toBe(body.batches?.received);
    expect(body.summary).toMatchObject({
      episodeId: id,
      finished: true,
      frameCount: await linesIn('frames.ndjson'),
      eventCount: await linesIn('events.ndjson'),
    });
  });

  it('leaves batches out when batches.json is missing or unreadable', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const path = join(h.dataDir, 'episodes', id, 'batches.json');
    const raw = async () => (await h.request('GET', ApiPaths.episode(id))).json();
    await rm(path);
    expect(await raw()).not.toHaveProperty('batches');
    await writeFile(path, '{"received":');
    expect(await raw()).not.toHaveProperty('batches');
    expect(h.logger.lines.some((l) => l.startsWith(`warn Episode ${id}: unreadable batches`))).toBe(
      true,
    );
  });
});

describe('GET /api/episodes/:id/{frames,events,objects}', () => {
  it('streams each NDJSON file as application/x-ndjson', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    await h.request('POST', ApiPaths.episodeBatches(id), {
      seq: 0,
      frames: [frame(0), frame(10)],
      events: [entered(0, 'a')],
      objects: [objectTrack(3)],
    });
    for (const [path, expected] of [
      [ApiPaths.episodeFrames(id), [frame(0), frame(10)]],
      [ApiPaths.episodeEvents(id), [entered(0, 'a')]],
      [`/api/episodes/${id}/objects`, [objectTrack(3)]],
    ] as const) {
      const res = await h.request('GET', path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/x-ndjson');
      expect(ndjsonLines(await res.text())).toEqual(expected);
    }
  });

  it('streams an empty file as an empty body', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const res = await h.request('GET', `/api/episodes/${id}/objects`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('answers 404 for unknown episodes', async () => {
    const h = await fixedHarness();
    expect((await h.request('GET', ApiPaths.episodeFrames('ep-nope'))).status).toBe(404);
  });

  it('reads only the lines after ?from and says where to read next', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const post = (seq: number, ts: number[]) =>
      h.request('POST', ApiPaths.episodeBatches(id), {
        seq,
        frames: ts.map((t) => frame(t)),
        events: [],
      });
    const read = (from?: number) => readFrom(h, ApiPaths.episodeFrames(id), from);

    await post(0, [0, 10]);
    const first = await read();
    expect(first.lines).toEqual([frame(0), frame(10)]);
    expect(first.next).toBe(Buffer.byteLength(await h.readData('episodes', id, 'frames.ndjson')));

    await post(1, [20]);
    const second = await read(first.next);
    expect(second.lines).toEqual([frame(20)]);
    expect(second.next).toBe(Buffer.byteLength(await h.readData('episodes', id, 'frames.ndjson')));

    expect(await read(second.next)).toEqual({ lines: [], next: second.next });
    expect(await read(second.next + 1000)).toEqual({ lines: [], next: second.next });
  });

  it('follows the events and objects channels with ?from too', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const post = (seq: number, t: number) =>
      h.request('POST', ApiPaths.episodeBatches(id), {
        seq,
        frames: [],
        events: [entered(t, `s${seq}`, seq)],
        objects: [objectTrack(t)],
      });
    await post(0, 0);
    const events = await readFrom(h, ApiPaths.episodeEvents(id), 0);
    const objects = await readFrom(h, ApiPaths.episodeObjects(id), 0);
    expect(events).toEqual({
      lines: [entered(0, 's0', 0)],
      next: lineOf(entered(0, 's0', 0)).length,
    });
    expect(objects).toEqual({ lines: [objectTrack(0)], next: lineOf(objectTrack(0)).length });

    await post(1, 40);
    expect(await readFrom(h, ApiPaths.episodeEvents(id), events.next)).toEqual({
      lines: [entered(40, 's1', 1)],
      next: events.next + lineOf(entered(40, 's1', 1)).length,
    });
    expect(await readFrom(h, ApiPaths.episodeObjects(id), objects.next)).toEqual({
      lines: [objectTrack(40)],
      next: objects.next + lineOf(objectTrack(40)).length,
    });
  });

  it('counts offsets in bytes, so multibyte text reads back whole', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const first = { ...entered(0, 'a'), instruction: 'Falte das Hemd schön glatt: 折りたたむ 👕' };
    const second = { ...entered(10, 'b', 1), instruction: 'Ärmel nach innen, ✓ fertig' };
    await h.request('POST', ApiPaths.episodeBatches(id), { seq: 0, frames: [], events: [first] });
    const one = await readFrom(h, ApiPaths.episodeEvents(id));
    expect(one).toEqual({ lines: [first], next: Buffer.byteLength(lineOf(first)) });
    expect(one.next).toBeGreaterThan(lineOf(first).length);

    await h.request('POST', ApiPaths.episodeBatches(id), { seq: 1, frames: [], events: [second] });
    expect(await readFrom(h, ApiPaths.episodeEvents(id), one.next)).toEqual({
      lines: [second],
      next: one.next + Buffer.byteLength(lineOf(second)),
    });
  });

  it('answers a smaller x-next-from when the file shrank below from', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const path = join(h.dataDir, 'episodes', id, 'frames.ndjson');
    await h.request('POST', ApiPaths.episodeBatches(id), {
      seq: 0,
      frames: [frame(0), frame(10), frame(20)],
      events: [],
    });
    const before = await readFrom(h, ApiPaths.episodeFrames(id));

    // Replaced by a shorter copy while a viewer follows it: the smaller offset tells it to restart.
    await truncate(path, lineOf(frame(0)).length);
    const after = await readFrom(h, ApiPaths.episodeFrames(id), before.next);
    expect(after).toEqual({ lines: [], next: lineOf(frame(0)).length });
    expect(after.next).toBeLessThan(before.next);
    expect(await readFrom(h, ApiPaths.episodeFrames(id), 0)).toEqual({
      lines: [frame(0)],
      next: after.next,
    });
  });

  it('never serves a trailing partial line, and serves it whole once it is complete', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const path = join(h.dataDir, 'episodes', id, 'frames.ndjson');
    await h.request('POST', ApiPaths.episodeBatches(id), {
      seq: 0,
      frames: [frame(0), frame(10)],
      events: [],
    });
    const whole = lineOf(frame(0)).length + lineOf(frame(10)).length;
    const line = lineOf(frame(20));
    // As if the process died partway through an append.
    await appendFile(path, line.slice(0, 25));

    expect(await readFrom(h, ApiPaths.episodeFrames(id))).toEqual({
      lines: [frame(0), frame(10)],
      next: whole,
    });
    expect(await readFrom(h, ApiPaths.episodeFrames(id), whole)).toEqual({
      lines: [],
      next: whole,
    });
    // The probe a viewer joining a long live episode sends to learn where the end is.
    expect(await readFrom(h, ApiPaths.episodeFrames(id), Number.MAX_SAFE_INTEGER)).toEqual({
      lines: [],
      next: whole,
    });

    await appendFile(path, line.slice(25));
    expect(await readFrom(h, ApiPaths.episodeFrames(id), whole)).toEqual({
      lines: [frame(20)],
      next: whole + line.length,
    });
  });

  it('rejects a from that is not a byte offset', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    for (const from of ['-1', '1.5', 'abc', '']) {
      const res = await h.request('GET', `${ApiPaths.episodeEvents(id)}?from=${from}`);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe('invalid_offset');
    }
  });
});

describe('the observations channel', () => {
  it('appends batch observations to observations.ndjson, in order', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const post = (seq: number, observations: unknown[]) =>
      h.request('POST', ApiPaths.episodeBatches(id), { seq, frames: [], events: [], observations });
    expect((await post(0, [observation(100), observation(133, 'predicted')])).status).toBe(200);
    expect((await post(1, [observation(166, 'lost')])).status).toBe(200);
    expect(ndjsonLines(await h.readData('episodes', id, 'observations.ndjson'))).toEqual([
      observation(100),
      observation(133, 'predicted'),
      observation(166, 'lost'),
    ]);
  });

  it('defaults observations to an empty list and rejects invalid ones', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    await h.request('POST', ApiPaths.episodeBatches(id), { seq: 0, frames: [], events: [] });
    expect(await h.readData('episodes', id, 'observations.ndjson')).toBe('');

    const res = await h.request('POST', ApiPaths.episodeBatches(id), {
      seq: 1,
      frames: [],
      events: [],
      observations: [{ ...observation(10), status: 'guessed' }],
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toMatch(/observations\.0\.status/);
    expect(await h.readData('episodes', id, 'observations.ndjson')).toBe('');
  });

  it('reads only the observations after ?from and says where to read next', async () => {
    const h = await fixedHarness();
    const id = await create(h);
    const post = (seq: number, t: number) =>
      h.request('POST', ApiPaths.episodeBatches(id), {
        seq,
        frames: [],
        events: [],
        observations: [observation(t)],
      });
    await post(0, 100);
    const first = await readFrom(h, ApiPaths.episodeObservations(id));
    expect(first).toEqual({ lines: [observation(100)], next: lineOf(observation(100)).length });

    await post(1, 133);
    expect(await readFrom(h, ApiPaths.episodeObservations(id), first.next)).toEqual({
      lines: [observation(133)],
      next: first.next + lineOf(observation(133)).length,
    });
    const res = await h.request('GET', ApiPaths.episodeObservations(id));
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
  });

  it('reads an episode recorded before observations existed as empty, from any offset', async () => {
    const h = await fixedHarness();
    const id = 'ep-synthetic-shirt-fold';
    await cp(SHIRT_FOLD, join(h.dataDir, 'episodes', id), { recursive: true });
    expect(await readdir(join(h.dataDir, 'episodes', id))).not.toContain('observations.ndjson');

    for (const from of [undefined, 0, 4096]) {
      const res = await h.request(
        'GET',
        from === undefined
          ? ApiPaths.episodeObservations(id)
          : `${ApiPaths.episodeObservations(id)}?from=${from}`,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
      expect(res.headers.get('x-next-from')).toBe('0');
    }
    expect((await listed(h)).map((e) => e.episodeId)).toEqual([id]);
    expect((await detail(h, id)).summary).toMatchObject({ episodeId: id, finished: true });
  });

  it('answers 404 for the observations of an unknown episode', async () => {
    const h = await fixedHarness();
    expect((await h.request('GET', ApiPaths.episodeObservations('ep-nope'))).status).toBe(404);
  });
});
