// One timebase for everything: the performance.now() timeline, which XR frame callbacks and
// requestVideoFrameCallback also use. Episodes store t relative to their start.

export interface Clock {
  /** Milliseconds on the performance.now() timeline. */
  now(): number;
  /** Wall-clock epoch milliseconds for a timestamp on this clock's timeline. */
  epochMs(t: number): number;
}

export const performanceClock: Clock = {
  now: () => performance.now(),
  epochMs: (t) => performance.timeOrigin + t,
};

/** Deterministic clock for tests and synthetic episodes. */
export class ManualClock implements Clock {
  constructor(
    private t = 0,
    private readonly origin = Date.UTC(2026, 9, 24, 4, 0, 0),
  ) {}
  now(): number {
    return this.t;
  }
  epochMs(t: number): number {
    return this.origin + t;
  }
  advance(ms: number): number {
    this.t += ms;
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
}
