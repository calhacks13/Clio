import { ApiErrorSchema, ApiPaths, type Detection, LocateResponseSchema } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import {
  alignDetections,
  fromGeminiBox,
  fromGeminiDetection,
  fromGeminiPoint,
  notFound,
  simplifyOutline,
  type VisionLocator,
} from '../src/services/vision';
import { harness, steppingClock } from './harness';

// Gemini's spatial convention: integers in 0..1000, y before x. Ours: 0..1, x right, y down.

describe('fromGeminiPoint', () => {
  it('swaps [y, x] to [x, y] and scales 0..1000 to 0..1', () => {
    expect(fromGeminiPoint([500, 250])).toEqual([0.25, 0.5]);
    expect(fromGeminiPoint([0, 1000])).toEqual([1, 0]);
  });

  it('clamps to the image and rejects anything that is not two numbers', () => {
    expect(fromGeminiPoint([1200, -50])).toEqual([0, 1]);
    expect(fromGeminiPoint([500])).toBeNull();
    expect(fromGeminiPoint(['500', 250])).toBeNull();
    expect(fromGeminiPoint([Number.NaN, 250])).toBeNull();
    expect(fromGeminiPoint(null)).toBeNull();
  });
});

describe('fromGeminiBox', () => {
  it('turns [ymin, xmin, ymax, xmax] into [x0, y0, x1, y1]', () => {
    expect(fromGeminiBox([100, 200, 300, 400])).toEqual([0.2, 0.1, 0.4, 0.3]);
  });

  it('orders swapped corners, clamps, and rejects malformed boxes', () => {
    expect(fromGeminiBox([300, 400, 100, 200])).toEqual([0.2, 0.1, 0.4, 0.3]);
    expect(fromGeminiBox([-10, -10, 1100, 500])).toEqual([0, 0, 0.5, 1]);
    expect(fromGeminiBox([1, 2, 3])).toBeNull();
    expect(fromGeminiBox('box')).toBeNull();
  });
});

describe('fromGeminiDetection', () => {
  it('converts a found object', () => {
    expect(
      fromGeminiDetection({
        id: 'cap',
        found: true,
        point: [500, 250],
        box_2d: [100, 200, 300, 400],
        confidence: 0.9,
      }),
    ).toEqual({
      id: 'cap',
      found: true,
      point: [0.25, 0.5],
      box: [0.2, 0.1, 0.4, 0.3],
      outline: null,
      confidence: 0.9,
    });
  });

  it('uses the box center when the point is missing', () => {
    expect(
      fromGeminiDetection({
        id: 'cap',
        found: true,
        point: null,
        box_2d: [100, 200, 300, 400],
        confidence: 0.8,
      }),
    ).toEqual({
      id: 'cap',
      found: true,
      point: [0.3, 0.2],
      box: [0.2, 0.1, 0.4, 0.3],
      outline: null,
      confidence: 0.8,
    });
  });

  it('reports not-found objects without a location or confidence', () => {
    expect(
      fromGeminiDetection({
        id: 'jug',
        found: false,
        point: [1, 2],
        box_2d: null,
        confidence: 0.4,
      }),
    ).toEqual({ id: 'jug', found: false, point: null, box: null, outline: null, confidence: 0 });
    expect(
      fromGeminiDetection({ id: 'jug', found: true, point: null, box_2d: null, confidence: 0.4 }),
    ).toEqual({ id: 'jug', found: false, point: null, box: null, outline: null, confidence: 0 });
  });

  it('clamps confidence and defaults a missing one', () => {
    const at = { id: 'cap', found: true, point: [500, 500], box_2d: null };
    expect(fromGeminiDetection({ ...at, confidence: 1.7 })?.confidence).toBe(1);
    expect(fromGeminiDetection({ ...at, confidence: -1 })?.confidence).toBe(0);
    expect(fromGeminiDetection(at)?.confidence).toBe(0.5);
  });

  it('drops entries without an id', () => {
    expect(fromGeminiDetection({ found: true, point: [1, 1] })).toBeNull();
    expect(fromGeminiDetection('cap')).toBeNull();
  });
});

describe('alignDetections', () => {
  const found = (id: string, x: number): Detection => ({
    id,
    found: true,
    point: [x, 0.5],
    box: null,
    outline: null,
    confidence: 0.9,
  });

  it('returns exactly one detection per requested id, in request order', () => {
    expect(
      alignDetections(
        ['cap', 'jug', 'funnel', 'cap'],
        [found('jug', 0.2), found('cap', 0.1), found('ghost', 0.3), found('cap', 0.9)],
      ),
    ).toEqual([
      found('cap', 0.1),
      found('jug', 0.2),
      { id: 'funnel', found: false, point: null, box: null, outline: null, confidence: 0 },
    ]);
  });

  it('takes the most confident instance when a finder answers an id more than once', () => {
    // Segmenters answer a phrase with every instance they see.
    const cap = (x: number, confidence: number): Detection => ({ ...found('cap', x), confidence });
    expect(
      alignDetections(
        ['cap', 'jug'],
        [cap(0.1, 0.4), notFound('jug'), cap(0.7, 0.8), found('jug', 0.3)],
      ),
    ).toEqual([cap(0.7, 0.8), found('jug', 0.3)]);
  });
});

