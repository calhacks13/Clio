import type { NormalizedBox, Procedure } from '@clio/protocol';
import type { WebGLRenderer } from 'three';
import { captureTime, FrameStream, frameSize } from '../adapters/camera/frame-stream';
import type { PassthroughCamera } from '../adapters/camera/passthrough-camera';
import {
  type TrackedQuery,
  TrackerClient,
  type TrackerDetections,
  type TrackerSocket,
  trackerUrl,
} from '../adapters/net/tracker-client';
import { HandOccluders } from '../adapters/render/hand-occluders';
import { type LiveBox, LiveBoxesPresenter } from '../adapters/render/presenters/live-boxes';
import {
  type LiveHighlight,
  LiveHighlightsPresenter,
} from '../adapters/render/presenters/live-highlights';
import { glowModeFor } from '../adapters/render/presenters/outlines';
import { createDepthProbe, type XrDepthProbe } from '../adapters/xr/depth';
import {
  createDepthSampler,
  type DepthSampler,
  depthUsageOf,
  preferDepthSensing,
} from '../adapters/xr/depth-sensing';
import type { XrRuntime } from '../adapters/xr/xr-session';
import type { Clock } from '../core/clock';
import { createLogger } from '../core/log';
import type { AppBus } from '../domain/events';
import { ObjectTrackRecorder } from '../domain/recording/object-track-recorder';
import { isShown, type LiveObject, LiveTracking } from '../domain/session/live-tracking';
import type { DepthSource } from '../domain/world/depth-source';
import type { SurfaceRaycaster } from '../domain/world/grounding';
import { LiveObjects, type LiveView } from '../domain/world/live-objects';
import type { ObjectRegistry } from '../domain/world/object-registry';
import type { Placement } from '../domain/world/placement';
import type { PoseHistory } from '../domain/world/pose-history';
import type { Workspace } from '../domain/world/workspace';

// The lesson's live tracking (docs/object-finder.md, "When Clio asks"). The camera's frames stream
// to the tracker's /track (tracker/TRACK.md, objects mode), told what the plan and the coach name
// (LiveTracking); it follows each object on every frame and asks jev about them itself, about once
// a second. Each answer is placed in the room at the object's measured distance (LiveObjects) and
// drawn with the primary page's depth-correct glow, and the registry and the recording hear about
// it as the camera's untrusted `detector`. Each lit object's bounding box is drawn next to its glow,
// with its name on a tag (with ?debug=1 every followed object's, its tag saying what the tracker
// last said of it). Robotics-ER's boxes from the action focus come back in as anchors: the tracker
// places the object from them and trusts them over jev for a while (tracker/TRACK.md). Without the
// tracker (not running, or the connection dropped) nothing is streamed and the lesson's own looks
// (Spotlight) carry on as before, while the connection keeps retrying. The Quest runs hot, so
// frames go out only while the session is shown and something is being followed.

const log = createLogger('live');
/** Entering AR waits this long for the tracker, to know whether to ask for depth sensing (ms). */
const CONNECT_WAIT_MS = 800;
/** Answers handled per XR frame at most (the newest). */
const MAX_PENDING = 4;
/** Sent frames whose size is remembered, for the recording. */
const SIZES_KEPT = 32;
/** An unlit object's box (?debug=1) is drawn this much fainter than a lit one's. */
const UNLIT_BOX_OPACITY = 0.45;

/**
 * One of Robotics-ER's boxes for the tracker: the action focus's FocusAnchors port
 * (domain/session/action-focus.ts).
 */
export interface FocusAnchor {
  id: string;
  box: NormalizedBox;
  /** Capture time of the frame ER saw (performance.now ms). */
  t: number;
  /** ER's words for the object, for jev from now on. */
  query?: string;
}

export interface LiveTrackerDeps {
  bus: AppBus;
  clock: Clock;
  registry: ObjectRegistry;
  poses: PoseHistory;
  camera: Pick<PassthroughCamera, 'frame' | 'model'>;
  surfaces: SurfaceRaycaster;
  workspace: () => Workspace;
  /** The lesson's plan as it is now. */
  procedure: () => Procedure | null;
  /** A tracker on this local port instead of the one the page's origin proxies (adb reverse it). */
  trackerPort: number | null;
  /** The streamed frames' width (frame-stream.ts, frameSize). */
  frameWidth: number | null;
  /** Hide an object's light while it is in hand. */
  hideHeld: boolean;
  /** IWER: its depth maps encode window depth without a far plane. */
  emulated: boolean;
  /** ?debug=1: every followed object's box, its tag saying the tracker's state, source and score. */
  debug?: boolean;
  /** The WebSocket (tests stand in for it). */
  socket?: (url: string) => TrackerSocket;
}

