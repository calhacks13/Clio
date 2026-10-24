import { HAND_JOINTS, type Handedness, type HandSample, JOINT_STRIDE } from '@clio/protocol';
import { distance, lerp, lerpPose, type Pose, transformPoint, type Vec3 } from '../../core/math';
import { type HandShapeId, handShape } from './hand-shapes';

/** A pose the ghost hand passes through: where the wrist is, and what shape the hand makes. */
export interface Keyframe {
  t: number;
  wrist: Pose;
  shape: HandShapeId;
}

const RADII = HAND_JOINTS.map((name) =>
  name === 'wrist'
    ? 0.012
    : name.endsWith('tip')
      ? 0.0075
      : name.includes('metacarpal')
        ? 0.01
        : 0.0085,
);

const smoothstep = (u: number) => u * u * (3 - 2 * u);

/** Samples a keyframe track as a full 25-joint hand (orientations follow the wrist). */
export function sampleTrack(
  track: readonly Keyframe[],
  t: number,
  hand: Handedness,
): HandSample | null {
  const first = track[0];
  const last = track.at(-1);
  if (!first || !last) return null;

  let a = first;
  let b = first;
  if (t >= last.t) {
    a = last;
    b = last;
  } else if (t > first.t) {
    const i = track.findIndex((k) => k.t > t);
    a = track[i - 1] ?? first;
    b = track[i] ?? last;
  }
  const span = b.t - a.t;
  const e = span > 0 ? smoothstep((t - a.t) / span) : 0;
  const wrist = lerpPose(a.wrist, b.wrist, e);
  const from = handShape(a.shape, hand);
  const to = handShape(b.shape, hand);

  const joints = new Array<number>(HAND_JOINTS.length * JOINT_STRIDE);
  const world: Vec3[] = [];
  for (let i = 0; i < HAND_JOINTS.length; i++) {
    const p = transformPoint(wrist, lerp(from[i] ?? [0, 0, 0], to[i] ?? [0, 0, 0], e));
    world.push(p);
    const o = i * JOINT_STRIDE;
    joints[o] = p[0];
    joints[o + 1] = p[1];
    joints[o + 2] = p[2];
    joints[o + 3] = wrist.q[0];
    joints[o + 4] = wrist.q[1];
    joints[o + 5] = wrist.q[2];
    joints[o + 6] = wrist.q[3];
    joints[o + 7] = RADII[i] ?? 0.008;
  }
  return { joints, pinch: distance(world[4] ?? [0, 0, 0], world[9] ?? [0, 0, 0]) };
}
