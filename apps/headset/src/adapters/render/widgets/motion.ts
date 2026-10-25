import { mixHex } from './theme';

// Calm motion for the widgets: pure easings and tweens, each a function of the frame's t minus a
// timestamp, so a frozen t draws the same pixels. Nothing loops or blinks. The small tween classes
// are built with a view and reused; reading or retargeting them allocates nothing.

export const easeOutCubic = (x: number): number => 1 - (1 - x) ** 3;
export const easeInCubic = (x: number): number => x * x * x;
export const easeInOutCubic = (x: number): number =>
  x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
export const linear = (x: number): number => x;

export type Easing = (x: number) => number;

/** 0..1: how far t is through [start, start + duration]; 1 when the duration is 0. */
export function progress(t: number, start: number, duration: number): number {
  if (duration <= 0) return t >= start ? 1 : 0;
  const x = (t - start) / duration;
  return x <= 0 ? 0 : Math.min(x, 1);
}

/** The eased progress of a tween started at `start`. */
export function tween(t: number, start: number, duration: number, ease: Easing = easeOutCubic) {
  return ease(progress(t, start, duration));
}

export const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

/** One pulse: 1, up to `peak` halfway, back to 1 (a sine bump), after `start`. */
export function pulse(t: number, start: number, duration: number, peak: number): number {
  const x = progress(t, start, duration);
  return x <= 0 || x >= 1 ? 1 : 1 + (peak - 1) * Math.sin(Math.PI * x);
}

/** A number that eases to each new target from wherever it was when retargeted. */
export class NumberTween {
  private from: number;
  private to: number;
  private start = Number.NEGATIVE_INFINITY;
  private duration = 0;

  constructor(
    value: number,
    private readonly ease: Easing = easeOutCubic,
  ) {
    this.from = value;
    this.to = value;
  }

  get target(): number {
    return this.to;
  }

  /** Eases to `to` over `duration` ms from t; a target it already has is ignored. */
  set(to: number, t: number, duration: number): void {
    if (to === this.to) return;
    this.from = this.value(t);
    this.to = to;
    this.start = t;
    this.duration = duration;
  }

  /** Jumps to `value` at once. */
  snap(value: number): void {
    this.from = value;
    this.to = value;
    this.start = Number.NEGATIVE_INFINITY;
  }

  value(t: number): number {
    return lerp(this.from, this.to, this.ease(progress(t, this.start, this.duration)));
  }

  done(t: number): boolean {
    return progress(t, this.start, this.duration) >= 1;
  }
}

/** An sRGB colour that eases to each new target, as a CSS colour transition does. */
export class ColorTween {
  private from: number;
  private to: number;
  private start = Number.NEGATIVE_INFINITY;
  private duration = 0;

  constructor(hex: number) {
    this.from = hex;
    this.to = hex;
  }

  get target(): number {
    return this.to;
  }

  set(to: number, t: number, duration: number): void {
    if (to === this.to) return;
    this.from = this.value(t);
    this.to = to;
    this.start = t;
    this.duration = duration;
  }

  snap(hex: number): void {
    this.from = hex;
    this.to = hex;
    this.start = Number.NEGATIVE_INFINITY;
  }

  value(t: number): number {
    return mixHex(this.from, this.to, easeOutCubic(progress(t, this.start, this.duration)));
  }
}
