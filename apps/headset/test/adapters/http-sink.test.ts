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

  it('marks a rejected (invalid) batch as not retriable', async () => {
    const err = await appendError(
      fetchReturning(400, { error: { code: 'invalid', message: 'bad batch' } }),
    );
    expect(err.retriable).toBe(false);
    expect(err.message).toMatch(/bad batch/);
  });
});
