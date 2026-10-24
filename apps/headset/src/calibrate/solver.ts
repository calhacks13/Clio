import {
  length,
  normalize,
  type Pose,
  type Quat,
  quatConjugate,
  quatFromAxisAngle,
  quatMultiply,
  quatNormalize,
  rotateVec,
  sub,
  type Vec3,
} from '../core/math';
import type { CameraIntrinsics } from '../domain/world/camera-model';

// Solves where the passthrough camera sits on the headset, how it is turned and its focal length,
// from point/pixel pairs: each sample is a point in the head (XR viewer) frame and the normalized
// image position it appeared at in the camera feed (the crosshair it was held under). Points come
// from the right index fingertip (0.3 to 0.6 m) and from marks on real surfaces 1 to 3 m away
// (placed with hit-test). Near points alone can't tell a turn of the camera, or a wrong focal
// length, from a shift: over 0.3 to 0.5 m a 2 degree pitch error looks like a 1 to 2 cm shift.
// Far points barely move with the camera's position, so they pin the orientation and the focal
// length, and the near points then pin the position.
//
// Unknowns: position, yaw/pitch/roll on top of the guessed orientation, and a focal scale (fx and
// fy together; the principal point stays at the guess, a small offset of it acts as a turn).
// Levenberg-Marquardt with a Huber loss and a weak prior around the guess, then samples far from
// the fit are rejected and the fit repeated. Residuals are differences in normalized image
// coordinates (x / -z, y / -z), which are angles in radians near the image center.
//
// The result is judged at working distance, not by the residual at the samples' depths: the
// parameter covariance is propagated to the camera rays 1 m out (predicted miss), and each far
// sample is predicted from a fit without it (held-out error), which catches a model that explains
// the samples but not the scene.

export interface CalibrationSample {
  /** The point in the head frame (m): x right, y up, -z forward. */
  head: Vec3;
  /** Where it appeared in the camera image, normalized 0..1 (x right, y down). */
  uv: readonly [number, number];
}

/** Which orientation corrections to solve for, on top of the camera position. */
export type RotationFreedom = 'none' | 'yawPitch' | 'full';

export interface SolveOptions {
  rotation?: RotationFreedom;
  /** Solve for a focal scale too. */
  focal?: boolean;
  /** Per-sample error below which the loss is quadratic (rad). */
  huber?: number;
  /** Prior widths around the initial guess: position (m), rotation (rad), log focal scale. */
  priorPosition?: number;
  priorRotation?: number;
  priorFocal?: number;
  /** Rejection threshold: max(this many robust sigmas, minOutlier). */
  outlierSigmas?: number;
  /** Errors below this (rad) are never rejected: hand tracking alone is about this good. */
  minOutlier?: number;
  /** Never keep fewer samples than this. */
  minInliers?: number;
}

export interface SampleFit {
  /** Angle between the observed and predicted rays (rad). */
  angle: number;
  /** That angle as a distance at the point's depth (m). */
  distance: number;
  /** The point's distance from the camera (m). */
  depth: number;
  inlier: boolean;
}

export interface CalibrationFit {
  headFromCamera: Pose;
  /** The intrinsics with the solved focal length. */
  intrinsics: CameraIntrinsics;
  rotation: RotationFreedom;
  /** Yaw (camera y), pitch (camera x) and roll (camera z) applied to the guess (rad). */
  yaw: number;
  pitch: number;
  roll: number;
  /** Solved focal length over the guessed one. */
  focalScale: number;
  samples: SampleFit[];
  inliers: number;
  /** Root mean square over inliers: angle (rad) and distance at the point's depth (m). */
  rmsAngle: number;
  rmsDistance: number;
  /** Expected distance between the solved and the true camera rays 1 m out, RMS over the image (m). */
  predictedMiss: number;
  /** RMS angle of far inliers, each predicted by a fit without it (rad); null without far samples. */
  heldOutAngle: number | null;
  /** Far inliers (points beyond FAR_DEPTH). */
  farInliers: number;
}

const DEG = Math.PI / 180;
const DEFAULTS: Required<SolveOptions> = {
  rotation: 'full',
  focal: true,
  huber: 1.0 * DEG,
  priorPosition: 0.03,
  priorRotation: 5 * DEG,
  priorFocal: 0.1,
  outlierSigmas: 3,
  minOutlier: 2 * DEG,
  minInliers: 6,
};
/** The residual scale the priors are weighed against in the fit (rad). */
const MEASUREMENT_SIGMA = 0.01;
/** The noise level assumed at least when propagating the covariance (rad). */
const MIN_SIGMA = 0.2 * DEG;
/** Points closer to the camera plane than this are treated as behind it (m). */
const MIN_DEPTH = 0.02;
const BEHIND_PENALTY = 1;
/** Points at least this far from the camera count as far (m). */
export const FAR_DEPTH = 0.8;
/** The distance the predicted miss is reported at (m). */
export const WORKING_DISTANCE = 1;
const GRID = [0.2, 0.5, 0.8];

