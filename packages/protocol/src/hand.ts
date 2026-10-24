import { z } from 'zod';

/** WebXR hand joints, in the order the WebXR Hand Input spec iterates them. Never reorder. */
export const HAND_JOINTS = [
  'wrist',
  'thumb-metacarpal',
  'thumb-phalanx-proximal',
  'thumb-phalanx-distal',
  'thumb-tip',
  'index-finger-metacarpal',
  'index-finger-phalanx-proximal',
  'index-finger-phalanx-intermediate',
  'index-finger-phalanx-distal',
  'index-finger-tip',
  'middle-finger-metacarpal',
  'middle-finger-phalanx-proximal',
  'middle-finger-phalanx-intermediate',
  'middle-finger-phalanx-distal',
  'middle-finger-tip',
  'ring-finger-metacarpal',
  'ring-finger-phalanx-proximal',
  'ring-finger-phalanx-intermediate',
  'ring-finger-phalanx-distal',
  'ring-finger-tip',
  'pinky-finger-metacarpal',
  'pinky-finger-phalanx-proximal',
  'pinky-finger-phalanx-intermediate',
  'pinky-finger-phalanx-distal',
  'pinky-finger-tip',
] as const;

export type HandJoint = (typeof HAND_JOINTS)[number];

/** Values stored per joint, in order. */
export const JOINT_FIELDS = ['px', 'py', 'pz', 'qx', 'qy', 'qz', 'qw', 'radius'] as const;
export const JOINT_STRIDE = JOINT_FIELDS.length;
export const HAND_SAMPLE_LENGTH = HAND_JOINTS.length * JOINT_STRIDE;

export const HANDEDNESS = ['left', 'right'] as const;
export const HandednessSchema = z.enum(HANDEDNESS);
export type Handedness = z.infer<typeof HandednessSchema>;

const JOINT_INDEX = new Map<HandJoint, number>(HAND_JOINTS.map((name, i) => [name, i]));

export function jointIndex(joint: HandJoint): number {
  const i = JOINT_INDEX.get(joint);
  if (i === undefined) throw new Error(`Unknown hand joint "${joint}"`);
  return i;
}

/** Offset of a joint's first value (px) inside `HandSample.joints`. */
export function jointOffset(joint: HandJoint): number {
  return jointIndex(joint) * JOINT_STRIDE;
}

export const HandSampleSchema = z.object({
  joints: z
    .array(z.number())
    .length(HAND_SAMPLE_LENGTH)
    .describe(
      '25 joints × [px, py, pz, qx, qy, qz, qw, radius], WebXR joint order, workspace frame',
    ),
  pinch: z
    .number()
    .nonnegative()
    .describe('Thumb-tip to index-tip distance in meters; the gripper-aperture proxy'),
});

export type HandSample = z.infer<typeof HandSampleSchema>;
