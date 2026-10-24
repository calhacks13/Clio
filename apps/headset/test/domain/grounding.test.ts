import { type Detection, type LocateRequest, parseProcedure } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { Emitter } from '../../src/core/emitter';
import type { AppEvents } from '../../src/domain/events';
import type { CameraModel } from '../../src/domain/world/camera-model';
import {
  type CameraFrame,
  type CameraFrameSource,
  ObjectGrounder,
  type SurfaceRaycaster,
  type VisionLocator,
} from '../../src/domain/world/grounding';
import { ObjectRegistry } from '../../src/domain/world/object-registry';
import { PoseHistory } from '../../src/domain/world/pose-history';
import { Workspace } from '../../src/domain/world/workspace';

const procedure = parseProcedure({
  schema: 'clio.procedure/1',
  id: 'p',
  version: 1,
  title: 'P',
  summary: 'S',
  workspace: { size: [1, 1] },
  objects: [
    { id: 'cup', label: 'cup', placement: { method: 'detect' }, tracking: { query: 'paper cup' } },
    { id: 'jug', label: 'jug', placement: { method: 'detect' } },
  ],
  steps: [{ id: 's', instruction: 'Wait.', success: { type: 'elapsed', ms: 10 } }],
});

type LocateObject = LocateRequest['objects'][number];

const model: CameraModel = {
  intrinsics: { width: 1280, height: 720, fx: 800, fy: 800, cx: 640, cy: 360 },
  headFromCamera: { p: [0, 0, 0], q: [0, 0, 0, 1] },
};

function setup(
  detections: Detection[],
  camera: Partial<CameraFrameSource> = {},
  surface?: SurfaceRaycaster,
) {
  const bus = new Emitter<AppEvents>();
  const registry = new ObjectRegistry(bus);
  registry.load(procedure.objects, 0);
  const history = new PoseHistory(16);
  history.push(90, { p: [0, 0.3, 0], q: [0, 0, 0, 1] });
  history.push(110, { p: [0, 0.3, 0], q: [0, 0, 0, 1] });
  const frame: CameraFrame = { t: 100, width: 1280, height: 720, jpegBase64: 'AAAA' };
  const queries: string[] = [];
  const asked: LocateObject[] = [];
  const source: CameraFrameSource = {
    model: () => model,
    capture: async () => frame,
    ...camera,
  };
  const locator: VisionLocator = {
    locate: async (_f, objects) => {
      queries.push(...objects.map((o) => `${o.id}=${o.query}`));
      asked.push(...objects);
      return { detections, model: 'finder-x' };
    },
  };
  const missing: string[][] = [];
  bus.on('object.missing', (e) => missing.push(e.objectIds));
  const grounder = new ObjectGrounder({
    camera: source,
    locator,
    registry,
    poses: history,
    workspace: () => new Workspace({ p: [0, 0, 0], q: [0, 0, 0, 1] }),
    ...(surface ? { surface } : {}),
  });
  return { grounder, registry, queries, asked, missing };
}

const cupSeen: Detection = {
  id: 'cup',
  found: true,
  point: [0.5, 560 / 720],
  box: [0.45, 0.7, 0.55, 600 / 720],
  outline: null,
  confidence: 0.9,
};

