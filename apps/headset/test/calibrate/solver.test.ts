import { describe, expect, it } from 'vitest';
import { DEFAULT_HEAD_FROM_CAMERA } from '../../src/adapters/camera/calibration';
import {
  type CalibrationFit,
  type CalibrationSample,
  calibrateCamera,
  correctedRotation,
  pointOnRay,
  projectToUv,
  solveCameraPose,
} from '../../src/calibrate/solver';
import { add, distance, dot, length, madd, type Pose, sub, type Vec3 } from '../../src/core/math';
import type { CameraIntrinsics } from '../../src/domain/world/camera-model';

const K: CameraIntrinsics = { width: 1280, height: 960, fx: 800, fy: 800, cx: 640, cy: 480 };
const DEG = Math.PI / 180;
const MM = 0.001;

/** A deterministic generator, so the noisy cases are repeatable. */
function rng(seed: number): { uniform: () => number; gauss: () => number } {
  let s = seed >>> 0;
  const uniform = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s + 0.5) / 2 ** 32;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
  return { uniform, gauss };
}

interface Truth {
  pose: Pose;
  /** The true intrinsics (the solver starts from K). */
  k: CameraIntrinsics;
}

const truthOf = (offset: Vec3, yaw = 0, pitch = 0, roll = 0, fx = 800): Truth => ({
  pose: {
    p: add(DEFAULT_HEAD_FROM_CAMERA.p, offset),
    q: correctedRotation(DEFAULT_HEAD_FROM_CAMERA.q, yaw, pitch, roll),
  },
  k: { ...K, fx, fy: fx },
});

const GRID = [0.3, 0.5, 0.7].flatMap((v) => [0.25, 0.5, 0.75].map((u): [number, number] => [u, v]));
const MARK_UV: [number, number][][] = [
  [
    [0.25, 0.3],
    [0.75, 0.5],
    [0.4, 0.7],
  ],
  [
    [0.75, 0.3],
    [0.25, 0.55],
    [0.6, 0.7],
  ],
];

interface Noise {
  /** Fingertip position noise per axis (m). */
  tip: number;
  /** Mark placement error per axis, shared by a mark's samples (m). */
  mark: number;
  /** Aiming error in the picture per axis (rad). */
  aim: number;
}
const EXACT: Noise = { tip: 0, mark: 0, aim: 0 };

/**
 * The samples of a run as calibrate.html takes them: nine fingertip crosshairs alternating 0.3 and
 * 0.6 m, then (with `marks`) two marks 1 to 2.5 m away seen at three crosshairs each.
 */
function runSamples(truth: Truth, noise: Noise, seed: number, marks = true): CalibrationSample[] {
  const r = rng(seed);
  const jitter = (sd: number): Vec3 => [r.gauss() * sd, r.gauss() * sd, r.gauss() * sd];
  const aimed = (uv: [number, number]): [number, number] => [
    uv[0] + (r.gauss() * noise.aim * truth.k.fx) / K.width,
    uv[1] + (r.gauss() * noise.aim * truth.k.fy) / K.height,
  ];
  const out: CalibrationSample[] = GRID.map((uv, i) => ({
    head: add(pointOnRay(truth.k, truth.pose, uv, i % 2 ? 0.6 : 0.3), jitter(noise.tip)),
    uv: aimed(uv),
  }));
  if (!marks) return out;
  for (const set of MARK_UV) {
    const depth = 1 + 1.5 * r.uniform();
    const placement = jitter(noise.mark);
    for (const uv of set) {
      out.push({
        head: add(add(pointOnRay(truth.k, truth.pose, uv, depth), placement), jitter(0.002)),
        uv: aimed(uv),
      });
    }
  }
  return out;
}

/** The distance between the solved and the true camera rays 1 m out, RMS over the image (m). */
function missAt1m(fit: CalibrationFit, truth: Truth): number {
  let total = 0;
  for (const u of [0.2, 0.5, 0.8]) {
    for (const v of [0.2, 0.5, 0.8]) {
      const real = pointOnRay(truth.k, truth.pose, [u, v], 1);
      const origin = fit.headFromCamera.p;
      const dir = sub(pointOnRay(fit.intrinsics, fit.headFromCamera, [u, v], 1), origin);
      const t = sub(real, origin);
      total += length(madd(t, dir, -dot(t, dir))) ** 2;
    }
  }
  return Math.sqrt(total / 9);
}

const quantile = (values: number[], q: number) => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? Number.NaN;
};

