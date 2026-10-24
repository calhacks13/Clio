import type { Handedness } from '@clio/protocol';
import type { Vec3 } from '../../../core/math';
import type { TrackedFrame } from '../../hands/types';

/** Everything a check may look at, in the workspace frame. */
export interface CheckContext {
  /** Now, on the performance.now() timeline. */
  t: number;
  stepStartT: number;
  frame: TrackedFrame;
  pinching: Record<Handedness, boolean>;
  objects: { position(id: string): Vec3 | undefined };
  /** Latched confirmations for the current step (the coach's advance_step, or the user). */
  confirmations: { coach: boolean; user: boolean };
}

export interface CheckStatus {
  satisfied: boolean;
  /** 0..1, for progress rings in the UI. */
  progress: number;
}

/** A stateful evaluator for one check; `update` is called once per frame. */
export interface CheckEvaluator {
  update(ctx: CheckContext): CheckStatus;
}

export const UNSATISFIED: CheckStatus = { satisfied: false, progress: 0 };
