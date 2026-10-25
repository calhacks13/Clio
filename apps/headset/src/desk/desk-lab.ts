import type { HealthResponse, Procedure } from '@clio/protocol';
import { MicCapture } from '../adapters/audio/mic-capture';
import type { FrameImage } from '../adapters/camera/frame-stream';
import { GeminiLiveAgent } from '../adapters/gemini/gemini-live-agent';
import type { ApiClient } from '../adapters/net/api-client';
import {
  RemoteFocusFinder,
  RemoteLocator,
  RemotePlanner,
  RemoteSceneAsker,
} from '../adapters/net/remote';
import { RemoteStepChecker, RemoteTemplates } from '../adapters/net/remote-plan';
import type { TrackerSocket } from '../adapters/net/tracker-client';
import { ScriptedAgent } from '../adapters/scripted/scripted-agent';
import { type Clock, performanceClock } from '../core/clock';
import { Emitter } from '../core/emitter';
import { createLogger } from '../core/log';
import type { RealtimeAgent } from '../domain/coach/agent';
import type { CoachFrameSource, MicSource, VoiceOutput } from '../domain/coach/ports';
import { CoachSession } from '../domain/coach/session';
import { CoachToolbox, type ToolOutcome } from '../domain/coach/toolbox';
import { DemoLibrary } from '../domain/demo/demo-library';
import type { Demonstration } from '../domain/demo/types';
import type { AppEvents } from '../domain/events';
import type { PlanView } from '../domain/plan/recital';
import { ActionFocus, type FocusFrames } from '../domain/session/action-focus';
import { CloserLook } from '../domain/session/closer-look';
import {
  type EpisodeContext,
  LessonController,
  type PlanImageSource,
} from '../domain/session/lesson-controller';
import type { CameraFrameSource } from '../domain/world/grounding';
import { ObjectRegistry } from '../domain/world/object-registry';
import { Workspace } from '../domain/world/workspace';
import type { DeskConfig } from './config';
import { DeskGrounder } from './desk-grounder';
import { DeskTracker } from './desk-tracker';
import { MutableMic } from './muted-mic';
import { DESK_WORKSPACE } from './stand-in';

// The desk lab's composition root: the headset's ClioApp (app/clio-app.ts) re-composed around the
// laptop's camera and microphone, without XR. The domain is the real one: the LessonController
// (planner, step watcher, curated lessons, the coach's tools), the CoachSession with its Narrator
// and CoachToolbox, the CloserLook, LiveTracking. So are the adapters: GeminiLiveAgent over the
// relay with the server's live model (the scripted coach without a key), the mic capture and the
// speaker, the server's planner, finder, step checker and scene asker, and the tracker's /track in
// objects mode, and the action focus (Robotics-ER 2 every few seconds while a step is focused, its
// boxes anchoring the tracker). What has no room to live in is stood in for or left out:
//   - no head pose, depth or hands: objects the finder or the tracker sees land in the registry at
//     a stand-in position (stand-in.ts), so the lesson knows they are found; hand checks never pass;
//   - a fixed workspace in front of the camera, never calibrated;
//   - no demonstrations (nothing draws ghost hands here): show_demo says so, auto-demo is off;
//   - no recording: the desk writes no episode.
// The per-frame pipeline is the headset's, ticked by a timer instead of the XR frame.

const log = createLogger('desk');
/** A planning frame is kept this often while a lesson may be about to start (as on the headset). */
const PLAN_FRAME_MS = 450;

/** The laptop camera in every role the lesson gives a camera (desk-camera.ts). */
export type DeskLabCamera = CameraFrameSource &
  CoachFrameSource &
  PlanImageSource &
  FocusFrames & { frame(): FrameImage | null };

export type CoachChoice = 'gemini' | 'scripted';

export interface DeskLabOptions {
  config: DeskConfig;
  api: ApiClient;
  health: HealthResponse | null;
  camera: DeskLabCamera;
  speaker: VoiceOutput;
  version: string;
  /** The tracker's /track WebSocket URL. */
  trackerUrl: string;
  clock?: Clock;
  /** Whether the page is shown (the tracker's frames stop while it is hidden). */
  visible?: () => boolean;
  /** Tests stand in for these. */
  agent?: (gemini: boolean) => RealtimeAgent;
  mic?: () => MicSource;
  socket?: (url: string) => TrackerSocket;
}

/** Nothing draws ghost hands on the desk: no step has a demonstration to show. */
class NoDemos extends DemoLibrary {
  constructor() {
    super(null);
  }
  override async forStep(): Promise<Demonstration | null> {
    return null;
  }
}

