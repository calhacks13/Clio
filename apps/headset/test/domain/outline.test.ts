import { describe, expect, it } from 'vitest';
import {
  composePose,
  dot,
  madd,
  normalize,
  type Pose,
  quatFromAxisAngle,
  quatMultiply,
  sub,
  type Vec3,
} from '../../src/core/math';
import { type CameraModel, pixelRay } from '../../src/domain/world/camera-model';
import { billboard, boxPolygon, liftOutline, outlinePoint } from '../../src/domain/world/outline';

const near = (a: readonly number[] | null | undefined, b: readonly number[], eps = 1e-6) =>
  !!a && a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] ?? Number.NaN)) < eps);

// A square sensor with f = 1000 px: pixel (u, v) looks along (u - 0.5, 0.5 - v, -1).
const model: CameraModel = {
  intrinsics: { width: 1000, height: 1000, fx: 1000, fy: 1000, cx: 500, cy: 500 },
  headFromCamera: { p: [0, 0, 0], q: [0, 0, 0, 1] },
};
const ahead: Pose = { p: [0, 0, 0], q: [0, 0, 0, 1] };

describe('billboard', () => {
  it('faces the eye and stays upright', () => {
    const plane = billboard([0, 0, -1], [0, 0, 0]);
    expect(plane).not.toBeNull();
    expect(near(plane?.normal, [0, 0, 1])).toBe(true);
    expect(near(plane?.right, [1, 0, 0])).toBe(true);
    expect(near(plane?.up, [0, 1, 0])).toBe(true);
  });

  it('tilts toward an eye above the object, keeping its right edge level', () => {
    const plane = billboard([0, 0, -1], [0, 1, 0]);
    expect(near(plane?.normal, normalize([0, 1, 1]))).toBe(true);
    expect(plane?.right[1]).toBeCloseTo(0);
    expect(plane?.up[1]).toBeGreaterThan(0);
  });

  it('still has a basis when the eye is straight above', () => {
    const plane = billboard([0, 0, 0], [0, 1, 0]);
    expect(near(plane?.normal, [0, 1, 0])).toBe(true);
    expect(near(plane?.right, [1, 0, 0])).toBe(true);
  });

  it('has none when the eye is at the object', () => {
    expect(billboard([0, 0, 0], [0, 0, 0])).toBeNull();
  });
});

describe('boxPolygon', () => {
  it('walks the corners of [x0, y0, x1, y1]', () => {
    expect(boxPolygon([0.25, 0.5, 0.75, 1])).toEqual([
      [0.25, 0.5],
      [0.75, 0.5],
      [0.75, 1],
      [0.25, 1],
    ]);
  });
});

describe('liftOutline', () => {
  it('measures the outline in meters on the plane through the object, facing the camera', () => {
    // 1 m ahead, 0.1 of the image is 10 cm. Image y runs down, outline y runs up.
    const points = liftOutline(
      [
        [0.4, 0.4],
        [0.6, 0.4],
        [0.6, 0.6],
      ],
      model,
      ahead,
      [0, 0, -1],
    );
    expect(points).toHaveLength(3);
    expect(near(points?.[0], [-0.1, 0.1])).toBe(true);
    expect(near(points?.[1], [0.1, 0.1])).toBe(true);
    expect(near(points?.[2], [0.1, -0.1])).toBe(true);
  });

  it('puts every vertex on its pixel ray, from any head pose and camera offset', () => {
    const turned = quatMultiply(
      quatFromAxisAngle([0, 1, 0], Math.PI / 6),
      quatFromAxisAngle([1, 0, 0], -Math.PI / 9),
    );
    const head: Pose = { p: [0.2, 1.5, 0.1], q: turned };
    const offset: CameraModel = {
      ...model,
      headFromCamera: { p: [0.03, -0.02, -0.05], q: [0, 0, 0, 1] },
    };
    const toObject = pixelRay(offset, [0.55, 0.6], head);
    const center: Vec3 = madd(toObject.origin, toObject.direction, 0.9);
    const polygon: [number, number][] = [
      [0.5, 0.55],
      [0.62, 0.57],
      [0.6, 0.68],
      [0.49, 0.66],
    ];
    const points = liftOutline(polygon, offset, head, center);
    expect(points).toHaveLength(4);
    const eye = composePose(head, offset.headFromCamera).p;
    const plane = billboard(center, eye);
    if (!points || !plane) throw new Error('expected an outline');
    for (const [i, uv] of polygon.entries()) {
      const vertex = outlinePoint(plane, center, points[i] as [number, number]);
      const ray = pixelRay(offset, uv, head);
      expect(dot(normalize(sub(vertex, ray.origin)), ray.direction)).toBeCloseTo(1, 9);
    }
  });

  it('gives up on an object behind the camera', () => {
    expect(
      liftOutline(
        [
          [0.4, 0.4],
          [0.6, 0.4],
          [0.5, 0.6],
        ],
        model,
        ahead,
        [0, 0, 1],
      ),
    ).toBeNull();
  });
});
