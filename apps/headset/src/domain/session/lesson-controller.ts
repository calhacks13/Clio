import {
  clipIdFor,
  EPISODE_FEATURE,
  EPISODE_SCHEMA_ID,
  type EpisodeCreate,
  type EpisodeMode,
  HAND_LAYOUT,
  type ImagePayload,
  type PlanRequest,
  type PlanResponse,
  type Procedure,
  type Step,
} from '@clio/protocol';
import type { Clock } from '../../core/clock';
import { poseToTuple } from '../../core/math';
import type { LessonView } from '../coach/ports';
import type { ToolHandlers, ToolOutcome } from '../coach/toolbox';
import { ClipPlayer } from '../demo/clip-player';
import type { DemoLibrary } from '../demo/demo-library';
import type { Demonstration } from '../demo/types';
import type { AppBus, HighlightStyle, LessonPhase } from '../events';
import type { PinchTransition } from '../hands/pinch-detector';
import { type FrameContext, ProcedureRunner, type RunnerState } from '../procedure/runner';
import type { EpisodeRecorder } from '../recording/recorder';
import type { Grounder } from '../world/grounding';
import type { ObjectRegistry } from '../world/object-registry';
import type { Workspace } from '../world/workspace';
import { Spotlight } from './spotlight';

// The application service for a lesson: goal → plan (LLM, with camera snapshots) → locate the
// plan's objects → run the procedure while recording, outlining what each step shows → revise
// when reality differs. It also implements the coach's tools, so everything the coach does flows
// through one place.

/** Port: the planner (the server's /api/plans). */
export interface LessonPlanner {
  plan(request: PlanRequest): Promise<PlanResponse>;
}

/** Port: camera snapshots to show the planner what the learner is looking at. */
export interface PlanImageSource {
  snapshots(max: number): Promise<ImagePayload[]>;
}

export type EpisodeContext = Pick<EpisodeCreate, 'operator' | 'coach' | 'device' | 'app'>;

export interface LessonOptions {
  mode?: EpisodeMode;
  /** May the coach complete a step whose check hasn't passed? (Labeled forced.) */
  coachCanForce?: boolean;
  /** Play each step's demonstration automatically when the step starts. */
  autoDemo?: boolean;
  /** Camera snapshots sent with each planning request. */
  planImages?: number;
  /** How often to look again at what the current step shows (ms); 0 only looks on step entry. */
  showRefreshMs?: number;
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
  options?: LessonOptions;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A pinch this close to a placed object is about that object, not a registration. */
const NEAR_KNOWN_OBJECT_M = 0.08;

export class LessonController {
  readonly player = new ClipPlayer();
  private currentPhase: LessonPhase = 'idle';
  private runner: ProcedureRunner | null = null;
  private plan: { planId: string | null; procedure: Procedure } | null = null;
  private demo: Demonstration | null = null;
  private demoClipId = '';
  private planning = false;
  private completedSteps = 0;
  private readonly pending = new Set<Promise<unknown>>();
  /** Missing objects already announced to the learner, so the coach isn't told twice. */
  private readonly announced = new Set<string>();
  /** Every camera lookup goes through here, so each one is recorded and outlined consistently. */
  private readonly spotlight: Spotlight;

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
    bus.on('object.registered', ({ objectId }) => {
      this.announced.delete(objectId);
    });
    bus.on('step.completed', () => {
      this.completedSteps++;
    });
    bus.on('step.entered', ({ t, index }) => this.onStepEntered(index, t));
    bus.on('procedure.completed', ({ t }) => this.finish('completed', t));
    bus.on('procedure.aborted', ({ t }) => this.finish('aborted', t));
  }

  get phase(): LessonPhase {
    return this.currentPhase;
  }

