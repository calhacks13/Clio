import { describe, expect, it } from 'vitest';
import { length, sub, type Vec3 } from '../../src/core/math';
import {
  alignCyclic,
  capSpeed,
  DEFAULT_MOTION_OPTIONS,
  leadMs,
  type MotionSmoothingOptions,
  motionOptionsFromParams,
  OneEuroFilter,
  OutlineMotion,
  oneEuroAlpha,
  predictionGain,
  resampleClosed,
} from '../../src/domain/world/motion-smoothing';
import type { Point2 } from '../../src/domain/world/outline';
import type { Placement } from '../../src/domain/world/placement';

// The camera sits at the origin looking down -z; objects are 0.6 m ahead. The outline's plane
// then has x along world +x and y along world +y, so a placement's 2D points read as world x/y.

const EYE: Vec3 = [0, 0, 0];
const SQUARE: Point2[] = [
  [-0.05, -0.05],
  [0.05, -0.05],
  [0.05, 0.05],
  [-0.05, 0.05],
];

function placement(center: Vec3, points: Point2[] = SQUARE): Placement {
  return {
    center,
    outline: { points, shape: 'contour' },
    points: [],
    label: center,
    depth: 'contact',
  };
}

/** A deterministic noise in [-1, 1]. */
function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return 2 * (x - Math.floor(x)) - 1;
}

function expectNear(a: Readonly<Vec3> | undefined, b: Readonly<Vec3>, within = 1e-9): void {
  expect(a).toBeDefined();
  expect(length(sub(a as Vec3, b))).toBeLessThan(within);
}

const options = (overrides: Partial<MotionSmoothingOptions> = {}) => ({
  ...DEFAULT_MOTION_OPTIONS,
  ...overrides,
});

describe('One Euro', () => {
  it('blends more as the step grows or the cutoff rises', () => {
    expect(oneEuroAlpha(1, 0.04)).toBeCloseTo(1 / (1 + 1 / (2 * Math.PI) / 0.04), 6);
    expect(oneEuroAlpha(4, 0.04)).toBeGreaterThan(oneEuroAlpha(1, 0.04));
    expect(oneEuroAlpha(1, 1)).toBeGreaterThan(oneEuroAlpha(1, 0.04));
    expect(oneEuroAlpha(1, 0)).toBe(0);
  });

  it('steadies a still signal and keeps up with a moving one', () => {
    const still = new OneEuroFilter(1, 10);
    const moving = new OneEuroFilter(1, 10);
    let worstStill = 0;
    let lagMoving = 0;
    for (let i = 0; i < 100; i++) {
      const t = i * 40;
      const jitter = 0.003 * noise(i);
      const steadied = still.filter(jitter, t);
      if (i >= 10) worstStill = Math.max(worstStill, Math.abs(steadied));
      // 0.5 m/s, with the same jitter.
      const x = 0.5 * (t / 1000);
      lagMoving = x - moving.filter(x + jitter, t);
    }
    expect(worstStill).toBeLessThan(0.002);
    // An exponential smoother at the still cutoff would trail by 0.5 m/s * 159 ms = 8 cm.
    expect(lagMoving).toBeLessThan(0.03);
  });
});

describe('prediction limits', () => {
  it('leads by the wanted time, easing into the cap', () => {
    expect(leadMs(60, 120)).toBe(60);
    expect(leadMs(90, 120)).toBe(90);
    expect(leadMs(110, 120)).toBeGreaterThan(90);
    expect(leadMs(110, 120)).toBeLessThan(110);
    expect(leadMs(10_000, 120)).toBeLessThanOrEqual(120);
    expect(leadMs(10_000, 120)).toBeGreaterThan(119);
    expect(leadMs(50, 0)).toBe(0);
    expect(leadMs(-5, 120)).toBe(0);
  });

  it('trusts a velocity only as far as it stands out from its noise', () => {
    expect(predictionGain(0, 0.01)).toBe(0);
    expect(predictionGain(0.5, 0)).toBe(1);
    expect(predictionGain(0.5, 0.0025)).toBeGreaterThan(0.95);
    expect(predictionGain(0.02, 0.01)).toBeLessThan(0.05);
  });

  it('caps the speed', () => {
    expect(length(capSpeed([3, 4, 0], 1))).toBeCloseTo(1, 9);
    expect(capSpeed([0.3, 0, 0], 1)).toEqual([0.3, 0, 0]);
  });
});

