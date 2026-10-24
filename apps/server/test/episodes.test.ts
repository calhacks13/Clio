import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ApiErrorSchema,
  ApiPaths,
  EpisodeDetailResponseSchema,
  EpisodeListResponseSchema,
} from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../src/deps';
import { recordSeq } from '../src/storage/episode-store';
import { entered, episodeCreate, finishBody, frame, framesEvery, objectTrack } from './fixtures';
import { type Harness, harness, ndjsonLines, sequence, steppingClock } from './harness';

const ID = 'ep-20261024-031502-abcz';

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
});
