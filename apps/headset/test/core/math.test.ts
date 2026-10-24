import { describe, expect, it } from 'vitest';
import {
  composePose,
  invertPose,
  type Pose,
  quatFromAxisAngle,
  quatFromBasis,
  rotateVec,
  slerp,
  transformPoint,
} from '../../src/core/math';

const close = (a: readonly number[], b: readonly number[], eps = 1e-6) =>
  a.every((v, i) => Math.abs(v - (b[i] ?? Number.NaN)) < eps);

describe('quaternions', () => {
  it('rotates +x by +90° about +y onto -z (right-handed)', () => {
    const q = quatFromAxisAngle([0, 1, 0], Math.PI / 2);
    expect(close(rotateVec(q, [1, 0, 0]), [0, 0, -1])).toBe(true);
  });

  it('slerps halfway to a 90° turn as a 45° turn', () => {
    const q = slerp([0, 0, 0, 1], quatFromAxisAngle([0, 0, 1], Math.PI / 2), 0.5);
    expect(close(rotateVec(q, [1, 0, 0]), [Math.SQRT1_2, Math.SQRT1_2, 0])).toBe(true);
  });

  it('builds a rotation from orthonormal basis axes', () => {
    // A frame whose x axis points along world -z and y stays up: a +90° yaw.
    const q = quatFromBasis([0, 0, -1], [0, 1, 0], [1, 0, 0]);
    expect(close(rotateVec(q, [1, 0, 0]), [0, 0, -1])).toBe(true);
    expect(close(rotateVec(q, [0, 0, 1]), [1, 0, 0])).toBe(true);
  });
});

describe('poses', () => {
  const yaw90: Pose = { p: [1, 0, 0], q: quatFromAxisAngle([0, 1, 0], Math.PI / 2) };

  it('transforms a point: rotate then translate', () => {
    expect(close(transformPoint(yaw90, [1, 0, 0]), [1, 0, -1])).toBe(true);
  });

  it('composes poses so that (a∘b)(x) = a(b(x))', () => {
    const b: Pose = { p: [0, 2, 0], q: [0, 0, 0, 1] };
    expect(close(transformPoint(composePose(yaw90, b), [1, 0, 0]), [1, 2, -1])).toBe(true);
  });

  it('inverts a pose', () => {
    const back = transformPoint(invertPose(yaw90), [1, 0, -1]);
    expect(close(back, [1, 0, 0])).toBe(true);
  });
});