/** The camera orientation: the guess turned by yaw (camera y), pitch (camera x), roll (camera z). */
export function correctedRotation(q0: Readonly<Quat>, yaw: number, pitch: number, roll = 0): Quat {
  const turn = quatMultiply(
    quatMultiply(quatFromAxisAngle([0, 1, 0], yaw), quatFromAxisAngle([1, 0, 0], pitch)),
    quatFromAxisAngle([0, 0, 1], roll),
  );
  return quatNormalize(quatMultiply(q0, turn));
}

/** A head-frame point in the camera's normalized image plane (x / -z, y / -z), or null if behind. */
export function normalizedProjection(
  headFromCamera: Pose,
  head: Readonly<Vec3>,
): [number, number] | null {
  const c = rotateVec(quatConjugate(headFromCamera.q), sub(head, headFromCamera.p));
  if (-c[2] < MIN_DEPTH) return null;
  return [c[0] / -c[2], c[1] / -c[2]];
}

/** A normalized image position (0..1, y down) in the normalized image plane (y up). */
export function uvToNormalized(
  k: CameraIntrinsics,
  uv: readonly [number, number],
): [number, number] {
  return [(uv[0] * k.width - k.cx) / k.fx, -(uv[1] * k.height - k.cy) / k.fy];
}

/** The normalized image position (0..1, y down) a head-frame point appears at, or null. */
export function projectToUv(
  k: CameraIntrinsics,
  headFromCamera: Pose,
  head: Readonly<Vec3>,
): [number, number] | null {
  const n = normalizedProjection(headFromCamera, head);
  if (!n) return null;
  return [(k.cx + k.fx * n[0]) / k.width, (k.cy - k.fy * n[1]) / k.height];
}

/** The point `distance` along the camera ray through `uv`, in the head frame. */
export function pointOnRay(
  k: CameraIntrinsics,
  headFromCamera: Pose,
  uv: readonly [number, number],
  distance: number,
): Vec3 {
  const [x, y] = uvToNormalized(k, uv);
  const d = rotateVec(headFromCamera.q, normalize([x, y, -1]));
  return [
    headFromCamera.p[0] + d[0] * distance,
    headFromCamera.p[1] + d[1] * distance,
    headFromCamera.p[2] + d[2] * distance,
  ];
}

/** The angle between two rays given in the normalized image plane (rad). */
export function rayAngle(a: readonly [number, number], b: readonly [number, number]): number {
  const ra = normalize([a[0], a[1], -1]);
  const rb = normalize([b[0], b[1], -1]);
  const cos = ra[0] * rb[0] + ra[1] * rb[1] + ra[2] * rb[2];
  const crossLen = length([
    ra[1] * rb[2] - ra[2] * rb[1],
    ra[2] * rb[0] - ra[0] * rb[2],
    ra[0] * rb[1] - ra[1] * rb[0],
  ]);
  return Math.atan2(crossLen, cos);
}

interface Problem {
  k: CameraIntrinsics;
  initial: Pose;
  rotation: RotationFreedom;
  focal: boolean;
  uv: (readonly [number, number])[];
  points: Vec3[];
}

/** Parameter layout: position (3), then the rotation angles, then the log focal scale. */
const rotationCount = (r: RotationFreedom) => (r === 'none' ? 0 : r === 'yawPitch' ? 2 : 3);
const paramCount = (problem: Problem) =>
  3 + rotationCount(problem.rotation) + (problem.focal ? 1 : 0);

interface Model {
  pose: Pose;
  k: CameraIntrinsics;
  yaw: number;
  pitch: number;
  roll: number;
  focalScale: number;
}

function modelOf(problem: Problem, x: readonly number[]): Model {
  const p: Vec3 = [x[0] ?? 0, x[1] ?? 0, x[2] ?? 0];
  const nr = rotationCount(problem.rotation);
  const yaw = nr >= 2 ? (x[3] ?? 0) : 0;
  const pitch = nr >= 2 ? (x[4] ?? 0) : 0;
  const roll = nr >= 3 ? (x[5] ?? 0) : 0;
  const focalScale = problem.focal ? Math.exp(x[3 + nr] ?? 0) : 1;
  const q = nr === 0 ? problem.initial.q : correctedRotation(problem.initial.q, yaw, pitch, roll);
  const k = { ...problem.k, fx: problem.k.fx * focalScale, fy: problem.k.fy * focalScale };
  return { pose: { p, q }, k, yaw, pitch, roll, focalScale };
}

