import { describe, expect, it } from 'vitest';
import type { DepthHit, DepthSource } from '../../src/adapters/xr/depth';
import {
  add,
  composePose,
  dot,
  invertPose,
  madd,
  type Pose,
  quatFromAxisAngle,
  sub,
  transformPoint,
  type Vec3,
} from '../../src/core/math';
import { type CameraModel, intersectPlaneY, type Ray } from '../../src/domain/world/camera-model';
import { billboard, outlinePoint } from '../../src/domain/world/outline';
import {
  maskRays,
  measureDepth,
  type ObjectMask,
  placeDetection,
  placeOutline,
  surfaceOrTable,
  surfaceRays,
} from '../../src/domain/world/placement';

// A Quest 3-like rig: the passthrough camera sits in front of the right eye (3.2 cm right, 2 cm
// down, 6 cm forward of the head) and looks 15° down; the eyes are 6.3 cm apart at the head. An
// outline on the camera's rays matches the object for every eye only at the object's distance.

const DEG = Math.PI / 180;
const intrinsics = { width: 1280, height: 960, fx: 800, fy: 800, cx: 640, cy: 480 };
const model: CameraModel = {
  intrinsics,
  headFromCamera: { p: [0.032, -0.02, -0.06], q: quatFromAxisAngle([1, 0, 0], -15 * DEG) },
};
/** Seated, 1.25 m eyes; the table is at 0.72 m, so the "45 cm below the head" guess is 8 cm high. */
const head: Pose = { p: [0, 1.25, 0], q: quatFromAxisAngle([1, 0, 0], -20 * DEG) };
const TABLE_Y = 0.72;
const camera = composePose(head, model.headFromCamera);
const eyes = {
  left: composePose(head, { p: [-0.0315, 0, 0], q: [0, 0, 0, 1] }),
  right: composePose(head, { p: [0.0315, 0, 0], q: [0, 0, 0, 1] }),
};

/** Where a world point appears to a pinhole at `pose` with the test intrinsics, in pixels. */
function pixel(pose: Pose, p: Readonly<Vec3>): [number, number] {
  const [x, y, z] = transformPoint(invertPose(pose), p);
  return [intrinsics.cx + (intrinsics.fx * x) / -z, intrinsics.cy - (intrinsics.fy * y) / -z];
}

/** Normalized image coordinates in a passthrough camera at `from`. */
function uvFrom(from: Pose, p: Readonly<Vec3>): [number, number] {
  const [px, py] = pixel(from, p);
  return [px / intrinsics.width, py / intrinsics.height];
}

/** Normalized image coordinates in the passthrough camera. */
const uv = (p: Readonly<Vec3>): [number, number] => uvFrom(camera, p);

/** Worst pixel distance between where two point sets appear to `pose`. */
function worstPx(pose: Pose, a: readonly Vec3[], b: readonly Vec3[]): number {
  return Math.max(
    ...a.map((p, i) => {
      const [ax, ay] = pixel(pose, p);
      const [bx, by] = pixel(pose, b[i] ?? [0, 0, 0]);
      return Math.hypot(ax - bx, ay - by);
    }),
  );
}

function near(actual: readonly number[] | undefined, expected: readonly number[], digits = 6) {
  expect(actual).toHaveLength(expected.length);
  for (const [i, v] of expected.entries()) expect(actual?.[i]).toBeCloseTo(v, digits);
}

describe('placeOutline: stereo', () => {
  // A flat card facing the camera 55 cm away: placed at its true depth, the outline IS the card.
  const center: Vec3 = add(camera.p, [0.04, -0.3, -0.46]);
  const plane = billboard(center, camera.p);
  if (!plane) throw new Error('no plane');
  const card: Vec3[] = (
    [
      [-0.05, -0.07],
      [0.05, -0.07],
      [0.06, 0.02],
      [0, 0.08],
      [-0.06, 0.02],
    ] as const
  ).map(([x, y]) => outlinePoint(plane, center, [x, y]));
  const mask: ObjectMask = { point: uv(center), box: null, outline: card.map(uv) };

  it('lines up with the object for both eyes at the true depth', () => {
    const placed = placeOutline(mask, head, model, { center, kind: 'contact' });
    if (!placed) throw new Error('not placed');
    expect(worstPx(eyes.left, placed.points, card)).toBeLessThan(0.01);
    expect(worstPx(eyes.right, placed.points, card)).toBeLessThan(0.01);
    expect(placed.outline.shape).toBe('contour');
    expect(placed.depth).toBe('contact');
  });

  it('lines up only from the camera at a wrong depth (the reported bug)', () => {
    const tooFar = madd(camera.p, sub(center, camera.p), 1.3);
    const placed = placeOutline(mask, head, model, { center: tooFar, kind: 'surface' });
    if (!placed) throw new Error('not placed');
    expect(worstPx(camera, placed.points, card)).toBeLessThan(0.01);
    expect(worstPx(eyes.right, placed.points, card)).toBeLessThan(5);
    expect(worstPx(eyes.left, placed.points, card)).toBeGreaterThan(10);
  });

  it('puts the label anchor at the top center of the outline', () => {
    const placed = placeOutline(mask, head, model, { center, kind: 'contact' });
    if (!placed) throw new Error('not placed');
    near(placed.label, outlinePoint(plane, center, [0, 0.08]));
  });
});

