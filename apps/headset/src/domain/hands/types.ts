import type { Handedness, HandSample } from '@clio/protocol';
import type { Pose } from '../../core/math';

/**
 * One tracking sample: head pose and both hands' 25 joints. The same shape is used in world
 * space (straight from the sampler) and in workspace space (after `Workspace.toWorkspaceFrame`);
 * variable names say which (`worldFrame`, `frame`).
 */
export interface TrackedFrame {
  /** performance.now() timeline, ms */
  t: number;
  head: Pose;
  left: HandSample | null;
  right: HandSample | null;
}

export const HANDS: readonly Handedness[] = ['left', 'right'];

export function handOf(frame: TrackedFrame, hand: Handedness): HandSample | null {
  return hand === 'left' ? frame.left : frame.right;
}