/** The 2-vector residual of one sample under `model`. */
function residual(problem: Problem, model: Model, i: number): [number, number] {
  const point = problem.points[i] as Vec3;
  const obs = uvToNormalized(model.k, problem.uv[i] as readonly [number, number]);
  const n = normalizedProjection(model.pose, point);
  if (!n) return [BEHIND_PENALTY, BEHIND_PENALTY];
  return [n[0] - obs[0], n[1] - obs[1]];
}

/** Solves the small symmetric system A x = b by Gaussian elimination with partial pivoting. */
function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] ?? 0]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r]?.[col] ?? 0) > Math.abs(m[pivot]?.[col] ?? 0)) pivot = r;
    }
    const pivotRow = m[pivot] as number[];
    if (Math.abs(pivotRow[col] ?? 0) < 1e-15) return null;
    [m[col], m[pivot]] = [pivotRow, m[col] as number[]];
    const top = m[col] as number[];
    for (let r = col + 1; r < n; r++) {
      const row = m[r] as number[];
      const f = (row[col] ?? 0) / (top[col] ?? 1);
      for (let c = col; c <= n; c++) row[c] = (row[c] ?? 0) - f * (top[c] ?? 0);
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    const row = m[r] as number[];
    let s = row[n] ?? 0;
    for (let c = r + 1; c < n; c++) s -= (row[c] ?? 0) * (x[c] ?? 0);
    x[r] = s / (row[r] ?? 1);
  }
  return x;
}

function inverse(a: number[][]): number[][] | null {
  const n = a.length;
  const cols: number[][] = [];
  for (let j = 0; j < n; j++) {
    const col = solveLinear(
      a,
      Array.from({ length: n }, (_, i) => (i === j ? 1 : 0)),
    );
    if (!col) return null;
    cols.push(col);
  }
  return Array.from({ length: n }, (_, i) => cols.map((c) => c[i] ?? 0));
}

function priorOf(problem: Problem, o: Required<SolveOptions>): { mean: number[]; width: number[] } {
  const n = paramCount(problem);
  const nr = rotationCount(problem.rotation);
  const mean = new Array<number>(n).fill(0);
  const width = new Array<number>(n).fill(o.priorRotation);
  for (let j = 0; j < 3; j++) {
    mean[j] = problem.initial.p[j] ?? 0;
    width[j] = o.priorPosition;
  }
  if (problem.focal) width[3 + nr] = o.priorFocal;
  return { mean, width };
}

const huberWeight = (e: number, huber: number) => (e <= huber ? 1 : huber / e);

/** The weighted normal matrix J^T W J over the samples in `use`, and J^T W r. */
function normalEquations(
  problem: Problem,
  x: readonly number[],
  use: readonly boolean[],
  huber: number,
): { jtj: number[][]; jtr: number[]; ssr: number; count: number } {
  const n = paramCount(problem);
  const model = modelOf(problem, x);
  const h = 1e-6;
  const shifted = Array.from({ length: n }, (_, j) => {
    const xj = [...x];
    xj[j] = (xj[j] ?? 0) + h;
    return modelOf(problem, xj);
  });
  const jtj = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const jtr = new Array<number>(n).fill(0);
  let ssr = 0;
  let count = 0;
  for (let i = 0; i < problem.points.length; i++) {
    if (!use[i]) continue;
    const r = residual(problem, model, i);
    const e = Math.hypot(r[0], r[1]);
    const w = huberWeight(e, huber);
    ssr += w * e * e;
    count++;
    const cols = shifted.map((s) => {
      const rs = residual(problem, s, i);
      return [(rs[0] - r[0]) / h, (rs[1] - r[1]) / h];
    });
    for (let a = 0; a < n; a++) {
      const ca = cols[a] as number[];
      jtr[a] = (jtr[a] ?? 0) + w * ((ca[0] ?? 0) * r[0] + (ca[1] ?? 0) * r[1]);
      const row = jtj[a] as number[];
      for (let b = 0; b < n; b++) {
        const cb = cols[b] as number[];
        row[b] = (row[b] ?? 0) + w * ((ca[0] ?? 0) * (cb[0] ?? 0) + (ca[1] ?? 0) * (cb[1] ?? 0));
      }
    }
  }
  return { jtj, jtr, ssr, count };
}

