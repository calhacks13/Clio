// The viewer's data model, shaped after Quest Capture v1: entities (scene.json), a pose time series
// for every tracked entity (objects and the headset), a hand series per side, and event annotations,
// plus the spans in which each object was held. Field names follow the format, so package records
// parse straight in; Clio episodes are converted into it by from-clio.ts. World frame: ROS REP-103
// (x forward, y left, z up), meters. Time: integer microseconds since the recording started. Pure:
// no DOM, fetch or three.js.

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

// OpenXR-compatible location flags. A tracked bit always comes with its valid bit.
export const ORIENTATION_VALID = 1;
export const POSITION_VALID = 2;
export const ORIENTATION_TRACKED = 4;
export const POSITION_TRACKED = 8;

export interface Location {
  translation: Vec3 | null;
  rotation: Quat | null;
  location_flags: number;
}

export interface Pose {
  translation: Vec3;
  rotation: Quat;
}

export type EntityRole = 'object' | 'environment' | 'headset' | 'hand';
/** What a procedure plan calls an object. Items, tools and containers can be carried. */
export type ObjectKind = 'item' | 'tool' | 'container' | 'point' | 'region';
export type Geometry =
  | { type: 'none' }
  | { type: 'box'; size: Vec3; color: string }
  | { type: 'glb'; path: string };

export interface Entity {
  id: string;
  name: string;
  role: EntityRole;
  motion: 'static' | 'tracked';
  geometry: Geometry;
  /** Static entities only; a tracked entity's pose comes from its samples. */
  pose: Pose | null;
  extensions?: {
    radius_m?: number;
    kind?: ObjectKind;
    /** Kept in the model but never drawn (a plan's hidden zone, such as a mistake region). */
    hidden?: boolean;
  };
}

export type EstimateType =
  | 'runtime_estimate'
  | 'vision_estimate'
  | 'predicted'
  | 'manual'
  | 'synthetic';

export interface PoseSample {
  kind: 'pose';
  t_us: number;
  sequence: number;
  source_id: string;
  estimate_type: EstimateType;
  entity_id: string;
  location: Location;
  confidence: number | null;
}

export type Handedness = 'left' | 'right';

/** OpenXR default joint set: palm, wrist, then thumb (4), index (5), middle, ring, little (5 each). */
export const HAND_JOINTS = 26;

/** The hand's bones as joint index pairs: from the wrist (1) out along each finger. */
export const HAND_BONES: readonly (readonly [number, number])[] = [
  [1, 2, 3, 4, 5],
  [1, 6, 7, 8, 9, 10],
  [1, 11, 12, 13, 14, 15],
  [1, 16, 17, 18, 19, 20],
  [1, 21, 22, 23, 24, 25],
].flatMap((chain) => chain.slice(1).map((j, i) => [chain[i] ?? 1, j] as const));

/**
 * A `hand` record with its 26 joints packed into arrays: `positions` holds x, y, z per joint (NaN
 * where the position is invalid), `flags` each joint's location flags. Joint orientations are not
 * kept; the viewer draws positions.
 */
export interface HandSample {
  kind: 'hand';
  t_us: number;
  sequence: number;
  source_id: string;
  estimate_type: EstimateType;
  entity_id: string;
  handedness: Handedness;
  active: boolean;
  positions: Float32Array;
  radii: Float32Array;
  flags: Uint8Array;
  /** Thumb tip to index tip in meters, or null when the hand was not tracked or not measured. */
  pinch_m: number | null;
}

export type EventKind =
  | 'grasp'
  | 'release'
  | 'tracking_lost'
  | 'tracking_recovered'
  | 'recenter'
  | 'marker';

export interface CaptureEvent {
  kind: 'event';
  t_us: number;
  sequence: number;
  source_id: string;
  event: EventKind;
  entity_ids: string[];
  origin: 'inferred' | 'manual' | 'runtime' | 'synthetic';
  details: Record<string, unknown>;
}

interface Timed {
  t_us: number;
}

/** Samples kept in time order. In-order arrival (the normal case) is a plain push. */
export class Series<T extends Timed> {
  readonly samples: T[] = [];

  add(sample: T): void {
    const last = this.samples.at(-1);
    if (!last || last.t_us <= sample.t_us) this.samples.push(sample);
    else this.samples.splice(this.indexAt(sample.t_us) + 1, 0, sample);
  }

