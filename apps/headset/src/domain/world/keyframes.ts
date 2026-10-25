import {
  distance,
  dot,
  invertPose,
  type Pose,
  rotateVec,
  transformPoint,
  type Vec3,
} from '../../core/math';
import type { CameraIntrinsics } from './camera-model';
import type { HeadMotion } from './pose-history';

// Which passthrough camera frames become keyframes: the stills the object-model generator makes a
// model of each object from (docs/room-scene.md). A few good pictures of the work are what it
// needs, so the headset keeps few: a frame from a new viewpoint (far enough or turned enough from
// every keyframe kept), with the head still enough not to blur it, looking at the work (an object
// it knows, or the middle of the table), a couple of seconds after the last one, up to a small cap
// an episode. Pure: the capture side (app/keyframe-capture.ts) feeds it poses in W.

export const KEYFRAME = {
  /** A new viewpoint is this far (m) from every kept keyframe's camera... */
  minMoveM: 0.2,
  /** ...or looks this many degrees away from it. */
  minTurnDeg: 12,
  /** Shortest time between two keyframes (ms). */
  minGapMs: 2000,
  /** Fastest the head may turn around the capture time (deg/s): more blurs the frame. */
  maxTurnDegPerS: 40,
  /** Fastest the head may move around the capture time (m/s). */
  maxMoveMPerS: 0.5,
  /** Most keyframes an episode. */
  maxPerEpisode: 40,
  /** A focus point counts as seen inside the image less this share of it at each edge. */
  focusMargin: 0.1,
  /** ...and no farther than this from the camera (m): farther, an object is a few pixels. */
  maxFocusM: 2.5,
} as const;

export type KeyframeTunables = { [K in keyof typeof KEYFRAME]: number };

/** One camera frame a keyframe could be made of. */
export interface KeyframeCandidate {
  /** Camera pose in W (WebXR camera axes: looking down -z). */
  pose: Pose;
  /** When the frame was captured (performance.now ms). */
  t: number;
  /** How fast the head moved around `t`; null when unknown, which counts as moving. */
  motion: HeadMotion | null;
  /** The camera's pinhole model, any image size. */
  intrinsics: CameraIntrinsics;
  /** Points of the work in W the frame should show one of; none: any view will do. */
  focus: readonly Vec3[];
}

/**
 * keep: a keyframe. full: the episode has its cap. soon: too soon after the last one. moving: the
 * head moves too fast (or its motion is unknown). away: no focus point in view. seen: a kept
 * keyframe already has this viewpoint.
 */
export type KeyframeVerdict = 'keep' | 'full' | 'soon' | 'moving' | 'away' | 'seen';

interface Kept {
  position: Vec3;
  forward: Vec3;
}

const DEG = Math.PI / 180;
const forwardOf = (pose: Pose) => rotateVec(pose.q, [0, 0, -1]);

/** Whether a point (W) is in front of the camera and inside its image, `margin` from the edges. */
export function inView(
  pose: Pose,
  intrinsics: CameraIntrinsics,
  point: Readonly<Vec3>,
  margin: number = KEYFRAME.focusMargin,
  maxDistance: number = KEYFRAME.maxFocusM,
): boolean {
  const [x, y, z] = transformPoint(invertPose(pose), point);
  const depth = -z;
  if (depth <= 0 || Math.hypot(x, y, z) > maxDistance) return false;
  const { width, height, fx, fy, cx, cy } = intrinsics;
  const u = cx + (fx * x) / depth;
  const v = cy - (fy * y) / depth;
  return (
    u >= margin * width &&
    u <= (1 - margin) * width &&
    v >= margin * height &&
    v <= (1 - margin) * height
  );
}

/** Decides keyframes for one episode at a time; reset() at each episode start. */
export class KeyframeSelector {
  private readonly kept: Kept[] = [];
  private lastT = Number.NEGATIVE_INFINITY;
  private readonly tunables: KeyframeTunables;

  constructor(tunables: Partial<KeyframeTunables> = {}) {
    this.tunables = { ...KEYFRAME, ...tunables };
  }

  /** Keyframes kept this episode. */
  get count(): number {
    return this.kept.length;
  }

  get full(): boolean {
    return this.kept.length >= this.tunables.maxPerEpisode;
  }

  /** Whether a frame captured at `t` could be one at all (cheap: no pose needed). */
  due(t: number): boolean {
    return !this.full && t - this.lastT >= this.tunables.minGapMs;
  }

  judge(frame: KeyframeCandidate): KeyframeVerdict {
    const k = this.tunables;
    if (this.full) return 'full';
    if (frame.t - this.lastT < k.minGapMs) return 'soon';
    const { motion } = frame;
    if (!motion || motion.angular > k.maxTurnDegPerS * DEG || motion.linear > k.maxMoveMPerS)
      return 'moving';
    if (
      frame.focus.length > 0 &&
      !frame.focus.some((p) => inView(frame.pose, frame.intrinsics, p, k.focusMargin, k.maxFocusM))
    )
      return 'away';
    const forward = forwardOf(frame.pose);
    const minCos = Math.cos(k.minTurnDeg * DEG);
    const known = this.kept.some(
      (kept) =>
        distance(kept.position, frame.pose.p) < k.minMoveM && dot(kept.forward, forward) > minCos,
    );
    return known ? 'seen' : 'keep';
  }

  /** A frame judged `keep` was stored: later frames are judged against it. */
  keep(pose: Pose, t: number): void {
    this.kept.push({ position: [...pose.p], forward: forwardOf(pose) });
    this.lastT = t;
  }

  reset(): void {
    this.kept.length = 0;
    this.lastT = Number.NEGATIVE_INFINITY;
  }
}
