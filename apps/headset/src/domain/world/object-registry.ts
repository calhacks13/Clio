import {
  type GripKind,
  type Handedness,
  LOCATION_FLAG,
  type ObjectSpec,
  type ObjectState,
  type PlacementMethod,
  type ReleaseReason,
} from '@clio/protocol';
import {
  composePose,
  distance,
  invertPose,
  type Pose,
  type Quat,
  type Vec3,
} from '../../core/math';
import type { AppBus } from '../events';

// Where every object of the current procedure is, in the workspace frame, and how sure we are.
// Estimates come from the layout, a pinch, the camera (detector or marker), or the hand holding the
// object: while an object is held it rides with the wrist, which is tracked at frame rate and is far
// more reliable than any camera estimate. Grasps and releases are announced on the bus, and every
// recorded state says how valid it is (location flags), who holds it and when it was measured.

export interface ObjectEstimate {
  id: string;
  spec: ObjectSpec;
  position: Vec3;
  orientation: Quat | null;
  confidence: number;
  source: PlacementMethod;
  /** When this estimate was last measured (performance.now ms); for a detection, its frame time. */
  t: number;
  heldBy: Handedness | null;
  /**
   * False when the position was not measured on its frame (a tracker coasting, a reused depth or a
   * surface guess, or where a hand let go): valid but never tracked. Absent means measured.
   */
  measured?: boolean;
  /**
   * When a live source lost the object (performance.now ms), until it is seen or held again. The
   * position stays where the object was last seen, for the lesson and for grasping, but it is
   * recorded with no valid flags.
   */
  lostAt?: number;
}

export interface Observation {
  position: Vec3;
  orientation?: Quat | null;
  confidence: number;
  source: PlacementMethod;
  t: number;
  /**
   * False when `position` was not measured on this frame (a tracker coasting, a reused depth or a
   * surface guess). Absent means measured, as every source before the live tracker was.
   */
  measured?: boolean;
}

interface Grip {
  hand: Handedness;
  grip: GripKind;
  /** Object pose in the wrist frame at the moment of grasping. */
  wristFromObject: Pose;
  /** False while the holding hand's wrist is untracked: the object stays where it was last seen. */
  wristTracked: boolean;
}

const MEASURED_SOURCES = new Set<PlacementMethod>(['detector', 'marker']);

/**
 * How valid an estimate is (`LOCATION_FLAG` bits). Camera estimates measured on their frame are
 * tracked; camera estimates that were not, layout, pinch and manual placements and held objects are
 * valid but carried over; a held object whose wrist is lost, and an object a live source lost, have
 * no valid pose at all. Orientation is measured only by markers.
 */
function locationFlags(est: ObjectEstimate, grip: Grip | undefined): number {
  if (grip ? !grip.wristTracked : est.lostAt !== undefined) return 0;
  const measured = !grip && MEASURED_SOURCES.has(est.source) && est.measured !== false;
  let flags = LOCATION_FLAG.positionValid | (measured ? LOCATION_FLAG.positionTracked : 0);
  if (est.orientation) {
    flags |= LOCATION_FLAG.orientationValid;
    if (measured && est.source === 'marker') flags |= LOCATION_FLAG.orientationTracked;
  }
  return flags;
}

export class ObjectRegistry {
  private readonly specs = new Map<string, ObjectSpec>();
  private readonly estimates = new Map<string, ObjectEstimate>();
  private readonly grips = new Map<string, Grip>();
  private readonly changed = new Set<string>();
  /** Latest time seen on the bus or in a frame, so late camera answers are announced in order. */
  private now = Number.NEGATIVE_INFINITY;

  constructor(private readonly bus: AppBus) {
    bus.onAny((_type, payload) => this.advance((payload as { t: number }).t));
  }

  /**
   * Replace the object set (new or revised plan). Layout objects are placed immediately. Held
   * objects are let go (`plan_changed`).
   */
  load(objects: readonly ObjectSpec[], t: number): void {
    this.advance(t);
    const previous = new Map(this.estimates);
    const held = [...this.grips];
    this.specs.clear();
    this.estimates.clear();
    this.grips.clear();
    this.changed.clear();
    for (const spec of objects) {
      this.specs.set(spec.id, spec);
      const kept = previous.get(spec.id);
      if (kept) {
        // A revised plan keeps what we already know about objects it still uses. One that was held
        // is where the hand let go: not measured there.
        const wasHeld = kept.heldBy !== null;
        this.estimates.set(spec.id, {
          ...kept,
          spec,
          heldBy: null,
          ...(wasHeld ? { t, measured: false } : {}),
        });
        if (wasHeld) this.changed.add(spec.id);
      } else if (spec.placement.method === 'layout') {
        this.set(spec.id, {
          position: [...spec.placement.position],
          confidence: 1,
          source: 'layout',
          t,
        });
      }
    }
    for (const [id, grip] of held) {
      const position = previous.get(id)?.position;
      if (!position) continue;
      this.bus.emit('object.released', {
        t,
        objectId: id,
        hand: grip.hand,
        reason: 'plan_changed',
        position,
      });
    }
  }

