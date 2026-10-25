import { EPISODE_FEATURE, type HealthResponse, type Procedure } from '@clio/protocol';
import { MicCapture } from '../adapters/audio/mic-capture';
import type { SpeakerOutput } from '../adapters/audio/voice-output';
import { passthroughCameraRecord } from '../adapters/camera/camera-meta';
import type { PassthroughCamera } from '../adapters/camera/passthrough-camera';
import { GeminiLiveAgent } from '../adapters/gemini/gemini-live-agent';
import type { ApiClient } from '../adapters/net/api-client';
import { HttpEpisodeSink } from '../adapters/net/http-episode-sink';
import {
  RemoteClipSource,
  RemoteLocator,
  RemotePlanner,
  RemoteSceneAsker,
} from '../adapters/net/remote';
import { RemoteStepChecker, RemoteTemplates } from '../adapters/net/remote-plan';
import type { PresentContext, Presenter } from '../adapters/render/presenter';
import { GhostHandsPresenter } from '../adapters/render/presenters/ghost-hands';
import { GlyphsPresenter } from '../adapters/render/presenters/glyphs';
import { HudPresenter } from '../adapters/render/presenters/hud';
import { InstructionPanelPresenter } from '../adapters/render/presenters/instruction-panel';
import { ObjectMarkersPresenter } from '../adapters/render/presenters/object-markers';
import { OutlinesPresenter } from '../adapters/render/presenters/outlines';
import {
  CalibrationMarkerPresenter,
  WorkspacePresenter,
} from '../adapters/render/presenters/workspace-view';
import { SceneRuntime } from '../adapters/render/scene-runtime';
import { ScriptedAgent } from '../adapters/scripted/scripted-agent';
import { WorkspaceAnchor } from '../adapters/xr/anchors';
import { XrPlaneReader } from '../adapters/xr/environment';
import { FrameSampler, poseFromMatrix } from '../adapters/xr/frame-sampler';
import { XrPlaneSurfaces } from '../adapters/xr/planes';
import { startArSession, type XrRuntime } from '../adapters/xr/xr-session';
import { performanceClock } from '../core/clock';
import { Emitter } from '../core/emitter';
import { createLogger } from '../core/log';
import type { Pose } from '../core/math';
import type { RealtimeAgent } from '../domain/coach/agent';
import { CoachSession } from '../domain/coach/session';
import { CoachToolbox } from '../domain/coach/toolbox';
import { DemoLibrary } from '../domain/demo/demo-library';
import type { AppEvents } from '../domain/events';
import { PinchDetector, type PinchTransition } from '../domain/hands/pinch-detector';
import { HANDS, type TrackedFrame } from '../domain/hands/types';
import { OverlayModel } from '../domain/overlay/overlay-model';
import { EpisodeRecorder } from '../domain/recording/recorder';
import { CloserLook } from '../domain/session/closer-look';
import { LessonController } from '../domain/session/lesson-controller';
import { CalibrationFlow } from '../domain/world/calibration';
import { EnvironmentRecorder } from '../domain/world/environment';
import { ObjectGrounder } from '../domain/world/grounding';
import { GraspTracker } from '../domain/world/holding';
import { ObjectRegistry } from '../domain/world/object-registry';
import { PoseHistory } from '../domain/world/pose-history';
import { chooseTablePlane, fitTable, type TablePlane } from '../domain/world/table-snap';
import { Workspace, workspaceInFrontOf } from '../domain/world/workspace';
import type { AppConfig } from './config';
import { LiveTracker } from './live-tracker';

// The composition root: the only place that knows every adapter. It wires the domain to the
// headset, then runs the per-frame pipeline from docs/ARCHITECTURE.md §5.2:
// sample → localize → perceive → decide → record → present. With a camera, what each step shows
// is followed live by the tracker when it answers (live-tracker.ts, ?live=0 turns it off).

const log = createLogger('app');
const PINCH_NEAREST_M = 0.15;
const RELOCATE_DELAY_MS = 600;
/** A planning frame is kept this often while a lesson may be about to start (lesson-controller). */
const PLAN_FRAME_MS = 450;
/** How long after the session starts the workspace waits for a detected table. */
const TABLE_WAIT_MS = 2000;