describe('maskRays', () => {
  it('starts at the camera (head pose, then the camera offset) and follows the intrinsics', () => {
    const rays = maskRays({ point: [0.5, 0.5], box: null, outline: null }, model, head);
    if (!rays) throw new Error('no rays');
    near(rays.point.origin, camera.p);
    // The principal point looks straight down the camera's -z: 35° below level here.
    near(rays.point.direction, [0, -Math.sin(35 * DEG), -Math.cos(35 * DEG)]);
    expect(rays.contact).toBeNull();
  });

  it('measures the contact the mask gives, else the box bottom center', () => {
    const through = (point: [number, number]) =>
      maskRays({ point, box: null, outline: null }, model, head)?.point.direction ?? [];
    const box = [0.4, 0.3, 0.6, 0.7] as const;
    const given = maskRays({ point: null, box, outline: null, contact: [0.45, 0.68] }, model, head);
    const fromBox = maskRays({ point: null, box, outline: null }, model, head);
    near(given?.contact?.direction, through([0.45, 0.68]));
    near(fromBox?.contact?.direction, through([0.5, 0.7]));
    // Without a point, the box center.
    near(fromBox?.point.direction, through([0.5, 0.5]));
  });
});

/**
 * A probe over fixed geometry: the table, and the object as a vertical card facing +z. `sensed`
 * answers as depth sensing does (the depth map), else as hit-test does (the room mesh, which
 * answers nothing asked of the depth map only).
 */
function sceneProbe(
  objects: { min: Vec3; max: Vec3 }[],
  tableY: number | null,
  sensed = false,
): DepthSource {
  const cast = (ray: Ray): DepthHit | null => {
    let best: DepthHit | null = null;
    const consider = (point: Vec3 | null, normal: Vec3) => {
      if (!point) return;
      const distance = dot(sub(point, ray.origin), ray.direction);
      if (distance > 0 && (!best || distance < best.distance - 1e-9)) {
        best = { point, normal, distance, ...(sensed ? { sensed: true } : {}) };
      }
    };
    if (tableY !== null) consider(intersectPlaneY(ray, tableY), [0, 1, 0]);
    for (const { min, max } of objects) {
      const s = (min[2] - ray.origin[2]) / ray.direction[2];
      const p = madd(ray.origin, ray.direction, s);
      const inside = p[0] >= min[0] && p[0] <= max[0] && p[1] >= min[1] && p[1] <= max[1];
      if (s > 0 && inside) consider(p, [0, 0, 1]);
    }
    return best;
  };
  return {
    measure: async (rays, options) =>
      rays.map((ray) => (options?.mapOnly && !sensed ? null : cast(ray))),
  };
}