/** Levenberg-Marquardt on the samples in `use` with Huber weights and the prior. */
function minimize(problem: Problem, use: readonly boolean[], o: Required<SolveOptions>): number[] {
  const n = paramCount(problem);
  const prior = priorOf(problem, o);
  const priorWeight = prior.width.map((w) => MEASUREMENT_SIGMA / w);
  const cost = (x: number[]): number => {
    const model = modelOf(problem, x);
    let c = 0;
    for (let i = 0; i < problem.points.length; i++) {
      if (!use[i]) continue;
      const r = residual(problem, model, i);
      const e = Math.hypot(r[0], r[1]);
      c += e <= o.huber ? e * e : 2 * o.huber * e - o.huber * o.huber;
    }
    for (let j = 0; j < n; j++) {
      c += (((x[j] ?? 0) - (prior.mean[j] ?? 0)) * (priorWeight[j] ?? 0)) ** 2;
    }
    return c;
  };

  let x = [...prior.mean];
  let lambda = 1e-3;
  let current = cost(x);
  for (let iter = 0; iter < 100; iter++) {
    const { jtj, jtr } = normalEquations(problem, x, use, o.huber);
    for (let j = 0; j < n; j++) {
      const pw = (priorWeight[j] ?? 0) ** 2;
      const row = jtj[j] as number[];
      row[j] = (row[j] ?? 0) + pw;
      jtr[j] = (jtr[j] ?? 0) + pw * ((x[j] ?? 0) - (prior.mean[j] ?? 0));
    }
    let improved = false;
    let step: number[] | null = null;
    for (let tries = 0; tries < 10; tries++) {
      const damped = jtj.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) : v)));
      step = solveLinear(
        damped,
        jtr.map((v) => -v),
      );
      if (!step) break;
      const candidate = x.map((v, j) => v + (step?.[j] ?? 0));
      const c = cost(candidate);
      if (c < current) {
        x = candidate;
        current = c;
        lambda = Math.max(lambda / 10, 1e-9);
        improved = true;
        break;
      }
      lambda *= 10;
    }
    if (!improved || !step || Math.max(...step.map(Math.abs)) < 1e-10) break;
  }
  return x;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

function evaluate(
  problem: Problem,
  model: Model,
): { angle: number; distance: number; depth: number }[] {
  return problem.points.map((point, i) => {
    const n = normalizedProjection(model.pose, point);
    const obs = uvToNormalized(model.k, problem.uv[i] as readonly [number, number]);
    const angle = n ? rayAngle(n, obs) : Math.PI;
    const depth = length(sub(point, model.pose.p));
    return { angle, distance: angle * depth, depth };
  });
}

/**
 * The expected distance between the solved and the true camera rays at `distance`, RMS over a grid
 * of image positions: the parameter covariance (from the samples kept, their scatter and the
 * prior) pushed through to points on the rays.
 */
function predictMiss(
  problem: Problem,
  x: readonly number[],
  use: readonly boolean[],
  o: Required<SolveOptions>,
  distance: number,
): number {
  const n = paramCount(problem);
  const { jtj, ssr, count } = normalEquations(problem, x, use, o.huber);
  const dof = Math.max(1, 2 * count - n);
  const sigma2 = Math.max(ssr / dof, MIN_SIGMA * MIN_SIGMA);
  const prior = priorOf(problem, o);
  const info = jtj.map((row, a) =>
    row.map((v, b) => v / sigma2 + (a === b ? 1 / (prior.width[a] ?? 1) ** 2 : 0)),
  );
  const cov = inverse(info);
  if (!cov) return Number.POSITIVE_INFINITY;
  const h = 1e-6;
  const model = modelOf(problem, x);
  const shifted = Array.from({ length: n }, (_, j) => {
    const xj = [...x];
    xj[j] = (xj[j] ?? 0) + h;
    return modelOf(problem, xj);
  });
  let total = 0;
  let cells = 0;
  for (const u of GRID) {
    for (const v of GRID) {
      const uv: [number, number] = [u, v];
      const base = pointOnRay(model.k, model.pose, uv, distance);
      // J (3 x n): how the point 1 m out moves with each parameter.
      const jac = shifted.map((s) =>
        sub(pointOnRay(s.k, s.pose, uv, distance), base).map((d) => d / h),
      );
      let variance = 0;
      for (let c = 0; c < 3; c++) {
        for (let a = 0; a < n; a++) {
          for (let b = 0; b < n; b++) {
            variance += (jac[a]?.[c] ?? 0) * (cov[a]?.[b] ?? 0) * (jac[b]?.[c] ?? 0);
          }
        }
      }
      total += variance;
      cells++;
    }
  }
  return Math.sqrt(total / cells);
}