describe('simplifyOutline', () => {
  const square = (n: number): [number, number][] => {
    // n points per edge, counterclockwise from the top left, on the square 0.25..0.75.
    const edge = (from: [number, number], to: [number, number]) =>
      Array.from({ length: n }, (_, i): [number, number] => [
        from[0] + ((to[0] - from[0]) * i) / n,
        from[1] + ((to[1] - from[1]) * i) / n,
      ]);
    return [
      ...edge([0.25, 0.25], [0.25, 0.75]),
      ...edge([0.25, 0.75], [0.75, 0.75]),
      ...edge([0.75, 0.75], [0.75, 0.25]),
      ...edge([0.75, 0.25], [0.25, 0.25]),
    ];
  };

  it('leaves a light outline as it is, minus repeated points', () => {
    expect(
      simplifyOutline([
        [0.25, 0.25],
        [0.25, 0.25],
        [0.75, 0.25],
        [0.5, 0.75],
        [0.25, 0.25],
      ]),
    ).toEqual([
      [0.25, 0.25],
      [0.75, 0.25],
      [0.5, 0.75],
    ]);
  });

  it('keeps the corners of a dense polygon and drops the points between them', () => {
    expect(simplifyOutline(square(200))).toEqual([
      [0.25, 0.25],
      [0.25, 0.75],
      [0.75, 0.75],
      [0.75, 0.25],
    ]);
  });

  it('caps the point count', () => {
    const wobbly = Array.from({ length: 900 }, (_, i): [number, number] => {
      const a = (2 * Math.PI * i) / 900;
      const r = 0.2 + 0.05 * Math.sin(37 * a);
      return [0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)];
    });
    expect(simplifyOutline(wobbly, 32)?.length).toBeLessThanOrEqual(32);
  });

  it('returns null for fewer than three distinct points', () => {
    expect(
      simplifyOutline([
        [0.5, 0.5],
        [0.5, 0.5],
        [0.25, 0.5],
      ]),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

const IMAGE = { mimeType: 'image/jpeg' as const, data: '/9j/4AAQSkZJRgABAQ' };
const OBJECTS = [
  { id: 'cap', query: 'blue cap with a windshield symbol' },
  { id: 'jug', query: 'blue jug of washer fluid' },
];

describe('POST /api/vision/locate', () => {
  it('answers 503, naming both ways to turn it on, when no object finder is configured', async () => {
    const h = await harness();
    const res = await h.request('POST', ApiPaths.visionLocate, { image: IMAGE, objects: OBJECTS });
    expect(res.status).toBe(503);
    const { error } = ApiErrorSchema.parse(await res.json());
    expect(error.code).toBe('vision_not_configured');
    expect(error.message).toContain('GEMINI_API_KEY');
    expect(error.message).toContain('CLIO_VISION_URL');
  });

  it('returns one detection per object, the model and the measured latency', async () => {
    const seen: unknown[] = [];
    const locator: VisionLocator = {
      async locate(request) {
        seen.push(request);
        return {
          model: 'vision-test',
          detections: [
            {
              id: 'cap',
              found: true,
              point: [0.25, 0.5],
              box: null,
              outline: null,
              confidence: 0.9,
            },
          ],
        };
      },
    };
    const h = await harness({ locator, now: steppingClock('2026-10-24T03:15:02.000Z', 250) });
    const res = await h.request('POST', ApiPaths.visionLocate, { image: IMAGE, objects: OBJECTS });
    expect(res.status).toBe(200);
    expect(LocateResponseSchema.parse(await res.json())).toEqual({
      detections: [
        { id: 'cap', found: true, point: [0.25, 0.5], box: null, outline: null, confidence: 0.9 },
        { id: 'jug', found: false, point: null, box: null, outline: null, confidence: 0 },
      ],
      model: 'vision-test',
      latencyMs: 250,
    });
    expect(seen).toEqual([{ image: IMAGE, objects: OBJECTS }]);
  });

  it("passes a tracking finder's session through and its refreshMs back", async () => {
    const seen: unknown[] = [];
    const locator: VisionLocator = {
      async locate(request) {
        seen.push(request);
        return { model: 'yoloe-26l-seg+jev-1.14.0', detections: [], refreshMs: 50 };
      },
    };
    const h = await harness({ locator });
    const body = { image: IMAGE, objects: OBJECTS, session: 'headset-run-1' };
    const res = await h.request('POST', ApiPaths.visionLocate, body);
    expect(LocateResponseSchema.parse(await res.json()).refreshMs).toBe(50);
    expect(seen).toEqual([body]);
  });

  it('answers 502 when the vision call fails', async () => {
    const locator: VisionLocator = {
      locate: async () => {
        throw new Error('deadline exceeded');
      },
    };
    const h = await harness({ locator });
    const res = await h.request('POST', ApiPaths.visionLocate, { image: IMAGE, objects: OBJECTS });
    expect(res.status).toBe(502);
    expect(ApiErrorSchema.parse(await res.json()).error).toEqual({
      code: 'upstream_failed',
      message: 'Vision request failed: deadline exceeded',
    });
  });

  it('validates the request', async () => {
    const locator: VisionLocator = { locate: async () => ({ model: 'v', detections: [] }) };
    const h = await harness({ locator });
    const post = (body: unknown) => h.request('POST', ApiPaths.visionLocate, body);
    expect((await post({ image: IMAGE, objects: [] })).status).toBe(400);
    const many = Array.from({ length: 17 }, (_, i) => ({ id: `o${i}`, query: 'thing' }));
    expect((await post({ image: IMAGE, objects: many })).status).toBe(400);
    expect(
      (await post({ image: { ...IMAGE, mimeType: 'image/gif' }, objects: OBJECTS })).status,
    ).toBe(400);
  });
});