describe('measureDepth', () => {
  // A 8 x 12 cm card standing on the table 55 cm ahead.
  const base: Vec3 = [0.05, TABLE_Y, -0.55];
  const card = { min: [0.01, TABLE_Y, -0.55] as Vec3, max: [0.09, TABLE_Y + 0.12, -0.55] as Vec3 };
  const middle: Vec3 = [0.05, TABLE_Y + 0.06, -0.55];
  const corners: Vec3[] = [
    [0.01, TABLE_Y, -0.55],
    [0.09, TABLE_Y, -0.55],
    [0.09, TABLE_Y + 0.12, -0.55],
    [0.01, TABLE_Y + 0.12, -0.55],
  ];
  const mask: ObjectMask = {
    point: uv(middle),
    box: null,
    outline: corners.map(uv),
    contact: uv(base),
  };
  const noSurfaces = surfaceOrTable(null, head);

  it('stands the object where the contact ray meets the table', async () => {
    const depth = await measureDepth(mask, model, head, sceneProbe([card], TABLE_Y), noSurfaces);
    expect(depth?.kind).toBe('contact');
    near(depth?.center, middle);
  });

  it('places the outline so both eyes see it on the object', async () => {
    const depth = await measureDepth(mask, model, head, sceneProbe([card], TABLE_Y), noSurfaces);
    const placed = depth && placeOutline(mask, head, model, depth);
    if (!placed) throw new Error('not placed');
    expect(worstPx(eyes.left, [placed.center], [middle])).toBeLessThan(0.01);
    // The outline plane faces the camera, so the card's corners sit a little off it.
    expect(worstPx(eyes.left, placed.points, corners)).toBeLessThan(6);
    expect(worstPx(eyes.right, placed.points, corners)).toBeLessThan(6);
  });

  it('lines the card up end to end with its relief, from the depth map along a grid', async () => {
    // Looked down on, the card's top is nearer than its foot: on one plane its corners are off for
    // the eyes; on the relief fitted to what the depth map sees through the grid, they are not.
    const probe = sceneProbe([card], TABLE_Y, true);
    const grid = surfaceRays(mask, model, head);
    const depth = await measureDepth(mask, model, head, probe, noSurfaces, grid);
    expect(depth?.kind).toBe('contact');
    expect(depth?.samples).toHaveLength(grid.length);
    const relief = depth?.relief;
    if (!depth || !relief) throw new Error('no relief');
    // The top leans toward the camera.
    expect(relief.slopeY).toBeGreaterThan(0.3);
    const flat = placeOutline(mask, head, model, { center: depth.center, kind: depth.kind });
    const placed = placeOutline(mask, head, model, depth);
    if (!flat || !placed) throw new Error('not placed');
    expect(placed.outline.relief?.distance).toBeCloseTo(Math.hypot(...sub(camera.p, middle)), 9);
    near(placed.eye, camera.p);
    expect(worstPx(camera, placed.points, flat.points)).toBeLessThan(0.01);
    for (const eye of [eyes.left, eyes.right]) {
      expect(worstPx(eye, placed.points, corners)).toBeLessThan(
        worstPx(eye, flat.points, corners) / 4,
      );
      expect(worstPx(eye, placed.points, corners)).toBeLessThan(1);
    }
  });

  it('asks for the grid from the depth map only, alongside the rays that place the object', async () => {
    const asked: { rays: number; mapOnly: boolean }[] = [];
    const probe: DepthSource = {
      measure: async (rays, options) => {
        asked.push({ rays: rays.length, mapOnly: options?.mapOnly === true });
        return rays.map(() => null);
      },
    };
    const grid = surfaceRays(mask, model, head);
    await measureDepth(mask, model, head, probe, noSurfaces, grid);
    expect(asked).toEqual([
      { rays: 2, mapOnly: false },
      { rays: grid.length, mapOnly: true },
    ]);
  });

  it('has no relief without a depth map: the room mesh leaves small objects out', async () => {
    const grid = surfaceRays(mask, model, head);
    const probe = sceneProbe([card], TABLE_Y);
    const depth = await measureDepth(mask, model, head, probe, noSurfaces, grid);
    expect(depth?.kind).toBe('contact');
    expect(depth?.relief).toBeUndefined();
    expect(depth?.samples).toEqual([]);
  });

  it('is what the table guess got wrong: off by many pixels for the left eye', () => {
    const placed = placeDetection(mask, model, head, noSurfaces);
    if (!placed) throw new Error('not placed');
    expect(worstPx(camera, [placed.center], [placed.center])).toBe(0);
    expect(worstPx(eyes.left, placed.points, corners)).toBeGreaterThan(12);
  });

  it('uses the point ray when the contact ray hits no surface to stand on', async () => {
    // No table in the scene: the contact ray finds only the card's bottom edge, facing the camera.
    const raised = { ...mask, contact: uv([0.05, TABLE_Y + 0.005, -0.55]) };
    const depth = await measureDepth(raised, model, head, sceneProbe([card], null), noSurfaces);
    expect(depth?.kind).toBe('point');
    near(depth?.center, middle);
  });

  it('passes over a wall behind an object that is not in the scene mesh', async () => {
    // No table in the mesh either: both rays go past the card to the wall. At 3.2 m that is out
    // of reach; at 1.1 m it is still well past where the point's ray meets the table guess.
    for (const z of [-3.2, -1.1]) {
      const wall = { min: [-5, 0, z] as Vec3, max: [5, 3, z] as Vec3 };
      const depth = await measureDepth(mask, model, head, sceneProbe([wall], null), noSurfaces);
      expect(depth?.kind).toBe('surface');
      near(depth?.center, (await measureDepth(mask, model, head, null, noSurfaces))?.center ?? []);
    }
  });

  it('trusts a depth-map hit on an object past the table guess, even far away', async () => {
    // A bottle on a nightstand 2.2 m away, lower than the table guess (45 cm below the head).
    // The depth map sees the bottle itself, so its hit is the bottle, not a wall behind it.
    const bottle = { min: [0, 0.45, -2.2] as Vec3, max: [0.1, 0.65, -2.2] as Vec3 };
    const center: Vec3 = [0.05, 0.55, -2.2];
    const far: ObjectMask = {
      point: uv(center),
      box: null,
      outline: [
        [0, 0.45, -2.2],
        [0.1, 0.45, -2.2],
        [0.1, 0.65, -2.2],
        [0, 0.65, -2.2],
      ].map((p) => uv(p as Vec3)),
      contact: uv([0.05, 0.45, -2.2]),
    };
    const sensed = await measureDepth(
      far,
      model,
      head,
      sceneProbe([bottle], null, true),
      noSurfaces,
    );
    expect(sensed?.kind).toBe('point');
    near(sensed?.center, center);
    // Hit-test's room mesh has no bottle in it: the same far hit is still passed over.
    const meshed = await measureDepth(far, model, head, sceneProbe([bottle], null), noSurfaces);
    expect(meshed?.kind).toBe('surface');
  });

  it('puts a flat object, not in the mesh, where its middle meets the table', async () => {
    // A 16 x 5 cm caliper lying on the table: the lowest image edge is its near edge, and the
    // point's ray reaches the table under its middle.
    const middle: Vec3 = [0.03, TABLE_Y, -0.62];
    const corners: Vec3[] = [
      [-0.05, TABLE_Y, -0.595],
      [0.11, TABLE_Y, -0.595],
      [0.11, TABLE_Y, -0.645],
      [-0.05, TABLE_Y, -0.645],
    ];
    const flat: ObjectMask = {
      point: uv(middle),
      box: null,
      outline: corners.map(uv),
      contact: uv([0.03, TABLE_Y, -0.595]),
    };
    const depth = await measureDepth(flat, model, head, sceneProbe([], TABLE_Y), noSurfaces);
    expect(depth?.kind).toBe('contact');
    near(depth?.center, middle);
    const placed = depth && placeOutline(flat, head, model, depth);
    if (!placed) throw new Error('not placed');
    expect(worstPx(eyes.left, [placed.center], [middle])).toBeLessThan(0.01);
  });

  it('uses the point hit when it is in front of the surface the contact ray reaches', async () => {
    // The card lifted 20 cm: the contact ray passes under it to the table behind.
    const lifted = {
      min: [0.01, TABLE_Y + 0.2, -0.55] as Vec3,
      max: [0.09, TABLE_Y + 0.32, -0.55] as Vec3,
    };
    const held: Vec3 = [0.05, TABLE_Y + 0.26, -0.55];
    const raised: ObjectMask = {
      point: uv(held),
      box: null,
      outline: null,
      contact: uv([0.05, TABLE_Y + 0.19, -0.55]),
    };
    const depth = await measureDepth(
      raised,
      model,
      head,
      sceneProbe([lifted], TABLE_Y),
      noSurfaces,
    );
    expect(depth?.kind).toBe('point');
    near(depth?.center, held);
  });

  it('falls back to detected planes, then the table guess, when hit-test finds nothing', async () => {
    const empty: DepthSource = { measure: async (rays) => rays.map(() => null) };
    const table = { cast: (ray: Ray) => intersectPlaneY(ray, TABLE_Y) };
    const onPlane = await measureDepth(mask, model, head, empty, surfaceOrTable(table, head));
    expect(onPlane?.kind).toBe('surface');
    near(onPlane?.center, middle);
    const guessed = await measureDepth(mask, model, head, null, noSurfaces);
    expect(guessed?.kind).toBe('surface');
    expect(guessed?.center[1]).toBeGreaterThan(middle[1]);
  });

  it('ends at a fixed distance along the point ray when nothing is below it', async () => {
    const level: Pose = { p: [0, 1.25, 0], q: quatFromAxisAngle([1, 0, 0], 40 * DEG) };
    const sky: ObjectMask = { point: [0.5, 0.2], box: [0.4, 0.1, 0.6, 0.3], outline: null };
    const depth = await measureDepth(sky, model, level, null, surfaceOrTable(null, level));
    expect(depth?.kind).toBe('fixed');
    const origin = composePose(level, model.headFromCamera).p;
    expect(Math.hypot(...sub(depth?.center ?? origin, origin))).toBeCloseTo(0.6, 6);
    // placeDetection keeps its old contract: nothing above the horizon.
    expect(placeDetection(sky, model, level, surfaceOrTable(null, level))).toBeNull();
  });

  it('asks the probe for the contact ray first, then the point ray', async () => {
    const asked: Ray[][] = [];
    const probe: DepthSource = {
      measure: async (rays) => {
        asked.push([...rays]);
        return rays.map(() => null);
      },
    };
    await measureDepth(mask, model, head, probe, noSurfaces);
    const rays = maskRays(mask, model, head);
    near(asked[0]?.[0]?.direction, rays?.contact?.direction ?? []);
    near(asked[0]?.[1]?.direction, rays?.point.direction ?? []);
    await measureDepth({ ...mask, contact: null, box: null }, model, head, probe, noSurfaces);
    expect(asked[1]).toHaveLength(1);
  });

  it('returns null for a mask with no geometry', async () => {
    const none: ObjectMask = { point: null, box: null, outline: null };
    expect(await measureDepth(none, model, head, null, noSurfaces)).toBeNull();
  });
});