  /** Index of the last sample at or before `t`, or -1 when every sample is later. */
  indexAt(t: number): number {
    let lo = 0;
    let hi = this.samples.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.samples[mid] as T).t_us <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  at(t: number): T | null {
    return this.samples[this.indexAt(t)] ?? null;
  }

  /** Forgets every sample before `t` (to bound a long live recording) and returns how many. */
  dropBefore(t: number): number {
    let lo = 0;
    let hi = this.samples.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.samples[mid] as T).t_us < t) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) this.samples.splice(0, lo);
    return lo;
  }

  get endUs(): number {
    return this.samples.at(-1)?.t_us ?? 0;
  }
}

const has = (flags: number, bit: number) => (flags & bit) === bit;

/**
 * Where the recording's world sits, as the source recorded it (not converted to ROS). For a Clio
 * episode: the workspace W (y up, origin at the calibrated table corner) in WebXR local-floor
 * space.
 */
export interface CaptureSpace {
  /** [px, py, pz, qx, qy, qz, qw] */
  worldFromWorkspace: [number, number, number, number, number, number, number];
  calibration: string;
  anchored: boolean;
}

/**
 * A stretch of time an object was held. `endUs` is null while it is still held. The object counts
 * as held from `startUs` up to, not including, `endUs`.
 */
export interface HeldSpan {
  entityId: string;
  /** Null when the hand is not known (a fist carry inferred from the object's motion). */
  hand: Handedness | null;
  startUs: number;
  endUs: number | null;
  /** `runtime`: recorded as grasp and release by the headset; `inferred`: worked out afterwards. */
  origin: 'inferred' | 'runtime';
  grip: 'pinch' | 'fist' | null;
}

const NO_SPANS: readonly HeldSpan[] = Object.freeze([]);

/** One recording: what a Capture v1 package holds, growing while a live episode streams in. */
export class Capture {
  readonly entities = new Map<string, Entity>();
  readonly poses = new Map<string, Series<PoseSample>>();
  readonly hands: Record<Handedness, Series<HandSample>> = {
    left: new Series(),
    right: new Series(),
  };
  readonly events = new Series<CaptureEvent>();
  /** Known once the recording is finished. */
  durationUs: number | null = null;
  /** Null when the source does not record it (Capture packages place everything in ROS already). */
  space: CaptureSpace | null = null;

  /** Held spans from grasp and release events, per object. */
  readonly #graspSpans = new Map<string, HeldSpan[]>();
  /** Held spans an adapter worked out from an object's samples, per object. */
  readonly #sampleSpans = new Map<string, readonly HeldSpan[]>();
  /** Both, by start time, built on first use. */
  readonly #spans = new Map<string, readonly HeldSpan[]>();
  /** The open span of each held object, and the hand entity holding it. */
  readonly #open = new Map<string, { span: HeldSpan; hand: string }>();
  readonly #holder = new WeakMap<HeldSpan, string>();
  readonly #handSide = new Map<string, Handedness>();
  /** The time of the newest grasp or release applied; an earlier one means replaying them all. */
  #graspsUntil = Number.NEGATIVE_INFINITY;

  constructor(public task: string) {}

  addEntity(entity: Entity): void {
    this.entities.set(entity.id, entity);
  }

  addPose(sample: PoseSample): void {
    let series = this.poses.get(sample.entity_id);
    if (!series) {
      series = new Series();
      this.poses.set(sample.entity_id, series);
    }
    series.add(sample);
  }

