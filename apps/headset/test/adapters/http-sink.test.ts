import { HAND_LAYOUT } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../src/adapters/net/api-client';
import { HttpEpisodeSink } from '../../src/adapters/net/http-episode-sink';
import { SinkError } from '../../src/domain/recording/sink';

const fetchReturning = (status: number, body: unknown = {}) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

const batch = { seq: 0, frames: [], events: [], objects: [] };

async function appendError(f: typeof fetch): Promise<SinkError> {
  const sink = new HttpEpisodeSink(new ApiClient('http://server', f));
  try {
    await sink.append('ep-1', batch);
  } catch (err) {
    if (err instanceof SinkError) return err;
    throw err;
  }
  throw new Error('expected a failure');
}

describe('HttpEpisodeSink', () => {
  it('posts a created episode and returns the server id', async () => {
    const sink = new HttpEpisodeSink(
      new ApiClient('http://server', fetchReturning(201, { episodeId: 'ep-7' })),
    );
    const id = await sink.create({
      schema: 'clio.episode/1',
      mode: 'learn',
      procedure: null,
      operator: { role: 'learner' },
      clock: { timeline: 'performance.now', startEpochMs: 0 },
      space: {
        frame: 'workspace',
        units: 'm',
        upAxis: '+y',
        worldFromWorkspace: [0, 0, 0, 0, 0, 0, 1],
        calibration: 'none',
        anchored: false,
      },
      hands: HAND_LAYOUT,
      objects: [],
      coach: { kind: 'none' },
      device: { userAgent: 't', emulated: true, xrFeatures: [] },
      app: { version: 't' },
    });
    expect(id).toBe('ep-7');
  });

  it('marks server errors and network failures as retriable', async () => {
    expect((await appendError(fetchReturning(503))).retriable).toBe(true);
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    expect((await appendError(offline)).retriable).toBe(true);
  });

  it('puts a media file with its own content type, and a refused one is not retried', async () => {
    const calls: { url: string; method?: string; type?: string; body?: unknown }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({ url, method: init?.method, type: headers?.['content-type'], body: init?.body });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const body = new Blob(['glb'], { type: 'model/gltf-binary' });
    await new HttpEpisodeSink(new ApiClient('http://server', f)).putMedia(
      'ep-1',
      'room-scan-1.glb',
      body,
    );
    expect(calls).toEqual([
      {
        url: 'http://server/api/episodes/ep-1/media/room-scan-1.glb',
        method: 'PUT',
        type: 'model/gltf-binary',
        body,
      },
    ]);

    const tooLarge = new HttpEpisodeSink(
      new ApiClient(
        'http://server',
        fetchReturning(413, { error: { code: 'too_large', message: 'too large' } }),
      ),
    );
    const err = await tooLarge
      .putMedia('ep-1', 'keyframe-0001.jpg', new Blob(['x']))
      .catch((e) => e);
    expect(err).toBeInstanceOf(SinkError);
    expect((err as SinkError).retriable).toBe(false);
  });

  it('marks a rejected (invalid) batch as not retriable', async () => {
    const err = await appendError(
      fetchReturning(400, { error: { code: 'invalid', message: 'bad batch' } }),
    );
    expect(err.retriable).toBe(false);
    expect(err.message).toMatch(/bad batch/);
  });
});