describe('camera calibration solver', () => {
  it('recovers position, orientation and focal length from exact samples', () => {
    const truth = truthOf([0.008, -0.006, 0.01], 2 * DEG, -1.5 * DEG, 0.7 * DEG, 856);
    const fit = calibrateCamera(runSamples(truth, EXACT, 1), K, DEFAULT_HEAD_FROM_CAMERA);
    // The weak prior pulls a little toward the guess.
    expect(distance(fit.headFromCamera.p, truth.pose.p)).toBeLessThan(1.5 * MM);
    expect(Math.abs(fit.yaw - 2 * DEG)).toBeLessThan(0.1 * DEG);
    expect(Math.abs(fit.pitch + 1.5 * DEG)).toBeLessThan(0.1 * DEG);
    expect(Math.abs(fit.roll - 0.7 * DEG)).toBeLessThan(0.1 * DEG);
    expect(Math.abs(fit.intrinsics.fx - 856)).toBeLessThan(4);
    expect(fit.inliers).toBe(15);
    expect(fit.farInliers).toBe(6);
    expect(fit.rmsAngle).toBeLessThan(0.15 * DEG);
    expect(missAt1m(fit, truth)).toBeLessThan(1.5 * MM);
  });

  it('rejects a bad sample', () => {
    const truth = truthOf([-0.012, 0.009, 0.015]);
    const samples = runSamples(truth, { tip: 0.002, mark: 0.005, aim: 0.2 * DEG }, 7);
    // Pinched before the fingertip reached the cross: about 9 degrees off.
    const bad = samples[4] as CalibrationSample;
    samples[4] = { head: bad.head, uv: [bad.uv[0] + 0.1, bad.uv[1] - 0.06] };
    const fit = calibrateCamera(samples, K, DEFAULT_HEAD_FROM_CAMERA);
    expect(fit.samples[4]?.inlier).toBe(false);
    expect(fit.inliers).toBe(14);
    expect(missAt1m(fit, truth)).toBeLessThan(8 * MM);
  });

  // Truth off the guess in orientation and focal length, as it may well be: a near-only run hides
  // that in a wrong position and still looks fine at 0.3 to 0.5 m. 3 mm fingertip noise, 1 cm mark
  // placement error, 0.3 degree aiming error.
  const NOISY: Noise = { tip: 0.003, mark: 0.01, aim: 0.3 * DEG };
  const cases: [string, Truth][] = [
    ['orientation as guessed', truthOf([0.009, -0.006, 0.012])],
    ['pitched 2 degrees off', truthOf([0.009, -0.006, 0.012], 0, 2 * DEG)],
    ['fx 860', truthOf([0.009, -0.006, 0.012], 0, 0, 0, 860)],
    ['all off', truthOf([0.009, -0.006, 0.012], 1.5 * DEG, -2 * DEG, 0.5 * DEG, 760)],
  ];

  it.each(cases)('is good at 1 m with far marks when %s (Monte Carlo)', (_, truth) => {
    const misses: number[] = [];
    const predicted: number[] = [];
    for (let run = 0; run < 60; run++) {
      const fit = calibrateCamera(runSamples(truth, NOISY, 100 + run), K, DEFAULT_HEAD_FROM_CAMERA);
      misses.push(missAt1m(fit, truth));
      predicted.push(fit.predictedMiss);
    }
    expect(quantile(misses, 0.5)).toBeLessThan(7 * MM);
    expect(quantile(misses, 0.9)).toBeLessThan(11 * MM);
    // The predicted miss tracks the real one (it errs a little on the safe side).
    const ratio = quantile(predicted, 0.5) / quantile(misses, 0.5);
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(2);
  });

  it('predicts a large miss for a near-only run, so it is not saved', () => {
    const truth = truthOf([0.009, -0.006, 0.012], 0, 2 * DEG);
    const predicted: number[] = [];
    for (let run = 0; run < 30; run++) {
      const samples = runSamples(truth, NOISY, 300 + run, false);
      const fit = calibrateCamera(samples, K, DEFAULT_HEAD_FROM_CAMERA);
      predicted.push(fit.predictedMiss);
      expect(fit.heldOutAngle).toBeNull();
    }
    expect(quantile(predicted, 0.5)).toBeGreaterThan(12 * MM);
  });

  it('keeps the minimum number of samples however bad they are', () => {
    const truth = truthOf([0, 0, 0]);
    const r = rng(3);
    const samples = runSamples(truth, EXACT, 3).map((s) => ({
      head: s.head,
      uv: [s.uv[0] + (r.uniform() - 0.5) * 0.2, s.uv[1] + (r.uniform() - 0.5) * 0.2] as [
        number,
        number,
      ],
    }));
    const fit = solveCameraPose(samples, K, DEFAULT_HEAD_FROM_CAMERA, { minInliers: 6 });
    expect(fit.inliers).toBeGreaterThanOrEqual(6);
    expect(Number.isFinite(fit.rmsDistance)).toBe(true);
  });

  it('projects points consistently with the rays', () => {
    const truth = truthOf([0.003, 0.002, 0.001]);
    for (const uv of GRID) {
      const back = projectToUv(K, truth.pose, pointOnRay(K, truth.pose, uv, 0.7));
      expect(back?.[0]).toBeCloseTo(uv[0], 9);
      expect(back?.[1]).toBeCloseTo(uv[1], 9);
    }
    expect(projectToUv(K, truth.pose, add(truth.pose.p, [0, 0, 0.3]))).toBeNull();
  });
});
