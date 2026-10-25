import {
  type MistakeRule,
  type ObjectSpec,
  type Procedure,
  type Step,
  safeParseProcedure,
} from '@clio/protocol';
import type { AppBus } from '../events';
import type { StepStatus } from '../plan/recital';
import { type CheckContext, type CheckEvaluator, createCheck } from './checks';

// The single source of truth for lesson progress. The plan is a list of steps, each todo, done or
// skipped; the focused step is the one being worked on (the HUD shows it and the dataset labels
// frames with it). Steps can be completed in any order. Checks complete the focused step on their
// own; the coach and the user complete steps through `complete()`, and every completion records who
// decided and whether the step's check had actually passed (`forced`), so the dataset can filter.
// The coach also edits the plan as the lesson goes: steps are added, reworded, skipped, reopened.
//
// Progress may be limited to trusted object positions (see `update`). Checks and mistake rules then
// run twice, as separate trees: one on trusted positions and one on every position. The tree that
// is in charge completes the step and fires mistakes; the full tree always decides `forced`, so the
// label means the same whoever is in charge. Neither tree's state leaks into the other's.

export type RunnerStatus = 'idle' | 'running' | 'completed' | 'aborted';
export type Decider = 'coach' | 'user';

export interface RunnerOptions {
  /** May the coach complete a step whose check hasn't passed? (Labeled forced either way.) */
  coachCanForce?: boolean;
}

export interface RunnerState {
  status: RunnerStatus;
  procedure: Procedure;
  /** Index of the focused step in the procedure. */
  stepIndex: number;
  /** The focused step, while running. */
  step: Step | null;
  stepStartT: number;
  /** 0..1 progress of the focused step's success check. */
  progress: number;
  statuses: Readonly<Record<string, StepStatus>>;
}

export type AdvanceResult = { ok: true; forced: boolean } | { ok: false; error: string };
export type CompleteResult =
  | { ok: true; forced: boolean; already: boolean }
  | { ok: false; error: string };
export type ChangeResult = { ok: true } | { ok: false; error: string };

/** A check context minus what the runner owns. */
export type FrameContext = Omit<CheckContext, 'stepStartT' | 'confirmations'>;
export type ObjectPositions = FrameContext['objects'];

/** Positions progress may rely on, and whether only those count right now. */
export interface Trust {
  positions: ObjectPositions;
  inCharge: boolean;
}

/** Before the first tracked frame: no hands, no object positions. */
const emptyFrame = (t: number): FrameContext => ({
  t,
  frame: { t, head: { p: [0, 0, 0], q: [0, 0, 0, 1] }, left: null, right: null },
  pinching: { left: false, right: false },
  objects: { position: () => undefined },
});

interface MistakeWatch {
  rule: MistakeRule;
  /** On trusted positions, and on every position. */
  trusted: CheckEvaluator;
  full: CheckEvaluator;
  wasSatisfied: boolean;
  lastFired: number;
}

const notRunning = { ok: false, error: 'No lesson is running.' } as const;

export class ProcedureRunner {
  private status: RunnerStatus = 'idle';
  private focusId: string | null = null;
  private readonly statuses = new Map<string, StepStatus>();
  private startT = 0;
  private stepStartT = 0;
  private progress = 0;
  /** The step's check on trusted positions only. */
  private success: CheckEvaluator | null = null;
  /** The same check on every object position; decides `forced`. */
  private full: CheckEvaluator | null = null;
  private mistakes: MistakeWatch[] = [];
  private confirmations = { coach: false, user: false };
  private decidedBy: Decider | null = null;
  private stuckReported = false;
  private lastFrame: FrameContext | null = null;
  private lastTrust: Trust | null = null;

  constructor(
    private procedure: Procedure,
    private readonly bus: AppBus,
    private readonly options: RunnerOptions = {},
  ) {
    for (const step of procedure.steps) this.statuses.set(step.id, 'todo');
  }

  get state(): RunnerState {
    const index = this.focusIndex();
    return {
      status: this.status,
      procedure: this.procedure,
      stepIndex: index < 0 ? this.procedure.steps.length - 1 : index,
      step: this.status === 'running' ? (this.procedure.steps[index] ?? null) : null,
      stepStartT: this.stepStartT,
      progress: this.progress,
      statuses: Object.fromEntries(this.statuses),
    };
  }

  statusOf(stepId: string): StepStatus | undefined {
    return this.statuses.get(stepId);
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
    this.focusNext(t);
  }

