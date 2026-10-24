import type { Vec3 } from '../core/math';

// The fingertip's recent positions in the head frame. A sample is taken only while it is still:
// the camera feed the user aligns it in runs about 100 ms behind hand tracking, so a moving tip
// would pair a pixel with the wrong point.

export interface SteadyOptions {
  /** How far back a sample averages (ms). */
  windowMs: number;
  /** Largest distance of any position from the mean in that window (m). */
  maxSpread: number;
  /** Fewest positions in the window. */
  minCount: number;
}

export const DEFAULT_STEADY: SteadyOptions = { windowMs: 350, maxSpread: 0.006, minCount: 8 };

export class SteadyPoint {
  private readonly times: number[] = [];
  private readonly points: Vec3[] = [];

  constructor(
    private readonly options: SteadyOptions = DEFAULT_STEADY,
    private readonly capacity = 128,
  ) {}

  push(t: number, point: Readonly<Vec3>): void {
    this.times.push(t);
    this.points.push([point[0], point[1], point[2]]);
    if (this.times.length > this.capacity) {
      this.times.shift();
      this.points.shift();
    }
  }

  /** Forget everything (the tip was lost). */
  clear(): void {
    this.times.length = 0;
    this.points.length = 0;
  }

  /** The mean position over the last window if the tip held still, else null. */
  steady(now: number): Vec3 | null {
    const { windowMs, maxSpread, minCount } = this.options;
    const recent = this.points.filter((_, i) => now - (this.times[i] ?? 0) <= windowMs);
    if (recent.length < minCount) return null;
    const mean: Vec3 = [0, 0, 0];
    for (const p of recent) for (let k = 0; k < 3; k++) mean[k] = (mean[k] ?? 0) + (p[k] ?? 0);
    for (let k = 0; k < 3; k++) mean[k] = (mean[k] ?? 0) / recent.length;
    const spread = Math.max(
      ...recent.map((p) => Math.hypot(p[0] - mean[0], p[1] - mean[1], p[2] - mean[2])),
    );
    return spread <= maxSpread ? mean : null;
  }
}
