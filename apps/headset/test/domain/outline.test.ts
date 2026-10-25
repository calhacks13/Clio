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
import {
  billboard,
  boxPolygon,
  fitRelief,
  liftOutline,
  outlinePoint,
  RELIEF_MAX_SCALE,
  type Relief,
  reliefPoint,
} from '../../src/domain/world/outline';

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

describe('reliefPoint', () => {
  // The camera 0.5 m in front of the outline's center; the object's top leans toward it.
  const relief: Relief = { offset: 0.01, slopeX: 0.2, slopeY: 0.8, distance: 0.5 };
  const camera: Vec3 = [0, 0, 0.5];

  it('is the outline point itself without a relief', () => {
    expect(reliefPoint(undefined, [0.03, -0.02])).toEqual([0.03, -0.02, 0]);
    expect(reliefPoint({ ...relief, distance: 0 }, [0.03, -0.02])).toEqual([0.03, -0.02, 0]);
  });

  it('is where the camera ray through the outline point meets the relief', () => {
    for (const p of [
      [0.03, -0.02],
      [-0.04, 0.06],
      [0, 0],
    ] as [number, number][]) {
      const [x, y, z] = reliefPoint(relief, p);
      // On the relief...
      expect(z).toBeCloseTo(relief.offset + relief.slopeX * x + relief.slopeY * y, 9);
      // ...and on the ray from the camera through (x, y, 0).
      const along = normalize(sub([x, y, z], camera));
      expect(dot(along, normalize(sub([...p, 0], camera)))).toBeCloseTo(1, 9);
    }
  });

  it('never goes behind the camera, nor more than twice as far', () => {
    // So steep that the ray past the top runs parallel to it.
    const steep: Relief = { offset: 0, slopeX: 0, slopeY: -10, distance: 0.5 };
    const [x, y, z] = reliefPoint(steep, [0, 0.1]);
    expect(z).toBeCloseTo(0.5 * (1 - RELIEF_MAX_SCALE), 9);
    expect([x, y]).toEqual([0, 0.1 * RELIEF_MAX_SCALE]);
  });
});

describe('fitRelief', () => {
  // The camera at the origin, the object 0.5 m ahead: the outline's frame is the world's, shifted.
  const center: Vec3 = [0, 0, -0.5];
  const eye: Vec3 = [0, 0, 0];
  /** A 2 x 12 cm tube looked down on, its top leaning 0.8 m per m toward the camera. */
  const tube = (lean = 0.8, offset = 0.01): Vec3[] => {
    const out: Vec3[] = [];
    for (let i = 0; i < 9; i++) {
      for (const x of [-0.01, 0, 0.01]) {
        const y = -0.06 + i * 0.015;
        out.push([x, y, -0.5 + offset + lean * y]);
      }
    }
    return out;
  };

  it('finds the lean of a long object from its surface, damped a little', () => {
    const relief = fitRelief(tube(), center, eye);
    if (!relief) throw new Error('no relief');
    expect(relief.distance).toBeCloseTo(0.5, 9);
    expect(relief.offset).toBeCloseTo(0.01, 3);
    expect(relief.slopeY).toBeGreaterThan(0.75);
    expect(relief.slopeY).toBeLessThanOrEqual(0.8);
    expect(Math.abs(relief.slopeX)).toBeLessThan(1e-9);
  });

  it('leaves out the room behind the object and a few stray reads', () => {
    const samples = tube();
    // The wall 1 m behind through some of the rays, and two reads 4 cm off the tube.
    samples.push([0.01, 0.02, -1.5], [-0.01, -0.03, -1.5], [0, 0.05, -1.5]);
    samples[4] = [0, -0.045, -0.5 + 0.01 + 0.8 * -0.045 + 0.04];
    samples[20] = [0, 0.03, -0.5 + 0.01 + 0.8 * 0.03 - 0.04];
    const clean = fitRelief(tube(), center, eye);
    const relief = fitRelief(samples, center, eye);
    expect(relief?.slopeY).toBeCloseTo(clean?.slopeY ?? 0, 2);
    expect(relief?.offset).toBeCloseTo(clean?.offset ?? 0, 3);
  });

  it('does not read a tilt across a thin object out of its noise', () => {
    // A pen seen side on: a millimetre wide, its reads a few millimetres apart in depth.
    const noise = [0.004, -0.003, 0.002, -0.004, 0.003, -0.002, 0.004, -0.003];
    const pen: Vec3[] = noise.map((n, i) => [i % 2 ? 0.0005 : -0.0005, -0.04 + i * 0.01, -0.5 + n]);
    const relief = fitRelief(pen, center, eye);
    expect(Math.abs(relief?.slopeX ?? 1)).toBeLessThan(0.1);
  });

  it('caps a relief steeper than a surface it could draw', () => {
    const relief = fitRelief(tube(6, 0), center, eye);
    expect(Math.hypot(relief?.slopeX ?? 0, relief?.slopeY ?? 0)).toBeCloseTo(2.5, 9);
  });

  it('needs a handful of samples on the object', () => {
    expect(fitRelief(tube().slice(0, 5), center, eye)).toBeNull();
    expect(
      fitRelief(
        tube().map(([x, y, z]): Vec3 => [x, y, z - 1]),
        center,
        eye,
      ),
    ).toBeNull();
    expect(fitRelief(tube(), center, center)).toBeNull();
  });
});
