import type { Pose, Vec3 } from '../core/math';
import type { CameraIntrinsics } from '../domain/world/camera-model';
import {
  type CalibrationFit,
  type CalibrationSample,
  calibrateCamera,
  projectToUv,
  rayAngle,
  uvToNormalized,
} from './solver';
import {
  type CalibrationStep,
  calibrationSteps,
  fingerTargets,
  markTargets,
  type StepPlan,
} from './targets';

// The calibration run: a crosshair per step, a sample per confirmed pinch, then the fit. Fingertip
// steps pair the steady fingertip with the crosshair; place steps put a mark on a real surface 1 to
// 3 m away; mark steps pair that mark with the crosshair the user turned the head to put it under.
// A sample is refused at once when the point wasn't held still, or when it is so far from the
// crosshair (under the starting guess) that the user can't have been aiming at it. Samples the fit
// rejects are replaced by extra steps of the same kind, up to a limit, so one bad pinch doesn't
// spoil the run. A result is saved only if it is good at working distance (solver.ts).

const DEG = Math.PI / 180;

export interface FlowOptions {
  intrinsics: CameraIntrinsics;
  /** The starting guess (the browser's lens pose, else the Quest 3 default). */
  initial: Pose;
  plan?: StepPlan;
  /** Most steps in a run, replacements included. */
  maxSteps?: number;
  /** Samples of each kind the fit must keep for a usable result. */
  minFingerInliers?: number;
  minMarkInliers?: number;
  /** A result whose predicted miss at 1 m is larger than this is not saved (mm). */
  maxMissMm?: number;
  /** ...or whose far samples, each predicted without itself, are off by more than this (deg). */
  maxHeldOutDeg?: number;
  /** ...or whose samples are off by more than this, RMS (deg). */
  maxErrorDeg?: number;
  /** Farther than this from the crosshair under the guess (deg): refused as not aimed. */
  maxAimDeg?: number;
  /** A mark must be at least this far away (m). */
  minMarkDistance?: number;
  seed?: number;
}

export type CaptureResult =
  | { kind: 'taken' }
  | { kind: 'unsteady' }
  | { kind: 'off-target' }
  | { kind: 'placed' }
  | { kind: 'no-surface' }
  | { kind: 'too-close' }
  | { kind: 'more'; added: number }
  | { kind: 'done'; fit: CalibrationFit; usable: boolean }
  | { kind: 'idle' };

type SampleKind = 'finger' | 'mark';

/** A run so far, to resume after a reload or a new AR session (the page stores it every step). */
export interface FlowProgress {
  version: 1;
  seed: number;
  steps: CalibrationStep[];
  index: number;
  samples: CalibrationSample[];
  kinds: SampleKind[];
  /** The camera it was measured against; progress for another one is not resumed. */
  intrinsics: { width: number; height: number; fx: number };
}

export class CalibrationFlow {
  readonly samples: CalibrationSample[] = [];
  /** What each sample is: a fingertip or a mark. */
  readonly kinds: SampleKind[] = [];
  private steps: CalibrationStep[];
  private index = 0;
  private result: CalibrationFit | null = null;
  private readonly o: Required<FlowOptions>;

  constructor(options: FlowOptions) {
    this.o = {
      plan: {},
      maxSteps: 24,
      minFingerInliers: 7,
      minMarkInliers: 4,
      maxMissMm: 12,
      maxHeldOutDeg: 1.5,
      maxErrorDeg: 3,
      maxAimDeg: 12,
      minMarkDistance: 0.8,
      seed: Date.now(),
      ...options,
    };
    this.steps = calibrationSteps(this.o.seed, this.o.plan);
  }

  /** The step to do, or null once the run is solved. */
  get step(): CalibrationStep | null {
    return this.result ? null : (this.steps[this.index] ?? null);
  }

  /** Steps done, and in the run. */
  get taken(): number {
    return this.index;
  }

  get total(): number {
    return this.steps.length;
  }

  get fit(): CalibrationFit | null {
    return this.result;
  }

  get initial(): Pose {
    return this.o.initial;
  }

  /** Samples of `kind` the fit kept. */
  kept(fit: CalibrationFit, kind: SampleKind): number {
    return fit.samples.filter((s, i) => s.inlier && this.kinds[i] === kind).length;
  }

  /** Whether a fit is good enough to save: judged by its miss at working distance. */
  usable(fit: CalibrationFit): boolean {
    return (
      this.kept(fit, 'finger') >= Math.min(6, this.o.minFingerInliers) &&
      this.kept(fit, 'mark') >= Math.min(3, this.o.minMarkInliers) &&
      fit.predictedMiss * 1000 <= this.o.maxMissMm &&
      fit.heldOutAngle !== null &&
      fit.heldOutAngle <= this.o.maxHeldOutDeg * DEG &&
      fit.rmsAngle <= this.o.maxErrorDeg * DEG
    );
  }

