import { describe, expect, it } from 'vitest';
import { type Pose, quatFromAxisAngle, type Vec3 } from '../../src/core/math';
import type { CameraIntrinsics } from '../../src/domain/world/camera-model';
import {
  inView,
  KEYFRAME,
  type KeyframeCandidate,
  KeyframeSelector,
} from '../../src/domain/world/keyframes';
import { PoseHistory } from '../../src/domain/world/pose-history';

const DEG = Math.PI / 180;
const intrinsics: CameraIntrinsics = {
  width: 1280,
  height: 960,
  fx: 870,
  fy: 870,
  cx: 640,
  cy: 480,
};
const still = { linear: 0.05, angular: 5 * DEG };

/** A camera at `p` looking down -z, turned `yawDeg` about +y. */
const camera = (p: Vec3 = [0.3, 0.45, 0.4], yawDeg = 0): Pose => ({
  p,
  q: quatFromAxisAngle([0, 1, 0], yawDeg * DEG),
});

const frame = (over: Partial<KeyframeCandidate> = {}): KeyframeCandidate => ({
  pose: camera(),
  t: 10_000,
  motion: still,
  intrinsics,
  focus: [],
  ...over,
});

/** Judges a frame and keeps it when it is a keyframe, as the capture side does. */
function offer(selector: KeyframeSelector, over: Partial<KeyframeCandidate> = {}) {
  const f = frame(over);
  const verdict = selector.judge(f);
  if (verdict === 'keep') selector.keep(f.pose, f.t);
  return verdict;
}

describe('KeyframeSelector', () => {
  it('keeps the first still frame, then nothing sooner than 2 s after it', () => {
    const selector = new KeyframeSelector();
    expect(offer(selector, { t: 1000 })).toBe('keep');
    const moved = camera([1, 0.45, 0.4]);
    expect(offer(selector, { t: 2999, pose: moved })).toBe('soon');
    expect(selector.due(2999)).toBe(false);
    expect(selector.due(3000)).toBe(true);
    expect(offer(selector, { t: 3000, pose: moved })).toBe('keep');
    expect(selector.count).toBe(2);
  });

  it('keeps a new viewpoint only: 20 cm from every keyframe, or turned 12 degrees', () => {
    const selector = new KeyframeSelector();
    let t = 0;
    const next = (pose: Pose) => {
      t += 2000;
      return offer(selector, { pose, t });
    };
    expect(next(camera([0, 0.45, 0.4]))).toBe('keep');
    expect(next(camera([0.15, 0.45, 0.4]))).toBe('seen'); // 15 cm away
    expect(next(camera([0.0, 0.45, 0.4], 10))).toBe('seen'); // turned 10 degrees
    expect(next(camera([0.21, 0.45, 0.4]))).toBe('keep'); // 21 cm away
    expect(next(camera([0.0, 0.45, 0.4], 13))).toBe('keep'); // turned 13 degrees
    // Near the second one and looking the same way: already seen, though new to the first.
    expect(next(camera([0.25, 0.45, 0.4], 3))).toBe('seen');
    // Rolling the head shows the same view.
    const rolled = { p: [0, 0.45, 0.4] as Vec3, q: quatFromAxisAngle([0, 0, 1], 30 * DEG) };
    expect(next(rolled)).toBe('seen');
  });

  it('waits for the head to be still enough not to blur the frame', () => {
    const selector = new KeyframeSelector();
    expect(offer(selector, { motion: null })).toBe('moving');
    expect(offer(selector, { motion: { linear: 0.1, angular: 41 * DEG } })).toBe('moving');
    expect(offer(selector, { motion: { linear: 0.51, angular: 0 } })).toBe('moving');
    expect(offer(selector, { motion: { linear: 0.49, angular: 39 * DEG } })).toBe('keep');
  });

  it('keeps a frame only when it shows the work, when it is told where that is', () => {
    const selector = new KeyframeSelector();
    const table: Vec3[] = [[0.3, 0, -0.2]];
    // From 45 cm above and 60 cm in front, looking straight ahead, the table's middle is below
    // the image; tilted down 40 degrees it is in view.
    const level = camera([0.3, 0.45, 0.4]);
    const down = { p: level.p, q: quatFromAxisAngle([1, 0, 0], -40 * DEG) };
    expect(offer(selector, { pose: level, focus: table })).toBe('away');
    expect(offer(selector, { pose: down, focus: table })).toBe('keep');
    // Any one point in view will do.
    const other = new KeyframeSelector();
    expect(offer(other, { pose: level, focus: [...table, [0.3, 0.45, -0.6]] })).toBe('keep');
  });

  it('stops at 40 an episode, and starts over after reset', () => {
    const selector = new KeyframeSelector();
    for (let i = 0; i < 45; i++)
      offer(selector, { t: i * 2000, pose: camera([i * 0.3, 0.45, 0.4]) });
    expect(selector.count).toBe(KEYFRAME.maxPerEpisode);
    expect(KEYFRAME.maxPerEpisode).toBe(40);
    expect(selector.full).toBe(true);
    expect(selector.due(1e9)).toBe(false);
    expect(offer(selector, { t: 1e9, pose: camera([99, 0, 0]) })).toBe('full');
    selector.reset();
    expect(selector.count).toBe(0);
    expect(offer(selector, { t: 0, pose: camera() })).toBe('keep');
  });

  it('takes other tunables', () => {
    const selector = new KeyframeSelector({ minGapMs: 0, maxPerEpisode: 2, minMoveM: 0.05 });
    expect(offer(selector, { t: 0, pose: camera([0, 0.45, 0.4]) })).toBe('keep');
    expect(offer(selector, { t: 1, pose: camera([0.06, 0.45, 0.4]) })).toBe('keep');
    expect(offer(selector, { t: 2, pose: camera([0.5, 0.45, 0.4]) })).toBe('full');
  });
});

