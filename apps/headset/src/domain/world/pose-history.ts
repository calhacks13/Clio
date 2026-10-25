import { distance, lerpPose, type Pose } from '../../core/math';

/** How fast the head moved: meters a second and radians a second. */
export interface HeadMotion {
  linear: number;
  angular: number;
}

/** A motion is measured over at least this much history (ms), or not at all. */
const MIN_MOTION_SPAN_MS = 10;

/**
 * A short history of head poses, so a camera frame captured at time t can be paired with where the
 * head was at t (camera frames arrive tens of milliseconds late).
 */
export class PoseHistory {
  private readonly times: number[] = [];
  private readonly poses: Pose[] = [];

  constructor(private readonly capacity = 256) {}

  push(t: number, pose: Pose): void {
    this.times.push(t);
    this.poses.push(pose);
    if (this.times.length > this.capacity) {
      this.times.shift();
      this.poses.shift();
    }
  }

  at(t: number): Pose | null {
    const n = this.times.length;
    if (n === 0) return null;
    const first = this.times[0] ?? 0;
    const last = this.times[n - 1] ?? 0;
    if (t <= first) return this.poses[0] ?? null;
    if (t >= last) return this.poses[n - 1] ?? null;
    for (let i = n - 1; i > 0; i--) {
      const t0 = this.times[i - 1] ?? 0;
      if (t0 <= t) {
        const t1 = this.times[i] ?? t0;
        const a = this.poses[i - 1];
        const b = this.poses[i];
        if (!a || !b) return null;
        return lerpPose(a, b, t1 > t0 ? (t - t0) / (t1 - t0) : 0);
      }
    }
    return this.poses[0] ?? null;
  }

  /**
   * How fast the head moved around time t: from the pose at t - halfWindowMs to the pose at
   * t + halfWindowMs, within the history. Null when the history covers too little of it.
   */
  motion(t: number, halfWindowMs = 50): HeadMotion | null {
    const n = this.times.length;
    const t0 = Math.max(this.times[0] ?? 0, t - halfWindowMs);
    const t1 = Math.min(this.times[n - 1] ?? 0, t + halfWindowMs);
    if (n < 2 || t1 - t0 < MIN_MOTION_SPAN_MS) return null;
    const a = this.at(t0);
    const b = this.at(t1);
    if (!a || !b) return null;
    const dot = Math.abs(a.q[0] * b.q[0] + a.q[1] * b.q[1] + a.q[2] * b.q[2] + a.q[3] * b.q[3]);
    const seconds = (t1 - t0) / 1000;
    return {
      linear: distance(a.p, b.p) / seconds,
      angular: (2 * Math.acos(Math.min(1, dot))) / seconds,
    };
  }
}
