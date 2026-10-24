import type { LocateRequest } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { createHttpLocator } from '../src/services/http-vision';

// An external object finder (e.g. jev) behind CLIO_VISION_URL. It receives our LocateRequest and
// answers { detections, model? }; Clio fills in whatever a finder leaves out.

const FINDER_URL = 'http://127.0.0.1:8001/locate';
const REQUEST: LocateRequest = {
  image: { mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRgABAQ' },
  objects: [
    {
      id: 'cap',
      query: 'Round blue cap with a windshield symbol, front left of the engine bay',
      phrase: 'blue washer cap',
    },
    { id: 'jug', query: 'Blue plastic jug of washer fluid on the fender' },
    { id: 'funnel', query: 'Small orange funnel' },
  ],
};

type Respond = (init: RequestInit) => Response | Promise<Response>;

function fakeFetch(respond: Respond) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return respond(init);
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

const json = (body: unknown) => () =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const locate = (respond: Respond, options: { token?: string; timeoutMs?: number } = {}) =>
  createHttpLocator({ url: FINDER_URL, fetch: fakeFetch(respond).fetch, ...options }).locate(
    REQUEST,
  );

describe('createHttpLocator', () => {
  it('posts the locate request as JSON to the configured URL, with the token', async () => {
    const { calls, fetch } = fakeFetch(json({ detections: [] }));
    await createHttpLocator({ url: FINDER_URL, token: 's3cret', fetch }).locate(REQUEST);
    expect(calls.map((c) => c.url)).toEqual([FINDER_URL]);
    const init = calls[0]?.init ?? {};
    const headers = new Headers(init.headers);
    expect(init.method).toBe('POST');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('authorization')).toBe('Bearer s3cret');
    expect(JSON.parse(String(init.body))).toEqual(REQUEST);
  });

  it('sends no authorization header without a token', async () => {
    const { calls, fetch } = fakeFetch(json({ detections: [] }));
    await createHttpLocator({ url: FINDER_URL, fetch }).locate(REQUEST);
    expect(new Headers(calls[0]?.init.headers).has('authorization')).toBe(false);
  });

  it('passes complete detections through and reports the model that answered', async () => {
    const detection = {
      id: 'cap',
      found: true,
      point: [0.375, 0.25],
      box: [0.25, 0.125, 0.5, 0.375],
      outline: [
        [0.25, 0.125],
        [0.5, 0.125],
        [0.375, 0.375],
      ],
      confidence: 0.8,
    };
    expect(await locate(json({ model: 'jev-sam', detections: [detection] }))).toEqual({
      model: 'jev-sam',
      detections: [detection],
    });
  });

  it('fills in what a finder leaves out: box and point from the outline, found, confidence', async () => {
    const outline = [
      [0.25, 0.125],
      [0.5, 0.125],
      [0.375, 0.375],
    ];
    const answer = await locate(
      json({
        detections: [
          { id: 'cap', outline },
          { id: 'jug', box: [0.5, 0.5, 0.75, 1] },
          { id: 'funnel' },
        ],
      }),
    );
    expect(answer).toEqual({
      model: 'http',
      detections: [
        {
          id: 'cap',
          found: true,
          point: [0.375, 0.25],
          box: [0.25, 0.125, 0.5, 0.375],
          outline,
          confidence: 0.5,
        },
        {
          id: 'jug',
          found: true,
          point: [0.625, 0.75],
          box: [0.5, 0.5, 0.75, 1],
          outline: null,
          confidence: 0.5,
        },
        { id: 'funnel', found: false, point: null, box: null, outline: null, confidence: 0 },
      ],
    });
  });

  it('honors found: false, orders box corners and clamps slightly-off values', async () => {
    const answer = await locate(
      json({
        detections: [
          { id: 'cap', found: false, point: [0.5, 0.5], confidence: 0.9 },
          { id: 'jug', found: true, box: [0.75, 1.01, 0.25, 0.5], confidence: 1.2 },
        ],
      }),
    );
    expect(answer.detections).toEqual([
      { id: 'cap', found: false, point: null, box: null, outline: null, confidence: 0 },
      {
        id: 'jug',
        found: true,
        point: [0.5, 0.75],
        box: [0.25, 0.5, 0.75, 1],
        outline: null,
        confidence: 1,
      },
    ]);
  });

  it('simplifies a dense mask contour to a light outline that keeps its shape', async () => {
    const circle = Array.from({ length: 2000 }, (_, i) => {
      const a = (2 * Math.PI * i) / 2000;
      return [0.5 + 0.25 * Math.cos(a), 0.5 + 0.25 * Math.sin(a)];
    });
    const [cap] = (await locate(json({ detections: [{ id: 'cap', outline: circle }] }))).detections;
    const outline = cap?.outline ?? [];
    expect(outline.length).toBeGreaterThanOrEqual(12);
    expect(outline.length).toBeLessThanOrEqual(64);
    for (const [x, y] of outline) expect(Math.hypot(x - 0.5, y - 0.5)).toBeCloseTo(0.25, 3);
  });

  it('rejects pixel coordinates, saying what Clio expects', async () => {
    await expect(locate(json({ detections: [{ id: 'cap', point: [640, 360] }] }))).rejects.toThrow(
      /pixel coordinates.*0\.\.1 of the image width and height/,
    );
  });

  it('reports an error status with the start of the body', async () => {
    await expect(locate(() => new Response('model not loaded', { status: 503 }))).rejects.toThrow(
      'Object finder answered 503: model not loaded',
    );
  });

  it('rejects an answer that is not JSON or has no detections list', async () => {
    await expect(locate(() => new Response('<html>'))).rejects.toThrow(/not valid JSON/);
    await expect(locate(json({ results: [] }))).rejects.toThrow(/detections/);
  });

  it('gives up after the timeout', async () => {
    const hang: Respond = (init) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    await expect(locate(hang, { timeoutMs: 10 })).rejects.toThrow(
      'Object finder timed out after 10 ms',
    );
  });

  it('says when the finder is unreachable', async () => {
    const refused: Respond = () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8001'), {
          code: 'ECONNREFUSED',
        }),
      });
    };
    await expect(locate(refused)).rejects.toThrow(
      `Object finder at ${FINDER_URL} is unreachable: connect ECONNREFUSED 127.0.0.1:8001`,
    );
  });
});
