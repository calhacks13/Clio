import type {
  NormalizedBox,
  NormalizedPoint,
  NormalizedPolygon,
  ObservationStatus,
} from '@clio/protocol';
import { composePose, type Pose, type Vec3 } from '../../core/math';
import type { CameraModel } from './camera-model';
import { DepthMemory } from './depth-memory';
import type { DepthSource } from './depth-source';
import type { SurfaceRaycaster } from './grounding';
import {
  DEFAULT_MOTION_OPTIONS,
  type MotionSmoothingOptions,
  OutlineMotion,
} from './motion-smoothing';
import type { ObjectRegistry } from './object-registry';
import {
  type DepthKind,
  maskRays,
  measureDepth,
  type ObjectDepth,
  type ObjectMask,
  type Placement,
  placeOutline,
  surfaceOrTable,
} from './placement';
import type { PoseHistory } from './pose-history';
import { TRACK_STATE_STATUS, type TrackedObjectSample } from './tracked-object';
import type { Workspace } from './workspace';

// The objects the tracker follows live, placed in the room frame by frame, as the primary-object
// page places its one target (placement.ts, depth-memory.ts, motion-smoothing.ts), once per object.
// Each detection is placed with the head pose of its frame: at once at the object's last measured
// distance when it has one, while that distance is measured again in the background (depth
// sensing first, then hit-test, along the mask's camera rays; else where it meets a surface), and
// then steadied and drawn where the object is now.
//
// What it says goes three ways, labelled for what it is:
//   drawing    every placed outline, for the live glow (views()).
//   registry   about five times a second per object, never while it is held (the hand owns it
//              then), as a `detector` observation, the camera's untrusted source. It is `measured`
//              only when the tracker saw the object on that frame (not coasting) and its distance
//              was measured on that frame along a ray that hit it (contact or point). A distance
//              reused from an earlier frame or guessed from a surface is not. A guessed fixed
//              distance gives no 3D at all, and a loss is a registry.lose().
//   recording  one TrackedObjectSample per detection (role tracker), for the episode's
//              observations, with the same labels; a loss is recorded once, not every frame.

/** One object in one tracked frame, as the tracker reports it (tracker/TRACK.md, objects mode). */
export interface LiveDetection {
  id: string;
  found: boolean;
  /** tracking, coasting, lost or unknown; null from a tracker that omits it. */
  state: string | null;
  box: NormalizedBox | null;
  outline: NormalizedPolygon | null;
  point: NormalizedPoint | null;
  contact: NormalizedPoint | null;
  score: number | null;
  /** ByteTrack's id for the track. */
  track: number | null;
}

/** One tracked frame. */
export interface LiveFrame {
  seq: number;
  /** When the frame was captured (performance.now ms). */
  t: number;
  /** The tracker's model, e.g. "yoloe-26l-seg". */
  model: string | null;
  /** The frame's size as it was sent; null when not known. */
  size: { width: number; height: number } | null;
  detections: readonly LiveDetection[];
}

/** What to draw for one followed object now. */
export interface LiveView {
  id: string;
  /** World space, where the object is now (its frame's latency predicted away). */
  placement: Placement;
  /** Bumped whenever the shape changes; between them only the center moves. */
  shapeVersion: number;
  /** Lost a moment ago: the last outline is held before it fades. */
  holding: boolean;
}

export interface LiveObjectsOptions {
  /** The registry hears about each object at most this often (ms). */
  observeEveryMs?: number;
  motion?: MotionSmoothingOptions;
}

export interface LiveObjectsDeps {
  registry: ObjectRegistry;
  /** Head poses, so a frame is placed from where the head was when it was captured. */
  poses: PoseHistory;
  /** The camera's model (stored calibration applied); null without one. */
  camera: () => CameraModel | null;
  /** Depth along world-space rays (depth sensing, then hit-test); null: surfaces only. */
  depth: () => DepthSource | null;
  surfaces: SurfaceRaycaster | null;
  workspace: () => Workspace;
  /** performance.now ms, the clock of the frames' capture times. */
  now: () => number;
  /** Each detection, for the episode's observations. */
  record?: (sample: TrackedObjectSample) => void;
  /** A placement failed (it is skipped). */
  failed?: (err: unknown) => void;
  options?: LiveObjectsOptions;
}

export const OBSERVE_EVERY_MS = 200;
/** Distances measured on the object itself, through the ray that saw it. */
const MEASURED_DEPTHS: ReadonlySet<DepthKind> = new Set(['contact', 'point']);

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A detection's state as an observation status (TRACK_STATE_STATUS), never measured if not found. */
export function liveStatus(det: Pick<LiveDetection, 'found' | 'state'>): ObservationStatus {
  const status = TRACK_STATE_STATUS[det.state ?? ''];
  const seen = status === 'measured' || status === 'predicted';
  if (det.found) return seen && status ? status : 'measured';
  return status && !seen ? status : 'lost';
}

