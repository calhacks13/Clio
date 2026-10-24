import {
  clipIdFor,
  EPISODE_FEATURE,
  EPISODE_SCHEMA_ID,
  type EpisodeCreate,
  type EpisodeMode,
  HAND_LAYOUT,
  type ImagePayload,
  type ObjectSpec,
  type PlacementMethod,
  type PlanRequest,
  type PlanResponse,
  PROCEDURE_SCHEMA_ID,
  type Procedure,
  type Step,
  safeParseProcedure,
} from '@clio/protocol';
import type { Clock } from '../../core/clock';
import { poseToTuple } from '../../core/math';
import type { AgentState } from '../coach/agent';
import type { LessonView } from '../coach/ports';
import type { ToolHandlers, ToolOutcome } from '../coach/toolbox';
import { ClipPlayer } from '../demo/clip-player';
import type { DemoLibrary } from '../demo/demo-library';
import type { Demonstration } from '../demo/types';
import type { AppBus, HighlightStyle, LessonPhase } from '../events';
import type { PinchTransition } from '../hands/pinch-detector';
import { briefStep, type PlanOp, type PlanView, recitePlan } from '../plan/recital';
import {
  type FrameContext,
  type ObjectPositions,
  ProcedureRunner,
  type RunnerState,
} from '../procedure/runner';
import type { EpisodeRecorder } from '../recording/recorder';
import type { Grounder } from '../world/grounding';
import type { ObjectRegistry } from '../world/object-registry';
import type { Workspace } from '../world/workspace';
import { type FramesFrom, RecentFrames } from './recent-frames';
import { Spotlight } from './spotlight';
import { type StepChecker, StepWatcher, stepLooks, type WatchTarget } from './step-watcher';
import { adaptTemplate, isCalibrated, type TemplateSource } from './templates';

// The application service for a lesson. The coach decides what the lesson is; this keeps track of
// where it stands. A lesson starts from a goal: its first draft comes from a curated lesson, the
// planner (goal plus camera snapshots), or the coach itself when planning fails. The coach then
// keeps the plan true through tools (add, reword, skip, refocus, complete), and every change is
// recorded and repeated back to it, so the plan works as the coach's notes without living in its
// context. It also finds and outlines what each step shows, and runs the step watcher. See
// docs/coach-plan.md.

/** Port: the planner (the server's /api/plans). */
export interface LessonPlanner {
  plan(request: PlanRequest): Promise<PlanResponse>;
}

/** Port: camera snapshots to show the planner (and the step watcher) what the learner sees. */
export interface PlanImageSource {
  snapshots(max: number): Promise<ImagePayload[]>;
}

export type EpisodeContext = Pick<
  EpisodeCreate,
  'operator' | 'coach' | 'device' | 'app' | 'camera'
> & {
  /** Recording features the app adds to the lesson's own (e.g. "environment.planes"). */
  features?: readonly string[];
};

export interface LessonOptions {
  mode?: EpisodeMode;
  /** May the coach complete a step whose check hasn't passed? (Labeled forced.) */
  coachCanForce?: boolean;
  /** Play each step's demonstration automatically when the step starts. */
  autoDemo?: boolean;
  /** Camera snapshots sent with each planning request. */
  planImages?: number;
  /**
   * Keep a planning frame this often (ms) while a lesson may be about to start (no lesson running,
   * the learner spoke lately), so start_lesson needn't wait for fresh ones; 0 turns it off.
   */
  planFrameMs?: number;
  /** How often to look again at what the current step shows (ms); 0 only looks on step entry. */
  showRefreshMs?: number;
  /** The least time from the step watcher's last answer to its next look (ms); 0 turns it off. */
  watchMs?: number;
  /** Tell the coach planning is slow after this long (ms). */
  planSlowMs?: number;
  /** Give up on the planner after this long (ms); the coach then writes the steps. */
  planTimeoutMs?: number;
}

export interface LessonDeps {
  bus: AppBus;
  clock: Clock;
  planner: LessonPlanner;
  registry: ObjectRegistry;
  workspace: () => Workspace;
  grounder: Grounder | null;
  images: PlanImageSource | null;
  demos: DemoLibrary;
  recorder: EpisodeRecorder | null;
  context: () => EpisodeContext;
  /** Judges whether a step looks done from the camera (the step watcher); null turns it off. */
  checker?: StepChecker | null;
  /** Curated lessons the coach can start from. */
  templates?: TemplateSource | null;
  /** Wall clock, for the provenance of plans the coach writes. */
  now?: () => Date;
  options?: LessonOptions;
}

/** Who may complete steps from sensor checks: everything (local), or only trusted data (coach). */
export type Authority = 'coach' | 'local';
type Actor = 'coach' | 'user' | 'planner' | 'app';

interface Planning {
  goal: string;
  context?: string;
  revision: boolean;
  startedT: number;
  slowSent: boolean;
  attempt: number;
  /** The plan arrived and the lesson is starting: no more slow or timeout notices. */
  landed?: boolean;
}

/** How start_lesson reached the lesson's first step, recorded as lesson.first_step. */
interface FirstStepTiming {
  /** When start_lesson was called. */
  startedT: number;
  source: 'planner' | 'template';
  frames: FramesFrom;
  captureMs: number;
  /** The planner's answer, or loading the curated lesson. */
  planMs: number;
}

/** A lesson the coach writes itself, before its first step exists. */
interface CoachDraft {
  goal: string;
  objects: ObjectSpec[];
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A pinch this close to a placed object is about that object, not a registration. */
const NEAR_KNOWN_OBJECT_M = 0.08;
const PLAN_SLOW_MS = 12_000;
/** Why a stage "rest" request revises the plan, as the planner and the episode see it. */
const REFINE_REASON = 'Write the outline steps in full while the learner does the first step';
/** The planner and the step check take goals up to this long. */
const GOAL_MAX = 300;
const PLAN_TIMEOUT_MS = 45_000;
/** The step watcher looks again this soon after each answer, about every 2.5 s in all. */
const WATCH_MS = 1000;
/** Placements measured by something other than the camera's guess. */
const TRUSTED_SOURCES: ReadonlySet<PlacementMethod> = new Set(['marker', 'pinch', 'manual']);
/** Coach-written lessons have no measured layout; the same default the planner uses. */
const COACH_WORKSPACE: [number, number] = [0.8, 0.6];
/** Planning frames are kept this long after the learner last spoke (when planFrameMs is on). */
const PLAN_FRAMES_WARM_MS = 8000;

/** A lowercase id from free text, e.g. "Unscrew the blue cap." gives "unscrew-the-blue-cap". */
function slugFrom(text: string, fallback: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 4);
  return (words.join('-') || fallback).slice(0, 40).replace(/-+$/, '');
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

const sameText = (a: string, b: string) =>
  a
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, '') ===
  b
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, '');