export class DeskLab {
  readonly bus = new Emitter<AppEvents>((err, type) =>
    log.error(`handler for ${String(type)} threw: ${String(err)}`),
  );
  readonly clock: Clock;
  readonly registry: ObjectRegistry;
  readonly lesson: LessonController;
  readonly tracker: DeskTracker;
  readonly grounder: DeskGrounder;
  private readonly closerLook: CloserLook;
  /** Robotics-ER's action focus; null with ?focus=0. */
  readonly focus: ActionFocus | null;
  /** In front of the camera, never calibrated: the planner's default table. */
  private readonly workspace = new Workspace({ p: [0, 0.75, -0.5], q: [0, 0, 0, 1] }, 'none');
  private coach: CoachSession | null = null;
  private agent: RealtimeAgent | null = null;
  private mic: MutableMic | null = null;
  private wanted: CoachChoice;
  private muted: boolean;
  private on = false;
  private kickedOff = false;
  /** True while a typed learner turn is being announced on the bus. */
  typing = false;

  constructor(private readonly o: DeskLabOptions) {
    const { bus } = this;
    const clock = o.clock ?? performanceClock;
    this.clock = clock;
    this.wanted = o.config.coach;
    this.muted = o.config.muted;
    this.registry = new ObjectRegistry(bus);
    this.grounder = new DeskGrounder({
      camera: o.camera,
      locator: new RemoteLocator(o.api),
      registry: this.registry,
      size: DESK_WORKSPACE,
    });
    this.tracker = new DeskTracker({
      bus,
      clock,
      registry: this.registry,
      procedure: () => this.lesson.procedure,
      camera: o.camera,
      url: o.trackerUrl,
      frameWidth: o.config.frameWidth,
      size: DESK_WORKSPACE,
      ...(o.visible ? { visible: o.visible } : {}),
      ...(o.socket ? { socket: o.socket } : {}),
    });
    this.lesson = new LessonController({
      bus,
      clock,
      planner: new RemotePlanner(o.api),
      registry: this.registry,
      workspace: () => this.workspace,
      grounder: this.grounder,
      images: o.camera,
      demos: new NoDemos(),
      recorder: null,
      context: () => this.context(),
      checker: new RemoteStepChecker(o.api),
      templates: new RemoteTemplates(o.api),
      live: () => this.tracker.live,
      options: {
        mode: 'learn',
        autoDemo: false,
        coachCanForce: true,
        showRefreshMs: o.config.showRefreshMs,
        planFrameMs: PLAN_FRAME_MS,
      },
    });
    this.closerLook = new CloserLook({
      camera: o.camera,
      asker: new RemoteSceneAsker(o.api),
      view: this.lesson.view(),
      bus,
      clock,
      placer: this.grounder,
    });
    // Looks only while the lab runs: a stopped lab sends Gemini nothing.
    this.focus = o.config.focus
      ? new ActionFocus({
          bus,
          clock,
          finder: new RemoteFocusFinder(o.api),
          frames: o.camera,
          anchors: this.tracker,
          tracking: this.tracker.tracking,
          view: this.lesson.view(),
          lesson: this.lesson,
          enabled: () => this.on,
        })
      : null;
    this.focus?.attach();
  }

  /** Started: the coach is on and the tracker connected (or retrying). */
  get running(): boolean {
    return this.on;
  }

  /** The coach the desk asks for (the one running may be scripted for want of a key). */
  get coachChoice(): CoachChoice {
    return this.wanted;
  }

  /** The coach running now, or null while stopped. */
  get coachKind(): RealtimeAgent['kind'] | null {
    return this.agent?.kind ?? null;
  }

  get coachModel(): string | null {
    return this.agent?.model ?? null;
  }

  get micMuted(): boolean {
    return this.muted;
  }

  plan(): PlanView | null {
    return this.lesson.view().plan();
  }

  /** Start the coach and the tracker; the first start also runs ?procedure= or plans ?goal=. */
  async start(): Promise<void> {
    if (this.on) return;
    this.on = true;
    this.tracker.open();
    await this.startCoach();
    if (this.kickedOff) return;
    this.kickedOff = true;
    const { procedureId, goal } = this.o.config;
    if (procedureId) await this.runProcedure(procedureId);
    else if (goal) this.startLesson(goal);
  }

  /** End the lesson, the coach and the tracker's stream. The camera keeps playing. */
  async stop(reason = 'stopped at the desk'): Promise<void> {
    if (!this.on) return;
    this.on = false;
    // As the headset shuts down: the stream first, then the lesson, then the voice.
    this.tracker.close();
    await this.lesson.stop(reason);
    await this.stopCoach();
  }

  /** Switch the voice between Gemini and the scripted coach; a running coach restarts. */
  async setCoach(choice: CoachChoice): Promise<void> {
    this.wanted = choice;
    if (!this.on) return;
    await this.stopCoach();
    await this.startCoach();
  }