/**
 * One measurement at a time, the newest waiting next (like primary/latest-only.ts): each one gets
 * its rays answered before the next asks. A job replaced before it ran is told so.
 */
class OneAtATime {
  private running = false;
  private waiting: { run: () => Promise<void>; dropped?: () => void } | null = null;

  constructor(private readonly failed?: (err: unknown) => void) {}

  run(run: () => Promise<void>, dropped?: () => void): void {
    const job = dropped ? { run, dropped } : { run };
    if (this.running) {
      this.waiting?.dropped?.();
      this.waiting = job;
      return;
    }
    this.running = true;
    void this.drain(job);
  }

  clear(): void {
    this.waiting?.dropped?.();
    this.waiting = null;
  }

  private async drain(first: { run: () => Promise<void> }): Promise<void> {
    let job: { run: () => Promise<void> } | null = first;
    while (job) {
      try {
        await job.run();
      } catch (err) {
        // Reported; the next one still runs.
        this.failed?.(err);
      }
      job = this.waiting;
      this.waiting = null;
    }
    this.running = false;
  }
}

interface Followed {
  id: string;
  depths: DepthMemory;
  motion: OutlineMotion;
  measuring: OneAtATime;
  /** Bumped by every detection; a measurement finished after a newer one was drawn isn't drawn. */
  seq: number;
  shownSeq: number;
  found: boolean;
  /** The status of the last detection recorded, so a loss is recorded once. */
  recorded: ObservationStatus | null;
  /** The frame time of the registry's last observation, and whether it was measured. */
  observedT: number;
  observedMeasured: boolean;
  /** No longer followed: a measurement still running is neither drawn nor told to the registry. */
  retired: boolean;
}

interface Detected {
  f: Followed;
  det: LiveDetection;
  frame: LiveFrame;
  status: ObservationStatus;
  mask: ObjectMask;
  model: CameraModel;
  head: Pose;
}

export class LiveObjects {
  private readonly followed = new Map<string, Followed>();
  private shown = new Map<string, LiveView>();

  constructor(private readonly deps: LiveObjectsDeps) {}

  /** The objects being followed now: new ones start fresh, the others are dropped. */
  follow(ids: readonly string[]): void {
    const wanted = new Set(ids);
    for (const [id, f] of this.followed) {
      if (wanted.has(id)) continue;
      f.retired = true;
      f.measuring.clear();
      this.followed.delete(id);
    }
    for (const id of ids) if (!this.followed.has(id)) this.followed.set(id, this.create(id));
  }

  /** One tracked frame, from the perceive stage (depth reads are answered on later XR frames). */
  handle(frame: LiveFrame): void {
    for (const det of frame.detections) {
      const f = this.followed.get(det.id);
      if (!f) continue;
      if (det.found) this.found(f, det, frame);
      else this.notFound(f, det, frame);
    }
  }

  /** The tracker went away: every followed object is lost until it answers again. */
  reset(): void {
    const t = this.deps.now();
    for (const f of this.followed.values()) {
      f.measuring.clear();
      f.shownSeq = ++f.seq;
      f.depths.forget();
      f.recorded = null;
      if (!f.found) continue;
      f.found = false;
      f.motion.lose(t);
      this.deps.registry.lose(f.id, t);
    }
  }

  /** Forget everything (the session ended). */
  clear(): void {
    for (const f of this.followed.values()) {
      f.retired = true;
      f.measuring.clear();
    }
    this.followed.clear();
    this.shown.clear();
  }

  /** What to draw now, once per frame; lit() answers from it. */
  views(now: number): LiveView[] {
    const shown = new Map<string, LiveView>();
    for (const f of this.followed.values()) {
      const frame = f.motion.at(now);
      if (!frame) continue;
      const { placement, shapeVersion, holding } = frame;
      shown.set(f.id, { id: f.id, placement, shapeVersion, holding });
    }
    this.shown = shown;
    return [...shown.values()];
  }

  /** Whether `id`'s live outline was drawn on the last views(). */
  lit(id: string): boolean {
    return this.shown.has(id);
  }

  private create(id: string): Followed {
    return {
      id,
      depths: new DepthMemory(),
      motion: new OutlineMotion(this.deps.options?.motion ?? DEFAULT_MOTION_OPTIONS),
      measuring: new OneAtATime(this.deps.failed),
      seq: 0,
      shownSeq: 0,
      found: false,
      recorded: null,
      observedT: Number.NEGATIVE_INFINITY,
      observedMeasured: false,
      retired: false,
    };
  }