describe('measureDepth: on the floor', () => {
  // Standing, eyes at 1.65 m and looking 30° down: the camera looks 45° down, at the floor about
  // 1.6 m ahead. The table guess (45 cm below the head) is 1.2 m up, a quarter of the way there.
  const standing: Pose = { p: [0, 1.65, 0], q: quatFromAxisAngle([1, 0, 0], -30 * DEG) };
  const lens = composePose(standing, model.headFromCamera);
  // A 10 x 4 cm case on the carpet 1.5 m ahead, its front a card facing the learner.
  const redCase = { min: [0, 0, -1.5] as Vec3, max: [0.1, 0.04, -1.5] as Vec3 };
  const middle: Vec3 = [0.05, 0.02, -1.5];
  const caseMask: ObjectMask = {
    point: uvFrom(lens, middle),
    box: null,
    outline: [
      [0, 0, -1.5],
      [0.1, 0, -1.5],
      [0.1, 0.04, -1.5],
      [0, 0.04, -1.5],
    ].map((p) => uvFrom(lens, p as Vec3)),
    contact: uvFrom(lens, [0.05, 0, -1.5]),
  };
  const noSurfaces = surfaceOrTable(null, standing);
  const floorPlane = { cast: (ray: Ray) => intersectPlaneY(ray, 0) };

  it('stands an object on the floor where the depth map sees the floor under it', async () => {
    const probe = sceneProbe([redCase], 0, true);
    const depth = await measureDepth(caseMask, model, standing, probe, noSurfaces);
    expect(depth?.kind).toBe('contact');
    near(depth?.center, middle);
  });

  it("stands it on the room mesh's floor when there is no depth map", async () => {
    const probe = sceneProbe([redCase], 0);
    const depth = await measureDepth(caseMask, model, standing, probe, noSurfaces);
    expect(depth?.kind).toBe('contact');
    near(depth?.center, middle);
  });

  it('puts papers lying on the carpet where the floor is under their middle', async () => {
    const papers: Vec3 = [-0.1, 0, -1.7];
    const flat: ObjectMask = {
      point: uvFrom(lens, papers),
      box: null,
      outline: [
        [-0.2, 0, -1.6],
        [0, 0, -1.6],
        [0, 0, -1.8],
        [-0.2, 0, -1.8],
      ].map((p) => uvFrom(lens, p as Vec3)),
      contact: uvFrom(lens, [-0.1, 0, -1.6]),
    };
    const depth = await measureDepth(flat, model, standing, sceneProbe([], 0, true), noSurfaces);
    expect(depth?.kind).toBe('contact');
    near(depth?.center, papers);
  });

  it("falls back to the room scan's floor plane when nothing measures the rays", async () => {
    const empty: DepthSource = { measure: async (rays) => rays.map(() => null) };
    const depth = await measureDepth(
      caseMask,
      model,
      standing,
      empty,
      surfaceOrTable(floorPlane, standing),
    );
    expect(depth?.kind).toBe('surface');
    near(depth?.center, middle);
  });

  it('guesses the table only without a room scan, far short of the case', async () => {
    const depth = await measureDepth(caseMask, model, standing, null, noSurfaces);
    expect(depth?.kind).toBe('surface');
    // The contact ray meets the guessed table at 1.2 m; the case's middle stands above that.
    expect(depth?.center[1]).toBeGreaterThan(1.2);
    const reach = (p: Readonly<Vec3>) => Math.hypot(...sub(p, lens.p));
    expect(reach(depth?.center ?? lens.p)).toBeLessThan(reach(middle) / 2);
  });
});
