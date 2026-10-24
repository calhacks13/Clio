import type { Handedness, ObjectSpec, ObjectState, PlacementMethod } from '@clio/protocol';
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
// more reliable than any camera estimate.

export interface ObjectEstimate {
  id: string;
  spec: ObjectSpec;
  position: Vec3;
  orientation: Quat | null;
  confidence: number;
  source: PlacementMethod;
  /** When this estimate was last updated (performance.now ms). */
  t: number;
  heldBy: Handedness | null;
}

export interface Observation {
  position: Vec3;
  orientation?: Quat | null;
  confidence: number;
  source: PlacementMethod;
  t: number;
}

interface Grip {
  hand: Handedness;
  /** Object pose in the wrist frame at the moment of grasping. */
  wristFromObject: Pose;
}

export class ObjectRegistry {
  private readonly specs = new Map<string, ObjectSpec>();
  private readonly estimates = new Map<string, ObjectEstimate>();
  private readonly grips = new Map<string, Grip>();
  private readonly changed = new Set<string>();

  constructor(private readonly bus: AppBus) {}

  /** Replace the object set (new or revised plan). Layout objects are placed immediately. */
  load(objects: readonly ObjectSpec[], t: number): void {
    const previous = new Map(this.estimates);
    this.specs.clear();
    this.estimates.clear();
    this.grips.clear();
    this.changed.clear();
    for (const spec of objects) {
      this.specs.set(spec.id, spec);
      const kept = previous.get(spec.id);
      if (kept) {
        // A revised plan keeps what we already know about objects it still uses.
        this.estimates.set(spec.id, { ...kept, spec, heldBy: null });
      } else if (spec.placement.method === 'layout') {
        this.set(spec.id, {
          position: [...spec.placement.position],
          confidence: 1,
          source: 'layout',
          t,
        });
      }
    }
  }

  spec(id: string): ObjectSpec | undefined {
    return this.specs.get(id);
  }

  allSpecs(): ObjectSpec[] {
    return [...this.specs.values()];
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

  /** Record an observation. Returns false when ignored (unknown object, or currently held). */
  observe(id: string, obs: Observation): boolean {
    if (!this.specs.has(id) || this.grips.has(id)) return false;
    this.set(id, obs);
    return true;
  }

  attach(id: string, hand: Handedness, wrist: Pose, t: number): boolean {
    const est = this.estimates.get(id);
    if (!est) return false;
    const objectPose: Pose = { p: est.position, q: est.orientation ?? [0, 0, 0, 1] };
    this.grips.set(id, { hand, wristFromObject: composePose(invertPose(wrist), objectPose) });
    this.estimates.set(id, { ...est, heldBy: hand, t });
    this.changed.add(id);
    return true;
  }

  detach(id: string, t: number): void {
    if (!this.grips.delete(id)) return;
    const est = this.estimates.get(id);
    if (est) this.estimates.set(id, { ...est, heldBy: null, t });
    this.changed.add(id);
  }

  heldBy(hand: Handedness): string[] {
    return [...this.grips].filter(([, g]) => g.hand === hand).map(([id]) => id);
  }

  /** Move held objects with their hands' wrists (workspace frame). */
  updateHeld(wrists: Partial<Record<Handedness, Pose>>, t: number): void {
    for (const [id, grip] of this.grips) {
      const wrist = wrists[grip.hand];
      const est = this.estimates.get(id);
      if (!wrist || !est) continue;
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

  /** Object states that changed since the last call, for the objects.ndjson stream. */
  drainChanges(): ObjectState[] {
    const out: ObjectState[] = [];
    for (const id of this.changed) {
      const est = this.estimates.get(id);
      if (!est) continue;
      out.push({
        id,
        position: est.position,
        orientation: est.orientation,
        confidence: est.confidence,
        source: est.source,
      });
    }
    this.changed.clear();
    return out;
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
    });
    this.changed.add(id);
    if (!previous || previous.source !== obs.source) {
      this.bus.emit('object.registered', {
        t: obs.t,
        objectId: id,
        position: obs.position,
        method: obs.source,
      });
    }
  }
}