  /** A place step: the user pinched with the gaze on a surface `distance` m away (null: none). */
  place(distance: number | null): CaptureResult {
    if (this.step?.kind !== 'place') return { kind: 'idle' };
    if (distance === null) return { kind: 'no-surface' };
    if (distance < this.o.minMarkDistance) return { kind: 'too-close' };
    this.index++;
    return { kind: 'placed' };
  }

  /**
   * The user confirmed the point (fingertip or mark) is under the crosshair. `point` is its steady
   * position in the head frame, or null when it wasn't held still (or isn't tracked).
   */
  capture(point: Readonly<Vec3> | null): CaptureResult {
    const step = this.step;
    if (!step || step.kind === 'place') return { kind: 'idle' };
    if (!point) return { kind: 'unsteady' };
    const k = this.o.intrinsics;
    const predicted = projectToUv(k, this.o.initial, point);
    if (!predicted) return { kind: 'off-target' };
    const aim = rayAngle(uvToNormalized(k, predicted), uvToNormalized(k, step.uv));
    if (aim > this.o.maxAimDeg * DEG) return { kind: 'off-target' };
    this.samples.push({ head: [point[0], point[1], point[2]], uv: [...step.uv] });
    this.kinds.push(step.kind);
    this.index++;
    if (this.index < this.steps.length) return { kind: 'taken' };
    return this.solve();
  }

  /**
   * The run so far, or null before the first step and once solved. Samples are in the head frame,
   * so they stay valid in a later session; a placed mark lives in its session's world frame, so a
   * run in the middle of a mark goes back to placing it (dropping the samples taken since).
   */
  progress(): FlowProgress | null {
    if (this.result || this.index === 0) return null;
    let index = this.index;
    if (this.steps[index]?.kind === 'mark') {
      while (index > 0 && this.steps[index]?.kind !== 'place') index--;
    }
    // Every step after the place step took one sample; the place step itself took none.
    const kept = this.samples.length - (index < this.index ? this.index - index - 1 : 0);
    const k = this.o.intrinsics;
    return {
      version: 1,
      seed: this.o.seed,
      steps: this.steps.map((s) => ({ ...s })),
      index,
      samples: this.samples.slice(0, kept).map((s) => ({ head: [...s.head], uv: [...s.uv] })),
      kinds: this.kinds.slice(0, kept),
      intrinsics: { width: k.width, height: k.height, fx: k.fx },
    };
  }

  /** Continues a stored run; false (and nothing changed) when it doesn't fit this camera. */
  restore(progress: FlowProgress): boolean {
    const k = this.o.intrinsics;
    const p = progress;
    const fits =
      p?.version === 1 &&
      p.intrinsics?.width === k.width &&
      p.intrinsics?.height === k.height &&
      p.intrinsics?.fx === k.fx &&
      Array.isArray(p.steps) &&
      Array.isArray(p.samples) &&
      Array.isArray(p.kinds) &&
      p.samples.length === p.kinds.length &&
      Number.isInteger(p.index) &&
      p.index > 0 &&
      p.index <= p.steps.length;
    if (!fits) return false;
    this.o.seed = p.seed;
    this.steps = p.steps.map((s) => ({ ...s }));
    this.index = p.index;
    this.result = null;
    this.samples.length = 0;
    this.kinds.length = 0;
    this.samples.push(
      ...p.samples.map((s) => ({ head: [...s.head] as Vec3, uv: [...s.uv] as const })),
    );
    this.kinds.push(...p.kinds);
    return true;
  }

  /** Start over with fresh steps. */
  restart(seed = Date.now()): void {
    this.samples.length = 0;
    this.kinds.length = 0;
    this.index = 0;
    this.result = null;
    this.steps = calibrationSteps(seed, this.o.plan);
  }

  private solve(): CaptureResult {
    const fit = calibrateCamera(this.samples, this.o.intrinsics, this.o.initial);
    const missingFingers = Math.max(0, this.o.minFingerInliers - this.kept(fit, 'finger'));
    const missingMarks = Math.max(0, this.o.minMarkInliers - this.kept(fit, 'mark'));
    let room = this.o.maxSteps - this.steps.length;
    let added = 0;
    if (missingFingers > 0 && room > 0) {
      const n = Math.min(missingFingers, room);
      const done = this.kinds.filter((k) => k === 'finger').length;
      this.steps.push(...fingerTargets(n, this.o.seed + 1, done));
      added += n;
      room -= n;
    }
    const lastMark = this.steps.reduce((m, s) => (s.kind === 'place' ? s.mark : m), -1);
    if (missingMarks > 0 && room > 0 && lastMark >= 0) {
      const n = Math.min(missingMarks, room);
      const done = this.steps.filter((s) => s.kind === 'mark' && s.mark === lastMark).length;
      this.steps.push(...markTargets(lastMark, n, done));
      added += n;
    }
    if (added > 0) return { kind: 'more', added };
    this.result = fit;
    return { kind: 'done', fit, usable: this.usable(fit) };
  }
}
