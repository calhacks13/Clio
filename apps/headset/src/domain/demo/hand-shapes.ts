import type { Handedness } from '@clio/protocol';
import {
  add,
  distance,
  lerp,
  madd,
  midpoint,
  normalize,
  quatFromAxisAngle,
  rotateVec,
  sub,
  type Vec3,
} from '../../core/math';

// Canonical hand poses for synthesized demonstrations, built with forward kinematics so they are
// anatomically plausible without any recorded data. Joint positions are in the wrist frame, in the
// WebXR joint order: palm facing -y, fingers along -z, and (for the right hand) the thumb toward -x.
// The left hand is the mirror image.

export type HandShapeId = 'open' | 'flat' | 'relaxed' | 'point' | 'pinch' | 'grasp';

type Finger = 'index' | 'middle' | 'ring' | 'pinky';
/** Flexion in degrees at the MCP, PIP and DIP joints. */
type Curl = [number, number, number];

interface FingerSpec {
  base: Vec3;
  knuckle: Vec3;
  lengths: [number, number, number];
}

const FINGERS: Record<Finger, FingerSpec> = {
  index: {
    base: [-0.022, 0, -0.012],
    knuckle: [-0.026, 0.002, -0.082],
    lengths: [0.04, 0.024, 0.021],
  },
  middle: {
    base: [-0.006, 0, -0.012],
    knuckle: [-0.006, 0.003, -0.086],
    lengths: [0.045, 0.028, 0.023],
  },
  ring: {
    base: [0.009, 0, -0.012],
    knuckle: [0.012, 0.002, -0.08],
    lengths: [0.041, 0.026, 0.022],
  },
  pinky: { base: [0.022, 0, -0.01], knuckle: [0.028, 0, -0.071], lengths: [0.032, 0.018, 0.019] },
};

const THUMB_BASE: Vec3 = [-0.024, -0.008, -0.022];
const THUMB_DIR = normalize([-0.55, -0.25, -0.8]);
const THUMB_REACH = 0.12;

const uniform = (c: Curl): Record<Finger, Curl> => ({ index: c, middle: c, ring: c, pinky: c });

const CURLS: Record<HandShapeId, Record<Finger, Curl>> = {
  open: uniform([5, 5, 3]),
  flat: uniform([0, 0, 0]),
  relaxed: uniform([15, 25, 12]),
  point: { index: [3, 3, 2], middle: [70, 95, 55], ring: [75, 95, 55], pinky: [75, 90, 50] },
  pinch: { index: [28, 38, 24], middle: [30, 45, 25], ring: [35, 50, 30], pinky: [40, 55, 30] },
  grasp: { index: [55, 70, 40], middle: [58, 72, 42], ring: [60, 75, 45], pinky: [62, 75, 45] },
};

/** Bends a finger direction toward the palm (rotation about -x). */
const flex = (dir: Vec3, degrees: number): Vec3 =>
  rotateVec(quatFromAxisAngle([-1, 0, 0], (degrees * Math.PI) / 180), dir);

function fingerChain(spec: FingerSpec, [a, b, c]: Curl): Vec3[] {
  const d0 = normalize(sub(spec.knuckle, spec.base));
  const intermediate = madd(spec.knuckle, flex(d0, a), spec.lengths[0]);
  const distal = madd(intermediate, flex(d0, a + b), spec.lengths[1]);
  const tip = madd(distal, flex(d0, a + b + c), spec.lengths[2]);
  return [spec.base, spec.knuckle, intermediate, distal, tip];
}

/** Thumb as a quadratic curve from its base toward `target` (or straight out when null). */
function thumbChain(target: Vec3 | null): Vec3[] {
  const p0 = THUMB_BASE;
  let end = target ?? madd(p0, THUMB_DIR, 0.1);
  if (distance(p0, end) > THUMB_REACH) end = madd(p0, normalize(sub(end, p0)), THUMB_REACH);
  const ctrl = madd(p0, THUMB_DIR, 0.05);
  const at = (s: number): Vec3 => lerp(lerp(p0, ctrl, s), lerp(ctrl, end, s), s);
  return [p0, at(0.42), at(0.72), end];
}

function thumbTarget(shape: HandShapeId, fingers: Record<Finger, Vec3[]>): Vec3 | null {
  const joint = (f: Finger, i: number): Vec3 => fingers[f][i] ?? [0, 0, 0];
  switch (shape) {
    case 'open':
    case 'flat':
      return null;
    case 'relaxed':
      return add(madd(THUMB_BASE, THUMB_DIR, 0.085), [0.01, -0.01, 0]);
    case 'point':
      return add(joint('middle', 2), [0, -0.012, 0]);
    case 'pinch':
      return add(joint('index', 4), [-0.01, 0, 0]);
    case 'grasp':
      return add(joint('index', 2), [0, -0.03, 0.01]);
  }
}

function build(shape: HandShapeId): Vec3[] {
  const curls = CURLS[shape];
  const fingers: Record<Finger, Vec3[]> = {
    index: fingerChain(FINGERS.index, curls.index),
    middle: fingerChain(FINGERS.middle, curls.middle),
    ring: fingerChain(FINGERS.ring, curls.ring),
    pinky: fingerChain(FINGERS.pinky, curls.pinky),
  };
  return [
    [0, 0, 0],
    ...thumbChain(thumbTarget(shape, fingers)),
    ...fingers.index,
    ...fingers.middle,
    ...fingers.ring,
    ...fingers.pinky,
  ];
}

const cache = new Map<string, readonly Vec3[]>();

/** 25 joint positions in the wrist frame, WebXR order. */
export function handShape(shape: HandShapeId, hand: Handedness): readonly Vec3[] {
  const key = `${shape}:${hand}`;
  let joints = cache.get(key);
  if (!joints) {
    const right = build(shape);
    joints = hand === 'right' ? right : right.map(([x, y, z]): Vec3 => [-x, y, z]);
    cache.set(key, joints);
  }
  return joints;
}

const at = (joints: readonly Vec3[], i: number): Vec3 => joints[i] ?? [0, 0, 0];

/** The point in the wrist frame that should coincide with the object being handled. */
export function gripPoint(shape: HandShapeId, hand: Handedness): Vec3 {
  const j = handShape(shape, hand);
  switch (shape) {
    case 'pinch':
      return midpoint(at(j, 4), at(j, 9));
    case 'grasp':
      return midpoint(at(j, 4), at(j, 12));
    case 'point':
      return at(j, 9);
    default:
      return add(midpoint(at(j, 0), at(j, 11)), [0, -0.025, 0]);
  }
}
