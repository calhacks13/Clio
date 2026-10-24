import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../src/adapters/net/api-client';
import { RemoteLocator } from '../../src/adapters/net/remote';

const FRAME = { t: 1000, width: 960, height: 720, jpegBase64: '/9j/4AAQ' };
const OBJECTS = [{ id: 'cap', query: 'blue cap', phrase: 'cap' }];

function server(answer: Record<string, unknown>) {
  const bodies: unknown[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { api: new ApiClient('http://server', fetch), bodies };
}

describe('RemoteLocator', () => {
  it('sends the same session with every frame of one run, and returns refreshMs', async () => {
    const { api, bodies } = server({
      detections: [],
      model: 'tracker',
      latencyMs: 30,
      refreshMs: 50,
    });
    const locator = new RemoteLocator(api);
    const first = await locator.locate(FRAME, OBJECTS);
    await locator.locate(FRAME, OBJECTS);
    expect(first).toEqual({ detections: [], model: 'tracker', refreshMs: 50 });
    const [a, b] = bodies as { session: string }[];
    expect(a?.session).toMatch(/\S{8,}/);
    expect(b?.session).toBe(a?.session);
    await new RemoteLocator(api).locate(FRAME, OBJECTS);
    expect((bodies[2] as { session: string }).session).not.toBe(a?.session);
  });

  it('leaves refreshMs out when the finder gives none', async () => {
    const { api } = server({ detections: [], model: 'gemini', latencyMs: 900 });
    expect(await new RemoteLocator(api, 's-1').locate(FRAME, OBJECTS)).toEqual({
      detections: [],
      model: 'gemini',
    });
  });
});
