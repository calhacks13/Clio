import type { CheckStatus } from './types';

/** Tracking can drop a hand for a frame or two; that shouldn't reset a dwell. */
export const DROPOUT_GRACE_MS = 150;

/**
 * Turns a per-frame condition into "held for at least dwellMs". A brief dropout (shorter than the
 * grace period) is bridged: the condition counts as still held.
 */
export class DwellGate {
  private since: number | null = null;
  private lastTrue = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly dwellMs: number,
    private readonly graceMs = DROPOUT_GRACE_MS,
  ) {}

  update(condition: boolean, t: number): CheckStatus {
    if (condition) {
      if (this.since === null) this.since = t;
      this.lastTrue = t;
    } else if (this.since !== null && t - this.lastTrue > this.graceMs) {
      this.since = null;
    }
    if (this.since === null) return { satisfied: false, progress: 0 };
    const held = this.lastTrue - this.since;
    return {
      satisfied: held >= this.dwellMs,
      progress: this.dwellMs <= 0 ? 1 : Math.min(1, held / this.dwellMs),
    };
  }
}