describe('inView', () => {
  const ahead = camera([0, 0, 0]);

  it('sees a point in front of the camera inside the image, short of its edges', () => {
    expect(inView(ahead, intrinsics, [0, 0, -1])).toBe(true);
    // u = 640 + 870 * x: the inner 80% ends at u = 1152, x = 0.589.
    expect(inView(ahead, intrinsics, [0.58, 0, -1])).toBe(true);
    expect(inView(ahead, intrinsics, [0.6, 0, -1])).toBe(false);
    expect(inView(ahead, intrinsics, [0.6, 0, -1], 0)).toBe(true);
    // Image y points down: v = 480 - 870 * y.
    expect(inView(ahead, intrinsics, [0, -0.43, -1])).toBe(true);
    expect(inView(ahead, intrinsics, [0, -0.46, -1])).toBe(false);
  });

  it('does not see what is behind it or too far to make out', () => {
    expect(inView(ahead, intrinsics, [0, 0, 1])).toBe(false);
    expect(inView(ahead, intrinsics, [0, 0, -2.4])).toBe(true);
    expect(inView(ahead, intrinsics, [0, 0, -2.6])).toBe(false);
  });

  it('follows the camera pose', () => {
    const right = camera([1, 0, 0], -90); // looking down +x
    expect(inView(right, intrinsics, [2, 0, 0])).toBe(true);
    expect(inView(right, intrinsics, [1, 0, -1])).toBe(false);
  });
});

describe('PoseHistory.motion', () => {
  const at = (x: number, yawDeg = 0): Pose => ({
    p: [x, 1.6, 0],
    q: quatFromAxisAngle([0, 1, 0], yawDeg * DEG),
  });

  it('measures how fast the head moved and turned around a time', () => {
    const poses = new PoseHistory();
    // 0.3 m/s and 30 deg/s, one pose every 14 ms.
    for (let t = 0; t <= 1000; t += 14) poses.push(t, at(0.0003 * t, 0.03 * t));
    const motion = poses.motion(500);
    expect(motion?.linear).toBeCloseTo(0.3, 6);
    expect((motion?.angular ?? 0) / DEG).toBeCloseTo(30, 4);
  });

  it('uses what history there is near its ends, and none too short to tell', () => {
    const poses = new PoseHistory();
    expect(poses.motion(0)).toBeNull();
    poses.push(0, at(0));
    expect(poses.motion(0)).toBeNull();
    poses.push(5, at(0.01));
    expect(poses.motion(5)).toBeNull(); // 5 ms of history
    poses.push(40, at(0.02));
    // From 0 to 40 ms: 2 cm.
    expect(poses.motion(30)?.linear).toBeCloseTo(0.5, 6);
    // Long after the newest pose: the history no longer covers it.
    expect(poses.motion(200)).toBeNull();
  });

  it('is still for a still head', () => {
    const poses = new PoseHistory();
    for (let t = 0; t <= 200; t += 14) poses.push(t, at(0.2, 15));
    expect(poses.motion(100)).toEqual({ linear: 0, angular: 0 });
  });
});