export class LessonController {
  readonly player = new ClipPlayer();
  private currentPhase: LessonPhase = 'idle';
  private runner: ProcedureRunner | null = null;
  private planId: string | null = null;
  private goal = '';
  private rev = 0;
  /** The coach's own note for each step. */
  private readonly notes = new Map<string, string>();
  /** Every step id this lesson has used, so a dropped step's id is never given to another. */
  private readonly usedIds = new Set<string>();
  private planning: Planning | null = null;
  private attempt = 0;
  private draft: CoachDraft | null = null;
  /** Inside a call that records its own plan change, so the bus listeners don't record it too. */
  private opDepth = 0;
  /** A completion by a check or the learner, recorded once the focus has moved on. */
  private unrecorded: { op: PlanOp; by: Actor; stepId: string } | null = null;
  /** The lesson completed inside a tool call; it finishes when the call returns. */
  private finishAfterOp: number | null = null;
  private coachState: AgentState | null = null;
  /**
   * Where each object's position was last measured. A held object's estimate reads 'pinch' while
   * it rides the hand, but its trust stays with how it was found.
   */
  private readonly basis = new Map<string, PlacementMethod>();
  /** Objects a free-space pinch registered while several were missing: a guess, not a measurement. */
  private readonly guessed = new Set<string>();
  /** Gives up on planning work in flight (see stop()). */
  private readonly abandons = new Set<() => void>();
  /** Counts lessons, so an answer about one lesson is never applied to the next. */
  private lessonSeq = 0;
  private demo: Demonstration | null = null;
  private demoClipId = '';
  private readonly pending = new Set<Promise<unknown>>();
  /** Missing objects already announced to the learner, so the coach isn't told twice. */
  private readonly announced = new Set<string>();
  /** Every camera lookup goes through here, so each one is recorded and outlined consistently. */
  private readonly spotlight: Spotlight;
  private readonly watcher: StepWatcher | null;
  /** Planning frames kept while a lesson may be about to start; null when planFrameMs is 0. */
  private readonly recentFrames: RecentFrames | null;
  private learnerSpokeT = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: LessonDeps) {
    const { bus, clock, registry, grounder, options } = deps;
    this.spotlight = new Spotlight({
      bus,
      clock,
      registry,
      grounder,
      ...(options?.showRefreshMs === undefined
        ? {}
        : { options: { refreshMs: options.showRefreshMs } }),
    });
    const watchMs = options?.watchMs ?? WATCH_MS;
    this.watcher =
      deps.checker && deps.images && watchMs > 0
        ? new StepWatcher({
            bus,
            clock,
            checker: deps.checker,
            frames: deps.images,
            target: () => this.watchTarget(),
            enabled: () => this.authority() === 'coach',
            options: { gapMs: watchMs },
          })
        : null;
    const planFrameMs = options?.planFrameMs ?? 0;
    this.recentFrames =
      deps.images && planFrameMs > 0
        ? new RecentFrames(deps.images, clock, { everyMs: planFrameMs })
        : null;
    if (this.recentFrames) {
      bus.on('coach.caption', ({ t, role }) => {
        if (role === 'user') this.learnerSpokeT = t;
      });
    }
    bus.on('object.registered', ({ objectId, method }) => {
      this.announced.delete(objectId);
      this.basis.set(objectId, method);
      if (method !== 'pinch') this.guessed.delete(objectId);
    });
    // A check or the Done button finished the focused step: record it once the focus has moved on.
    bus.on('step.completed', ({ stepId, by }) => {
      if (this.opDepth > 0) return;
      const actor: Actor = by === 'check' ? 'app' : by === 'skip' ? 'coach' : by;
      this.unrecorded = { op: by === 'skip' ? 'skip' : 'complete', by: actor, stepId };
    });
    bus.on('step.entered', ({ t, index }) => {
      this.onStepEntered(index, t);
      this.recordUnrecorded();
    });
    // A tool call that ends the lesson records its plan change before the recording stops.
    bus.on('procedure.completed', ({ t }) => {
      this.recordUnrecorded();
      if (this.opDepth > 0) this.finishAfterOp = t;
      else this.finish('completed', t);
    });
    bus.on('procedure.aborted', ({ t }) => this.finish('aborted', t));
    bus.on('coach.status', ({ state }) => {
      this.coachState = state;
    });
  }

  get phase(): LessonPhase {
    return this.currentPhase;
  }

  get procedure(): Procedure | null {
    return this.runner?.state.procedure ?? null;
  }

  get runnerState(): RunnerState | null {
    return this.runner?.state ?? null;
  }

  get activeDemo(): Demonstration | null {
    return this.demo;
  }

  currentStep(): Step | null {
    return this.runner?.state.step ?? null;
  }

  /**
   * Coach authority: a Gemini coach that can see is connected in learn mode, so checks may use only
   * trusted positions and the coach judges the rest. Otherwise checks use everything, as before.
   */
  authority(): Authority {
    const { coach } = this.deps.context();
    const learn = (this.deps.options?.mode ?? 'learn') === 'learn';
    return coach.kind === 'gemini' && learn && this.coachState === 'ready' ? 'coach' : 'local';
  }

  view(): LessonView {
    return {
      procedure: () => this.procedure,
      label: (id) => this.deps.registry.spec(id)?.label ?? id,
      plan: () => this.planView(),
      authority: () => this.authority(),
    };
  }

  handlers(): ToolHandlers {
    return {
      start_lesson: ({ goal, context, template_id }) =>
        this.startLesson(goal, context, template_id),
      revise_plan: ({ reason }, { callId }) => this.revisePlan(reason, callId),
      add_step: (args, { callId }) =>
        this.op(() =>
          this.addStep(args.text, args.done_when, args.after_step_id, args.objects, callId),
        ),
      update_step: (args, { callId }) => this.op(() => this.updateStep(args, callId)),
      complete_step: ({ reason, evidence, step_id }, { callId }) =>
        this.op(() => this.completeStep(step_id, reason, evidence, callId)),
      add_material: ({ label, look_for }, { callId }) =>
        this.op(() => this.addMaterial(label, look_for, callId)),
      highlight: ({ object_id, style }) => this.highlight(object_id, style),
      show_demo: ({ step_id }) => this.showDemo(step_id),
      flag_mistake: ({ kind, message }) => this.flagMistake(kind, message),
    };
  }

  /** Start a lesson for a goal. Answers at once; the plan arrives as plan.ready (or plan.failed). */
  startLesson(rawGoal: string, context?: string, templateId?: string): ToolOutcome {
    // A re-plan of the current lesson gives way to a new lesson.
    if (this.planning && !this.planning.revision) {
      return { ok: false, error: 'Already planning a lesson; it will arrive as an [app] message.' };
    }
    const goal = rawGoal.trim().slice(0, GOAL_MAX);
    for (const abandon of this.abandons) abandon();
    const attempt = ++this.attempt;
    this.planning = {
      goal,
      ...(context ? { context } : {}),
      revision: false,
      startedT: this.deps.clock.now(),
      slowSent: false,
      attempt,
    };
    this.draft = null;
    this.track(this.prepare(goal, context, templateId, attempt));
    return { ok: true, result: { status: templateId ? 'loading' : 'planning', goal } };
  }

  /** Run a procedure (curated from the menu, or freshly planned). */
  async run(
    procedure: Procedure,
    planId: string | null = null,
    opts: {
      goal?: string;
      locate?: 'await' | 'background';
      by?: Actor;
      callId?: string;
      /** Announce the plan (plan.ready, with these warnings) once the lesson exists. */
      announce?: string[];
      /** Announce it as the first stage of a plan, whose outline is being written in full. */
      outline?: boolean;
      /** The start_lesson this run belongs to; a newer one cancels it. */
      attempt?: number;
      /** How start_lesson got here, recorded once the first step is on (lesson.first_step). */
      timing?: FirstStepTiming;
    } = {},
  ): Promise<{ missing: string[] }> {
    const { bus, clock, registry, recorder } = this.deps;
    if (this.runner?.state.status === 'running') {
      this.runner.abort('a new lesson started', clock.now());
    }
    registry.load(procedure.objects, clock.now());
    this.planId = planId;
    this.goal =
      opts.goal ??
      (procedure.origin.kind === 'generated' ? procedure.origin.goal : procedure.title);
    this.rev = -1;
    this.notes.clear();
    this.usedIds.clear();
    for (const step of procedure.steps) this.usedIds.add(step.id);
    this.announced.clear();
    const background = opts.locate === 'background';
    let missing: string[] = [];
    if (!background) missing = await this.locate(registry.unplaced());
    if (opts.attempt !== undefined && opts.attempt !== this.attempt) return { missing };
    recorder?.start(this.episodeMeta(procedure), clock.now());
    this.lessonSeq++;
    this.runner = new ProcedureRunner(procedure, bus, {
      coachCanForce: this.deps.options?.coachCanForce ?? true,
    });
    if (opts.announce) {
      bus.emit('plan.ready', {
        t: clock.now(),
        planId: planId ?? procedure.id,
        procedure,
        warnings: opts.announce,
        revision: false,
        ...(opts.outline ? { stage: 'first' as const } : {}),
      });
    }
    this.setPhase('lesson');
    const runner = this.runner;
    this.op(() => {
      runner.start(clock.now());
      return { ok: true, result: null };
    });
    this.changed('start', opts.by ?? (procedure.origin.kind === 'curated' ? 'app' : 'planner'), {
      callId: opts.callId,
    });
    if (opts.timing) this.recordFirstStep(opts.timing, background ? 'background' : 'await');
    // Found while the coach briefs the first step. After the start, so the objects that step
    // looks for join its look rather than being asked about twice.
    if (background) this.track(this.locateStarted(opts.timing));
    return { missing };
  }

  revisePlan(reason: string, callId?: string): ToolOutcome {
    const runner = this.activeRunner();
    if (!runner) return { ok: false, error: 'No lesson is running to revise.' };
    if (this.planning) return { ok: false, error: 'Already planning.' };
    const { bus, clock } = this.deps;
    const attempt = ++this.attempt;
    this.planning = {
      goal: this.goal,
      revision: true,
      startedT: clock.now(),
      slowSent: false,
      attempt,
    };
    bus.emit('plan.requested', { t: clock.now(), goal: this.goal, revision: true });
    this.track(this.revise(runner, reason, attempt, callId));
    return { ok: true, result: { status: 'replanning' } };
  }

  /** Per tracked frame (workspace space). */
  update(frame: FrameContext): void {
    this.runner?.update(frame, {
      positions: this.trustedPositions(),
      inCharge: this.authority() === 'coach',
    });
    this.tick(frame.t);
  }

  /** Time-based upkeep: demos, planning deadlines, outlines, the step watcher, planning frames. */
  tick(t: number): void {
    if (this.demo && this.player.finished(t)) this.endDemo(t);
    this.checkPlanning(t);
    const look = this.spotlight.tick(t);
    if (look) this.track(look);
    const watch = this.watcher?.tick(t);
    if (watch) this.track(watch);
    // Frames cost a JPEG encode each, so they are kept only when a lesson may be about to start.
    const warm =
      !this.planning && !this.activeRunner() && t - this.learnerSpokeT <= PLAN_FRAMES_WARM_MS;
    const frame = this.recentFrames?.tick(t, warm);
    if (frame) this.track(frame);
  }

  /** A pinch in free space while objects are missing registers the next missing one there. */
  onPinch(transition: PinchTransition): void {
    const { registry } = this.deps;
    if (transition.phase !== 'start') return;
    const queue = this.registrationQueue();
    const [next] = queue;
    if (!next || registry.nearest(transition.point, NEAR_KNOWN_OBJECT_M)) return;
    const placed = registry.observe(next, {
      position: transition.point,
      confidence: 0.9,
      source: 'pinch',
      t: transition.t,
    });
    // With several objects missing, the learner may have pinched for the task, not for this one.
    if (placed && queue.length > 1) this.guessed.add(next);
    else if (placed) this.guessed.delete(next);
  }

  /** Refine positions with the camera (e.g. after the learner puts an object down). Quiet. */
  relocate(ids: readonly string[]): void {
    if (!this.deps.grounder || ids.length === 0) return;
    const requests = ids.map((id) => ({ id }));
    this.track(this.spotlight.find(requests, { join: true }));
  }

  /** Learner-side confirmation (e.g. a "done" gesture or button). */
  confirmByUser(reason = 'user confirmed'): ToolOutcome {
    if (!this.runner) return { ok: false, error: 'No lesson is running.' };
    const r = this.runner.advance('user', reason, this.deps.clock.now());
    return r.ok
      ? { ok: true, result: { advanced: true, forced: r.forced } }
      : { ok: false, error: r.error };
  }

  async stop(reason: string): Promise<void> {
    // Give up on a plan in flight rather than waiting for it and starting a lesson nobody sees,
    // and on the rest of a plan still being written.
    if (this.planning || this.draft || this.abandons.size > 0) {
      this.planning = null;
      this.draft = null;
      this.attempt++;
      for (const abandon of this.abandons) abandon();
    }
    if (this.runner?.state.status === 'running') this.runner.abort(reason, this.deps.clock.now());
    this.watcher?.stop();
    await this.settled();
  }

  /** Resolves when background work (planning, grounding, recording uploads) has finished. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  // ---- drafting the plan ---------------------------------------------------------------------

  private async prepare(
    goal: string,
    context: string | undefined,
    templateId: string | undefined,
    attempt: number,
  ): Promise<void> {
    const { bus, clock, planner } = this.deps;
    const timing: FirstStepTiming = {
      startedT: this.planning?.startedT ?? clock.now(),
      source: templateId ? 'template' : 'planner',
      frames: 'none',
      captureMs: 0,
      planMs: 0,
    };
    if (this.runner?.state.status === 'running') {
      this.runner.abort('a new lesson was requested', clock.now());
    }
    // The previous lesson is over: its plan must not stand in for the new one.
    this.runner = null;
    this.setPhase('planning', goal);
    bus.emit('plan.requested', { t: clock.now(), goal, revision: false });
    let draft: PlanResponse;
    try {
      draft = await this.cancellable(
        (async () => {
          if (templateId) {
            if (!this.deps.templates) throw new Error('No curated lessons are available');
            const asked = clock.now();
            const template = await this.deps.templates.get(templateId);
            timing.planMs = clock.now() - asked;
            const calibrated = isCalibrated(this.deps.workspace().method);
            const procedure = adaptTemplate(template, calibrated);
            return { planId: template.id, procedure, warnings: [] };
          }
          // The first step in full and the rest as an outline, so the lesson starts quickly.
          const captured = clock.now();
          const { images, from } = await this.planFrames();
          const asked = clock.now();
          timing.frames = from;
          timing.captureMs = asked - captured;
          const response = await planner.plan({
            goal,
            ...(context ? { context } : {}),
            images,
            stage: 'first',
          });
          timing.planMs = clock.now() - asked;
          return response;
        })(),
      );
    } catch (err) {
      if (attempt !== this.attempt) return;
      this.planning = null;
      this.failPlanning(goal, errorText(err), false);
      return;
    }
    if (attempt !== this.attempt) return;
    // Still "planning" until the lesson has started, so nothing else starts or edits it meanwhile.
    if (this.planning) this.planning.landed = true;
    const from = draft.outlineFrom ?? draft.procedure.steps.length;
    const outline = from < draft.procedure.steps.length;
    // The lesson starts on the plan: the coach is briefed on step 1 while its objects are found.
    const started = this.run(draft.procedure, draft.planId, {
      goal,
      announce: draft.warnings,
      outline,
      attempt,
      locate: 'background',
      timing,
    });
    // The outline is written in full at once, while the lesson starts and the learner works.
    if (outline) this.track(this.refine(draft, { goal, context, from, attempt }, started));
    try {
      await started;
    } finally {
      if (attempt === this.attempt) this.planning = null;
    }
  }

  private async revise(
    runner: ProcedureRunner,
    reason: string,
    attempt: number,
    callId: string | undefined,
  ): Promise<void> {
    const { planner } = this.deps;
    const { procedure, statuses } = runner.state;
    const kept = procedure.steps.filter((s) => statuses[s.id] !== 'todo');
    const todo = procedure.steps.filter((s) => statuses[s.id] === 'todo');
    const base = { ...procedure, steps: [...kept, ...todo] };
    let response: PlanResponse;
    try {
      const images = await this.cancellable(this.captureImages());
      response = await this.cancellable(
        planner.plan({
          goal: this.goal,
          images,
          revise: {
            planId: this.planId ?? procedure.id,
            fromStepIndex: kept.length,
            reason,
            skippedStepIds: kept.filter((s) => statuses[s.id] === 'skipped').map((s) => s.id),
            base,
          },
        }),
      );
    } catch (err) {
      if (attempt !== this.attempt) return;
      this.planning = null;
      this.failPlanning(this.goal, errorText(err), true);
      return;
    }
    if (attempt !== this.attempt) return;
    this.planning = null;
    if (this.runner !== runner || runner.state.status !== 'running') return;
    // A step the planner was asked to replace but that was finished meanwhile stays as it is.
    const asked = new Set(todo.map((s) => s.id));
    const now = runner.state.statuses;
    const fresh = response.procedure.steps
      .slice(kept.length)
      .filter((s) => !(asked.has(s.id) && now[s.id] !== 'todo'));
    const done = runner.state.procedure.steps.filter((s) => now[s.id] !== 'todo');
    const merged = this.mergeRevision(runner, done, fresh, response);
    if (!merged.ok) {
      this.failPlanning(this.goal, merged.error, true);
      return;
    }
    this.swapPlan(runner, merged.procedure, response, {
      op: 'revise',
      label: 'plan.revised',
      data: { kept: kept.length, reason },
      details: { reason, ...(callId ? { callId } : {}) },
      warnings: response.warnings,
    });
  }

  /**
   * Stage rest of a two-stage plan: while the lesson starts and the learner works on the first
   * step, the planner writes the outline steps in full from fresh camera views. They replace the
   * outline steps nobody has started; the focused step and finished ones stay as they are. The
   * refinement is dropped when the plan moved on without it: a new lesson, a re-plan, or the coach
   * changing the steps itself.
   */
  private async refine(
    draft: PlanResponse,
    ask: { goal: string; context: string | undefined; from: number; attempt: number },
    started: Promise<unknown>,
  ): Promise<void> {
    const { goal, context, from, attempt } = ask;
    const outlined = JSON.stringify(draft.procedure.steps);
    let response: PlanResponse;
    try {
      // After the lesson has started (at once), so this capture's encode doesn't delay the step-1
      // briefing.
      await started;
      const images = await this.cancellable(this.captureImages());
      response = await this.cancellable(
        this.deps.planner.plan({
          goal,
          ...(context ? { context } : {}),
          images,
          stage: 'rest',
          revise: {
            planId: draft.planId,
            fromStepIndex: from,
            reason: REFINE_REASON,
            base: draft.procedure,
          },
        }),
      );
    } catch (err) {
      if (attempt === this.attempt) this.refineDropped(errorText(err));
      return;
    }
    const runner = this.activeRunner();
    if (attempt !== this.attempt || !runner || this.planId !== draft.planId) return;
    const { procedure, statuses } = runner.state;
    if (JSON.stringify(procedure.steps) !== outlined) {
      this.refineDropped('the coach changed the steps meanwhile');
      return;
    }
    const focus = runner.state.step?.id;
    const kept = procedure.steps.filter(
      (s, i) => i < from || statuses[s.id] !== 'todo' || s.id === focus,
    );
    const keep = new Set(kept.map((s) => s.id));
    const fresh = response.procedure.steps.slice(from).filter((s) => !keep.has(s.id));
    const merged = this.mergeRevision(runner, kept, fresh, response);
    if (!merged.ok) {
      this.refineDropped(merged.error);
      return;
    }
    const announced = new Set(draft.warnings);
    this.swapPlan(runner, merged.procedure, response, {
      op: 'refine',
      label: 'plan.refined',
      data: { kept: kept.length },
      details: { reason: REFINE_REASON },
      warnings: response.warnings.filter((w) => !announced.has(w)),
      stage: 'rest',
    });
  }

  /** The outline stays as it is: the coach and the learner can work from it. */
  private refineDropped(reason: string): void {
    const { bus, clock } = this.deps;
    bus.emit('annotation', { t: clock.now(), label: 'plan.refine_dropped', data: { reason } });
  }

  /** Swaps in the planner's plan as one recorded change and announces it to the coach. */
  private swapPlan(
    runner: ProcedureRunner,
    procedure: Procedure,
    response: PlanResponse,
    change: {
      op: 'revise' | 'refine';
      label: string;
      data: Record<string, unknown>;
      details: Record<string, string>;
      warnings: string[];
      stage?: 'rest';
    },
  ): void {
    const { bus, clock } = this.deps;
    const t = clock.now();
    for (const spec of procedure.objects) this.deps.registry.add(spec, t);
    // One op, so a revision that leaves nothing to do records itself before the lesson finishes.
    this.op(() => {
      bus.emit('annotation', {
        t,
        label: change.label,
        data: { from: this.planId, to: response.planId, ...change.data },
      });
      runner.replacePlan(procedure, t);
      for (const step of procedure.steps) this.usedIds.add(step.id);
      for (const id of this.notes.keys()) if (!runner.statusOf(id)) this.notes.delete(id);
      this.planId = response.planId;
      this.changed(change.op, 'planner', change.details);
      bus.emit('plan.ready', {
        t,
        planId: response.planId,
        procedure,
        warnings: change.warnings,
        revision: true,
        ...(change.stage ? { stage: change.stage } : {}),
      });
      return { ok: true, result: null };
    });
    this.track(this.locate(this.deps.registry.unplaced()));
  }

  /**
   * A revision lands on the plan as it is now: the `kept` steps stay as they are, then the
   * planner's new steps replace all the others. A new step never takes an id the lesson used for
   * something else, but may take the id of a step it replaces.
   */
  private mergeRevision(
    runner: ProcedureRunner,
    kept: readonly Step[],
    fresh: readonly Step[],
    response: PlanResponse,
  ): { ok: true; procedure: Procedure } | { ok: false; error: string } {
    const { procedure } = runner.state;
    const keep = new Set(kept.map((s) => s.id));
    const replaced = new Set(procedure.steps.filter((s) => !keep.has(s.id)).map((s) => s.id));
    const taken = new Set([...this.usedIds].filter((id) => !replaced.has(id)));
    const steps = fresh.map((s) => {
      const id = uniqueId(s.id, taken);
      taken.add(id);
      return id === s.id ? s : { ...s, id };
    });
    const known = new Set(procedure.objects.map((o) => o.id));
    const objects = [
      ...procedure.objects,
      ...response.procedure.objects.filter((o) => !known.has(o.id)),
    ];
    const r = safeParseProcedure({ ...procedure, objects, steps: [...kept, ...steps] });
    return r.ok ? { ok: true, procedure: r.procedure } : { ok: false, error: r.error };
  }

  private failPlanning(goal: string, error: string, revision: boolean): void {
    const { bus, clock } = this.deps;
    bus.emit('plan.failed', { t: clock.now(), goal, error, revision });
    if (revision) return;
    // The coach writes the steps itself; the lesson starts with its first add_step. A coach that
    // can't (the scripted one) asks the learner again instead.
    this.draft = { goal, objects: [] };
    if (this.deps.context().coach.kind === 'gemini') this.setPhase('planning', goal);
    else this.setPhase('idle');
  }

  /** A promise that stop() can make fail at once, so it never waits on a slow planner. */
  private cancellable<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abandon = () => reject(new Error('stopped'));
      this.abandons.add(abandon);
      work.then(resolve, reject).finally(() => this.abandons.delete(abandon));
    });
  }

  /** Tell the coach when planning is slow, and give up on it at the deadline. */
  private checkPlanning(t: number): void {
    const p = this.planning;
    if (!p || p.landed) return;
    const elapsed = t - p.startedT;
    const options = this.deps.options;
    if (elapsed >= (options?.planTimeoutMs ?? PLAN_TIMEOUT_MS)) {
      this.planning = null;
      this.attempt++;
      this.failPlanning(p.goal, `no plan after ${Math.round(elapsed / 1000)} s`, p.revision);
    } else if (!p.slowSent && elapsed >= (options?.planSlowMs ?? PLAN_SLOW_MS)) {
      p.slowSent = true;
      this.deps.bus.emit('plan.slow', { t, goal: p.goal, elapsedMs: elapsed });
    }
  }

  // ---- plan tools ------------------------------------------------------------------------------

  private addStep(
    text: string,
    doneWhen: string,
    afterStepId: string | undefined,
    objects: readonly string[] | undefined,
    callId: string,
  ): ToolOutcome {
    if (this.planning) return this.planningError();
    const runner = this.activeRunner();
    const known = runner ? this.deps.registry.allSpecs() : (this.draft?.objects ?? []);
    const unknown = (objects ?? []).filter((id) => !known.some((o) => o.id === id));
    if (unknown.length > 0) {
      const ids = known.map((o) => o.id).join(', ') || 'none yet; call add_material';
      return { ok: false, error: `Unknown material "${unknown[0]}". Materials: ${ids}.` };
    }
    if (!runner) return this.startCoachLesson(text, doneWhen, objects ?? [], known, callId);

    const { procedure, statuses } = runner.state;
    const focusBefore = this.focusId();
    // The same call again (a replay after a reconnect) gives the same step. A skipped step with
    // the same words is not a duplicate: skipping and adding anew is how a step changes.
    const same = procedure.steps.find(
      (s) => statuses[s.id] === 'todo' && sameText(s.instruction, text),
    );
    if (same) return this.planResult({ step_id: same.id, already: true }, focusBefore);
    const step = this.coachStep(text, doneWhen, objects ?? [], known);
    const r = runner.insert(step, afterStepId ?? null);
    if (!r.ok) return r;
    this.usedIds.add(step.id);
    this.changed('add', 'coach', { stepId: step.id, callId });
    return this.planResult({ step_id: step.id }, focusBefore);
  }

  /** The planner failed: the coach's first step starts a lesson it writes itself. */
  private startCoachLesson(
    text: string,
    doneWhen: string,
    objects: readonly string[],
    known: readonly ObjectSpec[],
    callId: string,
  ): ToolOutcome {
    const draft = this.draft;
    if (!draft) return { ok: false, error: 'No lesson is running. Call start_lesson first.' };
    const { coach } = this.deps.context();
    const step = this.coachStep(text, doneWhen, objects, known);
    const parsed = safeParseProcedure({
      schema: PROCEDURE_SCHEMA_ID,
      id: slugFrom(draft.goal, 'lesson'),
      version: 1,
      origin: {
        kind: 'generated',
        goal: draft.goal,
        model: coach.model ?? coach.kind,
        createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
      },
      title: draft.goal,
      summary: draft.goal,
      workspace: { size: COACH_WORKSPACE },
      objects: draft.objects,
      steps: [step],
    });
    if (!parsed.ok) return { ok: false, error: parsed.error };
    this.draft = null;
    // With background locating, run() starts the lesson before it first awaits.
    this.track(
      this.run(parsed.procedure, null, {
        goal: draft.goal,
        locate: 'background',
        by: 'coach',
        callId,
      }),
    );
    return this.planResult({ step_id: step.id, started: true }, null);
  }

  private updateStep(
    args: {
      step_id: string;
      text?: string;
      done_when?: string;
      note?: string;
      status?: 'current' | 'skipped' | 'todo';
      reason?: string;
    },
    callId: string,
  ): ToolOutcome {
    if (this.planning && !this.planning.revision) return this.planningError();
    const runner = this.activeRunner();
    if (!runner) return { ok: false, error: 'No lesson is running.' };
    const { step_id: id, text, done_when: doneWhen, note, status, reason } = args;
    if (text === undefined && doneWhen === undefined && note === undefined && !status) {
      return { ok: false, error: 'Nothing to change: give text, done_when, note or status.' };
    }
    const current = runner.statusOf(id);
    if (!current) {
      const ids = runner.state.procedure.steps.map((s) => s.id).join(', ');
      return { ok: false, error: `Unknown step "${id}". Steps: ${ids}.` };
    }
    // A re-plan replaces the steps still to do, so only notes on finished steps survive it.
    const replaced = text !== undefined || doneWhen !== undefined || status || current === 'todo';
    if (this.planning?.revision && replaced) return this.planningError();
    const focusBefore = this.focusId();
    const t = this.deps.clock.now();
    if (status) {
      const r =
        status === 'skipped'
          ? runner.skip(id, t)
          : status === 'current'
            ? runner.focus(id, t)
            : runner.reopen(id);
      if (!r.ok) return r;
    }
    // Skipping the last step ends the lesson; there is nothing left to reword.
    const ended = runner.state.status !== 'running';
    if (!ended && (text !== undefined || doneWhen !== undefined)) {
      const r = runner.edit(id, {
        ...(text !== undefined ? { instruction: text } : {}),
        ...(doneWhen !== undefined ? { doneWhen } : {}),
      });
      if (!r.ok) return r;
    }
    if (note !== undefined) {
      if (note.trim()) this.notes.set(id, note.trim());
      else this.notes.delete(id);
    }
    const op: PlanOp =
      status === 'skipped'
        ? 'skip'
        : status === 'current'
          ? 'focus'
          : status === 'todo'
            ? 'reopen'
            : 'edit';
    this.changed(op, 'coach', { stepId: id, callId, ...(reason ? { reason } : {}) });
    return this.planResult(ended ? { finished: true } : {}, focusBefore);
  }

  private completeStep(
    stepId: string,
    reason: string,
    evidence: 'seen' | 'heard',
    callId: string,
  ): ToolOutcome {
    if (this.planning && !this.planning.revision) return this.planningError();
    const runner = this.activeRunner();
    if (!runner) return { ok: false, error: 'No lesson is running.' };
    const focusBefore = this.focusId();
    const r = runner.complete(stepId, 'coach', this.deps.clock.now());
    if (!r.ok) return r;
    if (!r.already) this.changed('complete', 'coach', { stepId, reason, evidence, callId });
    const finished = runner.state.status === 'completed';
    return this.planResult(
      { done: true, ...(r.already ? { already: true } : {}), ...(finished ? { finished } : {}) },
      focusBefore,
    );
  }

  private addMaterial(label: string, lookFor: string | undefined, callId: string): ToolOutcome {
    if (this.planning && !this.planning.revision) return this.planningError();
    const { registry, clock } = this.deps;
    const runner = this.activeRunner();
    const draft = runner ? null : this.draft;
    if (!runner && !draft) {
      return { ok: false, error: 'No lesson is running. Call start_lesson first.' };
    }
    const existing = runner ? registry.allSpecs() : (draft?.objects ?? []);
    const same = existing.find((o) => sameText(o.label, label));
    if (same) return this.planResult({ material_id: same.id, already: true }, this.focusId());
    const spec: ObjectSpec = {
      id: uniqueId(slugFrom(label, 'material'), new Set(existing.map((o) => o.id))),
      label,
      kind: 'item',
      radius: 0.03,
      hidden: false,
      placement: { method: 'detect' },
      tracking: { query: lookFor?.trim() || label, moves: true },
    };
    if (!runner) {
      draft?.objects.push(spec);
      return { ok: true, result: { material_id: spec.id } };
    }
    const r = runner.addObject(spec);
    if (!r.ok) return r;
    registry.add(spec, clock.now());
    this.track(this.locate([spec.id]));
    this.changed('material', 'coach', { callId, materialId: spec.id });
    return this.planResult({ material_id: spec.id }, this.focusId());
  }

  /** A step the coach wrote: confirmed by the coach or learner, outlining the materials it uses. */
  private coachStep(
    text: string,
    doneWhen: string,
    objects: readonly string[],
    known: readonly ObjectSpec[],
  ): Step {
    const taken = new Set([
      ...this.usedIds,
      ...(this.runner?.state.procedure.steps ?? []).map((s) => s.id),
    ]);
    const id = uniqueId(slugFrom(text, 'step'), taken);
    return {
      id,
      instruction: text.trim(),
      doneWhen: doneWhen.trim(),
      targets: [...objects],
      hand: 'either',
      show: objects.slice(0, 4).map((objectId) => {
        const spec = known.find((o) => o.id === objectId);
        const label = spec?.label ?? objectId;
        return {
          object: objectId,
          phrase: label.slice(0, 60),
          description: (spec?.tracking?.query ?? label).slice(0, 300),
        };
      }),
      success: { type: 'confirm', by: 'either', prompt: doneWhen.trim() },
      mistakes: [],
    };
  }

  private planningError(): ToolOutcome {
    return {
      ok: false,
      error: this.planning?.revision
        ? 'A re-plan is running and will replace the steps not done yet. Wait for the new plan.'
        : 'The plan is being written. Wait for it, then change it.',
    };
  }

  /** A plan tool's answer: the recital, plus the briefing when the call moved the focus. */
  private planResult(extra: Record<string, unknown>, focusBefore: string | null): ToolOutcome {
    const plan = this.planView();
    const focus = plan?.focusId ?? null;
    return {
      ok: true,
      result: {
        ...extra,
        ...(plan && focus && focus !== focusBefore ? { now: briefStep(plan, focus) } : {}),
        ...(plan ? { plan: recitePlan(plan) } : {}),
      },
    };
  }

  /** Runs a tool that records its own plan change, so the bus listeners don't record it twice. */
  private op(fn: () => ToolOutcome): ToolOutcome {
    this.opDepth++;
    try {
      return fn();
    } finally {
      this.opDepth--;
      const t = this.finishAfterOp;
      if (this.opDepth === 0 && t !== null) {
        this.finishAfterOp = null;
        this.finish('completed', t);
      }
    }
  }

  private recordUnrecorded(): void {
    const change = this.unrecorded;
    if (!change) return;
    this.unrecorded = null;
    this.changed(change.op, change.by, { stepId: change.stepId });
  }

  /** Record a plan change and tell the app (coach instruction, HUD) to read the plan again. */
  private changed(op: PlanOp, by: Actor, details: Record<string, string | undefined> = {}): void {
    const { bus, clock } = this.deps;
    const t = clock.now();
    this.rev++;
    const data = Object.fromEntries(Object.entries(details).filter(([, v]) => v !== undefined));
    bus.emit('annotation', {
      t,
      label: 'plan.updated',
      data: { rev: this.rev, op, by, ...data, plan: this.snapshot() },
    });
    bus.emit('plan.changed', { t, rev: this.rev, op, stepId: details.stepId ?? null });
  }

  /** The plan as recorded with every change: what each step says and where it stands. */
  private snapshot() {
    const state = this.runner?.state;
    if (!state) return null;
    return {
      goal: this.goal,
      focusId: this.focusId(),
      steps: state.procedure.steps.map((s) => ({
        id: s.id,
        instruction: s.instruction,
        ...(s.doneWhen ? { doneWhen: s.doneWhen } : {}),
        status: state.statuses[s.id] ?? 'todo',
        targets: s.targets,
        ...(s.action ? { action: s.action.verb } : {}),
        ...(this.notes.has(s.id) ? { note: this.notes.get(s.id) } : {}),
      })),
      materials: state.procedure.objects.filter((o) => !o.hidden).map((o) => o.id),
    };
  }

  private planView(): PlanView | null {
    const state = this.runner?.state;
    if (!state || state.status === 'aborted') return null;
    const label = (id: string) => this.deps.registry.spec(id)?.label ?? id;
    return {
      goal: this.goal,
      title: state.procedure.title,
      rev: Math.max(0, this.rev),
      steps: state.procedure.steps.map((s) => {
        const note = this.notes.get(s.id);
        return {
          id: s.id,
          instruction: s.instruction,
          ...(s.doneWhen ? { doneWhen: s.doneWhen } : {}),
          status: state.statuses[s.id] ?? 'todo',
          ...(note ? { note } : {}),
          uses: s.targets.map(label),
          demo: !!s.action,
          ...(s.coachNotes ? { coachNotes: s.coachNotes } : {}),
        };
      }),
      focusId: this.focusId(),
      materials: state.procedure.objects
        .filter((o) => !o.hidden)
        .map((o) => ({ id: o.id, label: o.label })),
    };
  }

  private focusId(): string | null {
    const state = this.runner?.state;
    if (state?.status === 'running') return state.step?.id ?? null;
    // Announced but not started yet: the first step is next.
    if (state?.status === 'idle') return state.procedure.steps[0]?.id ?? null;
    return null;
  }

  private activeRunner(): ProcedureRunner | null {
    return this.runner?.state.status === 'running' ? this.runner : null;
  }

  private watchTarget(): WatchTarget | null {
    const state = this.activeRunner()?.state;
    const step = state?.step;
    if (!state || !step || this.planning) return null;
    return {
      lesson: this.lessonSeq,
      goal: this.goal,
      step: {
        id: step.id,
        instruction: step.instruction,
        ...(step.doneWhen ? { doneWhen: step.doneWhen } : {}),
      },
      ...stepLooks(step, state.procedure.objects),
    };
  }

  /** Positions measured by something other than a camera guess: what coach-era checks may use. */
  private trustedPositions(): ObjectPositions {
    const { registry, workspace } = this.deps;
    const calibrated = isCalibrated(workspace().method);
    return {
      position: (id) => {
        const estimate = registry.get(id);
        if (!estimate || this.guessed.has(id)) return undefined;
        const basis = this.basis.get(id) ?? estimate.source;
        const trusted = TRUSTED_SOURCES.has(basis) || (basis === 'layout' && calibrated);
        return trusted ? estimate.position : undefined;
      },
    };
  }

  // ---- other tools -----------------------------------------------------------------------------

  private highlight(objectId: string, style: HighlightStyle): ToolOutcome {
    const { bus, clock, registry } = this.deps;
    const spec = registry.spec(objectId);
    if (!spec) {
      const known =
        registry
          .allSpecs()
          .map((s) => s.id)
          .join(', ') || 'none';
      return {
        ok: false,
        error: `Unknown object "${objectId}". Objects in this lesson: ${known}.`,
      };
    }
    bus.emit('overlay.highlight', { t: clock.now(), objectId, style, source: 'coach' });
    if (!registry.get(objectId)) {
      this.track(this.locate([objectId]));
      return {
        ok: true,
        result: { shown: false, note: 'The headset cannot show it yet; describe where it is.' },
      };
    }
    return { ok: true, result: { shown: true } };
  }

  private async showDemo(stepId?: string): Promise<ToolOutcome> {
    const procedure = this.procedure;
    if (!procedure) return { ok: false, error: 'No lesson is running.' };
    const step = stepId ? procedure.steps.find((s) => s.id === stepId) : this.currentStep();
    if (!step)
      return { ok: false, error: stepId ? `Unknown step "${stepId}".` : 'No step is active.' };
    const demo = await this.demoFor(procedure, step);
    if (!demo) {
      return {
        ok: false,
        error: step.action
          ? 'The headset cannot show this step yet; explain it in words.'
          : 'This step has no hand motion to demonstrate.',
      };
    }
    this.playDemo(demo, procedure, step, this.deps.clock.now());
    return {
      ok: true,
      result: {
        playing: true,
        source: demo.source,
        seconds: Math.round(demo.clip.durationMs / 100) / 10,
      },
    };
  }

  private flagMistake(kind: string, message: string): ToolOutcome {
    const step = this.currentStep();
    if (!step) return { ok: false, error: 'No step is active.' };
    this.deps.bus.emit('mistake.detected', {
      t: this.deps.clock.now(),
      stepId: step.id,
      kind,
      message,
      source: 'coach',
    });
    return { ok: true, result: { shown: true } };
  }

  // ---- internals -----------------------------------------------------------------------------

  private onStepEntered(index: number, t: number): void {
    const procedure = this.procedure;
    const step = procedure?.steps[index];
    if (!procedure || !step) return;
    // Demonstrations belong to their step.
    if (this.demo && this.demo.stepId !== step.id) this.endDemo(t);
    // Outline what the step shows, and find the targets that are still missing.
    const lesson = this.lessonSeq;
    const look = this.spotlight.enterStep(step);
    this.track(look.then((missing) => this.announce(missing, lesson)));
    if (this.deps.options?.autoDemo && step.action) {
      this.track(this.autoDemo(procedure, step, look, t));
    }
  }

  /**
   * Plays the step's demonstration as it starts. A synthesized one needs its objects placed: when
   * they weren't yet (the lesson's first look still out), it plays once the step's look has
   * answered, if the step is still on and no other demonstration is playing.
   */
  private async autoDemo(
    procedure: Procedure,
    step: Step,
    look: Promise<unknown>,
    t: number,
  ): Promise<void> {
    const { registry } = this.deps;
    const lesson = this.lessonSeq;
    const ids = [step.action?.object, step.action?.target];
    const unplaced = ids.some((id) => id !== undefined && !registry.get(id));
    const demo = await this.demoFor(procedure, step);
    const current = () => lesson === this.lessonSeq && this.currentStep()?.id === step.id;
    if (demo) {
      if (current()) this.playDemo(demo, procedure, step, t);
      return;
    }
    if (!unplaced) return;
    await look;
    if (!current() || this.demo) return;
    const placed = await this.demoFor(procedure, step);
    if (placed && current() && !this.demo) {
      this.playDemo(placed, procedure, step, this.deps.clock.now());
    }
  }

  private demoFor(procedure: Procedure, step: Step): Promise<Demonstration | null> {
    const { registry } = this.deps;
    return this.deps.demos.forStep(procedure, step, {
      position: (id) => registry.position(id),
      spec: (id) => registry.spec(id),
    });
  }

  private playDemo(demo: Demonstration, procedure: Procedure, step: Step, t: number): void {
    if (this.demo) this.endDemo(t);
    const base = clipIdFor(procedure.id, step.id);
    this.demoClipId = demo.source === 'recorded' ? base : `synth:${base}`;
    this.demo = demo;
    this.player.play(demo.clip, t);
    this.deps.bus.emit('overlay.demo', { t, stepId: step.id, playing: true });
    this.deps.bus.emit('demo.playback', {
      t,
      stepId: step.id,
      clipId: this.demoClipId,
      phase: 'start',
    });
  }

  private endDemo(t: number): void {
    const demo = this.demo;
    if (!demo) return;
    this.player.stop();
    this.demo = null;
    this.deps.bus.emit('overlay.demo', { t, stepId: demo.stepId, playing: false });
    this.deps.bus.emit('demo.playback', {
      t,
      stepId: demo.stepId,
      clipId: this.demoClipId,
      phase: 'end',
    });
  }

  /**
   * Locate objects with the camera; returns the ids still missing, announcing new ones once. An
   * object some look is already finding waits for that look's answer instead of a second one.
   */
  private async locate(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const lesson = this.lessonSeq;
    const previous = this.currentPhase;
    const showPhase = this.deps.grounder !== null && previous !== 'lesson';
    if (showPhase) this.setPhase('locating');
    const requests = ids.map((id) => ({ id }));
    const missing = await this.spotlight.find(requests, { join: true });
    if (showPhase && this.currentPhase === 'locating') this.setPhase(previous);
    this.announce(missing, lesson);
    return missing;
  }

  /**
   * The lesson's objects, found once it has started. A planned lesson records when the look
   * answered (lesson.first_locate), unless another lesson has started since.
   */
  private async locateStarted(timing: FirstStepTiming | undefined): Promise<void> {
    const { bus, clock, registry } = this.deps;
    const lesson = this.lessonSeq;
    const ids = registry.unplaced();
    const askedT = clock.now();
    const missing = await this.locate(ids);
    if (!timing || lesson !== this.lessonSeq) return;
    const t = clock.now();
    bus.emit('annotation', {
      t,
      label: 'lesson.first_locate',
      data: {
        locateMs: t - askedT,
        sinceStartMs: t - timing.startedT,
        located: ids.filter((id) => !missing.includes(id)),
        missing,
      },
    });
  }

  /** How long start_lesson took to reach the first step (lesson.first_step), once it is on. */
  private recordFirstStep(timing: FirstStepTiming, locate: 'await' | 'background'): void {
    const { bus, clock } = this.deps;
    const t = clock.now();
    const { startedT, ...spent } = timing;
    bus.emit('annotation', {
      t,
      label: 'lesson.first_step',
      data: { stepId: this.currentStep()?.id ?? null, ...spent, totalMs: t - startedT, locate },
    });
  }

  /**
   * Tell the learner (through the HUD, and a coach that is told) about missing objects, once. An
   * answer about an earlier lesson is no news in this one.
   */
  private announce(missing: readonly string[], lesson: number): void {
    if (lesson !== this.lessonSeq) return;
    const fresh = missing.filter((id) => !this.announced.has(id));
    for (const id of fresh) this.announced.add(id);
    if (fresh.length > 0) {
      this.deps.bus.emit('object.missing', { t: this.deps.clock.now(), objectIds: fresh });
    }
  }

  /** Missing objects in the order the learner should register them: current targets first. */
  private registrationQueue(): string[] {
    const unplaced = this.deps.registry.unplaced();
    const targets = this.currentStep()?.targets ?? [];
    return [
      ...targets.filter((id) => unplaced.includes(id)),
      ...unplaced.filter((id) => !targets.includes(id)),
    ];
  }

  private async captureImages(): Promise<ImagePayload[]> {
    return (await this.planFrames()).images;
  }

  /** Frames for the planner, from the recent ones when kept, and where they came from. */
  private async planFrames(): Promise<{ images: ImagePayload[]; from: FramesFrom }> {
    const source = this.deps.images;
    const max = this.deps.options?.planImages ?? 2;
    if (!source) return { images: [], from: 'none' };
    try {
      if (this.recentFrames) return await this.recentFrames.take(max);
      const images = await source.snapshots(max);
      return { images, from: images.length > 0 ? 'fresh' : 'none' };
    } catch {
      return { images: [], from: 'none' };
    }
  }

  private finish(outcome: 'completed' | 'aborted', t: number): void {
    // A re-plan for a lesson that is over has nothing to land on.
    if (this.planning?.revision) {
      this.planning = null;
      this.attempt++;
    }
    this.spotlight.stop();
    this.endDemo(t);
    this.setPhase('done');
    const statuses = Object.values(this.runner?.state.statuses ?? {});
    const stop = this.deps.recorder?.stop(
      outcome,
      {
        stepsCompleted: statuses.filter((s) => s === 'done').length,
        stepsTotal: statuses.filter((s) => s !== 'skipped').length,
      },
      t,
    );
    if (stop) this.track(stop);
  }

  private episodeMeta(procedure: Procedure): Omit<EpisodeCreate, 'clock'> {
    const { registry } = this.deps;
    const workspace = this.deps.workspace();
    const context = this.deps.context();
    return {
      schema: EPISODE_SCHEMA_ID,
      mode: this.deps.options?.mode ?? 'learn',
      procedure: { id: procedure.id, version: procedure.version, title: procedure.title },
      plan: procedure,
      operator: context.operator,
      space: {
        frame: 'workspace',
        units: 'm',
        upAxis: '+y',
        worldFromWorkspace: poseToTuple(workspace.worldFromWorkspace),
        calibration: workspace.method,
        anchored: workspace.anchored,
      },
      hands: HAND_LAYOUT,
      objects: registry.all().map((e) => ({
        id: e.id,
        label: e.spec.label,
        position: e.position,
        radius: e.spec.radius,
        method: e.source,
      })),
      coach: context.coach,
      device: context.device,
      app: context.app,
      ...(context.camera ? { camera: context.camera } : {}),
      features: [
        EPISODE_FEATURE.objectFlags,
        EPISODE_FEATURE.objectGrasp,
        ...(context.features ?? []),
      ],
    };
  }

  private setPhase(phase: LessonPhase, detail?: string): void {
    this.currentPhase = phase;
    this.deps.bus.emit('lesson.phase', {
      t: this.deps.clock.now(),
      phase,
      ...(detail ? { detail } : {}),
    });
  }

  private track(promise: Promise<unknown>): void {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise));
  }
}
