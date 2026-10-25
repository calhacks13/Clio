import { describe, expect, it } from 'vitest';
import {
  composePose,
  dot,
  madd,
  type Pose,
  quatFromAxisAngle,
  rotateVec,
  sub,
  type Vec3,
} from '../../src/core/math';
import { type CameraModel, intersectPlaneY } from '../../src/domain/world/camera-model';
import { billboard, outlinePoint } from '../../src/domain/world/outline';
import {
  type ObjectMask,
  placeDetection,
  surfaceOrTable,
  surfaceRays,
} from '../../src/domain/world/placement';

// A level camera at the head, 1.2 m above the floor: 1280 x 960, f = 800 px. The default table
// plane is 45 cm below the head (y = 0.75). A ray through image row y meets it where
// (y * 960 - 480) / 800 * depth = 0.45, so the box bottom at row 0.8125 lands 1.2 m ahead.

const model: CameraModel = {
  intrinsics: { width: 1280, height: 960, fx: 800, fy: 800, cx: 640, cy: 480 },
  headFromCamera: { p: [0, 0, 0], q: [0, 0, 0, 1] },
};
const head: Pose = { p: [0, 1.2, 0], q: [0, 0, 0, 1] };
const box = [0.4, 0.5, 0.6, 0.8125] as const;
const contour: [number, number][] = [
  [0.4, 0.55],
  [0.5, 0.5],
  [0.6, 0.55],
  [0.6, 0.8125],
  [0.4, 0.8125],
];

/** Where a world point appears in the camera image, normalized. */
function project(p: Readonly<Vec3>, worldFromHead: Pose): [number, number] {
  const camera = composePose(worldFromHead, model.headFromCamera);
  const inverse: Pose['q'] = [-camera.q[0], -camera.q[1], -camera.q[2], camera.q[3]];
  const [x, y, z] = rotateVec(inverse, sub(p, camera.p));
  const { width, height, fx, fy, cx, cy } = model.intrinsics;
  return [(cx + (fx * x) / -z) / width, (cy - (fy * y) / -z) / height];
}

function near(actual: readonly number[] | undefined, expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  for (const [i, v] of expected.entries()) expect(actual?.[i]).toBeCloseTo(v, 6);
}

describe('placeDetection', () => {
  it('stands the object on the table plane below the head when no real surface is known', () => {
    const placed = placeDetection(
      { point: [0.5, 0.65], box: [...box], outline: null },
      model,
      head,
      surfaceOrTable(null, head),
    );
    // Base 1.2 m ahead on y = 0.75; the point's ray passes 0.216 m below the eye there.
    near(placed?.center, [0, 1.2 - 0.216, -1.2]);
    expect(placed?.outline.shape).toBe('box');
  });

  it('prefers a real surface the box bottom meets', () => {
    const counter = {
      cast: (ray: Parameters<typeof intersectPlaneY>[0]) => intersectPlaneY(ray, 0.9),
    };
    const placed = placeDetection(
      { point: null, box: [...box], outline: null },
      model,
      head,
      surfaceOrTable(counter, head),
    );
    // 0.3 m below the eye at a slope of 0.375: 0.8 m ahead. Without a point, the object stands
    // there up to the box's middle (slope 0.1875).
    near(placed?.center, [0, 1.05, -0.8]);
  });

  it('falls back to the table plane when the surfaces miss', () => {
    const placed = placeDetection(
      { point: null, box: [...box], outline: null },
      model,
      head,
      surfaceOrTable({ cast: () => null }, head),
    );
    near(placed?.center, [0, 1.2 - 0.225, -1.2]);
  });

  it('stands the object on the floor when the floor is the surface the box bottom meets', () => {
    const floor = {
      cast: (ray: Parameters<typeof intersectPlaneY>[0]) => intersectPlaneY(ray, 0),
    };
    const placed = placeDetection(
      { point: null, box: [...box], outline: null },
      model,
      head,
      surfaceOrTable(floor, head),
    );
    // 1.2 m below the eye at a slope of 0.375: 3.2 m ahead, up to the box's middle (slope 0.1875).
    near(placed?.center, [0, 1.2 - 0.6, -3.2]);
  });

  it('lays the contour on a plane through the object, where the camera saw it', () => {
    const placed = placeDetection(
      { point: [0.5, 0.65], box: [...box], outline: contour },
      model,
      head,
      surfaceOrTable(null, head),
    );
    if (!placed) throw new Error('not placed');
    expect(placed.outline.shape).toBe('contour');
    const plane = billboard(placed.center, head.p);
    if (!plane) throw new Error('no plane');
    // The plane faces the camera...
    const toCamera = sub(head.p, placed.center);
    expect(dot(plane.normal, toCamera)).toBeCloseTo(Math.hypot(...toCamera), 6);
    // ...and every vertex projects back onto the contour.
    placed.outline.points.forEach((p, i) => {
      near(
        project(outlinePoint(plane, placed.center, p), head),
        contour[i] ?? [Number.NaN, Number.NaN],
      );
    });
    // 20% of a 1280 px frame at f = 800 is 0.32 m per meter of depth: the plane is 1.22 m away.
    const xs = placed.outline.points.map(([x]) => x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.39, 2);
  });

  it('uses the head pose of the frame', () => {
    const turned: Pose = { p: [0, 1.2, 0], q: quatFromAxisAngle([0, 1, 0], Math.PI / 2) };
    const placed = placeDetection(
      { point: [0.5, 0.65], box: [...box], outline: null },
      model,
      turned,
      surfaceOrTable(null, turned),
    );
    // Turned left a quarter: what was 1.2 m ahead is now 1.2 m to the left (-x).
    near(placed?.center, [-1.2, 0.984, 0]);
  });

  it('places nothing above the horizon', () => {
    const sky = placeDetection(
      { point: [0.5, 0.2], box: [0.4, 0.1, 0.6, 0.3], outline: null },
      model,
      head,
      surfaceOrTable(null, head),
    );
    expect(sky).toBeNull();
  });
});

