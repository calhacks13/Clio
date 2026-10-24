import {
  HAND_JOINTS,
  HAND_SAMPLE_LENGTH,
  type HandJoint,
  type HandSample,
  JOINT_STRIDE,
} from '@clio/protocol';

type P = [number, number, number];

/** A hand whose listed joints sit at the given points; all others sit at `rest`. */
export function makeHand(points: Partial<Record<HandJoint, P>>, rest: P = [0, 0, 0]): HandSample {
  const joints = new Array<number>(HAND_SAMPLE_LENGTH).fill(0);
  HAND_JOINTS.forEach((name, i) => {
    const p = points[name] ?? rest;
    const o = i * JOINT_STRIDE;
    joints[o] = p[0];
    joints[o + 1] = p[1];
    joints[o + 2] = p[2];
    joints[o + 6] = 1; // identity quaternion
    joints[o + 7] = 0.008; // radius
  });
  const thumb = points['thumb-tip'] ?? rest;
  const index = points['index-finger-tip'] ?? rest;
  const pinch = Math.hypot(thumb[0] - index[0], thumb[1] - index[1], thumb[2] - index[2]);
  return { joints, pinch };
}

/** A hand pinching (thumb and index tips `gap` apart) centered on `at`, wrist 8 cm behind. */
export function pinchingHand(at: P, gap = 0.01): HandSample {
  return makeHand(
    {
      wrist: [at[0], at[1], at[2] + 0.08],
      'thumb-tip': [at[0] - gap / 2, at[1], at[2]],
      'index-finger-tip': [at[0] + gap / 2, at[1], at[2]],
    },
    [at[0], at[1], at[2] + 0.04],
  );
}
