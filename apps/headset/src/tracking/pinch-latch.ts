import { DEFAULT_PINCH, type PinchThresholds } from '../domain/hands/pinch-detector';

/**
 * PinchDetector's rule (start and end distances with hysteresis, a short dropout grace) applied to
 * a raw thumb-to-index distance, so the frame loop needn't build a HandSample per hand per frame.
 */
export class PinchLatch {
  private pinching = false;
  private lastSeen = Number.NEGATIVE_INFINITY;

  constructor(private readonly thresholds: PinchThresholds = DEFAULT_PINCH) {}

  /** `gap` is the tip distance (m), or null while the hand isn't tracked. Returns the state. */
  update(gap: number | null, t: number): boolean {
    if (gap === null) {
      if (this.pinching && t - this.lastSeen >= (this.thresholds.dropoutGraceMs ?? 150))
        this.pinching = false;
      return this.pinching;
    }
    this.lastSeen = t;
    if (!this.pinching && gap <= this.thresholds.startDistance) this.pinching = true;
    else if (this.pinching && gap >= this.thresholds.endDistance) this.pinching = false;
    return this.pinching;
  }
}
