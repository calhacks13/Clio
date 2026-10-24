import type { Handedness, HandSample } from '@clio/protocol';
import type { Vec3 } from '../../core/math';
import { pinchPoint } from './features';

export interface PinchTransition {
  hand: Handedness;
  phase: 'start' | 'end';
  point: Vec3;
  t: number;
}

export interface PinchThresholds {
  /** A pinch starts when the tips come within this distance (m). */
  startDistance: number;
  /** An active pinch ends only once the tips are this far apart (m). Must exceed startDistance. */
  endDistance: number;
}

export const DEFAULT_PINCH: PinchThresholds = { startDistance: 0.02, endDistance: 0.035 };

/** Pinch state per hand with hysteresis, so tracking jitter near the threshold can't flicker. */
export class PinchDetector {
  private readonly pinching: Record<Handedness, boolean> = { left: false, right: false };
  private readonly last: Record<Handedness, Vec3> = { left: [0, 0, 0], right: [0, 0, 0] };

  constructor(private readonly thresholds: PinchThresholds = DEFAULT_PINCH) {}

  isPinching(hand: Handedness): boolean {
    return this.pinching[hand];
  }

  update(hand: Handedness, sample: HandSample | null, t: number): PinchTransition | null {
    if (!sample) {
      if (!this.pinching[hand]) return null;
      this.pinching[hand] = false;
      return { hand, phase: 'end', point: this.last[hand], t };
    }
    const point = pinchPoint(sample);
    this.last[hand] = point;
    if (!this.pinching[hand] && sample.pinch <= this.thresholds.startDistance) {
      this.pinching[hand] = true;
      return { hand, phase: 'start', point, t };
    }
    if (this.pinching[hand] && sample.pinch >= this.thresholds.endDistance) {
      this.pinching[hand] = false;
      return { hand, phase: 'end', point, t };
    }
    return null;
  }
}