export interface ClioAppOptions {
  config: AppConfig;
  container: HTMLElement;
  api: ApiClient;
  health: HealthResponse | null;
  camera: PassthroughCamera | null;
  speaker: SpeakerOutput;
  emulated: boolean;
  /** A saved procedure to run instead of planning one. */
  procedure: Procedure | null;
  /** A goal to plan immediately. */
  goal: string | null;
  version: string;
}

export class ClioApp {
  readonly bus = new Emitter<AppEvents>((err, type) =>
    log.error(`handler for ${String(type)} threw: ${String(err)}`),
  );
  readonly clock = performanceClock;
  private readonly scene: SceneRuntime;
  private readonly registry: ObjectRegistry;
  private readonly poses = new PoseHistory(256);
  private readonly pinch = new PinchDetector();
  private readonly grasp: GraspTracker;
  private readonly recorder: EpisodeRecorder;
  private readonly lesson: LessonController;
  /** The voice coach's line to the smart model (look_closer). */
  private readonly closerLook: CloserLook;
  private readonly overlay: OverlayModel;
  private readonly sampler = new FrameSampler();
  private readonly surfaces = new XrPlaneSurfaces();
  private readonly planes = new XrPlaneReader((err) =>
    log.warn(`plane detection failed (${String(err)}); planes are not recorded`),
  );
  private readonly environment: EnvironmentRecorder;
  /** Null without a camera, or with ?live=0. */
  private readonly live: LiveTracker | null;
  private readonly anchor = new WorkspaceAnchor();
  private readonly workspacePresenters: Presenter[];
  private readonly worldPresenters: Presenter[];
  private workspace: Workspace | null = null;
  private calibration: CalibrationFlow | null;
  private coach: CoachSession | null = null;
  private agent: RealtimeAgent | null = null;
  private runtime: XrRuntime | null = null;
  private lastT = 0;
  private kickedOff = false;
  private pendingAnchor: Pose | null = null;
  /** Until this frame time, the workspace may still snap to a detected table. */
  private tableDeadline: number | null = null;