describe('ObjectGrounder', () => {
  it('asks the locator with each object query, falling back to its label', async () => {
    const { grounder, queries } = setup([]);
    await grounder.ground([{ id: 'cup' }, { id: 'jug' }]);
    expect(queries).toEqual(['cup=paper cup', 'jug=jug']);
  });

  it("asks in this moment's words when given, with a short phrase, once per object", async () => {
    const { grounder, asked } = setup([]);
    await grounder.ground([
      { id: 'cup', description: 'White paper cup on the left, lid off', phrase: 'paper cup' },
      { id: 'jug' },
      { id: 'cup' },
      { id: 'ghost' },
    ]);
    expect(asked).toEqual([
      { id: 'cup', query: 'White paper cup on the left, lid off', phrase: 'paper cup' },
      { id: 'jug', query: 'jug', phrase: 'jug' },
    ]);
  });

  it('places found objects in the workspace from the head pose at capture time', async () => {
    const { grounder, registry } = setup([cupSeen]);
    const result = await grounder.ground([{ id: 'cup' }]);
    expect(result).toMatchObject({ ok: true, located: ['cup'], missing: [] });
    const cup = registry.get('cup');
    expect(cup?.source).toBe('detector');
    expect(cup?.position[1]).toBeCloseTo(0.05);
    expect(cup?.position[2]).toBeCloseTo(-1);
  });

  it('reports every sighting: the words, the 2D answer, the 3D position, who answered and when', async () => {
    const { grounder } = setup([cupSeen]);
    const result = await grounder.ground([{ id: 'cup', description: 'paper cup', phrase: 'cup' }]);
    if (!result.ok) throw new Error(result.reason);
    expect(result.source).toBe('finder-x');
    expect(result.frameT).toBe(100);
    const [sighting] = result.sightings;
    expect(sighting).toMatchObject({
      id: 'cup',
      description: 'paper cup',
      phrase: 'cup',
      detection: cupSeen,
    });
    expect(sighting?.position?.[1]).toBeCloseTo(0.05);
    expect(sighting?.position?.[2]).toBeCloseTo(-1);
  });

  it('lifts a contour around the object, and brackets the box when there is no contour', async () => {
    const contour: [number, number][] = [
      [0.45, 0.7],
      [0.55, 0.7],
      [0.56, 0.8],
      [0.5, 600 / 720],
      [0.44, 0.8],
    ];
    const withContour = setup([{ ...cupSeen, outline: contour }]);
    const traced = await withContour.grounder.ground([{ id: 'cup' }]);
    const outline = traced.ok ? traced.sightings[0]?.outline : null;
    expect(outline?.shape).toBe('contour');
    expect(outline?.points).toHaveLength(5);
    // The cup is 1 m away: 0.1 of a 1280 px image at f = 800 px is 16 cm across.
    const xs = outline?.points.map((p) => p[0]) ?? [];
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.12 * 1.6, 2);

    const boxOnly = setup([cupSeen]);
    const boxed = await boxOnly.grounder.ground([{ id: 'cup' }]);
    expect(boxed.ok && boxed.sightings[0]?.outline?.shape).toBe('box');
    expect(boxed.ok && boxed.sightings[0]?.outline?.points).toHaveLength(4);
  });

  it('reports what the camera could not find, leaving the announcing to the lesson', async () => {
    const { grounder, missing } = setup([
      cupSeen,
      { id: 'jug', found: false, point: null, box: null, outline: null, confidence: 0 },
    ]);
    const result = await grounder.ground([{ id: 'cup' }, { id: 'jug' }]);
    expect(result).toMatchObject({ ok: true, located: ['cup'], missing: ['jug'] });
    const jug = result.ok ? result.sightings[1] : null;
    expect(jug).toMatchObject({ id: 'jug', position: null, outline: null });
    expect(missing).toEqual([]);
  });

  it('does not place an object the finder is unsure about', async () => {
    const { grounder, registry } = setup([{ ...cupSeen, confidence: 0.2 }]);
    const result = await grounder.ground([{ id: 'cup' }]);
    expect(result).toMatchObject({ ok: true, located: [], missing: ['cup'] });
    expect(registry.get('cup')).toBeUndefined();
  });

  it('places an answer about a frame captured earlier (a closer look) with its head pose', () => {
    const { grounder, registry } = setup([]);
    const frame: CameraFrame = { t: 100, width: 1280, height: 720, jpegBase64: 'AAAA' };
    const objects = [{ id: 'cup', query: 'Which cup is empty?', phrase: 'cup' }];
    const result = grounder.place(frame, objects, { detections: [cupSeen], model: 'er-2' });
    expect(result).toMatchObject({ ok: true, located: ['cup'], source: 'er-2', frameT: 100 });
    expect(registry.get('cup')?.position[2]).toBeCloseTo(-1);
  });

  it('says so when there is no camera, instead of guessing', async () => {
    const { grounder } = setup([cupSeen], { capture: async () => null });
    expect(await grounder.ground([{ id: 'cup' }])).toEqual({
      ok: false,
      reason: 'no-camera-frame',
    });
  });

  it('lifts onto a detected real surface when one is available', async () => {
    // A detected table top 10 cm below the camera ray's workspace-plane hit: the cup's base lands on it.
    const surface: SurfaceRaycaster = {
      cast: (ray) => {
        const s = (-0.1 - ray.origin[1]) / ray.direction[1];
        return s > 0
          ? [ray.origin[0] + ray.direction[0] * s, -0.1, ray.origin[2] + ray.direction[2] * s]
          : null;
      },
    };
    const { grounder, registry } = setup([cupSeen], {}, surface);
    await grounder.ground([{ id: 'cup' }]);
    // Base ray (0, -0.3, -1) meets y = -0.1 at z = -4/3; the center ray (0, -0.25, -1) passes above
    // that base at y = 0.3 - 0.25 * 4/3.
    const cup = registry.get('cup');
    expect(cup?.position[2]).toBeCloseTo(-4 / 3);
    expect(cup?.position[1]).toBeCloseTo(0.3 - 0.25 * (4 / 3));
  });
});