  addHand(sample: HandSample): void {
    this.hands[sample.handedness].add(sample);
    if (!this.#handSide.has(sample.entity_id))
      this.#handSide.set(sample.entity_id, sample.handedness);
  }

  /** Grasp and release events also open and close held spans. */
  addEvent(event: CaptureEvent): void {
    this.events.add(event);
    if (event.event !== 'grasp' && event.event !== 'release') return;
    if (event.t_us >= this.#graspsUntil) {
      this.#graspsUntil = event.t_us;
      this.#applyGrasp(event);
      return;
    }
    // Arrived late: replay every grasp and release in time order.
    this.#graspSpans.clear();
    this.#open.clear();
    this.#spans.clear();
    for (const e of this.events.samples) {
      if (e.event === 'grasp' || e.event === 'release') this.#applyGrasp(e);
    }
  }

  /** The object's held spans by start time: recorded or inferred grasps, and inferred carries. */
  heldSpans(entityId: string): readonly HeldSpan[] {
    let spans = this.#spans.get(entityId);
    if (!spans) {
      const fromGrasps = this.#graspSpans.get(entityId) ?? NO_SPANS;
      const fromSamples = this.#sampleSpans.get(entityId) ?? NO_SPANS;
      spans =
        fromSamples.length === 0
          ? fromGrasps
          : [...fromGrasps, ...fromSamples].sort((a, b) => a.startUs - b.startUs);
      this.#spans.set(entityId, spans);
    }
    return spans;
  }

  /** Ids of the objects that have held spans. */
  heldEntityIds(): string[] {
    return [...new Set([...this.#graspSpans.keys(), ...this.#sampleSpans.keys()])];
  }

  /**
   * Replaces the held spans worked out from an object's samples rather than from grasp and release
   * events (a carry with no grasp recorded). The adapter keeps them from overlapping grasp spans.
   */
  setSampleHeldSpans(entityId: string, spans: readonly HeldSpan[]): void {
    if (spans.length === 0) this.#sampleSpans.delete(entityId);
    else this.#sampleSpans.set(entityId, spans);
    this.#spans.delete(entityId);
  }

  /** The entity id of the hand holding during a span, when known. */
  holderOf(span: HeldSpan): string | null {
    const holder = this.#holder.get(span);
    if (holder !== undefined) return holder;
    if (span.hand === null) return null;
    for (const [id, side] of this.#handSide) if (side === span.hand) return id;
    return null;
  }

  #sideOf(handId: string): Handedness | null {
    const side = this.#handSide.get(handId);
    if (side) return side;
    if (/left/i.test(handId)) return 'left';
    return /right/i.test(handId) ? 'right' : null;
  }

  #applyGrasp(e: CaptureEvent): void {
    const isHand = (id: string) => this.entities.get(id)?.role === 'hand';
    const hand = e.entity_ids.find(isHand) ?? null;
    const objects = e.entity_ids.filter((id) => !isHand(id));
    if (e.event === 'grasp') {
      if (!hand) return;
      for (const id of objects) {
        const open = this.#open.get(id);
        if (open?.hand === hand) continue;
        if (open) open.span.endUs = e.t_us;
        const grip = e.details.grip;
        const span: HeldSpan = {
          entityId: id,
          hand: this.#sideOf(hand),
          startUs: e.t_us,
          endUs: null,
          origin: e.origin === 'inferred' ? 'inferred' : 'runtime',
          grip: grip === 'pinch' || grip === 'fist' ? grip : null,
        };
        this.#holder.set(span, hand);
        this.#open.set(id, { span, hand });
        const spans = this.#graspSpans.get(id);
        if (spans) spans.push(span);
        else this.#graspSpans.set(id, [span]);
        this.#spans.delete(id);
      }
      return;
    }
    // A release names its objects, or only the hand: then everything that hand holds.
    const released =
      objects.length > 0
        ? objects
        : [...this.#open].filter(([, open]) => open.hand === hand).map(([id]) => id);
    for (const id of released) {
      const open = this.#open.get(id);
      if (!open) continue;
      open.span.endUs = e.t_us;
      this.#open.delete(id);
    }
  }

  /** The newest time recorded on any stream, or the duration once finished. */
  get endUs(): number {
    let end = Math.max(this.durationUs ?? 0, this.hands.left.endUs, this.hands.right.endUs);
    for (const series of this.poses.values()) end = Math.max(end, series.endUs);
    return Math.max(end, this.events.endUs);
  }

  ofRole(role: EntityRole): Entity[] {
    return [...this.entities.values()].filter((e) => e.role === role);
  }

  /** The headset's pose series (the first headset entity's), if it has samples. */
  headset(): Series<PoseSample> | null {
    const id = this.ofRole('headset')[0]?.id;
    return (id && this.poses.get(id)) || null;
  }
}

/** A tracked entity as it stood at some time. */
export interface EntityAt {
  /** The newest sample at or before the time. */
  sample: PoseSample;
  /** The newest valid position at or before the time: where to draw it, even when lost. */
  position: Vec3 | null;
  rotation: Quat | null;
  /** The newest sample says the position is not valid. */
  lost: boolean;
  /** The newest sample's position was measured directly (not inferred or carried over). */
  tracked: boolean;
}

/** How far back `entityAt` looks for the last valid position of a lost entity. */
const MAX_LOOKBACK = 10_000;

export function entityAt(series: Series<PoseSample>, t: number): EntityAt | null {
  const i = series.indexAt(t);
  const sample = series.samples[i];
  if (!sample) return null;
  const flags = sample.location.location_flags;
  let position = has(flags, POSITION_VALID) ? sample.location.translation : null;
  for (let j = i - 1; !position && j >= 0 && i - j <= MAX_LOOKBACK; j--) {
    const earlier = series.samples[j] as PoseSample;
    if (has(earlier.location.location_flags, POSITION_VALID)) {
      position = earlier.location.translation;
    }
  }
  return {
    sample,
    position,
    rotation: has(flags, ORIENTATION_VALID) ? sample.location.rotation : null,
    lost: !has(flags, POSITION_VALID),
    tracked: has(flags, POSITION_TRACKED),
  };
}

/**
 * Valid positions in the `windowUs` up to `t`, as polylines: a sample without a valid position
 * ends one. Thinned to about `maxPoints` in all; the newest sample is always the last point.
 */
export function trail(
  series: Series<PoseSample>,
  t: number,
  windowUs: number,
  maxPoints = 200,
): Vec3[][] {
  const end = series.indexAt(t);
  const start = series.indexAt(t - windowUs) + 1;
  const stride = Math.max(1, Math.ceil((end - start + 1) / maxPoints));
  const lines: Vec3[][] = [];
  let line: Vec3[] = [];
  for (let i = start; i <= end; i++) {
    const s = series.samples[i] as PoseSample;
    const p = has(s.location.location_flags, POSITION_VALID) ? s.location.translation : null;
    if (!p) {
      if (line.length > 1) lines.push(line);
      line = [];
    } else if ((i - start) % stride === 0 || i === end) {
      line.push(p);
    }
  }
  if (line.length > 1) lines.push(line);
  return lines;
}

/** The span in which the object is held at `t`, or null when nothing holds it then. */
export function heldSpanAt(capture: Capture, entityId: string, t: number): HeldSpan | null {
  const spans = capture.heldSpans(entityId);
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((spans[mid] as HeldSpan).startUs <= t) lo = mid + 1;
    else hi = mid;
  }
  // The newest span started by `t` usually decides; an earlier, longer one can still be open.
  for (let i = lo - 1; i >= 0; i--) {
    const span = spans[i] as HeldSpan;
    if (span.endUs === null || t < span.endUs) return span;
  }
  return null;
}

/**
 * Which hand holds which object at `t`: object id to the hand's entity id, or to null when the hand
 * is not known.
 */
export function heldAt(capture: Capture, t: number): Map<string, string | null> {
  const held = new Map<string, string | null>();
  for (const id of capture.heldEntityIds()) {
    const span = heldSpanAt(capture, id, t);
    if (span) held.set(id, capture.holderOf(span));
  }
  return held;
}

/** One object's timeline lane: when its position was valid, and its grasp and release marks. */
export interface Lane {
  entityId: string;
  label: string;
  /** [from, to] in microseconds; a sample's validity lasts until the next sample (or `endUs`). */
  validSpans: Array<[number, number]>;
  marks: Array<{ tUs: number; kind: 'grasp' | 'release' }>;
  /** The color the object is drawn in, so a lane matches its object. */
  color: string;
}

export function validSpans(
  series: Series<PoseSample> | undefined,
  endUs: number,
): [number, number][] {
  const spans: [number, number][] = [];
  let open: [number, number] | null = null;
  for (const s of series?.samples ?? []) {
    const valid = has(s.location.location_flags, POSITION_VALID);
    if (valid && !open) {
      open = [s.t_us, s.t_us];
      spans.push(open);
    } else if (!valid && open) {
      open[1] = s.t_us;
      open = null;
    }
  }
  if (open) open[1] = Math.max(open[0], endUs);
  return spans;
}

export function graspMarks(capture: Capture, entityId: string): Lane['marks'] {
  const marks: Lane['marks'] = [];
  for (const e of capture.events.samples) {
    if ((e.event === 'grasp' || e.event === 'release') && e.entity_ids.includes(entityId)) {
      marks.push({ tUs: e.t_us, kind: e.event });
    }
  }
  return marks;
}

/** The hand's newest sample at or before `t`, or null when that hand was not tracked then. */
export function handAt(capture: Capture, side: Handedness, t: number): HandSample | null {
  const sample = capture.hands[side].at(t);
  return sample?.active ? sample : null;
}