describe('shapes', () => {
  it('resamples a closed polygon evenly and counter-clockwise', () => {
    const clockwise = [...SQUARE].reverse();
    const points = resampleClosed(clockwise, 8);
    expect(points).toHaveLength(8);
    // Perimeter 0.4 m: one point every 5 cm.
    for (let i = 0; i < 8; i++) {
      const a = points?.[i] as Point2;
      const b = points?.[(i + 1) % 8] as Point2;
      expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(0.05, 9);
    }
    expect(resampleClosed([[0, 0]], 8)).toBeNull();
  });

  it('lines a rotated ring up with the last one', () => {
    const ring = resampleClosed(SQUARE, 16) as Point2[];
    const rotated = [...ring.slice(5), ...ring.slice(0, 5)];
    expect(alignCyclic(rotated, ring)).toEqual(ring);
  });
});

describe('OutlineMotion', () => {
  it('holds a jittering still outline steady, its shape too', () => {
    const motion = new OutlineMotion(options());
    const centers: Vec3[] = [];
    let worstVertex = 0;
    let worstChange = 0;
    let previous: Point2[] | null = null;
    for (let i = 0; i < 75; i++) {
      const t = i * 40;
      const j = (k: number) => 0.004 * noise(i * 7 + k);
      const points = SQUARE.map(([x, y], k): Point2 => [x + j(k), y + j(k + 3)]);
      // Rotate the vertex order every frame, as a segmenter's contour does.
      const shuffled = [...points.slice(i % 4), ...points.slice(0, i % 4)];
      motion.add({
        key: 'cup',
        placement: placement([j(10), j(11), -0.6 + 3 * j(12)], shuffled),
        t,
        eye: EYE,
      });
      const frame = motion.at(t + 80);
      if (!frame) throw new Error('nothing drawn');
      if (i >= 25) {
        centers.push(frame.placement.center);
        // How far each point is off the square's edge (the raw ones are up to 4 mm off).
        for (const [x, y] of frame.placement.outline.points) {
          worstVertex = Math.max(worstVertex, Math.abs(Math.max(Math.abs(x), Math.abs(y)) - 0.05));
        }
        // How far its points move from one mask to the next, on average.
        const points = frame.placement.outline.points;
        if (previous) {
          const moved = points.map((p, k) => {
            const q = previous?.[k] as Point2;
            return Math.hypot(p[0] - q[0], p[1] - q[1]);
          });
          worstChange = Math.max(worstChange, moved.reduce((a, b) => a + b) / moved.length);
        }
        previous = points;
      }
    }
    const spread = (axis: 0 | 1 | 2) =>
      Math.max(...centers.map((c) => c[axis])) - Math.min(...centers.map((c) => c[axis]));
    // Raw jitter: 8 mm sideways, 24 mm in depth, peak to peak.
    expect(spread(0)).toBeLessThan(0.004);
    expect(spread(1)).toBeLessThan(0.004);
    expect(spread(2)).toBeLessThan(0.008);
    expect(worstVertex).toBeLessThan(0.003);
    // The raw points move about 4 mm from mask to mask.
    expect(worstChange).toBeLessThan(0.001);
  });

  it('follows a shape that really changes', () => {
    const motion = new OutlineMotion(options());
    const square = (half: number): Point2[] =>
      SQUARE.map(([x, y]): Point2 => [x * half * 20, y * half * 20]);
    for (let i = 0; i < 25; i++) {
      motion.add({
        key: 'cup',
        placement: placement([0, 0, -0.6], square(0.05)),
        t: i * 40,
        eye: EYE,
      });
    }
    // Turned or picked up: 5 cm to 8 cm across in 200 ms, then steady.
    let width = 0;
    for (let i = 25; i < 40; i++) {
      const half = 0.05 + 0.03 * Math.min(1, (i - 24) / 5);
      motion.add({
        key: 'cup',
        placement: placement([0, 0, -0.6], square(half)),
        t: i * 40,
        eye: EYE,
      });
      const xs = motion.at(i * 40)?.placement.outline.points.map(([x]) => x) ?? [];
      width = Math.max(...xs) - Math.min(...xs);
      if (i === 34) expect(width).toBeGreaterThan(0.14); // 200 ms after it settled
    }
    expect(width).toBeCloseTo(0.16, 2);
  });

  it("glides a sample's jump out evenly over glideMs instead of stepping the light there", () => {
    // Held still at its filtered place, then a sample that moves it (no prediction, no smoothing
    // of its own, so the jump is the sample's).
    const { glideMs } = DEFAULT_MOTION_OPTIONS;
    const motion = new OutlineMotion(options({ predictMs: 0, minCutoff: 1000, beta: 0 }));
    motion.add({ key: 'cup', placement: placement([0, 0, -0.6]), t: 0, eye: [0, 0, 0] });
    expect(motion.at(10)?.placement.center[0]).toBeCloseTo(0, 9);
    motion.add({ key: 'cup', placement: placement([0.02, 0, -0.6]), t: 14, eye: [0, 0, 0] });
    // The gap closes from the frame before the sample (10 ms), by the same amount each frame.
    const x = (now: number) => motion.at(now)?.placement.center[0] ?? Number.NaN;
    const frames: number[] = [];
    for (let now = 24; now <= 400; now += 14) frames.push(now);
    const drawn = frames.map(x);
    const end = drawn[drawn.length - 1] as number;
    expect(end).toBeCloseTo(0.02, 3);
    const each = end * (14 / glideMs);
    expect(drawn[0]).toBeCloseTo(each, 9);
    for (let i = 1; i < frames.length; i++) {
      const at = drawn[i] as number;
      const before = drawn[i - 1] as number;
      expect(at).toBeGreaterThanOrEqual(before);
      if ((frames[i] as number) <= 10 + glideMs) expect(at - before).toBeCloseTo(each, 9);
      // Closed once glideMs has passed.
      else expect(at).toBeCloseTo(end, 9);
    }
    // Asked twice for the same frame, it draws the same place.
    expect(x(400)).toBe(end);
  });

  it('jumps to a new object, a snap or a restart instead of gliding there', () => {
    const motion = new OutlineMotion(options({ predictMs: 0 }));
    motion.add({ key: 'cup', placement: placement([0, 0, -0.6]), t: 0, eye: [0, 0, 0] });
    motion.at(10);
    // Farther than snapM: another object, or a depth fix.
    motion.add({ key: 'cup', placement: placement([0.5, 0, -0.6]), t: 14, eye: [0, 0, 0] });
    expect(motion.at(24)?.placement.center[0]).toBeCloseTo(0.5, 6);
    motion.add({ key: 'jug', placement: placement([-0.1, 0, -0.6]), t: 28, eye: [0, 0, 0] });
    expect(motion.at(38)?.placement.center[0]).toBeCloseTo(-0.1, 6);
  });

  it('draws without a glide when glideMs is 0', () => {
    const motion = new OutlineMotion(
      options({ predictMs: 0, minCutoff: 1000, beta: 0, glideMs: 0 }),
    );
    motion.add({ key: 'cup', placement: placement([0, 0, -0.6]), t: 0, eye: [0, 0, 0] });
    motion.at(10);
    motion.add({ key: 'cup', placement: placement([0.02, 0, -0.6]), t: 14, eye: [0, 0, 0] });
    expect(motion.at(24)?.placement.center[0]).toBeCloseTo(0.02, 3);
  });

  it('draws a moving outline where the object is now, not where its frame saw it', () => {
    const motion = new OutlineMotion(options());
    const speed = 0.4; // m/s along +x
    let error = Number.POSITIVE_INFINITY;
    let lead = 0;
    for (let i = 0; i < 40; i++) {
      const t = i * 40;
      // The head follows it, so it moves sideways across the view.
      const x = speed * (t / 1000);
      motion.add({ key: 'cup', placement: placement([x, 0, -0.6]), t, eye: [x, 0, 0] });
      const now = t + 90; // captured 90 ms before it is drawn
      const frame = motion.at(now);
      if (!frame) throw new Error('nothing drawn');
      error = Math.abs(frame.placement.center[0] - speed * (now / 1000));
      lead = motion.stats.leadMs;
    }
    // Without prediction it would trail by the 90 ms of latency plus the filter's lag: > 36 mm.
    // Prediction is capped at 60 ms, so a third of the latency is left (it stops cleanly, below).
    expect(error).toBeLessThan(0.022);
    expect(lead).toBeLessThanOrEqual(DEFAULT_MOTION_OPTIONS.predictMs);
    expect(motion.stats.predictGain).toBeGreaterThan(0.9);
  });

  it('starts soon after a still object moves and stops without flying past it', () => {
    // Still for a second, slid 24 cm at 0.4 m/s across the view, then still: a sample every
    // 40 ms, each drawn 90 ms after its frame, at 72 Hz.
    const motion = new OutlineMotion(options());
    const xAt = (t: number) => 0.4 * Math.min(0.6, Math.max(0, (t - 1000) / 1000));
    let past = 0;
    let started = Number.NaN;
    let next = 0;
    for (let now = 90; now < 3000; now += 14) {
      for (; next <= now - 90; next += 40) {
        motion.add({ key: 'cup', placement: placement([xAt(next), 0, -0.6]), t: next, eye: EYE });
      }
      const x = motion.at(now)?.placement.center[0] ?? Number.NaN;
      if (now > 1600) past = Math.max(past, x - 0.24);
      if (Number.isNaN(started) && x > 0.048) started = now;
    }
    // A fifth of the way: the object is there at 1120 ms; 90 ms of it is the frames' latency.
    // (A still cutoff of 0.3 Hz, a 1.5 Hz velocity filter and 120 ms of prediction: 146 ms
    // after it, and 27 mm past the stop.)
    expect(started - 1120).toBeLessThan(140);
    expect(past).toBeLessThan(0.012);
  });

  it('caps the extrapolation in time and speed', () => {
    const motion = new OutlineMotion(options({ predictMs: 100, maxSpeed: 0.5 }));
    const speed = 2; // m/s, faster than maxSpeed
    for (let i = 0; i < 40; i++) {
      const t = i * 40;
      const x = speed * (t / 1000);
      motion.add({ key: 'cup', placement: placement([x, 0, -0.6]), t, eye: [x, 0, 0] });
    }
    const last = 39 * 40;
    const filtered = (motion.at(last) as NonNullable<ReturnType<OutlineMotion['at']>>).placement
      .center[0];
    // Far later: still at most maxSpeed * predictMs ahead of where the filter has it at capture.
    const later = motion.at(last + 5000);
    if (!later) throw new Error('nothing drawn');
    const ahead = later.placement.center[0] - filtered;
    expect(ahead).toBeLessThanOrEqual(0.5 * 0.1 + 1e-9);
    expect(ahead).toBeGreaterThan(0);
  });

  it('does not predict when off', () => {
    const motion = new OutlineMotion(options({ predictMs: 0 }));
    for (let i = 0; i < 20; i++) {
      const t = i * 40;
      motion.add({ key: 'cup', placement: placement([0.4 * (t / 1000), 0, -0.6]), t, eye: EYE });
    }
    const a = motion.at(19 * 40);
    const b = motion.at(19 * 40 + 100);
    expect(a?.placement.center).toEqual(b?.placement.center);
  });

  it('holds a lost outline, coasting to a stop, then fades it', () => {
    const motion = new OutlineMotion(options({ holdMs: 400 }));
    for (let i = 0; i < 30; i++) {
      const t = i * 40;
      motion.add({ key: 'cup', placement: placement([0.3 * (t / 1000), 0, -0.6]), t, eye: EYE });
    }
    const lostAt = 29 * 40 + 60;
    motion.lose(lostAt);
    const at = (now: number) => motion.at(now)?.placement.center[0] ?? Number.NaN;
    expect(motion.at(lostAt + 100)?.holding).toBe(true);
    // The prediction slows down: it moves less and less, and never goes back.
    const steps = [0, 50, 100, 200, 390].map((ms) => at(lostAt + ms));
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1] as number);
    }
    expect((steps[4] as number) - (steps[3] as number)).toBeLessThan(0.001);
    expect(motion.at(lostAt + 399)).not.toBeNull();
    expect(motion.at(lostAt + 400)).toBeNull();
  });

  it('carries on from a short loss, and starts over after a fade', () => {
    const motion = new OutlineMotion(options({ holdMs: 400 }));
    motion.add({ key: 'cup', placement: placement([0, 0, -0.6]), t: 0, eye: EYE });
    motion.add({ key: 'cup', placement: placement([0, 0, -0.6]), t: 40, eye: EYE });
    motion.lose(50);
    motion.add({ key: 'cup', placement: placement([0.02, 0, -0.6]), t: 120, eye: EYE });
    // Smoothed, not jumped: a short loss doesn't restart the filter.
    expect(motion.at(120)?.placement.center[0]).toBeLessThan(0.02);
    expect(motion.at(120)?.holding).toBe(false);
    motion.lose(130);
    motion.add({ key: 'cup', placement: placement([0.02, 0.01, -0.6]), t: 600, eye: EYE });
    expectNear(motion.at(600)?.placement.center, [0.02, 0.01, -0.6]);
  });

  it('starts over for another target or a far jump', () => {
    const motion = new OutlineMotion(options());
    motion.add({ key: 'cup', placement: placement([0, 0, -0.6]), t: 0, eye: EYE });
    motion.add({ key: 'pen', placement: placement([0.05, 0, -0.6]), t: 40, eye: EYE });
    expectNear(motion.at(40)?.placement.center, [0.05, 0, -0.6]);
    motion.add({ key: 'pen', placement: placement([0.5, 0, -0.6]), t: 80, eye: EYE });
    expectNear(motion.at(80)?.placement.center, [0.5, 0, -0.6]);
    expect(motion.stats.snaps).toBe(1);
  });

  it('replaces a frame placed again at its re-measured distance', () => {
    const once = new OutlineMotion(options());
    const twice = new OutlineMotion(options());
    for (const motion of [once, twice]) {
      motion.add({ key: 'cup', placement: placement([0, 0, -0.6]), t: 0, eye: EYE });
    }
    twice.add({ key: 'cup', placement: placement([0, 0, -0.65]), t: 40, eye: EYE });
    twice.add({ key: 'cup', placement: placement([0, 0, -0.62]), t: 40, eye: EYE });
    once.add({ key: 'cup', placement: placement([0, 0, -0.62]), t: 40, eye: EYE });
    const a = once.at(40)?.placement.center as Vec3;
    const b = twice.at(40)?.placement.center as Vec3;
    expect(length(sub(a, b))).toBeLessThan(1e-12);
    // An older frame arriving late changes nothing.
    twice.add({ key: 'cup', placement: placement([0.1, 0, -0.6]), t: 20, eye: EYE });
    expect(twice.at(40)?.placement.center).toEqual(b);
  });

  it('turning the head moves nothing: the outline is smoothed in the room', () => {
    const motion = new OutlineMotion(options());
    for (let i = 0; i < 20; i++) {
      const t = i * 40;
      // The camera swings sideways; the object stays put.
      const eye: Vec3 = [0.3 * Math.sin(i / 3), 0, 0];
      motion.add({ key: 'cup', placement: placement([0, 0, -0.6]), t, eye });
      const center = motion.at(t + 80)?.placement.center as Vec3;
      expect(length(sub(center, [0, 0, -0.6]))).toBeLessThan(1e-9);
    }
  });
});

describe('motionOptionsFromParams', () => {
  it('reads overrides, ignores junk, and turns off with smooth=0', () => {
    const read = (q: string) => motionOptionsFromParams(new URLSearchParams(q));
    expect(read('smooth=0')).toBeNull();
    expect(read('')).toEqual(DEFAULT_MOTION_OPTIONS);
    const tuned = read('minCutoff=0.5&beta=3&predictMs=80&holdMs=abc&maxSpeed=-1');
    expect(tuned?.minCutoff).toBe(0.5);
    expect(tuned?.beta).toBe(3);
    expect(tuned?.predictMs).toBe(80);
    expect(tuned?.holdMs).toBe(DEFAULT_MOTION_OPTIONS.holdMs);
    expect(tuned?.maxSpeed).toBe(DEFAULT_MOTION_OPTIONS.maxSpeed);
  });
});