export class LiveTracker {
  readonly presenter: LiveHighlightsPresenter;
  /** The bounding boxes next to the glow, sharing its depth occlusion. */
  readonly boxPresenter: LiveBoxesPresenter;
  /** The real hands in the depth buffer, so a light behind a hand stays behind it. */
  readonly occluders = new HandOccluders();
  private readonly tracking: LiveTracking;
  private readonly objects: LiveObjects;
  private readonly client: TrackerClient;
  private readonly stream: FrameStream;
  private readonly detach: () => void;
  private readonly pending: TrackerDetections[] = [];
  private readonly sizes = new Map<number, { width: number; height: number }>();
  private session: XRSession | null = null;
  private probe: XrDepthProbe | null = null;
  private sensing: DepthSampler | null = null;
  private depth: DepthSource | null = null;
  /** The set (as JSON) last sent on this connection, and the one last followed. */
  private sent: string | null = null;
  private followed: string | null = null;
  /** The ids of the set last sent on this connection: the only ones an anchor may name. */
  private sentIds = new Set<string>();
  private highlights: LiveHighlight[] = [];
  private boxes: LiveBox[] = [];
  private masks: Placement[] = [];
  private readonly onVisibility = () => this.updateStreaming();

  /** Every followed object's current silhouette, including objects not lit by this step. */
  get panelMasks(): readonly Placement[] {
    return this.masks;
  }

  constructor(private readonly deps: LiveTrackerDeps) {
    const { bus, clock, registry, camera, workspace } = deps;
    this.tracking = new LiveTracking({ bus, registry, procedure: deps.procedure });
    this.detach = this.tracking.attach();
    // The registry owns the lesson's 3D estimates: only the 2D observations are recorded here.
    const recorder = new ObjectTrackRecorder({ bus, clock, workspace, states: 'none' });
    this.objects = new LiveObjects({
      registry,
      poses: deps.poses,
      camera: () => camera.model(),
      depth: () => this.depth,
      surfaces: deps.surfaces,
      workspace,
      now: () => clock.now(),
      record: (sample) => recorder.record(sample),
      failed: (err) => log.warn(`placement failed: ${String(err)}`),
    });
    this.client = new TrackerClient({
      url: deps.trackerPort ? `ws://localhost:${deps.trackerPort}/track` : trackerUrl(location),
      ...(deps.socket ? { socket: deps.socket } : {}),
      detections: (message) => {
        this.stream.received(message.seq);
        this.pending.push(message);
        if (this.pending.length > MAX_PENDING) this.pending.shift();
      },
      connection: (open) => {
        if (open) return;
        // A new connection starts in target mode, without the set: it is sent again.
        this.sent = null;
        this.sentIds.clear();
        this.pending.length = 0;
        this.objects.reset();
        this.masks = [];
      },
    });
    this.stream = new FrameStream({
      now: () => clock.now(),
      options: frameSize(deps.frameWidth === null ? null : String(deps.frameWidth)),
      ready: () => this.client.connected,
      grab: () => {
        const image = camera.frame();
        return image ? { ...image, t: captureTime(image.t, clock.now()) } : null;
      },
      send: (frame) => {
        const { jpeg, ...header } = frame;
        if (!this.client.sendFrame(header, jpeg.bytes)) return false;
        this.sizes.set(frame.seq, { width: frame.width, height: frame.height });
        for (const seq of this.sizes.keys()) {
          if (this.sizes.size <= SIZES_KEPT) break;
          this.sizes.delete(seq);
        }
        return true;
      },
      failed: (err) => log.warn(`frame encoding failed: ${String(err)}`),
    });
    this.presenter = new LiveHighlightsPresenter(() => this.highlights, {
      windowFar: deps.emulated ? 'infinite' : 'reported',
      hideHeld: deps.hideHeld,
    });
    this.boxPresenter = new LiveBoxesPresenter(() => this.boxes, {
      occlusion: this.presenter.occlusion,
    });
  }

  /** Before the session: connect, true once the tracker answers (then depth is worth asking for). */
  async connect(): Promise<boolean> {
    this.client.open();
    const connected = await this.client.waitConnected(CONNECT_WAIT_MS);
    if (!connected) log.info('no tracker on /track yet; objects are looked for as before');
    return connected;
  }