  private found(f: Followed, det: LiveDetection, frame: LiveFrame): void {
    const status = liveStatus(det);
    f.found = true;
    f.recorded = status;
    const mask: ObjectMask = {
      point: det.point,
      box: det.box,
      outline: det.outline,
      contact: det.contact,
    };
    const model = this.deps.camera();
    const head = this.deps.poses.at(frame.t);
    const rays = model && head && maskRays(mask, model, head);
    if (!model || !head || !rays) {
      this.record(f, det, frame, status, null, false);
      return;
    }
    const d: Detected = { f, det, frame, status, mask, model, head };
    const seq = ++f.seq;
    const now = this.deps.now();
    const reused = f.depths.reuse(f.id, mask, rays.point, now);
    if (reused) {
      // Drawn on this frame at the last measured distance: placed, but not measured.
      f.shownSeq = seq;
      this.place(d, reused, false);
      this.record(f, det, frame, status, reused.kind === 'fixed' ? null : reused.center, false);
      if (!f.depths.shouldMeasure(f.id, mask, now)) return;
      const epoch = f.depths.epoch;
      f.measuring.run(async () => {
        const depth = await this.measure(d);
        if (!depth) return;
        f.depths.remember(f.id, mask, rays.point, depth, this.deps.now(), epoch);
        if (seq === f.shownSeq) this.place(d, depth, this.measured(d, depth));
      });
      return;
    }
    f.depths.shouldMeasure(f.id, mask, now);
    const epoch = f.depths.epoch;
    f.measuring.run(
      async () => {
        const depth = await this.measure(d);
        if (depth) f.depths.remember(f.id, mask, rays.point, depth, this.deps.now(), epoch);
        const measured = depth !== null && this.measured(d, depth);
        if (depth && seq > f.shownSeq) {
          f.shownSeq = seq;
          this.place(d, depth, measured);
        }
        const position = depth && depth.kind !== 'fixed' ? depth.center : null;
        this.record(f, det, frame, status, position, measured);
      },
      () => this.record(f, det, frame, status, null, false),
    );
  }

  private notFound(f: Followed, det: LiveDetection, frame: LiveFrame): void {
    const status = liveStatus(det);
    // A measurement still running for an earlier frame is not drawn over the loss.
    f.shownSeq = ++f.seq;
    f.measuring.clear();
    if (f.found) {
      f.found = false;
      f.motion.lose(this.deps.now());
      f.depths.forget();
      this.deps.registry.lose(f.id, frame.t);
    }
    if (status === f.recorded) return;
    f.recorded = status;
    this.record(f, det, frame, status, null, false);
  }

  /** Measured on this frame: seen (not coasting), and its distance hit the object itself. */
  private measured(d: Detected, depth: ObjectDepth): boolean {
    return d.status === 'measured' && MEASURED_DEPTHS.has(depth.kind);
  }

  private async measure({ mask, model, head }: Detected): Promise<ObjectDepth | null> {
    try {
      const surface = surfaceOrTable(this.deps.surfaces, head);
      return await measureDepth(mask, model, head, this.deps.depth(), surface);
    } catch (err) {
      this.deps.failed?.(err);
      return null;
    }
  }

  /** Draw the detection at `depth`, and tell the registry when it is due. */
  private place(d: Detected, depth: ObjectDepth, measured: boolean): void {
    const { f, det, frame, mask, model, head } = d;
    if (f.retired) return;
    const placement = placeOutline(mask, head, model, depth);
    if (!placement) return;
    const eye = composePose(head, model.headFromCamera).p;
    f.motion.add({ key: f.id, placement, t: frame.t, eye });
    this.observe(f, det, frame.t, depth, measured);
  }

  private observe(
    f: Followed,
    det: LiveDetection,
    t: number,
    depth: ObjectDepth,
    measured: boolean,
  ): void {
    // A guessed distance is no position; a confidence is reported or the position isn't told.
    if (depth.kind === 'fixed' || det.score === null || t < f.observedT) return;
    const every = this.deps.options?.observeEveryMs ?? OBSERVE_EVERY_MS;
    if (t - f.observedT < every && !(measured && !f.observedMeasured)) return;
    const { registry } = this.deps;
    if (registry.get(f.id)?.heldBy) return;
    registry.observe(f.id, {
      position: this.deps.workspace().toWorkspacePoint(depth.center),
      confidence: clamp01(det.score),
      source: 'detector',
      t,
      measured,
    });
    f.observedT = t;
    f.observedMeasured = measured;
  }

  private record(
    f: Followed,
    det: LiveDetection,
    frame: LiveFrame,
    status: ObservationStatus,
    position: Vec3 | null,
    measured: boolean,
  ): void {
    const { record } = this.deps;
    if (!record) return;
    const seen = det.found || status === 'lost';
    record({
      objectId: f.id,
      observedT: frame.t,
      status,
      role: 'tracker',
      source: frame.model ?? 'tracker',
      score: det.found ? det.score : null,
      trackId: det.track === null ? null : String(det.track),
      image: seen
        ? {
            box: det.box,
            outline: det.outline,
            point: det.point,
            contact: det.contact,
            frame: frame.size && { seq: frame.seq, ...frame.size },
          }
        : null,
      position,
      ...(position ? { positionMeasured: measured } : {}),
      orientation: null,
    });
  }
}