  constructor(private readonly o: ClioAppOptions) {
    const { bus, clock } = this;
    this.scene = new SceneRuntime(o.container);
    this.registry = new ObjectRegistry(bus);
    this.grasp = new GraspTracker(this.registry);
    this.calibration = o.config.calibrate ? new CalibrationFlow() : null;
    this.recorder = new EpisodeRecorder({
      bus,
      clock,
      sink: new HttpEpisodeSink(o.api),
      onDrop: (why) => log.warn(`recording: dropped ${why}`),
    });
    this.environment = new EnvironmentRecorder({ bus });
    bus.on('recorder.status', ({ recording }) => {
      if (recording) this.environment.reset();
    });
    const grounder = o.camera
      ? new ObjectGrounder({
          camera: o.camera,
          locator: new RemoteLocator(o.api),
          registry: this.registry,
          poses: this.poses,
          workspace: () => this.currentWorkspace(),
          surface: this.surfaces,
        })
      : null;
    this.live =
      o.camera && o.config.live
        ? new LiveTracker({
            bus,
            clock,
            registry: this.registry,
            poses: this.poses,
            camera: o.camera,
            surfaces: this.surfaces,
            workspace: () => this.currentWorkspace(),
            procedure: () => this.lesson.procedure,
            trackerPort: o.config.trackerPort,
            frameWidth: o.config.frameWidth,
            hideHeld: !o.config.liveHeld,
            emulated: o.emulated,
          })
        : null;
    this.lesson = new LessonController({
      bus,
      clock,
      planner: new RemotePlanner(o.api),
      registry: this.registry,
      workspace: () => this.currentWorkspace(),
      grounder,
      images: o.camera,
      demos: new DemoLibrary(new RemoteClipSource(o.api)),
      recorder: this.recorder,
      context: () => this.episodeContext(),
      checker: new RemoteStepChecker(o.api),
      templates: new RemoteTemplates(o.api),
      live: () => this.live?.live ?? false,
      options: {
        mode: o.config.mode,
        autoDemo: o.config.autoDemo,
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
      placer: grounder,
    });
    this.overlay = new OverlayModel(bus, this.lesson.view());
    this.overlay.attach();

    const lit = (id: string) => this.live?.lit(id) ?? false;
    this.workspacePresenters = [
      new ObjectMarkersPresenter(lit),
      new OutlinesPresenter(lit),
      new GhostHandsPresenter(),
      new GlyphsPresenter(),
      new WorkspacePresenter(),
    ];
    this.worldPresenters = [
      new InstructionPanelPresenter(() => this.lesson.confirmByUser('Done button')),
      new HudPresenter(),
      new CalibrationMarkerPresenter(),
      ...(this.live ? [this.live.presenter] : []),
    ];
    for (const p of this.workspacePresenters) this.scene.workspaceRoot.add(p.object);
    for (const p of this.worldPresenters) this.scene.worldRoot.add(p.object);
    if (this.live) this.scene.worldRoot.add(this.live.occluders.object);

    // Live observations come many times a second; they would drown the log.
    if (o.config.debug) {
      this.bus.onAny((type) => {
        if (type !== 'objects.observed') log.debug(String(type));
      });
    }
  }

  async enterXr(): Promise<void> {
    // Depth sensing measures what the tracker follows; it costs, so only with a tracker there.
    const depthSensing = (await this.live?.connect()) ?? false;
    try {
      this.runtime = await startArSession(this.scene.renderer, { depthSensing });
    } catch (err) {
      // The boot page builds a new app for the next try.
      this.live?.stop();
      throw err;
    }
    this.live?.start(this.runtime, this.scene.renderer);
    log.info(`XR session: ${this.runtime.features.join(', ') || 'no optional features'}`);
    this.runtime.session.addEventListener('end', () => void this.shutdown('session ended'));
    if (!this.o.config.calibrate && (await this.anchor.restore(this.runtime.session))) {
      log.info('restored the saved workspace anchor');
    }
    this.scene.start((time, frame) => {
      if (frame) this.onFrame(time, frame);
    });
  }

  async shutdown(reason: string): Promise<void> {
    await this.lesson.stop(reason);
    this.live?.stop();
    await this.coach?.stop();
    this.scene.stop();
  }

  // ---- per frame -------------------------------------------------------------------------------

  private onFrame(t: number, frame: XRFrame): void {
    const runtime = this.runtime;
    if (!runtime) return;
    const dt = this.lastT ? t - this.lastT : 0;
    this.lastT = t;

    // 1. Sample (world space).
    const world = this.sampler.sample(frame, runtime.space, t);
    if (!world) return;
    this.poses.push(t, world.head);

    // 2. Localize: establish and refine the workspace frame; track real surfaces.
    const workspace = this.localize(world, frame, runtime);
    this.surfaces.update(frame, runtime.space);
    this.scene.setWorkspacePose(workspace.worldFromWorkspace);
    const local = workspace.toWorkspaceFrame(world);

    // 3. Perceive: pinches (detected in world space), grasps, object-estimate changes.
    for (const hand of HANDS) {
      const transition = this.pinch.update(hand, world[hand], t);
      if (transition) this.onPinch(transition, local, workspace);
    }
    const released = this.grasp.update(local);
    if (released.length > 0) setTimeout(() => this.lesson.relocate(released), RELOCATE_DELAY_MS);
    this.live?.perceive(frame, t);
    const changes = this.registry.drainChanges();
    if (changes.length > 0) this.bus.emit('objects.updated', { t, objects: changes });

    // 4. Decide.
    this.lesson.update({
      t,
      frame: local,
      pinching: { left: this.pinch.isPinching('left'), right: this.pinch.isPinching('right') },
      objects: { position: (id) => this.registry.position(id) },
    });
    this.overlay.setProgress(this.lesson.runnerState?.progress ?? 0);
    this.coach?.tick(t);
    if (!this.kickedOff && !this.calibration && this.tableDeadline === null) {
      this.kickedOff = true;
      void this.kickoff();
    }

    // 5. Record.
    this.recorder.recordFrame(local);
    if (this.recorder.recording && this.planeDetection) {
      this.environment.update(t, this.planes.read(frame, runtime.space), workspace);
    }

    // 6. Present.
    this.live?.prepare(frame, runtime.space);
    const ctx: PresentContext = {
      t,
      dt,
      snapshot: this.overlay.snapshot(t),
      procedure: this.lesson.procedure,
      objects: this.registry.all(),
      objectMasks: this.live?.panelMasks ?? [],
      demo: this.lesson.activeDemo,
      demoHands: this.lesson.activeDemo ? this.lesson.player.sample(t) : null,
      hands: local,
      head: world.head,
      worldFromWorkspace: workspace.worldFromWorkspace,
      calibration: this.calibration
        ? { ...this.calibration.prompt, firstCorner: this.calibration.firstCorner }
        : null,
      debug: this.o.config.debug,
    };
    for (const p of this.workspacePresenters) p.update(ctx);
    for (const p of this.worldPresenters) p.update(ctx);
  }

  private localize(world: TrackedFrame, frame: XRFrame, runtime: XrRuntime): Workspace {
    if (!this.workspace) {
      const restored = this.anchor.pose(frame, runtime.space);
      this.workspace = restored
        ? new Workspace(restored, 'persisted_anchor', true)
        : new Workspace(
            workspaceInFrontOf(world.head),
            this.calibration ? 'none' : 'default_in_front',
          );
      if (!this.calibration && !this.anchor.active) {
        if (this.o.config.table === 'auto') this.tableDeadline = world.t + TABLE_WAIT_MS;
        else log.info('workspace: in front of the user (table=off)');
      }
    } else if (this.anchor.active) {
      const refined = this.anchor.pose(frame, runtime.space);
      if (refined) this.workspace.update(refined, true);
    }
    if (this.tableDeadline !== null) this.snapToTable(world, frame, runtime.space);
    if (this.pendingAnchor) {
      const pose = this.pendingAnchor;
      this.pendingAnchor = null;
      void this.anchor.create(frame, runtime.space, pose).then((ok) => {
        if (ok && this.workspace) this.workspace.update(this.workspace.worldFromWorkspace, true);
      });
    }
    return this.workspace;
  }

  /**
   * Moves the workspace onto the detected table: at once for a plane labeled table or desk, else
   * when the wait is over (the largest surface at table height, or the default in front).
   */
  private snapToTable(world: TrackedFrame, frame: XRFrame, space: XRReferenceSpace): void {
    const deadline = this.tableDeadline;
    if (deadline === null) return;
    // One episode, one frame: the workspace never moves once recording has started.
    if (this.recorder.recording) {
      this.tableDeadline = null;
      return;
    }
    const waited = world.t >= deadline;
    const choice = chooseTablePlane(tablePlanes(frame, space), world.head);
    if (choice && (choice.by === 'label' || waited)) {
      const { pose, size } = fitTable(
        choice.plane,
        world.head,
        this.o.procedure?.workspace.size[0],
      );
      this.workspace = new Workspace(pose, 'none');
      this.tableDeadline = null;
      const what = choice.by === 'label' ? choice.plane.label : 'largest surface';
      const [w, d] = size.map((m) => m.toFixed(2));
      log.info(`workspace: on the ${what} (${w} x ${d} m, ${pose.p[1].toFixed(2)} m up)`);
    } else if (waited) {
      this.tableDeadline = null;
      log.info('workspace: in front of the user (no table plane in reach)');
    }
  }

  private onPinch(transition: PinchTransition, local: TrackedFrame, workspace: Workspace): void {
    if (this.calibration) {
      const pose = this.calibration.onPinch(transition);
      if (pose) this.finishCalibration(pose);
      return;
    }
    const point = workspace.toWorkspacePoint(transition.point);
    const inWorkspace = { ...transition, point };
    this.bus.emit('hand.pinch', {
      t: transition.t,
      hand: transition.hand,
      phase: transition.phase,
      point,
      nearest: this.registry.nearest(point, PINCH_NEAREST_M),
    });
    this.grasp.onPinch(inWorkspace, local);
    this.lesson.onPinch(inWorkspace);
  }

  private finishCalibration(pose: Pose): void {
    this.workspace = new Workspace(pose, 'pinch_two_corners', false);
    this.pendingAnchor = pose;
    this.calibration = null;
    this.bus.emit('workspace.calibrated', {
      t: this.clock.now(),
      method: 'pinch_two_corners',
      worldFromWorkspace: pose,
    });
    log.info('workspace calibrated');
  }

  // ---- lesson start ------------------------------------------------------------------------

  private async kickoff(): Promise<void> {
    await this.startCoach();
    const { procedure, goal } = this.o;
    // Announced like a planned lesson, so the coach hears the whole plan with its step ids.
    if (procedure) await this.lesson.run(procedure, null, { announce: [] });
    else if (goal) await this.lesson.startLesson(goal);
    // Otherwise the coach asks what they want to learn and calls start_lesson.
  }

  private async startCoach(): Promise<void> {
    const { config, health, api, speaker, camera } = this.o;
    if (config.coach === 'off') return;
    const useGemini = config.coach === 'gemini' && health?.coach.configured;
    if (config.coach === 'gemini' && !useGemini)
      log.warn('Gemini not configured on the server; using the scripted coach');
    const templates = await new RemoteTemplates(api).list().catch(() => []);
    const make = (gemini: boolean): RealtimeAgent =>
      gemini && health
        ? new GeminiLiveAgent({
            model: health.coach.liveModel,
            transport: config.transport,
            token: async () => (await api.coachToken(health.coach.liveModel)).token,
            ...(config.voice ? { voice: config.voice } : {}),
          })
        : new ScriptedAgent();
    const session = (agent: RealtimeAgent) =>
      new CoachSession({
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
        ...(agent.kind === 'gemini' ? { mic: new MicCapture() } : {}),
        ...(camera && agent.kind === 'gemini' ? { camera } : {}),
        ...(this.o.procedure?.coach.persona ? { persona: this.o.procedure.coach.persona } : {}),
        templates,
      });
    try {
      this.agent = make(!!useGemini);
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

  /** Planes are detected (and recorded) only when the session enabled the feature. */
  private get planeDetection(): boolean {
    return this.runtime?.features.includes('plane-detection') ?? false;
  }

  private currentWorkspace(): Workspace {
    return this.workspace ?? new Workspace({ p: [0, 0.75, -0.5], q: [0, 0, 0, 1] }, 'none');
  }

  private episodeContext() {
    const agent = this.agent;
    return {
      operator: {
        role: this.o.config.mode === 'record_demo' ? ('expert' as const) : ('learner' as const),
      },
      coach: {
        kind: agent?.kind ?? ('none' as const),
        ...(agent?.model ? { model: agent.model } : {}),
        ...(agent?.kind === 'gemini' ? { transport: this.o.config.transport } : {}),
      },
      device: {
        userAgent: navigator.userAgent,
        emulated: this.o.emulated,
        xrFeatures: this.runtime?.features ?? [],
      },
      app: { version: this.o.version },
      // The model the camera's answers are lifted with, so they can be lifted again offline.
      ...(this.o.camera ? { camera: passthroughCameraRecord(this.o.camera) } : {}),
      features: [
        ...(this.planeDetection ? [EPISODE_FEATURE.environmentPlanes] : []),
        ...(this.live ? [EPISODE_FEATURE.objectObservations] : []),
      ],
    };
  }
}

/** Horizontal planes with their semantic labels (Quest's room setup), for the table snap. */
function tablePlanes(frame: XRFrame, space: XRReferenceSpace): TablePlane[] {
  const planes: TablePlane[] = [];
  for (const plane of frame.detectedPlanes ?? []) {
    if (plane.orientation !== 'horizontal' || plane.polygon.length < 3) continue;
    const pose = frame.getPose(plane.planeSpace, space);
    if (!pose) continue;
    planes.push({
      pose: poseFromMatrix(pose.transform.matrix),
      polygon: plane.polygon.map((p) => [p.x, p.z] as const),
      label: plane.semanticLabel ?? null,
    });
  }
  return planes;
}