/** Fits on `use` with outlier rejection; returns the parameters and the samples kept. */
function robustFit(
  problem: Problem,
  o: Required<SolveOptions>,
  start: readonly boolean[],
): { x: number[]; use: boolean[] } {
  let use = [...start];
  let x = minimize(problem, use, o);
  for (let round = 0; round < 5; round++) {
    const errors = evaluate(problem, modelOf(problem, x));
    const inlierAngles = errors.filter((_, i) => use[i]).map((e) => e.angle);
    const sigma = 1.4826 * median(inlierAngles);
    const threshold = Math.max(o.outlierSigmas * sigma, o.minOutlier);
    // Best first, so the floor on inliers keeps the best samples.
    const order = errors
      .map((e, i) => ({ e: e.angle, i }))
      .filter(({ i }) => start[i])
      .sort((a, b) => a.e - b.e);
    const next = problem.points.map(() => false);
    order.forEach(({ e, i }, rank) => {
      next[i] = e <= threshold || rank < o.minInliers;
    });
    if (next.every((v, i) => v === use[i])) break;
    use = next;
    x = minimize(problem, use, o);
  }
  return { x, use };
}

/**
 * The camera pose (and focal length) in the head frame that best explains the samples, starting
 * from `initial`, with outliers rejected. Needs at least 3 samples (more than minInliers to reject
 * any).
 */
export function solveCameraPose(
  samples: readonly CalibrationSample[],
  intrinsics: CameraIntrinsics,
  initial: Pose,
  options: SolveOptions = {},
): CalibrationFit {
  const o = { ...DEFAULTS, ...options };
  if (samples.length < 3) throw new Error('need at least 3 samples');
  const problem: Problem = {
    k: intrinsics,
    initial,
    rotation: o.rotation,
    focal: o.focal,
    uv: samples.map((s) => s.uv),
    points: samples.map((s) => [...s.head] as Vec3),
  };
  const { x, use } = robustFit(
    problem,
    o,
    samples.map(() => true),
  );
  const model = modelOf(problem, x);
  const errors = evaluate(problem, model);
  const fits = errors.map((e, i) => ({ ...e, inlier: use[i] ?? false }));
  const inliers = fits.filter((f) => f.inlier);
  const rms = (v: number[]) => Math.sqrt(v.reduce((s, a) => s + a * a, 0) / Math.max(1, v.length));

  // Each far inlier predicted by a fit on the other inliers (no rejection: the set is settled).
  const far = fits.flatMap((f, i) => (f.inlier && f.depth >= FAR_DEPTH ? [i] : []));
  const heldOut = far.map((i) => {
    const without = use.map((u, j) => u && j !== i);
    const m = modelOf(problem, minimize(problem, without, o));
    const n = normalizedProjection(m.pose, problem.points[i] as Vec3);
    return n
      ? rayAngle(n, uvToNormalized(m.k, problem.uv[i] as readonly [number, number]))
      : Math.PI;
  });

  return {
    headFromCamera: model.pose,
    intrinsics: model.k,
    rotation: o.rotation,
    yaw: model.yaw,
    pitch: model.pitch,
    roll: model.roll,
    focalScale: model.focalScale,
    samples: fits,
    inliers: inliers.length,
    rmsAngle: rms(inliers.map((f) => f.angle)),
    rmsDistance: rms(inliers.map((f) => f.distance)),
    predictedMiss: predictMiss(problem, x, use, o, WORKING_DISTANCE),
    heldOutAngle: far.length > 0 ? rms(heldOut) : null,
    farInliers: far.length,
  };
}

/**
 * The full model: position, yaw, pitch, roll and focal length, always. Choosing a smaller model by
 * how much it lowers the residual at the samples' depths picks the wrong one: a turn hides in a
 * shift there. With far samples the full model is well determined; without them the prior keeps
 * the turn and focal length near the guess and the predicted miss says how little is known.
 */
export function calibrateCamera(
  samples: readonly CalibrationSample[],
  intrinsics: CameraIntrinsics,
  initial: Pose,
  options: Omit<SolveOptions, 'rotation' | 'focal'> = {},
): CalibrationFit {
  return solveCameraPose(samples, intrinsics, initial, {
    ...options,
    rotation: 'full',
    focal: true,
  });
}
