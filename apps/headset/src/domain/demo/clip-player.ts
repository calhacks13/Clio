import type { ClipFrame, HandSample } from '@clio/protocol';
import { quatNormalize } from '../../core/math';
import type { HandClip } from './types';

export interface PlayOptions {
  loop?: boolean;
  speed?: number;
}

export interface HandsSample {
  left: HandSample | null;
  right: HandSample | null;
}

/** Interpolates two hand samples joint by joint (positions linear, orientations nlerp). */
function lerpHand(a: HandSample | null, b: HandSample | null, u: number): HandSample | null {
  if (!a || !b) return u < 0.5 ? a : b;
  const joints = a.joints.map((v, i) => v + ((b.joints[i] ?? v) - v) * u);
  for (let o = 3; o < joints.length; o += 8) {
    const q = quatNormalize([
      joints[o] ?? 0,
      joints[o + 1] ?? 0,
      joints[o + 2] ?? 0,
      joints[o + 3] ?? 1,
    ]);
    joints[o] = q[0];
    joints[o + 1] = q[1];
    joints[o + 2] = q[2];
    joints[o + 3] = q[3];
  }
  return { joints, pinch: a.pinch + (b.pinch - a.pinch) * u };
}

/** Plays a recorded or synthesized clip against the app clock. */
export class ClipPlayer {
  private clip: HandClip | null = null;
  private startT = 0;
  private loop = false;
  private speed = 1;

  play(clip: HandClip, t: number, { loop = false, speed = 1 }: PlayOptions = {}): void {
    this.clip = clip;
    this.startT = t;
    this.loop = loop;
    this.speed = speed;
  }

  stop(): void {
    this.clip = null;
  }

  get active(): boolean {
    return this.clip !== null;
  }

  finished(t: number): boolean {
    return !!this.clip && !this.loop && (t - this.startT) * this.speed >= this.clip.durationMs;
  }

  sample(t: number): HandsSample | null {
    const clip = this.clip;
    const first = clip?.frames[0];
    if (!clip || !first) return null;
    let local = (t - this.startT) * this.speed;
    if (this.loop && clip.durationMs > 0) local %= clip.durationMs;
    local = Math.min(Math.max(local, 0), clip.durationMs);

    const frames = clip.frames;
    const next = frames.findIndex((f) => f.t > local);
    if (next <= 0) {
      const f: ClipFrame = next === 0 ? first : (frames.at(-1) ?? first);
      return { left: f.left, right: f.right };
    }
    const a = frames[next - 1] ?? first;
    const b = frames[next] ?? a;
    const u = b.t > a.t ? (local - a.t) / (b.t - a.t) : 0;
    return { left: lerpHand(a.left, b.left, u), right: lerpHand(a.right, b.right, u) };
  }
}
