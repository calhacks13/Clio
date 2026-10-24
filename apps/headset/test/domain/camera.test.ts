import { describe, expect, it } from 'vitest';
import type { Pose } from '../../src/core/math';
import {
  type CameraModel,
  intersectPlaneY,
  liftDetection,
  pixelRay,
} from '../../src/domain/world/camera-model';
import { PoseHistory } from '../../src/domain/world/pose-history';

const near = (a: readonly number[] | null | undefined, b: readonly number[], eps = 1e-4) =>
  !!a && a.every((v, i) => Math.abs(v - (b[i] ?? Number.NaN)) < eps);

const model: CameraModel = {
  intrinsics: { width: 1280, height: 720, fx: 800, fy: 800, cx: 640, cy: 360 },
  headFromCamera: { p: [0, 0, 0], q: [0, 0, 0, 1] },
};
const head: Pose = { p: [0, 0.3, 0], q: [0, 0, 0, 1] };

describe('camera model', () => {
  it('casts the image center straight ahead', () => {
    const ray = pixelRay(model, [0.5, 0.5], head);
    expect(near(ray.origin, [0, 0.3, 0])).toBe(true);
    expect(near(ray.direction, [0, 0, -1])).toBe(true);
  });

  it('casts the right edge outward by atan((w - cx) / fx)', () => {
    // (1280 - 640) / 800 = 0.8 → normalize(0.8, 0, -1)
    const ray = pixelRay(model, [1, 0.5], head);
    expect(near(ray.direction, [0.624695, 0, -0.780869])).toBe(true);
  });

  it('applies the camera offset in the head frame', () => {
    const shifted: CameraModel = {
      ...model,
      headFromCamera: { p: [0.03, 0.02, -0.05], q: [0, 0, 0, 1] },
    };
    expect(near(pixelRay(shifted, [0.5, 0.5], head).origin, [0.03, 0.32, -0.05])).toBe(true);
  });

  it('intersects a ray with a horizontal plane, and misses planes behind or parallel', () => {
    expect(
      near(intersectPlaneY({ origin: [0, 0.3, 0], direction: [0, -0.3, -1] }, 0), [0, 0, -1]),
    ).toBe(true);
    expect(intersectPlaneY({ origin: [0, 0.3, 0], direction: [0, 0.3, -1] }, 0)).toBeNull();
    expect(intersectPlaneY({ origin: [0, 0.3, 0], direction: [0, 0, -1] }, 0)).toBeNull();
  });

  it('lifts a detection to 3D: depth from the box bottom on the table, height from the point', () => {
    // Camera 0.3 m above the table looking forward. A cup stands 1 m ahead: its base projects to
    // v = (360 + 800·0.3) / 720 = 0.8333 and its center (5 cm up) to v = (360 + 800·0.25) / 720.
    const lifted = liftDetection(
      { point: [0.5, 560 / 720], box: [0.45, 0.7, 0.55, 600 / 720] },
      model,
      head,
      0,
    );
    expect(near(lifted, [0, 0.05, -1])).toBe(true);
  });

  it('falls back to the table under the point when there is no box', () => {
    const lifted = liftDetection({ point: [0.5, 600 / 720], box: null }, model, head, 0);
    expect(near(lifted, [0, 0, -1])).toBe(true);
  });
});

describe('PoseHistory', () => {
  it('interpolates the head pose at a camera timestamp', () => {
    const h = new PoseHistory(8);
    h.push(0, { p: [0, 1, 0], q: [0, 0, 0, 1] });
    h.push(10, { p: [1, 1, 0], q: [0, 0, 0, 1] });
    expect(h.at(2.5)?.p).toEqual([0.25, 1, 0]);
  });

  it('clamps to the nearest sample outside the recorded range', () => {
    const h = new PoseHistory(8);
    h.push(0, { p: [0, 1, 0], q: [0, 0, 0, 1] });
    h.push(10, { p: [1, 1, 0], q: [0, 0, 0, 1] });
    expect(h.at(50)?.p).toEqual([1, 1, 0]);
    expect(new PoseHistory(4).at(0)).toBeNull();
  });
});