  /**
   * Evaluate the focused step on a tracked frame. With `trust`, the trusted tree sees only its
   * positions, and it alone completes steps and fires mistakes while `trust.inCharge`.
   */
  update(frame: FrameContext, trust?: Trust): void {
    if (!this.success || !this.full || this.status !== 'running') return;
    this.lastFrame = frame;
    this.lastTrust = trust ?? null;
    const full = this.context(frame);
    const ctx = trust ? this.context({ ...frame, objects: trust.positions }) : full;
    const useTrusted = trust?.inCharge ?? false;
    const step = this.focused();
    if (!step) return;

    for (const watch of this.mistakes) {
      const trusted = watch.trusted.update(ctx);
      const all = watch.full.update(full);
      const s = useTrusted ? trusted : all;
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

    const trusted = this.success.update(ctx);
    const all = this.full.update(full);
    const status = useTrusted ? trusted : all;
    this.progress = status.progress;
    if (status.satisfied) {
      this.finish(step, this.decidedBy ?? 'check', !all.satisfied, ctx.t);
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

  /** Latch a confirmation for the focused step; it takes effect on the next update. */
  confirm(by: Decider): void {
    this.confirmations[by] = true;
    this.decidedBy = by;
  }

  /** Complete the focused step (the user's Done button). */
  advance(by: Decider, _reason: string, t: number): AdvanceResult {
    const r = this.complete(null, by, t);
    return r.ok ? { ok: true, forced: r.forced } : r;
  }

  /**
   * Complete a step, the focused one by default. Any todo or skipped step can be completed; a step
   * that isn't focused never had its check evaluated, so its completion is labeled forced. `check`
   * is the app having seen it done (the step watcher): it confirms nothing for the step's check.
   */
  complete(stepId: string | null, by: Decider | 'check', t: number): CompleteResult {
    if (this.status !== 'running') return notRunning;
    const step = stepId === null ? this.focused() : this.find(stepId);
    if (!step) return { ok: false, error: this.unknownStep(stepId ?? '') };
    if (this.statuses.get(step.id) === 'done') return { ok: true, forced: false, already: true };
    const policy = by === 'coach' && this.options.coachCanForce === false;
    if (step.id !== this.focusId) {
      // Only the focused step is checked, so this completion is unverified.
      if (policy) return { ok: false, error: `Step "${step.id}" isn't being worked on yet.` };
      this.finish(step, by, true, t);
      return { ok: true, forced: true, already: false };
    }
    if (by !== 'check') this.confirm(by);
    const frame = { ...(this.lastFrame ?? emptyFrame(t)), t };
    const trust = this.lastTrust;
    this.success?.update(this.context(trust ? { ...frame, objects: trust.positions } : frame));
    const forced = !(this.full?.update(this.context(frame)).satisfied ?? false);
    if (forced && policy) {
      return {
        ok: false,
        error: `Step "${step.id}" is not done yet; the app has not detected it.`,
      };
    }
    this.finish(step, by, forced, t);
    return { ok: true, forced, already: false };
  }

  /** The step isn't needed or can't be done. */
  skip(stepId: string, t: number): ChangeResult {
    if (this.status !== 'running') return notRunning;
    const step = this.find(stepId);
    if (!step) return { ok: false, error: this.unknownStep(stepId) };
    const status = this.statuses.get(step.id);
    if (status === 'done') return { ok: false, error: `Step "${step.id}" is already done.` };
    if (status === 'skipped') return { ok: true };
    this.statuses.set(step.id, 'skipped');
    this.bus.emit('step.completed', {
      t,
      stepId: step.id,
      index: this.indexOf(step.id),
      by: 'skip',
      forced: true,
      durationMs: step.id === this.focusId ? t - this.stepStartT : 0,
    });
    if (step.id === this.focusId) this.focusNext(t);
    return { ok: true };
  }

  /** Work on a step now, reopening it if it was done or skipped. */
  focus(stepId: string, t: number): ChangeResult {
    if (this.status !== 'running') return notRunning;
    const step = this.find(stepId);
    if (!step) return { ok: false, error: this.unknownStep(stepId) };
    this.statuses.set(step.id, 'todo');
    if (step.id !== this.focusId) this.enter(step.id, t);
    return { ok: true };
  }

  /** Make a done or skipped step todo again without moving the focus. */
  reopen(stepId: string): ChangeResult {
    if (this.status !== 'running') return notRunning;
    const step = this.find(stepId);
    if (!step) return { ok: false, error: this.unknownStep(stepId) };
    this.statuses.set(step.id, 'todo');
    return { ok: true };
  }

  /** Add a step after `afterId`, or at the end. The focus stays where it is. */
  insert(step: Step, afterId: string | null): ChangeResult {
    if (this.status !== 'running') return notRunning;
    if (this.statuses.has(step.id))
      return { ok: false, error: `Step "${step.id}" already exists.` };
    let at = this.procedure.steps.length;
    if (afterId !== null) {
      const i = this.indexOf(afterId);
      if (i < 0) return { ok: false, error: this.unknownStep(afterId) };
      at = i + 1;
    }
    const steps = [...this.procedure.steps];
    steps.splice(at, 0, step);
    const r = this.revalidate({ ...this.procedure, steps });
    if (r.ok) this.statuses.set(step.id, 'todo');
    return r;
  }

  /** Reword a step that isn't done. The focused step keeps its check state. */
  edit(stepId: string, patch: Partial<Pick<Step, 'instruction' | 'doneWhen'>>): ChangeResult {
    if (this.status !== 'running') return notRunning;
    const step = this.find(stepId);
    if (!step) return { ok: false, error: this.unknownStep(stepId) };
    if (this.statuses.get(step.id) === 'done') {
      return { ok: false, error: `Step "${step.id}" is already done; reopen it to change it.` };
    }
    const steps = this.procedure.steps.map((s) => (s.id === step.id ? { ...s, ...patch } : s));
    return this.revalidate({ ...this.procedure, steps });
  }

  /** Declare another object (a material the plan didn't list). */
  addObject(spec: ObjectSpec): ChangeResult {
    if (this.procedure.objects.some((o) => o.id === spec.id)) {
      return { ok: false, error: `Object "${spec.id}" already exists.` };
    }
    return this.revalidate({ ...this.procedure, objects: [...this.procedure.objects, spec] });
  }

  goTo(stepId: string, t: number): boolean {
    return this.focus(stepId, t).ok;
  }

  abort(reason: string, t: number): void {
    if (this.status !== 'running') return;
    this.status = 'aborted';
    this.bus.emit('procedure.aborted', { t, reason });
  }

  /**
   * Swap in a revised plan. Steps are matched by id: kept steps keep their status, new ones are
   * todo, and steps the revision left out are gone. The focused step keeps the focus if the
   * revision left it as it was; otherwise the focus goes to the first step still to do.
   */
  replacePlan(procedure: Procedure, t: number): void {
    const before = this.focused();
    const previous = new Map(this.statuses);
    this.procedure = procedure;
    this.statuses.clear();
    for (const step of procedure.steps) this.statuses.set(step.id, previous.get(step.id) ?? 'todo');
    if (this.status !== 'running') return;
    const now = before ? this.find(before.id) : undefined;
    const unchanged = now && JSON.stringify(now) === JSON.stringify(before);
    if (!unchanged || this.statuses.get(now.id) !== 'todo') this.focusNext(t);
  }

  private find(stepId: string): Step | undefined {
    return this.procedure.steps.find((s) => s.id === stepId);
  }

  private indexOf(stepId: string): number {
    return this.procedure.steps.findIndex((s) => s.id === stepId);
  }

  private focusIndex(): number {
    return this.focusId === null ? -1 : this.indexOf(this.focusId);
  }

  private focused(): Step | null {
    return this.focusId === null ? null : (this.find(this.focusId) ?? null);
  }

  private unknownStep(stepId: string): string {
    return `Unknown step "${stepId}". Steps: ${this.procedure.steps.map((s) => s.id).join(', ')}.`;
  }

  private revalidate(candidate: Procedure): ChangeResult {
    const r = safeParseProcedure(candidate);
    if (!r.ok) return { ok: false, error: r.error };
    this.procedure = r.procedure;
    return { ok: true };
  }

  private context(frame: FrameContext): CheckContext {
    return { ...frame, stepStartT: this.stepStartT, confirmations: { ...this.confirmations } };
  }

  private enter(stepId: string, t: number): void {
    const index = this.indexOf(stepId);
    const step = this.procedure.steps[index];
    if (!step) return;
    this.focusId = step.id;
    this.stepStartT = t;
    this.progress = 0;
    this.success = createCheck(step.success);
    this.full = createCheck(step.success);
    this.mistakes = step.mistakes.map((rule) => ({
      rule,
      trusted: createCheck(rule.when),
      full: createCheck(rule.when),
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

  /** Focus the first step still to do, in list order, or finish the lesson. */
  private focusNext(t: number): void {
    const next = this.procedure.steps.find((s) => this.statuses.get(s.id) === 'todo');
    if (next) {
      this.enter(next.id, t);
      return;
    }
    this.focusId = null;
    this.status = 'completed';
    this.success = null;
    this.full = null;
    this.bus.emit('procedure.completed', { t, durationMs: t - this.startT });
  }

  private finish(step: Step, by: Decider | 'check', forced: boolean, t: number): void {
    const focused = step.id === this.focusId;
    this.statuses.set(step.id, 'done');
    this.bus.emit('step.completed', {
      t,
      stepId: step.id,
      index: this.indexOf(step.id),
      by,
      forced,
      durationMs: focused ? t - this.stepStartT : 0,
    });
    if (focused) this.focusNext(t);
  }
}
