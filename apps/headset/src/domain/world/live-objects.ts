import type {
  NormalizedBox,
  NormalizedPoint,
  NormalizedPolygon,
  ObservationStatus,
} from '@clio/protocol';
import { composePose, distance, type Pose, type Vec3 } from '../../core/math';
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
  surfaceRays,
} from './placement';
import type { PoseHistory } from './pose-history';
import { TRACK_STATE_STATUS, type TrackedObjectSample } from './tracked-object';
import type { Workspace } from './workspace';

// The objects the tracker follows live, placed in the room frame by frame, as the primary-object
// page places its one target (placement.ts, depth-memory.ts, motion-smoothing.ts), once per object.
// Each detection is placed with the head pose of its frame: at once at the object's last measured
// distance when it has one, while that distance is measured again in the background (depth
// sensing first, then hit-test, along the mask's camera rays; else where it meets a surface), and
// then steadied and drawn where the object is now. A distance measured on the object itself is
// followed, a few times a second, by depth samples through a grid of points inside the outline:
// the object's surface, for a shape fused after the episode. Those never hold up drawing.
//
// What it says goes three ways, labelled for what it is:
//   drawing    every placed outline, for the live glow (views()).
//   registry   about five times a second per object, never while it is held (the hand owns it
//              then), as a `detector` observation, the camera's untrusted source. It is `measured`
//              only when the tracker saw the object on that frame (not coasting) and its distance
//              was measured on that frame along a ray that hit it (contact or point). A distance
//              reused from an earlier frame or guessed from a surface is not. A guessed fixed
//              distance gives no 3D at all, and a loss is a registry.lose(). A distance measured
//              after a newer detection was drawn is told all the same (just not drawn), unless the
//              object was lost since.
//   recording  one TrackedObjectSample per detection (role tracker), for the episode's
//              observations, with the same labels; a loss is recorded once, not every frame. One
//              recorded only once its distance is measured says when it arrived; a detection
//              measured again in the background is recorded then too, so its surface samples ride
//              along (one dropped before it was measured is recorded where it was drawn).

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
/** An object's surface is sampled at most this often (ms between the frames sampled). */
export const SURFACE_EVERY_MS = 500;
/** A surface hit farther than this (m) from the measured center is the background behind. */
export const SURFACE_REACH_M = 0.3;
/** Rays through the outline per sampled frame. */
export const SURFACE_MAX_POINTS = 24;
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
  /**
   * Bumped by every detection; a measurement finished after a newer one was drawn isn't drawn, but
   * the registry still hears of it (it keeps only what is newer than it knows).
   */
  seq: number;
  shownSeq: number;
  /** The last loss: a measurement for a detection before it is neither drawn nor told. */
  lostSeq: number;
  found: boolean;
  /** The status of the last detection recorded, so a loss is recorded once. */
  recorded: ObservationStatus | null;
  /** The frame time of the registry's last observation, and whether it was measured. */
  observedT: number;
  observedMeasured: boolean;
  /** The frame time of the last surface sampling. */
  surfaceT: number;
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
      f.shownSeq = f.lostSeq = ++f.seq;
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
      lostSeq: 0,
      found: false,
      recorded: null,
      observedT: Number.NEGATIVE_INFINITY,
      observedMeasured: false,
      surfaceT: Number.NEGATIVE_INFINITY,
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
      const drawnAt = reused.kind === 'fixed' ? null : reused.center;
      if (!f.depths.shouldMeasure(f.id, mask, now)) {
        this.record(f, det, frame, status, drawnAt, false);
        return;
      }
      const epoch = f.depths.epoch;
      // Measured again in the background: redrawn unless a newer detection was drawn meanwhile,
      // told unless it was lost since, and recorded once measured (its surface sampled then) as
      // arriving now. Dropped, or measured no better than a guess, it is recorded where it was drawn.
      f.measuring.run(
        async () => {
          const depth = await this.measure(d);
          if (!depth) {
            this.record(f, det, frame, status, drawnAt, false, now);
            return;
          }
          f.depths.remember(f.id, mask, rays.point, depth, this.deps.now(), epoch);
          const measured = this.measured(d, depth);
          if (seq > f.lostSeq) this.place(d, depth, measured, seq === f.shownSeq);
          const surface = await this.sampleSurface(d, depth, seq);
          const position = depth.kind === 'fixed' ? drawnAt : depth.center;
          this.record(f, det, frame, status, position, measured, now, surface);
        },
        () => this.record(f, det, frame, status, drawnAt, false, now),
      );
      return;
    }
    f.depths.shouldMeasure(f.id, mask, now);
    const epoch = f.depths.epoch;
    // Recorded once measured (or dropped) as arriving now, so a loss recorded meanwhile stays newer.
    f.measuring.run(
      async () => {
        const depth = await this.measure(d);
        if (depth) f.depths.remember(f.id, mask, rays.point, depth, this.deps.now(), epoch);
        const measured = depth !== null && this.measured(d, depth);
        if (depth && seq > f.lostSeq) {
          const draw = seq > f.shownSeq;
          if (draw) f.shownSeq = seq;
          this.place(d, depth, measured, draw);
        }
        const surface = depth && (await this.sampleSurface(d, depth, seq));
        const position = depth && depth.kind !== 'fixed' ? depth.center : null;
        this.record(f, det, frame, status, position, measured, now, surface);
      },
      () => this.record(f, det, frame, status, null, false, now),
    );
  }

  private notFound(f: Followed, det: LiveDetection, frame: LiveFrame): void {
    const status = liveStatus(det);
    // A measurement still running for an earlier frame is neither drawn over the loss nor told.
    f.shownSeq = f.lostSeq = ++f.seq;
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

  /**
   * The object's surface on a frame whose distance was measured on the object itself: where the
   * camera rays through a grid of points inside its outline meet the depth map, within
   * SURFACE_REACH_M of the measured center (farther is the background behind it). At most once
   * per SURFACE_EVERY_MS per object, never while the object is held (the hand owns it then), nor
   * for a frame lost or dropped since, nor without a depth source. Null when none were taken.
   */
  private async sampleSurface(
    d: Detected,
    depth: ObjectDepth,
    seq: number,
  ): Promise<Vec3[] | null> {
    const { f, frame, mask, model, head } = d;
    if (!this.measured(d, depth) || f.retired || seq <= f.lostSeq) return null;
    if (frame.t - f.surfaceT < SURFACE_EVERY_MS) return null;
    if (this.deps.registry.get(f.id)?.heldBy) return null;
    const probe = this.deps.depth();
    if (!probe) return null;
    const rays = surfaceRays(mask, model, head, SURFACE_MAX_POINTS);
    if (rays.length === 0) return null;
    f.surfaceT = frame.t;
    try {
      const hits = await probe.measure(rays);
      return hits.flatMap((hit) =>
        hit && distance(hit.point, depth.center) <= SURFACE_REACH_M ? [hit.point] : [],
      );
    } catch (err) {
      this.deps.failed?.(err);
      return null;
    }
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

  /** Draw the detection at `depth` (if `draw`), and tell the registry when it is due. */
  private place(d: Detected, depth: ObjectDepth, measured: boolean, draw = true): void {
    const { f, det, frame, mask, model, head } = d;
    if (f.retired) return;
    const placement = placeOutline(mask, head, model, depth);
    if (!placement) return;
    if (draw) {
      const eye = composePose(head, model.headFromCamera).p;
      f.motion.add({ key: f.id, placement, t: frame.t, eye });
    }
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
    const told = registry.observe(f.id, {
      position: this.deps.workspace().toWorkspacePoint(depth.center),
      confidence: clamp01(det.score),
      source: 'detector',
      t,
      measured,
    });
    // Not taken (older than what it knows, or than a loss): the next one is not held back for it.
    if (!told) return;
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
    arrivedT?: number,
    surface: Vec3[] | null = null,
  ): void {
    const { record } = this.deps;
    if (!record) return;
    const seen = det.found || status === 'lost';
    record({
      objectId: f.id,
      observedT: frame.t,
      ...(arrivedT === undefined ? {} : { arrivedT }),
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
      ...(surface ? { surface } : {}),
    });
  }
}