  spec(id: string): ObjectSpec | undefined {
    return this.specs.get(id);
  }

  allSpecs(): ObjectSpec[] {
    return [...this.specs.values()];
  }

  /** Declare one more object, leaving the others (and what is held) alone. */
  add(spec: ObjectSpec, t: number): void {
    if (this.specs.has(spec.id)) return;
    this.specs.set(spec.id, spec);
    this.placeAtLayout(spec, t);
  }

  /**
   * A declared object written again (a plan's later stage fills in what its first stage wrote
   * quickly: kind, size, words). Only the spec changes: where the object is, how valid that is,
   * the hand holding it and a loss all stay. One with no position yet takes a layout spot the new
   * spec gives it. Unknown objects are ignored; add() declares them.
   */
  update(spec: ObjectSpec, t: number): void {
    if (!this.specs.has(spec.id)) return;
    this.specs.set(spec.id, spec);
    const est = this.estimates.get(spec.id);
    if (est) this.estimates.set(spec.id, { ...est, spec });
    else this.placeAtLayout(spec, t);
  }

  get(id: string): ObjectEstimate | undefined {
    return this.estimates.get(id);
  }

  position(id: string): Vec3 | undefined {
    return this.estimates.get(id)?.position;
  }

  all(): ObjectEstimate[] {
    return [...this.estimates.values()];
  }

  /** Declared objects that have no position yet, in declaration order. */
  unplaced(): string[] {
    return [...this.specs.keys()].filter((id) => !this.estimates.has(id));
  }

  /**
   * Record an observation. Returns false when ignored: an unknown object, one that is held, an
   * answer about a moment older than what we already know or than its loss (a slow camera answer
   * that arrives after the object was carried), or a camera guess about an object still at its
   * measured layout position (taped spots are more precise than a lifted detection; once the
   * object has been carried, the layout is stale).
   */
  observe(id: string, obs: Observation): boolean {
    if (!this.specs.has(id) || this.grips.has(id)) return false;
    const est = this.estimates.get(id);
    if (est && (obs.t < est.t || (est.lostAt !== undefined && obs.t < est.lostAt))) return false;
    if (obs.source === 'detector' && est?.source === 'layout') return false;
    this.set(id, obs);
    return true;
  }

  /** Attach an object to a hand (it then rides with the wrist). False if unknown or already held. */
  attach(id: string, hand: Handedness, wrist: Pose, t: number, grip: GripKind = 'pinch'): boolean {
    const est = this.estimates.get(id);
    if (!est || this.grips.has(id)) return false;
    const objectPose: Pose = { p: est.position, q: est.orientation ?? [0, 0, 0, 1] };
    this.grips.set(id, {
      hand,
      grip,
      wristFromObject: composePose(invertPose(wrist), objectPose),
      wristTracked: true,
    });
    const { lostAt: _found, ...held } = est;
    this.estimates.set(id, { ...held, heldBy: hand, t });
    this.changed.add(id);
    this.bus.emit('object.grasped', { t, objectId: id, hand, grip, position: est.position });
    return true;
  }

  /**
   * A live source lost the object at `t` (the camera frame time of the answer that lost it). Its
   * last camera estimate is recorded once as a state with no valid flags at the last position,
   * until the object is observed or grasped again. The lesson keeps reading that position (checks,
   * pinch targets, overlays), as it did before any source could report a loss, and the object does
   * not become unplaced, so nothing re-finds it. Ignored for an object that is held (the hand owns
   * it then), that was never placed or is already lost, that was not placed by a camera (a layout
   * spot or a hand's release stays where it was), or whose estimate is newer than the loss.
   */
  lose(id: string, t: number): void {
    const est = this.estimates.get(id);
    if (!est || this.grips.has(id) || est.lostAt !== undefined || t < est.t) return;
    if (!MEASURED_SOURCES.has(est.source)) return;
    this.estimates.set(id, { ...est, lostAt: t });
    this.changed.add(id);
  }

