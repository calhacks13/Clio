import { describe, expect, it } from 'vitest';
import { DEFAULT_HEAD_FROM_CAMERA } from '../../src/adapters/camera/calibration';
import { CalibrationFlow } from '../../src/calibrate/flow';
import { correctedRotation, pointOnRay } from '../../src/calibrate/solver';
import { SteadyPoint } from '../../src/calibrate/steady';
import { type CalibrationStep, calibrationSteps } from '../../src/calibrate/targets';
import { add, distance, type Pose } from '../../src/core/math';
import type { CameraIntrinsics } from '../../src/domain/world/camera-model';

const DEG = Math.PI / 180;
const K: CameraIntrinsics = { width: 1280, height: 960, fx: 800, fy: 800, cx: 640, cy: 480 };
const TRUE_K: CameraIntrinsics = { ...K, fx: 840, fy: 840 };
const TRUTH: Pose = {
  p: add(DEFAULT_HEAD_FROM_CAMERA.p, [0.007, -0.005, 0.009]),
  q: correctedRotation(DEFAULT_HEAD_FROM_CAMERA.q, 1 * DEG, -1.5 * DEG),
};

describe('calibration steps', () => {
  it('cover the 3x3 grid with the fingertip first, then place and aim at each mark', () => {
    const steps = calibrationSteps(42);
    const fingers = steps.filter((s) => s.kind === 'finger');
    expect(fingers).toHaveLength(9);
    expect(new Set(fingers.map((t) => t.uv.join(','))).size).toBe(9);
    expect(fingers.map((t) => t.reach).slice(0, 4)).toEqual(['near', 'far', 'near', 'far']);
    expect(steps.slice(9).map((s) => s.kind)).toEqual([
      'place',
      'mark',
      'mark',
      'mark',
      'place',
      'mark',
      'mark',
      'mark',
    ]);
    for (const s of steps) {
      if (s.kind === 'place') continue;
      expect(s.uv[0]).toBeGreaterThan(0.1);
      expect(s.uv[0]).toBeLessThan(0.9);
    }
  });
});

describe('steady point', () => {
  it('averages a still point and refuses a moving one', () => {
    const steady = new SteadyPoint();
    for (let i = 0; i < 30; i++) steady.push(i * 14, [0.1, 0, -0.3 + (i % 2) * 0.001]);
    expect(steady.steady(29 * 14)?.[2]).toBeCloseTo(-0.2995, 3);
    for (let i = 30; i < 60; i++) steady.push(i * 14, [0.1 + (i - 30) * 0.002, 0, -0.3]);
    expect(steady.steady(59 * 14)).toBeNull();
    steady.clear();
    expect(steady.steady(59 * 14)).toBeNull();
  });
});

