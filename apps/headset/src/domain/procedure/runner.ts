import type { MistakeRule, Procedure, Step } from '@clio/protocol';
import type { AppBus } from '../events';
import { type CheckContext, type CheckEvaluator, createCheck } from './checks';

// The single source of truth for lesson progress. Checks advance steps on their own; the coach and
// the user can confirm or advance through `advance()`, and every completion records who decided and
// whether the step's check had actually passed (`forced`), so the dataset can filter.

export type RunnerStatus = 'idle' | 'running' | 'completed' | 'aborted';
export type Decider = 'coach' | 'user';

export interface RunnerOptions {
  /** May the coach complete a step whose check hasn't passed? (Labeled forced either way.) */
  coachCanForce?: boolean;
}

export interface RunnerState {
  status: RunnerStatus;
  procedure: Procedure;
  stepIndex: number;
  step: Step | null;
  stepStartT: number;
  /** 0..1 progress of the current step's success check. */
  progress: number;
}

export type AdvanceResult = { ok: true; forced: boolean } | { ok: false; error: string };

/** A check context minus what the runner owns. */
export type FrameContext = Omit<CheckContext, 'stepStartT' | 'confirmations'>;

/** Before the first tracked frame: no hands, no object positions. */
const emptyFrame = (t: number): FrameContext => ({
  t,
  frame: { t, head: { p: [0, 0, 0], q: [0, 0, 0, 1] }, left: null, right: null },
  pinching: { left: false, right: false },
  objects: { position: () => undefined },
});

interface MistakeWatch {
  rule: MistakeRule;
  evaluator: CheckEvaluator;
  wasSatisfied: boolean;
  lastFired: number;
}

export class ProcedureRunner {
  private status: RunnerStatus = 'idle';
  private index = 0;
  private startT = 0;
  private stepStartT = 0;
  private progress = 0;
  private success: CheckEvaluator | null = null;
  private mistakes: MistakeWatch[] = [];
  private confirmations = { coach: false, user: false };
  private decidedBy: Decider | null = null;
  private stuckReported = false;
  private lastFrame: FrameContext | null = null;

  constructor(
    private procedure: Procedure,
    private readonly bus: AppBus,
    private readonly options: RunnerOptions = {},
  ) {}

  get state(): RunnerState {
    return {
      status: this.status,
      procedure: this.procedure,
      stepIndex: this.index,
      step: this.status === 'running' ? (this.procedure.steps[this.index] ?? null) : null,
      stepStartT: this.stepStartT,
      progress: this.progress,
    };
  }

  start(t: number): void {
    this.status = 'running';
    this.startT = t;
    this.bus.emit('procedure.started', {
      t,
      procedureId: this.procedure.id,
      version: this.procedure.version,
      stepCount: this.procedure.steps.length,
    });
    this.enter(0, t);
  }

  update(frame: FrameContext): void {
    if (this.status !== 'running' || !this.success) return;
    this.lastFrame = frame;
    const ctx = this.context(frame);
    const step = this.currentStep();

    for (const watch of this.mistakes) {
      const s = watch.evaluator.update(ctx);
      const rising = s.satisfied && !watch.wasSatisfied;
      watch.wasSatisfied = s.satisfied;
      if (rising && ctx.t - watch.lastFired >= watch.rule.cooldownMs) {
        watch.lastFired = ctx.t;
        this.bus.emit('mistake.detected', {
          t: ctx.t,
          stepId: step.id,
          kind: watch.rule.kind,
          message: watch.rule.message,
          source: 'rule',
        });
      }
    }

    const status = this.success.update(ctx);
    this.progress = status.progress;
    if (status.satisfied) {
      this.complete(this.decidedBy ?? 'check', false, ctx.t);
      return;
    }

    if (step.stuckAfterMs && !this.stuckReported && ctx.t - this.stepStartT >= step.stuckAfterMs) {
      this.stuckReported = true;
      this.bus.emit('step.stuck', {
        t: ctx.t,
        stepId: step.id,
        elapsedMs: ctx.t - this.stepStartT,
      });
    }
  }

  /** Latch a confirmation for the current step; it takes effect on the next update. */
  confirm(by: Decider): void {
    this.confirmations[by] = true;
    this.decidedBy = by;
  }

  /** The coach's advance_step, or a user's "next". */
  advance(by: Decider, _reason: string, t: number): AdvanceResult {
    if (this.status !== 'running' || !this.success) {
      return { ok: false, error: 'No step is active.' };
    }
    this.confirm(by);
    const frame = this.lastFrame ?? emptyFrame(t);
    if (this.success.update(this.context({ ...frame, t })).satisfied) {
      this.complete(by, false, t);
      return { ok: true, forced: false };
    }
    if (by === 'coach' && this.options.coachCanForce === false) {
      return {
        ok: false,
        error: `Step "${this.currentStep().id}" is not done yet; the app has not detected it.`,
      };
    }
    this.complete(by, true, t);
    return { ok: true, forced: true };
  }

  goTo(stepId: string, t: number): boolean {
    const i = this.procedure.steps.findIndex((s) => s.id === stepId);
    if (i < 0 || this.status !== 'running') return false;
    this.enter(i, t);
    return true;
  }

  abort(reason: string, t: number): void {
    if (this.status !== 'running') return;
    this.status = 'aborted';
    this.bus.emit('procedure.aborted', { t, reason });
  }

  /**
   * Swap in a revised plan. Steps before the current one are unchanged by construction; the
   * current step is re-entered if the revision replaced it.
   */
  replacePlan(procedure: Procedure, t: number): void {
    const before = this.procedure.steps[this.index];
    this.procedure = procedure;
    if (this.status !== 'running') return;
    const now = procedure.steps[this.index];
    if (!now) {
      this.status = 'completed';
      this.bus.emit('procedure.completed', { t, durationMs: t - this.startT });
    } else if (JSON.stringify(now) !== JSON.stringify(before)) {
      this.enter(this.index, t);
    }
  }

  private currentStep(): Step {
    const step = this.procedure.steps[this.index];
    if (!step) throw new Error(`No step at index ${this.index}`);
    return step;
  }

  private context(frame: FrameContext): CheckContext {
    return { ...frame, stepStartT: this.stepStartT, confirmations: { ...this.confirmations } };
  }

  private enter(index: number, t: number): void {
    const step = this.procedure.steps[index];
    if (!step) return;
    this.index = index;
    this.stepStartT = t;
    this.progress = 0;
    this.success = createCheck(step.success);
    this.mistakes = step.mistakes.map((rule) => ({
      rule,
      evaluator: createCheck(rule.when),
      wasSatisfied: false,
      lastFired: Number.NEGATIVE_INFINITY,
    }));
    this.confirmations = { coach: false, user: false };
    this.decidedBy = null;
    this.stuckReported = false;
    this.bus.emit('step.entered', {
      t,
      stepId: step.id,
      index,
      instruction: step.instruction,
      targets: step.targets,
    });
  }

  private complete(by: Decider | 'check', forced: boolean, t: number): void {
    const step = this.currentStep();
    this.bus.emit('step.completed', {
      t,
      stepId: step.id,
      index: this.index,
      by,
      forced,
      durationMs: t - this.stepStartT,
    });
    if (this.index + 1 < this.procedure.steps.length) {
      this.enter(this.index + 1, t);
    } else {
      this.status = 'completed';
      this.success = null;
      this.bus.emit('procedure.completed', { t, durationMs: t - this.startT });
    }
  }
}
