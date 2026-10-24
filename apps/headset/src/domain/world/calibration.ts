import type { Pose, Vec3 } from '../../core/math';
import type { PinchTransition } from '../hands/pinch-detector';
import { workspaceFromCorners } from './workspace';

export type CalibrationStep = 'first' | 'second' | 'done';

export interface CalibrationPrompt {
  step: CalibrationStep;
  text: string;
  error: string | null;
}

const TEXT: Record<CalibrationStep, string> = {
  first: 'Pinch the near-left corner of your work area.',
  second: 'Now pinch the near-right corner.',
  done: 'Work area set.',
};

/**
 * Interactive two-corner calibration: the hands are the measuring instrument. Feed it pinch
 * transitions in world space; it returns the workspace pose once both corners are in.
 */
export class CalibrationFlow {
  private first: Vec3 | null = null;
  private result: Pose | null = null;
  private error: string | null = null;

  get prompt(): CalibrationPrompt {
    const step: CalibrationStep = this.result ? 'done' : this.first ? 'second' : 'first';
    return { step, text: TEXT[step], error: this.error };
  }

  /** The first corner, once pinched (for drawing feedback). */
  get firstCorner(): Vec3 | null {
    return this.first;
  }

  onPinch(transition: PinchTransition): Pose | null {
    if (transition.phase !== 'start' || this.result) return null;
    if (!this.first) {
      this.first = transition.point;
      this.error = null;
      return null;
    }
    try {
      this.result = workspaceFromCorners(this.first, transition.point);
      this.error = null;
      return this.result;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  reset(): void {
    this.first = null;
    this.result = null;
    this.error = null;
  }
}
