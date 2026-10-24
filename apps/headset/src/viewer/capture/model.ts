// The viewer's data model, shaped after Quest Capture v1: entities (scene.json), a pose time series
// for every tracked entity (objects and the headset), a hand series per side, and event annotations.
// Field names follow the format, so package records parse straight in; Clio episodes are converted
// into it by from-clio.ts. World frame: ROS REP-103 (x forward, y left, z up), meters. Time: integer
// microseconds since the recording started. Pure: no DOM, fetch or three.js.

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
  extensions?: { radius_m?: number };
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

  get endUs(): number {
    return this.samples.at(-1)?.t_us ?? 0;
  }
}

const has = (flags: number, bit: number) => (flags & bit) === bit;

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
  }

  addEvent(event: CaptureEvent): void {
    this.events.add(event);
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

/** Which hand holds which object at `t`: grasp and release events replayed in order. */
export function heldAt(capture: Capture, t: number): Map<string, string> {
  const held = new Map<string, string>();
  const last = capture.events.indexAt(t);
  for (let i = 0; i <= last; i++)
    applyGrasp(capture, held, capture.events.samples[i] as CaptureEvent);
  return held;
}

function applyGrasp(capture: Capture, held: Map<string, string>, e: CaptureEvent): void {
  if (e.event !== 'grasp' && e.event !== 'release') return;
  const isHand = (id: string) => capture.entities.get(id)?.role === 'hand';
  const hand = e.entity_ids.find(isHand) ?? null;
  const objects = e.entity_ids.filter((id) => !isHand(id));
  if (e.event === 'grasp') {
    if (hand) for (const id of objects) held.set(id, hand);
  } else if (objects.length > 0) {
    for (const id of objects) held.delete(id);
  } else {
    for (const [id, by] of held) if (by === hand) held.delete(id);
  }
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
