import type { Procedure } from '@clio/protocol';
import { type FrameImage, FrameStream, frameSize } from '../adapters/camera/frame-stream';
import {
  type TrackedQuery,
  TrackerClient,
  type TrackerDetection,
  type TrackerDetections,
  type TrackerSocket,
} from '../adapters/net/tracker-client';
import type { Clock } from '../core/clock';
import { createLogger } from '../core/log';
import type { AppBus, HighlightStyle } from '../domain/events';
import type { Accent } from '../domain/overlay/accents';
import { isShown, LiveTracking } from '../domain/session/live-tracking';
import type { ObjectRegistry } from '../domain/world/object-registry';
import { anchorPoint, DESK_WORKSPACE, standInPosition } from './stand-in';

// The lesson's live tracking on the desk: the headset's app/live-tracker.ts without the room. The
// same LiveTracking (domain/session) says what the tracker follows and which objects are lit, the
// same TrackerClient speaks /track in objects mode (tracker/TRACK.md), and the same FrameStream
// sends the webcam's frames as fast as the tracker answers them. What comes back is kept per object
// for the picture (the outline, box and tag drawn over the video) and told to the registry at its
// stand-in position (stand-in.ts) about five times a second, so the lesson knows what is found; a
// loss is a registry.lose(), as on the headset. Frames go out only while the page is shown and
// something is followed. Nothing here reaches the coach, and nothing is recorded.

const log = createLogger('desk-tracker');
/** The registry hears about each object at most this often (ms), like LiveObjects. */
const OBSERVE_EVERY_MS = 200;

/** One followed object's newest answer, with who last placed it. */
export interface DeskDetection extends TrackerDetection {
  /** "jev", "er", or null before either placed it (or from a tracker that doesn't say). */
  source: string | null;
}

/** What the desk draws for one followed object. */
export interface DeskObject {
  id: string;
  label: string;
  phrase: string;
  query: string;
  /** The step shows it or a highlight is on it (the headset's isShown). */
  lit: boolean;
  /** Its place in the focused step's show list; null when the step doesn't show it. */
  rank: number | null;
  style: HighlightStyle | null;
  accent: Accent;
  /** The newest frame's answer for it; null before the tracker answered about it. */
  detection: DeskDetection | null;
}

export interface DeskTrackerStats {
  connected: boolean;
  /** The tracker's model, once connected. */
  model: string | null;
  streaming: boolean;
  /** Answers per second. */
  fps: number;
  /** Median time from sending a frame to its answer (ms). */
  sendToAnswerMs: number | null;
  /** Median time to grab and encode a frame (ms). */
  encodeMs: number | null;
  /** The tracker's own time on the newest frame (ms). */
  trackMs: number | null;
  /** The streamed frames' size. */
  frame: { width: number; height: number } | null;
  followed: number;
  lit: number;
  /** Followed objects found on the newest frame. */
  found: number;
  /** Who placed the objects found on the newest frame. */
  sources: { jev: number; er: number; none: number };
}

export interface DeskTrackerDeps {
  bus: AppBus;
  clock: Clock;
  registry: ObjectRegistry;
  /** The lesson's plan as it is now. */
  procedure: () => Procedure | null;
  camera: { frame(): FrameImage | null };
  /** The tracker's /track WebSocket URL. */
  url: string;
  /** Streamed frame width (frame-stream.ts frameSize). */
  frameWidth: number;
  /** Whether the page is shown; frames stop while it is hidden. */
  visible?: () => boolean;
  /** The WebSocket (tests stand in for it). */
  socket?: (url: string) => TrackerSocket;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** The workspace the stand-in positions lie on (m). */
  size?: readonly [number, number];
}

/** Who placed a detection: the tracker's `source` field (TRACK.md), once its client keeps it. */
export function sourceOf(detection: object): string | null {
  const source = (detection as { source?: unknown }).source;
  return typeof source === 'string' ? source : null;
}

export class DeskTracker {
  readonly tracking: LiveTracking;
  private readonly client: TrackerClient;
  private readonly stream: FrameStream;
  private readonly detach: () => void;
  private readonly latest = new Map<string, DeskDetection>();
  private readonly observedT = new Map<string, number>();
  private readonly sizes = new Map<number, { width: number; height: number }>();
  private last: { size: { width: number; height: number } | null; trackMs: number | null } | null =
    null;
  /** The set (as JSON) last sent on this connection. */
  private sent: string | null = null;
  private opened = false;

