import { ApiErrorSchema, ApiPaths, DemoClipSchema } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { completed, entered, episodeCreate, framesEvery, hand } from './fixtures';
import { type Harness, harness, sequence, steppingClock } from './harness';

async function recordedEpisode(h: Harness, body = episodeCreate()): Promise<string> {
  const res = await h.request('POST', ApiPaths.episodes, body);
  const { episodeId } = (await res.json()) as { episodeId: string };
  await h.request('POST', ApiPaths.episodeBatches(episodeId), {
    seq: 0,
    frames: framesEvery(10, 0, 60),
    events: [
      entered(0, 'a'),
      completed(30, 'a'),
      entered(30, 'b'),
      completed(60, 'b', { by: 'coach', forced: true }),
    ],
  });
  return episodeId;
}

const newHarness = () =>
  harness({ now: steppingClock('2026-10-24T03:15:02.123Z'), rand: sequence(0.5) });

describe('POST /api/clips/from-episode', () => {
  it('slices completed, unforced steps into clips and stores them', async () => {
    const h = await newHarness();
    const episodeId = await recordedEpisode(h);
    const res = await h.request('POST', ApiPaths.clipsFromEpisode, { episodeId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      clips: [{ clipId: 'shirt-fold/a', stepId: 'a', durationMs: 30, frameCount: 4 }],
    });

    const stored = DemoClipSchema.parse(
      JSON.parse(await h.readData('clips', 'shirt-fold', 'a.json')),
    );
    expect(stored).toMatchObject({
      schema: 'clio.clip/1',
      clipId: 'shirt-fold/a',
      procedureId: 'shirt-fold',
      procedureVersion: 1,
      stepId: 'a',
      source: { episodeId: 'ep-20261024-031502-iiii', startT: 0, endT: 30 },
      durationMs: 30,
    });
    expect(stored.frames.map((f) => f.t)).toEqual([0, 10, 20, 30]);
    expect(stored.frames[3]).toEqual({ t: 30, left: hand(30), right: null });
  });

  it('only slices the requested steps', async () => {
    const h = await newHarness();
    const episodeId = await recordedEpisode(h);
    const res = await h.request('POST', ApiPaths.clipsFromEpisode, { episodeId, stepIds: ['b'] });
    expect(await res.json()).toEqual({ clips: [] });
  });

  it('refuses episodes without a procedure', async () => {
    const h = await newHarness();
    const episodeId = await recordedEpisode(h, episodeCreate({ mode: 'free', procedure: null }));
    const res = await h.request('POST', ApiPaths.clipsFromEpisode, { episodeId });
    expect(res.status).toBe(400);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('no_procedure');
  });

  it('validates the request', async () => {
    const h = await newHarness();
    const missing = await h.request('POST', ApiPaths.clipsFromEpisode, { episodeId: 'ep-nope' });
    expect(missing.status).toBe(404);
    const unsafe = await h.request('POST', ApiPaths.clipsFromEpisode, { episodeId: '../x' });
    expect(unsafe.status).toBe(400);
    const invalid = await h.request('POST', ApiPaths.clipsFromEpisode, { stepIds: ['a'] });
    expect(invalid.status).toBe(400);
  });
});

describe('GET /api/clips/:procedureId/:stepId', () => {
  it('serves a stored clip', async () => {
    const h = await newHarness();
    const episodeId = await recordedEpisode(h);
    await h.request('POST', ApiPaths.clipsFromEpisode, { episodeId });
    const res = await h.request('GET', ApiPaths.clip('shirt-fold', 'a'));
    expect(res.status).toBe(200);
    const clip = DemoClipSchema.parse(await res.json());
    expect(clip.clipId).toBe('shirt-fold/a');
    expect(clip.frames).toHaveLength(4);
  });

  it('answers 404 for unknown clips and 400 for unsafe ids', async () => {
    const h = await newHarness();
    expect((await h.request('GET', ApiPaths.clip('shirt-fold', 'nope'))).status).toBe(404);
    expect((await h.request('GET', '/api/clips/..%2F..%2Fdata/x')).status).toBe(400);
  });
});