  /** The per-frame pipeline without XR: perceive, decide (no hands, no record, no present). */
  tick(t = this.clock.now()): void {
    this.tracker.perceive(t);
    const changes = this.registry.drainChanges();
    if (changes.length > 0) this.bus.emit('objects.updated', { t, objects: changes });
    this.lesson.update({
      t,
      frame: { t, head: { p: [0, 0, 0], q: [0, 0, 0, 1] }, left: null, right: null },
      pinching: { left: false, right: false },
      objects: { position: (id) => this.registry.position(id) },
    });
    this.coach?.tick(t);
    this.focus?.tick(t)?.catch((err: unknown) => log.warn(`action focus: ${String(err)}`));
  }

  /**
   * A learner turn typed instead of spoken: it reaches the voice as the learner's own words and
   * the lesson hears that the learner spoke. False when no listening coach is running.
   */
  say(text: string): boolean {
    const line = text.trim();
    const agent = this.agent;
    if (!line || !agent || agent.kind !== 'gemini') return false;
    const t = this.clock.now();
    this.typing = true;
    try {
      this.bus.emit('coach.caption', { t, role: 'user', text: line, final: true });
      this.bus.emit('transcript', { t, role: 'user', text: line, final: true });
    } finally {
      this.typing = false;
    }
    agent.narrate({ kind: 'learner_text', text: line, reply: true });
    return true;
  }

  /** Start a lesson as the coach's start_lesson would; the coach hears the plan when it lands. */
  startLesson(goal: string): ToolOutcome {
    if (!goal.trim()) return { ok: false, error: 'Write a goal first.' };
    return this.lesson.startLesson(goal);
  }

  /** Run a curated lesson (procedures/), announced to the coach like a planned one. */
  async runProcedure(id: string): Promise<void> {
    let procedure: Procedure;
    try {
      procedure = await this.o.api.procedure(id);
    } catch (err) {
      log.warn(`no lesson "${id}": ${String(err)}`);
      return;
    }
    await this.lesson.run(procedure, null, { announce: [] });
  }

  /** The learner's Done button. */
  done(): ToolOutcome {
    return this.lesson.confirmByUser('Done button');
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.mic) this.mic.muted = muted;
  }

  private async startCoach(): Promise<void> {
    const { health, api, speaker, camera, config } = this.o;
    const useGemini = this.wanted === 'gemini' && !!health?.coach.configured;
    if (this.wanted === 'gemini' && !useGemini) {
      log.warn('Gemini is not configured on the server: using the scripted coach');
    }
    const templates = await new RemoteTemplates(api).list().catch(() => []);
    const make = (gemini: boolean): RealtimeAgent => {
      if (this.o.agent) return this.o.agent(gemini);
      return gemini && health
        ? new GeminiLiveAgent({
            model: health.coach.liveModel,
            transport: config.transport,
            token: async () => (await api.coachToken(health.coach.liveModel)).token,
            ...(config.voice ? { voice: config.voice } : {}),
          })
        : new ScriptedAgent();
    };
    const session = (agent: RealtimeAgent) => {
      this.mic =
        agent.kind === 'gemini' ? new MutableMic(this.o.mic?.() ?? new MicCapture()) : null;
      if (this.mic) this.mic.muted = this.muted;
      return new CoachSession({
        agent,
        toolbox: new CoachToolbox(
          { ...this.lesson.handlers(), ...this.closerLook.handlers() },
          this.bus,
          this.clock,
        ),
        bus: this.bus,
        clock: this.clock,
        view: this.lesson.view(),
        voice: speaker,
        ...(this.mic ? { mic: this.mic } : {}),
        ...(agent.kind === 'gemini' ? { camera } : {}),
        templates,
      });
    };
    try {
      this.agent = make(useGemini);
      this.coach = session(this.agent);
      await this.coach.start();
    } catch (err) {
      log.warn(`coach failed to start (${String(err)}); falling back to the scripted coach`);
      await this.coach?.stop().catch(() => {});
      this.agent = make(false);
      this.coach = session(this.agent);
      await this.coach.start();
    }
  }

  private async stopCoach(): Promise<void> {
    const coach = this.coach;
    this.coach = null;
    this.mic = null;
    await coach?.stop().catch((err: unknown) => log.warn(`coach stop: ${String(err)}`));
    this.agent = null;
  }

  private context(): EpisodeContext {
    const agent = this.agent;
    return {
      operator: { role: 'learner' },
      coach: {
        kind: agent?.kind ?? 'none',
        ...(agent?.model ? { model: agent.model } : {}),
        ...(agent?.kind === 'gemini' ? { transport: this.o.config.transport } : {}),
      },
      device: {
        userAgent: globalThis.navigator?.userAgent ?? 'desk',
        emulated: false,
        xrFeatures: [],
      },
      app: { version: this.o.version },
    };
  }
}