  /** The session started: depth along camera rays, and streaming while it is shown. */
  start(runtime: XrRuntime, renderer: WebGLRenderer): void {
    const { session, space } = runtime;
    this.session = session;
    this.probe = createDepthProbe(session, space);
    this.sensing = createDepthSampler(session, {
      space,
      gl: renderer.getContext() as WebGL2RenderingContext,
      // Not session.depthUsage: it throws on a session without depth sensing.
      binding: depthUsageOf(session) === 'gpu-optimized' ? renderer.xr.getBinding() : null,
      windowFar: this.deps.emulated ? 'infinite' : 'reported',
    });
    this.depth = preferDepthSensing(this.sensing, this.probe);
    log.info(
      this.sensing
        ? `depth sensing: ${session.depthUsage}, ${session.depthDataFormat}`
        : 'no depth sensing: hit-test and planes',
    );
    session.addEventListener('visibilitychange', this.onVisibility);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** The tracker is connected and follows the lesson's objects: Spotlight stops looking again. */
  get live(): boolean {
    return this.client.connected;
  }

  /** Whether an object's live light is on (prepare() decided, this frame). */
  lit(id: string): boolean {
    return this.highlights.some((h) => h.id === id);
  }

  /**
   * The action focus's FocusAnchors: Robotics-ER's box for a followed object goes to the tracker,
   * which places the object from it and trusts it over jev for a while. Dropped without a tracker,
   * before the set was sent on this connection (objects mode), and for an object not in it.
   */
  anchor({ id, box, t, query }: FocusAnchor): void {
    if (!this.sentIds.has(id)) return;
    this.client.send({ type: 'anchor', id, t, box, source: 'er', ...(query ? { query } : {}) });
  }

  /** Perceive stage: what to follow, depth reads, and the tracker's answers since the last frame. */
  perceive(frame: XRFrame, t: number): void {
    this.tracking.update(t);
    this.follow();
    this.probe?.update(frame);
    this.sensing?.update(frame);
    for (const message of this.pending.splice(0)) {
      this.objects.handle({
        seq: message.seq,
        t: message.t,
        model: message.model ?? this.client.model,
        size: this.sizes.get(message.seq) ?? null,
        detections: message.detections,
      });
    }
    this.updateStreaming();
    this.stream.tick();
  }

  /**
   * Before the presenters: the hands' occluders, and what each live light and box shows now. Only
   * the step's show items and the coach's highlights are lit, each with its box; the lesson's
   * other objects are followed for the recording alone (with ?debug=1 their boxes are drawn too,
   * fainter).
   */
  prepare(frame: XRFrame, space: XRReferenceSpace): void {
    const { registry, clock } = this.deps;
    this.occluders.update(frame, space);
    const views = this.objects.views(clock.now());
    this.masks = views.flatMap((view) => {
      const spec = registry.spec(view.id);
      return spec && !spec.hidden ? [view.placement] : [];
    });
    this.highlights = [];
    this.boxes = [];
    for (const view of views) {
      const object = this.tracking.get(view.id);
      const spec = registry.spec(view.id);
      if (!object || !spec) continue;
      const lit = isShown(object);
      const held = !!registry.get(view.id)?.heldBy;
      const box = this.boxFor(view, object, spec.label, lit, held && this.deps.hideHeld);
      if (box) this.boxes.push(box);
      if (!lit) continue;
      this.highlights.push({
        ...view,
        label: spec.label,
        rank: object.rank,
        style: object.style,
        accent: object.accent,
        mode: glowModeFor(spec),
        held,
        tagged: box !== null,
      });
    }
  }

  stop(): void {
    this.detach();
    this.session?.removeEventListener('visibilitychange', this.onVisibility);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.session = null;
    this.stream.stop();
    this.client.close();
    this.pending.length = 0;
    this.objects.clear();
    this.probe?.close();
    this.sensing?.close();
    this.probe = null;
    this.sensing = null;
    this.depth = null;
    this.occluders.hide();
    this.highlights = [];
    this.boxes = [];
    this.masks = [];
  }

  /** A followed object's box, or null when it has none or is not to be boxed now. */
  private boxFor(
    view: LiveView,
    object: LiveObject,
    label: string,
    lit: boolean,
    hidden: boolean,
  ): LiveBox | null {
    const box = view.placement.box;
    const debug = this.deps.debug ?? false;
    if (!box || hidden || (!lit && !debug)) return null;
    return {
      key: view.id,
      center: view.placement.center,
      corners: box.corners,
      shapeVersion: view.shapeVersion,
      label,
      detail: debug ? trackerSays(view) : null,
      accent: lit ? object.accent : { color: object.accent.color, opacity: UNLIT_BOX_OPACITY },
      dashed: false,
    };
  }

  /** Tell the tracker what to follow whenever that changes, and again on a new connection. */
  private follow(): void {
    const objects: TrackedQuery[] = this.tracking.objects.map(({ id, phrase, query }) => ({
      id,
      phrase,
      query,
    }));
    const key = JSON.stringify(objects);
    if (key !== this.followed) {
      this.objects.follow(objects.map((o) => o.id));
      this.followed = key;
    }
    if (key !== this.sent && this.client.send({ type: 'objects', objects })) {
      this.sent = key;
      this.sentIds = new Set(objects.map((o) => o.id));
    }
  }

  /** Stream only while the session is shown (not covered by the system menu) and something is followed. */
  private updateStreaming(): void {
    const state = this.session?.visibilityState;
    const shown =
      this.session !== null &&
      state !== 'hidden' &&
      state !== 'visible-blurred' &&
      document.visibilityState === 'visible' &&
      this.tracking.objects.length > 0;
    if (shown && !this.stream.streaming) this.stream.start();
    else if (!shown && this.stream.streaming) this.stream.stop();
  }
}

/** A debug tag's second line: what the tracker last said of the object. */
function trackerSays({ state, source, score }: LiveView): string {
  return [state ?? '–', source ?? '–', score === null ? '–' : score.toFixed(2)].join(' · ');
}