describe('calibration flow', () => {
  it('runs fingertip and mark steps, replaces a rejected sample and saves a good fit', () => {
    const flow = new CalibrationFlow({
      intrinsics: K,
      initial: DEFAULT_HEAD_FROM_CAMERA,
      seed: 5,
      minFingerInliers: 9,
    });
    expect(flow.capture(null)).toEqual({ kind: 'unsteady' });
    // A tip nowhere near the crosshair is refused outright.
    expect(flow.capture([0.3, 0.3, -0.3])).toEqual({ kind: 'off-target' });
    const markDepth = [1.4, 2.1];
    const results: string[] = [];
    let n = 0;
    while (flow.step) {
      const step = flow.step;
      if (step.kind === 'place') {
        expect(flow.capture([0, 0, -1])).toEqual({ kind: 'idle' });
        expect(flow.place(null)).toEqual({ kind: 'no-surface' });
        expect(flow.place(0.5)).toEqual({ kind: 'too-close' });
        results.push(flow.place(1.5).kind);
        continue;
      }
      const depth =
        step.kind === 'mark' ? (markDepth[step.mark] ?? 1) : step.reach === 'near' ? 0.3 : 0.6;
      const point = pointOnRay(TRUE_K, TRUTH, step.uv, depth);
      // The third pinch came early: the tip was 3 cm short of the crosshair.
      results.push(flow.capture(n === 2 ? add(point, [0.03, 0, 0]) : point).kind);
      n++;
    }
    expect(results.filter((r) => r === 'placed')).toHaveLength(2);
    expect(results.filter((r) => r === 'more')).toHaveLength(1);
    expect(flow.total).toBe(18);
    const fit = flow.fit;
    expect(fit).not.toBeNull();
    if (!fit) return;
    expect(fit.samples[2]?.inlier).toBe(false);
    expect(flow.kept(fit, 'mark')).toBe(6);
    expect(distance(fit.headFromCamera.p, TRUTH.p)).toBeLessThan(0.002);
    expect(fit.intrinsics.fx).toBeCloseTo(840, -1);
    expect(flow.usable(fit)).toBe(true);
    expect(results.at(-1)).toBe('done');
    expect(flow.capture(pointOnRay(K, TRUTH, [0.5, 0.5], 0.4))).toEqual({ kind: 'idle' });
    flow.restart(9);
    expect(flow.taken).toBe(0);
    expect(flow.kinds).toHaveLength(0);
    // TypeScript still thinks the loop above left no step.
    const next = flow.step as CalibrationStep | null;
    expect(next?.kind).toBe('finger');
  });

  it('resumes a stored run where it stopped, through JSON as the page stores it', () => {
    const flow = new CalibrationFlow({ intrinsics: K, initial: DEFAULT_HEAD_FROM_CAMERA, seed: 5 });
    expect(flow.progress()).toBeNull();
    for (let i = 0; i < 4; i++) {
      const step = flow.step;
      if (step?.kind !== 'finger') throw new Error('fingertip steps first');
      flow.capture(pointOnRay(TRUE_K, TRUTH, step.uv, step.reach === 'near' ? 0.3 : 0.6));
    }
    const stored = JSON.parse(JSON.stringify(flow.progress()));
    const resumed = new CalibrationFlow({
      intrinsics: K,
      initial: DEFAULT_HEAD_FROM_CAMERA,
      seed: 99,
    });
    expect(resumed.restore(stored)).toBe(true);
    expect(resumed.taken).toBe(4);
    expect(resumed.samples).toEqual(flow.samples);
    expect(resumed.step).toEqual(flow.step);
  });

  it('goes back to placing a mark when stopped in the middle of aiming at it', () => {
    const flow = new CalibrationFlow({ intrinsics: K, initial: DEFAULT_HEAD_FROM_CAMERA, seed: 5 });
    while (flow.step?.kind === 'finger') {
      const step = flow.step;
      flow.capture(pointOnRay(TRUE_K, TRUTH, step.uv, step.reach === 'near' ? 0.3 : 0.6));
    }
    const placeAt = flow.taken;
    expect(flow.place(1.5)).toEqual({ kind: 'placed' });
    const aim = flow.step;
    if (aim?.kind !== 'mark') throw new Error('expected a mark step');
    flow.capture(pointOnRay(TRUE_K, TRUTH, aim.uv, 1.5));
    expect(flow.samples).toHaveLength(10);
    const progress = flow.progress();
    expect(progress?.index).toBe(placeAt);
    expect(progress?.samples).toHaveLength(9);
    expect(progress?.kinds.every((k) => k === 'finger')).toBe(true);
    const resumed = new CalibrationFlow({ intrinsics: K, initial: DEFAULT_HEAD_FROM_CAMERA });
    expect(progress && resumed.restore(progress)).toBe(true);
    expect(resumed.step?.kind).toBe('place');
  });

  it('refuses progress measured against another camera, or malformed', () => {
    const flow = new CalibrationFlow({ intrinsics: K, initial: DEFAULT_HEAD_FROM_CAMERA, seed: 5 });
    const step = flow.step;
    if (step?.kind !== 'finger') throw new Error('fingertip steps first');
    flow.capture(pointOnRay(TRUE_K, TRUTH, step.uv, 0.3));
    const progress = flow.progress();
    if (!progress) throw new Error('expected progress');
    const other = new CalibrationFlow({
      intrinsics: { ...K, width: 640, height: 480, fx: 400, fy: 400, cx: 320, cy: 240 },
      initial: DEFAULT_HEAD_FROM_CAMERA,
    });
    expect(other.restore(progress)).toBe(false);
    expect(other.taken).toBe(0);
    const fresh = new CalibrationFlow({ intrinsics: K, initial: DEFAULT_HEAD_FROM_CAMERA });
    expect(fresh.restore({ ...progress, kinds: [] })).toBe(false);
    expect(fresh.restore({ ...progress, index: 99 })).toBe(false);
  });

  it('does not save a run without far marks', () => {
    const flow = new CalibrationFlow({
      intrinsics: K,
      initial: DEFAULT_HEAD_FROM_CAMERA,
      seed: 3,
      plan: { marks: 0 },
      minMarkInliers: 0,
    });
    let last = '';
    while (flow.step) {
      const step = flow.step;
      if (step.kind !== 'finger') throw new Error('fingertip steps only');
      last = flow.capture(
        pointOnRay(TRUE_K, TRUTH, step.uv, step.reach === 'near' ? 0.3 : 0.6),
      ).kind;
    }
    expect(last).toBe('done');
    const fit = flow.fit;
    expect(fit && flow.usable(fit)).toBe(false);
  });
});
