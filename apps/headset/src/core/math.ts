// Minimal vector / quaternion / pose math on plain tuples, so domain code never depends on
// three.js. Conventions match WebXR: right-handed, +y up, quaternions [x, y, z, w], meters.

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export interface Pose {
  p: Vec3;
  q: Quat;
}
export type Pose7 = [number, number, number, number, number, number, number];

export const IDENTITY_QUAT: Readonly<Quat> = Object.freeze([0, 0, 0, 1]);
export const identityPose = (): Pose => ({ p: [0, 0, 0], q: [0, 0, 0, 1] });

// ---- vectors -----------------------------------------------------------------------------------

export const vec = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const add = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
export const sub = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
export const scale = (a: Readonly<Vec3>, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
/** a + b·s */
export const madd = (a: Readonly<Vec3>, b: Readonly<Vec3>, s: number): Vec3 => [
  a[0] + b[0] * s,
  a[1] + b[1] * s,
  a[2] + b[2] * s,
];
export const dot = (a: Readonly<Vec3>, b: Readonly<Vec3>): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Readonly<Vec3>): number => Math.hypot(a[0], a[1], a[2]);
export const distance = (a: Readonly<Vec3>, b: Readonly<Vec3>): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export function normalize(a: Readonly<Vec3>): Vec3 {
  const l = length(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
export const lerp = (a: Readonly<Vec3>, b: Readonly<Vec3>, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
export const midpoint = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => lerp(a, b, 0.5);

// ---- quaternions -------------------------------------------------------------------------------

export function quatMultiply(a: Readonly<Quat>, b: Readonly<Quat>): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export const quatConjugate = (q: Readonly<Quat>): Quat => [-q[0], -q[1], -q[2], q[3]];

export function quatNormalize(q: Readonly<Quat>): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return l > 1e-12 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [0, 0, 0, 1];
}

export function quatFromAxisAngle(axis: Readonly<Vec3>, angle: number): Quat {
  const [x, y, z] = normalize(axis);
  const s = Math.sin(angle / 2);
  return [x * s, y * s, z * s, Math.cos(angle / 2)];
}

/** Rotates v by unit quaternion q. */
export function rotateVec(q: Readonly<Quat>, v: Readonly<Vec3>): Vec3 {
  const qv: Vec3 = [q[0], q[1], q[2]];
  const t = scale(cross(qv, v), 2);
  return add(add(v, scale(t, q[3])), cross(qv, t));
}

/** Rotation whose columns (images of x, y, z) are the given orthonormal axes. */
export function quatFromBasis(x: Readonly<Vec3>, y: Readonly<Vec3>, z: Readonly<Vec3>): Quat {
  const [m00, m10, m20] = x;
  const [m01, m11, m21] = y;
  const [m02, m12, m22] = z;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return quatNormalize(q);
}

export function slerp(a: Readonly<Quat>, b: Readonly<Quat>, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cos > 0.9995) {
    return quatNormalize([
      a[0] + (bx - a[0]) * t,
      a[1] + (by - a[1]) * t,
      a[2] + (bz - a[2]) * t,
      a[3] + (bw - a[3]) * t,
    ]);
  }
  const theta = Math.acos(cos);
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sin;
  const wb = Math.sin(t * theta) / sin;
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
}

/** Heading-only version of q: keeps the rotation about +y, drops pitch and roll. */
export function yawOnly(q: Readonly<Quat>): Quat {
  const fwd = rotateVec(q, [0, 0, -1]);
  const yaw = Math.atan2(-fwd[0], -fwd[2]);
  return quatFromAxisAngle([0, 1, 0], yaw);
}

// ---- poses -------------------------------------------------------------------------------------

export const transformPoint = (pose: Pose, v: Readonly<Vec3>): Vec3 =>
  add(pose.p, rotateVec(pose.q, v));

/** (a∘b)(x) = a(b(x)). */
export const composePose = (a: Pose, b: Pose): Pose => ({
  p: transformPoint(a, b.p),
  q: quatNormalize(quatMultiply(a.q, b.q)),
});

export function invertPose(pose: Pose): Pose {
  const qi = quatConjugate(pose.q);
  return { p: scale(rotateVec(qi, pose.p), -1), q: qi };
}

export const lerpPose = (a: Pose, b: Pose, t: number): Pose => ({
  p: lerp(a.p, b.p, t),
  q: slerp(a.q, b.q, t),
});

export const poseToTuple = (pose: Pose): Pose7 => [...pose.p, ...pose.q];
export const poseFromTuple = (t: Readonly<Pose7>): Pose => ({
  p: [t[0], t[1], t[2]],
  q: [t[3], t[4], t[5], t[6]],
});