  constructor(private readonly deps: DeskTrackerDeps) {
    const { bus, clock, registry } = deps;
    this.tracking = new LiveTracking({ bus, registry, procedure: deps.procedure });
    this.detach = this.tracking.attach();
    this.client = new TrackerClient({
      url: deps.url,
      ...(deps.socket ? { socket: deps.socket } : {}),
      ...(deps.setTimeout ? { setTimeout: deps.setTimeout } : {}),
      ...(deps.clearTimeout ? { clearTimeout: deps.clearTimeout } : {}),
      detections: (message) => {
        this.stream.received(message.seq);
        this.handle(message);
      },
      connection: (open) => {
        // A new connection starts in target mode, without the set: it is sent again.
        this.sent = null;
        if (!open) this.forget();
      },
    });
    this.stream = new FrameStream({
      now: () => clock.now(),
      options: frameSize(String(deps.frameWidth)),
      ready: () => this.client.connected,
      grab: () => deps.camera.frame(),
      send: (frame) => {
        const { jpeg, ...header } = frame;
        if (!this.client.sendFrame(header, jpeg.bytes)) return false;
        this.sizes.set(frame.seq, { width: frame.width, height: frame.height });
        for (const seq of this.sizes.keys()) {
          if (this.sizes.size <= 32) break;
          this.sizes.delete(seq);
        }
        return true;
      },
      failed: (err) => log.warn(`frame encoding failed: ${String(err)}`),
      ...(deps.setTimeout ? { setTimeout: deps.setTimeout } : {}),
      ...(deps.clearTimeout ? { clearTimeout: deps.clearTimeout } : {}),
    });
  }

  /** Connect to the tracker, and keep reconnecting until close(). */
  open(): void {
    this.opened = true;
    this.client.open();
  }

  /** Stop streaming and drop the connection (the lesson's objects are still known). */
  close(): void {
    this.opened = false;
    this.stream.stop();
    this.client.close();
    this.forget();
  }

  /** For good: also stop listening to the lesson. */
  dispose(): void {
    this.close();
    this.detach();
  }

  /** The tracker is connected and follows the lesson's objects: the lesson stops looking again. */
  get live(): boolean {
    return this.client.connected;
  }

  /** Per tick: what to follow, highlights that ran out, and the next frame when it is due. */
  perceive(t: number): void {
    this.tracking.update(t);
    this.follow();
    const shown = this.opened && (this.deps.visible?.() ?? true);
    const wanted = shown && this.client.connected && this.tracking.objects.length > 0;
    if (wanted && !this.stream.streaming) this.stream.start();
    else if (!wanted && this.stream.streaming) this.stream.stop();
    this.stream.tick();
  }

  /** Every followed object, lit ones first as LiveTracking orders them, with its newest answer. */
  objects(): DeskObject[] {
    return this.tracking.objects.map((o) => ({
      id: o.id,
      label: this.deps.registry.spec(o.id)?.label ?? o.id,
      phrase: o.phrase,
      query: o.query,
      lit: isShown(o),
      rank: o.rank,
      style: o.style,
      accent: o.accent,
      detection: this.latest.get(o.id) ?? null,
    }));
  }

  stats(): DeskTrackerStats {
    const objects = this.objects();
    const sources = { jev: 0, er: 0, none: 0 };
    let found = 0;
    for (const o of objects) {
      if (!o.detection?.found) continue;
      found++;
      const source = o.detection.source;
      if (source === 'jev') sources.jev++;
      else if (source === 'er') sources.er++;
      else sources.none++;
    }
    const stream = this.stream.stats;
    return {
      connected: this.client.connected,
      model: this.client.model,
      streaming: this.stream.streaming,
      fps: stream.fps,
      sendToAnswerMs: stream.sendToAnswerMs,
      encodeMs: stream.encodeMs,
      trackMs: this.last?.trackMs ?? null,
      frame: this.last?.size ?? null,
      followed: objects.length,
      lit: objects.filter((o) => o.lit).length,
      found,
      sources,
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
    if (key !== this.sent && this.client.send({ type: 'objects', objects })) this.sent = key;
  }

  private handle(message: TrackerDetections): void {
    const { registry, size } = this.deps;
    this.latest.clear();
    this.last = { size: this.sizes.get(message.seq) ?? null, trackMs: message.ms?.total ?? null };
    for (const d of message.detections) {
      if (!this.tracking.get(d.id)) continue;
      this.latest.set(d.id, { ...d, source: sourceOf(d) });
      if (d.found) {
        const point = anchorPoint(d);
        const last = this.observedT.get(d.id) ?? Number.NEGATIVE_INFINITY;
        if (!point || message.t - last < OBSERVE_EVERY_MS) continue;
        const told = registry.observe(d.id, {
          position: standInPosition(point, size ?? DESK_WORKSPACE),
          confidence: d.score ?? 0.5,
          source: 'detector',
          t: message.t,
          measured: false,
        });
        if (told) this.observedT.set(d.id, message.t);
      } else if (d.state === 'lost') {
        registry.lose(d.id, message.t);
      }
    }
  }

  /** What the tracker last said no longer holds (dropped, closed). */
  private forget(): void {
    this.latest.clear();
    this.observedT.clear();
    this.last = null;
  }
}