  get procedure(): Procedure | null {
    return this.plan?.procedure ?? null;
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

  view(): LessonView {
    return {
      procedure: () => this.procedure,
      label: (id) => this.deps.registry.spec(id)?.label ?? id,
    };
  }

  handlers(): ToolHandlers {
    return {
      start_lesson: ({ goal, context }) => this.startLesson(goal, context),
      revise_plan: ({ reason }) => this.revisePlan(reason),
      highlight: ({ object_id, style }) => this.highlight(object_id, style),
      show_demo: ({ step_id }) => this.showDemo(step_id),
      advance_step: ({ reason }) => this.advance('coach', reason),
      flag_mistake: ({ kind, message }) => this.flagMistake(kind, message),
    };
  }

  /** Plan a lesson for a goal and run it. */
  async startLesson(goal: string, context?: string): Promise<ToolOutcome> {
    const { bus, clock, planner } = this.deps;
    if (this.planning) return { ok: false, error: 'Already planning a lesson.' };
    if (this.runner?.state.status === 'running') {
      this.runner.abort('a new lesson was requested', clock.now());
      await this.settled();
    }
    this.planning = true;
    this.setPhase('planning', goal);
    bus.emit('plan.requested', { t: clock.now(), goal, revision: false });
    let response: PlanResponse;
    try {
      const images = await this.captureImages();
      response = await planner.plan({ goal, ...(context ? { context } : {}), images });
    } catch (err) {
      this.planning = false;
      bus.emit('plan.failed', { t: clock.now(), goal, error: errorText(err) });
      this.setPhase('idle');
      return { ok: false, error: `Planning failed: ${errorText(err)}` };
    }
    this.planning = false;
    const { procedure, planId, warnings } = response;
    bus.emit('plan.ready', { t: clock.now(), planId, procedure, warnings, revision: false });
    const located = await this.run(procedure, planId);
    return {
      ok: true,
      timing: 'when_idle',
      result: {
        title: procedure.title,
        steps: procedure.steps.length,
        notFound: located.missing.map((id) => this.view().label(id)),
        warnings,
      },
    };
  }

  /** Run a procedure (curated from the menu, or freshly planned). */
  async run(procedure: Procedure, planId: string | null = null): Promise<{ missing: string[] }> {
    const { bus, clock, registry, recorder } = this.deps;
    registry.load(procedure.objects, clock.now());
    this.plan = { planId, procedure };
    this.completedSteps = 0;
    this.announced.clear();
    const missing = await this.locate(registry.unplaced());
    recorder?.start(this.episodeMeta(procedure), clock.now());
    this.runner = new ProcedureRunner(procedure, bus, {
      coachCanForce: this.deps.options?.coachCanForce ?? true,
    });
    this.setPhase('lesson');
    this.runner.start(clock.now());
    return { missing };
  }

  async revisePlan(reason: string): Promise<ToolOutcome> {
    const { bus, clock, planner, registry } = this.deps;
    const plan = this.plan;
    const runner = this.runner;
    if (!plan || !runner || runner.state.status !== 'running') {
      return { ok: false, error: 'No lesson is running to revise.' };
    }
    if (this.planning) return { ok: false, error: 'Already planning.' };
    const fromStepIndex = runner.state.stepIndex;
    const goal =
      plan.procedure.origin.kind === 'generated'
        ? plan.procedure.origin.goal
        : plan.procedure.title;
    this.planning = true;
    bus.emit('plan.requested', { t: clock.now(), goal, revision: true });
    let response: PlanResponse;
    try {
      response = await planner.plan({
        goal,
        images: await this.captureImages(),
        revise: { planId: plan.planId ?? plan.procedure.id, fromStepIndex, reason },
      });
    } catch (err) {
      bus.emit('plan.failed', { t: clock.now(), goal, error: errorText(err) });
      return { ok: false, error: `Re-planning failed: ${errorText(err)}` };
    } finally {
      this.planning = false;
    }
    const t = clock.now();
    bus.emit('plan.ready', { t, ...response, revision: true });
    bus.emit('annotation', {
      t,
      label: 'plan.revised',
      data: { from: plan.planId, to: response.planId, fromStepIndex, reason },
    });
    registry.load(response.procedure.objects, t);
    this.plan = { planId: response.planId, procedure: response.procedure };
    runner.replacePlan(response.procedure, t);
    const missing = await this.locate(registry.unplaced());
    return {
      ok: true,
      timing: 'when_idle',
      result: {
        steps: response.procedure.steps.length,
        resumingAtStep: fromStepIndex + 1,
        notFound: missing.map((id) => this.view().label(id)),
      },
    };
  }

  /** Per tracked frame (workspace space). */
  update(frame: FrameContext): void {
    this.runner?.update(frame);
    this.tick(frame.t);
  }

  /** Time-based upkeep: demo playback, and looking again at what the step shows. */
  tick(t: number): void {
    if (this.demo && this.player.finished(t)) this.endDemo(t);
    const look = this.spotlight.tick(t);
    if (look) this.track(look);
  }

  /** A pinch in free space while objects are missing registers the next missing one there. */
  onPinch(transition: PinchTransition): void {
    const { registry } = this.deps;
    if (transition.phase !== 'start') return;
    const [next] = this.registrationQueue();
    if (!next || registry.nearest(transition.point, NEAR_KNOWN_OBJECT_M)) return;
    registry.observe(next, {
      position: transition.point,
      confidence: 0.9,
      source: 'pinch',
      t: transition.t,
    });
  }

  /** Refine positions with the camera (e.g. after the learner puts an object down). Quiet. */
  relocate(ids: readonly string[]): void {
    if (!this.deps.grounder || ids.length === 0) return;
    this.track(this.spotlight.find(ids.map((id) => ({ id }))));
  }

  /** Learner-side confirmation (e.g. a "done" gesture or button). */
  confirmByUser(reason = 'user confirmed'): ToolOutcome {
    return this.advance('user', reason);
  }

  async stop(reason: string): Promise<void> {
    if (this.runner?.state.status === 'running') this.runner.abort(reason, this.deps.clock.now());
    await this.settled();
  }

  /** Resolves when background work (grounding, recording uploads) has finished. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  // ---- tools ---------------------------------------------------------------------------------

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
        result: { shown: false, note: `${spec.label} is not located yet; looking for it.` },
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
          ? 'Cannot show this yet: its objects have not been located.'
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

  private advance(by: 'coach' | 'user', reason: string): ToolOutcome {
    if (!this.runner) return { ok: false, error: 'No lesson is running.' };
    const r = this.runner.advance(by, reason, this.deps.clock.now());
    return r.ok
      ? { ok: true, result: { advanced: true, forced: r.forced } }
      : { ok: false, error: r.error };
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
    this.track(this.spotlight.enterStep(step).then((missing) => this.announce(missing)));
    if (this.deps.options?.autoDemo && step.action) {
      this.track(
        this.demoFor(procedure, step).then((demo) => {
          if (demo && this.currentStep()?.id === step.id) this.playDemo(demo, procedure, step, t);
        }),
      );
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

  /** Locate objects with the camera; returns the ids still missing, announcing new ones once. */
  private async locate(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const previous = this.currentPhase;
    const showPhase = this.deps.grounder !== null && previous !== 'lesson';
    if (showPhase) this.setPhase('locating');
    const missing = await this.spotlight.find(ids.map((id) => ({ id })));
    if (showPhase) this.setPhase(previous);
    this.announce(missing);
    return missing;
  }

  /** Tell the learner (through the coach) about missing objects, once each. */
  private announce(missing: readonly string[]): void {
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
    const source = this.deps.images;
    if (!source) return [];
    return source.snapshots(this.deps.options?.planImages ?? 2).catch(() => []);
  }

  private finish(outcome: 'completed' | 'aborted', t: number): void {
    this.spotlight.stop();
    this.endDemo(t);
    this.setPhase('done');
    const stop = this.deps.recorder?.stop(
      outcome,
      { stepsCompleted: this.completedSteps, stepsTotal: this.procedure?.steps.length ?? 0 },
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
      features: [EPISODE_FEATURE.objectFlags, EPISODE_FEATURE.objectGrasp],
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