describe('surfaceRays', () => {
  const triangle: [number, number][] = [
    [0.4, 0.8],
    [0.6, 0.8],
    [0.5, 0.5],
  ];
  const mask = (over: Partial<ObjectMask>): ObjectMask => ({
    point: null,
    box: [0.4, 0.5, 0.6, 0.8],
    outline: triangle,
    ...over,
  });
  /** The image point a ray passes through. */
  const imagePoint = (ray: { origin: Vec3; direction: Vec3 }) =>
    project(madd(ray.origin, ray.direction, 1), head);
  /** Strictly inside the triangle: on the inner side of each edge. */
  function insideTriangle([x, y]: readonly [number, number]): boolean {
    const side = (a: [number, number], b: [number, number]) =>
      (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    const [a, b, c] = triangle as [[number, number], [number, number], [number, number]];
    const sides = [side(a, b), side(b, c), side(c, a)];
    return sides.every((s) => s > 1e-9) || sides.every((s) => s < -1e-9);
  }

  it('casts at most 24 rays from the camera, each through a point inside the outline', () => {
    const rays = surfaceRays(mask({}), model, head);
    // A grid over the outline's bounds keeps only the cells inside the triangle.
    expect(rays.length).toBeGreaterThanOrEqual(8);
    expect(rays.length).toBeLessThanOrEqual(24);
    for (const ray of rays) {
      near(ray.origin, head.p);
      expect(insideTriangle(imagePoint(ray))).toBe(true);
    }
    // Not all through one point: spread across the outline.
    const us = rays.map((ray) => imagePoint(ray)[0]);
    expect(Math.max(...us) - Math.min(...us)).toBeGreaterThan(0.1);
  });

  it('fills the box when there is no outline, up to the limit', () => {
    const rays = surfaceRays(mask({ outline: null }), model, head);
    expect(rays).toHaveLength(24);
    for (const ray of rays) {
      const [u, v] = imagePoint(ray);
      expect(u).toBeGreaterThan(0.4);
      expect(u).toBeLessThan(0.6);
      expect(v).toBeGreaterThan(0.5);
      expect(v).toBeLessThan(0.8);
    }
    expect(surfaceRays(mask({ outline: null }), model, head, 4)).toHaveLength(4);
    // An outline too short to be a polygon counts as none.
    expect(surfaceRays(mask({ outline: [[0.5, 0.6]] }), model, head)).toHaveLength(24);
  });

  it('casts none without an outline or a box', () => {
    expect(surfaceRays(mask({ outline: null, box: null, point: [0.5, 0.6] }), model, head)).toEqual(
      [],
    );
  });
});