  detach(id: string, t: number, reason: ReleaseReason = 'opened'): void {
    const grip = this.grips.get(id);
    if (!grip) return;
    this.grips.delete(id);
    const est = this.estimates.get(id);
    if (!est) return;
    // Where the hand let go is carried, not measured, even before the wrist ever moved it.
    this.estimates.set(id, { ...est, heldBy: null, t, measured: false });
    this.changed.add(id);
    this.bus.emit('object.released', {
      t,
      objectId: id,
      hand: grip.hand,
      reason,
      position: est.position,
    });
  }

  heldBy(hand: Handedness): string[] {
    return [...this.grips].filter(([, g]) => g.hand === hand).map(([id]) => id);
  }

  /**
   * Move held objects with their hands' wrists (workspace frame). A held object whose wrist is
   * missing stays put; that is recorded once, as a state without valid flags.
   */
  updateHeld(wrists: Partial<Record<Handedness, Pose>>, t: number): void {
    this.advance(t);
    for (const [id, grip] of this.grips) {
      const wrist = wrists[grip.hand];
      const est = this.estimates.get(id);
      if (!est) continue;
      if (!wrist) {
        if (grip.wristTracked) this.changed.add(id);
        grip.wristTracked = false;
        continue;
      }
      grip.wristTracked = true;
      const pose = composePose(wrist, grip.wristFromObject);
      this.estimates.set(id, {
        ...est,
        position: pose.p,
        orientation: est.orientation ? pose.q : null,
        source: 'pinch',
        t,
      });
      this.changed.add(id);
    }
  }

  /** Closest object to a point within `maxDistance`, ignoring hidden zones unless asked. */
  nearest(
    point: Readonly<Vec3>,
    maxDistance: number,
    { includeHidden = false } = {},
  ): { objectId: string; distance: number } | null {
    let best: { objectId: string; distance: number } | null = null;
    for (const est of this.estimates.values()) {
      if (est.spec.hidden && !includeHidden) continue;
      const d = distance(point, est.position);
      if (d <= maxDistance && (!best || d < best.distance))
        best = { objectId: est.id, distance: d };
    }
    return best;
  }

  /**
   * Object states that changed since the last call, for the objects.ndjson stream. Like every
   * time on the bus, `observedT` is performance.now ms here; the recorder rebases it. A state
   * without a valid position says what is true now, not what was measured, so it has no
   * `observedT`: it is placed at its line's time, after the last carried state.
   */
  drainChanges(): ObjectState[] {
    const out: ObjectState[] = [];
    for (const id of this.changed) {
      const est = this.estimates.get(id);
      if (!est) continue;
      const flags = locationFlags(est, this.grips.get(id));
      out.push({
        id,
        position: est.position,
        orientation: flags & LOCATION_FLAG.orientationValid ? est.orientation : null,
        // A loss says nothing about where the object is now, as ObjectTrackRecorder records it.
        confidence: est.lostAt === undefined ? est.confidence : 0,
        source: est.source,
        locationFlags: flags,
        heldBy: est.heldBy,
        ...(flags & LOCATION_FLAG.positionValid ? { observedT: est.t } : {}),
      });
    }
    this.changed.clear();
    return out;
  }

  private placeAtLayout(spec: ObjectSpec, t: number): void {
    if (spec.placement.method !== 'layout') return;
    this.set(spec.id, {
      position: [...spec.placement.position],
      confidence: 1,
      source: 'layout',
      t,
    });
  }

  private set(id: string, obs: Observation): void {
    const spec = this.specs.get(id);
    if (!spec) return;
    const previous = this.estimates.get(id);
    this.estimates.set(id, {
      id,
      spec,
      position: obs.position,
      orientation: obs.orientation ?? null,
      confidence: obs.confidence,
      source: obs.source,
      t: obs.t,
      heldBy: null,
      ...(obs.measured === false ? { measured: false } : {}),
    });
    this.changed.add(id);
    if (!previous || previous.source !== obs.source) {
      // A slow camera answer is announced when it arrives; its frame time stays in the estimate.
      this.bus.emit('object.registered', {
        t: Math.max(obs.t, this.now),
        objectId: id,
        position: obs.position,
        method: obs.source,
      });
    }
  }

  private advance(t: number): void {
    if (t > this.now) this.now = t;
  }
}
