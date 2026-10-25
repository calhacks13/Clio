import type {
  CompiledObjectShape,
  CompiledObjectTrack,
  ShapesDoc,
  TracksDoc,
} from "@clio/protocol";
import { rosFromW, rosQuatFromW } from "@clio-viewer/capture/from-clio";
import {
  type Capture,
  HAND_JOINTS,
  type HandSample,
  ORIENTATION_VALID,
  POSITION_VALID,
  type PoseSample,
  type Quat,
  type Vec3,
} from "@clio-viewer/capture/model";
import { extentSize, shapeInRos } from "./compiled-objects";
import { formatTime, type InspectorRow } from "./lanes";

// Objects out of reach stay still (display only; INTEGRATION.md, "Objects out of reach"). A
// tracker's 3D estimate of an object no hand is touching jitters, and a camera far from the object
// can jump it by meters between frames. This splits each object's timeline into stretches where a
// hand could be touching it and stretches where none could, and draws the object at one recorded
// pose for each stretch out of reach. The recording, the compile and the inspector's measured rows
// are unchanged; only where the scene draws the object, its trail and its model move.
//
// The rule, evaluated every STEP (1/30 s) from the object's first position:
//
// - In reach while a held span covers the time (recorded or inferred): a hand carries it.
// - A tracked hand is in reach when any of its joints is within CONTACT_MARGIN of the object's
//   volume: the sphere of its radius, and its estimated extent box and measured shape box when the
//   compile has them, all riding on the position.
// - A hand that is not tracked might be touching it out of view, so it is in reach when the object
//   is within ARM_REACH of the head, unless the hand was seen too recently to have got there:
//   farther from the object, when last tracked, than CONTACT_MARGIN plus HAND_SPEED times the time
//   since. With no current head pose (a frame gap, frames not loaded) only that second bound
//   applies, and a hand never tracked before is in reach.
// - A hidden moment (no compiled position) uses where the object was last seen.
//
// Then hysteresis, so a stretch does not flicker: a gap in reach shorter than MIN_REST counts as
// reach (a hand moving round the object it handles), and then a reach shorter than MIN_REACH
// counts as none (a joint or a stray estimate brushing the margin). What is left out of reach is a
// rest stretch.
//
// A rest stretch's pose is the recorded estimate in it nearest the per-axis median of its
// estimates: robust to stray ones (a far camera's jumps), and always a pose that was recorded, with
// that estimate's rotation. A compiled track takes them from the raw estimates the compile
// resampled, each counted once, so the raw and compiled views agree. Entered from a reach, the drawn position eases from the tracked one
// to the rest pose over EASE, and back before a reach, so an object that was still does not jump;
// while in reach the tracked motion is drawn exactly. Pure: no DOM or three.js. Positions are in
// the Capture's ROS frame (z up, meters).

/** The rule's numbers; INTEGRATION.md says why each is what it is. */
export const REST_RULE = {
  /** Reach is evaluated this often (the compiled grid's 30 fps). */
  stepUs: 33_333,
  /** A tracked joint this close to the object's volume could be touching it. */
  contactMarginM: 0.1,
  /** An untracked hand can touch what is this close to the head (the headset, at the eyes). */
  armReachM: 1.1,
  /** How fast an untracked hand could have moved since it was last tracked. */
  handSpeedMS: 3,
  /** No joint is farther than this from the wrist (a quick reject before every joint). */
  handSpanM: 0.25,
  /** A head or hand sample older than this says nothing about now. */
  frameGapUs: 100_000,
  /** A reach shorter than this ends no rest stretch. */
  minReachUs: 200_000,
  /** Out of reach at least this long before the object is held still. */
  minRestUs: 500_000,
  /** The drawn position eases between the tracked one and the rest pose over this. */
  easeUs: 250_000,
} as const;

export type RestRule = { [K in keyof typeof REST_RULE]: number };

/** One step of an object's drawn track; it holds until the next sample. */
export interface TrackSample {
  tUs: number;
  /** Where the object is drawn while this sample holds; null draws nothing. */
  position: Vec3 | null;
  rotation: Quat | null;
  /** The position is carried over from an earlier sample (a raw loss): the trail breaks. */
  lost: boolean;
}

/** A recorded estimate with a valid position: what a rest pose is chosen from. */
export interface RestEstimate {
  tUs: number;
  position: Vec3;
  rotation: Quat | null;
}

interface Box {
  center: Vec3;
  half: Vec3;
  /** The box's inverse rotation, row-major 3 x 3. */
  inverse: number[];
}

/** What a hand can touch of the object, riding on its position. */
export interface ObjectVolume {
  radius: number;
  boxes: Box[];
  /** No point of the volume is farther than this from the position. */
  bound: number;
}

/** One object's drawn track, as the objects layer draws it, from raw estimates or the compile. */
export interface RestTrack {
  /** By time. */
  samples: TrackSample[];
  /** The last sample holds until here, exclusive; Infinity holds it for good. */
  endUs: number;
  /** By time. */
  estimates: RestEstimate[];
  /** When a hand held it: [start, end), end null while still held. */
  held: (readonly [number, number | null])[];
  volume: ObjectVolume;
}

/** Out of reach from `startUs` up to, not including, `endUs`: drawn at one pose. */
export interface RestStretch {
  startUs: number;
  /** Infinity when the stretch runs to the end of the recording. */
  endUs: number;
  position: Vec3;
  rotation: Quat | null;
  /** Entered from a reach: the drawn position eases in. */
  easeIn: boolean;
  /** Left for a reach: the drawn position eases back out. */
  easeOut: boolean;
}

export interface RestPlan {
  /** By time, never overlapping. */
  stretches: RestStretch[];
}

const NO_REST: RestPlan = Object.freeze({ stretches: [] }) as RestPlan;
const DEFAULT_RADIUS = 0.03;

function quatMatrix([x, y, z, w]: readonly number[]): number[] {
  const n = Math.hypot(x, y, z, w) || 1;
  const [a, b, c, d] = [x / n, y / n, z / n, w / n];
  // Row-major R; its transpose is the inverse.
  return [
    1 - 2 * (b * b + c * c),
    2 * (a * b - c * d),
    2 * (a * c + b * d),
    2 * (a * b + c * d),
    1 - 2 * (a * a + c * c),
    2 * (b * c - a * d),
    2 * (a * c - b * d),
    2 * (b * c + a * d),
    1 - 2 * (a * a + b * b),
  ];
}

function box(center: Vec3, size: readonly number[], rotation: Quat): Box {
  const r = quatMatrix(rotation);
  return {
    center,
    half: [size[0] / 2, size[1] / 2, size[2] / 2],
    inverse: [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]],
  };
}

/**
 * What a hand can touch of an object: the sphere of its radius, and its estimated extent (a box
 * of width by width by height about the position, as the scene draws it) and its measured shape's
 * box when the compile has them. Every one counts, so the largest decides.
 */
export function objectVolume(
  radius: number,
  track: CompiledObjectTrack | null = null,
  shape: CompiledObjectShape | null = null,
): ObjectVolume {
  const boxes: Box[] = [];
  const size = track ? extentSize(track) : null;
  if (size) boxes.push(box([0, 0, 0], size, [0, 0, 0, 1]));
  const ros = shape ? shapeInRos(shape) : null;
  if (ros?.box) boxes.push(box(ros.box.center, ros.box.size, ros.box.rotation));
  let bound = radius;
  for (const b of boxes) {
    bound = Math.max(bound, Math.hypot(...b.center) + Math.hypot(...b.half));
  }
  return { radius, boxes, bound };
}

/** From the point (x, y, z) to the volume at `p`; 0 inside. */
function distanceTo(
  volume: ObjectVolume,
  p: Vec3,
  x: number,
  y: number,
  z: number,
): number {
  const dx = x - p[0];
  const dy = y - p[1];
  const dz = z - p[2];
  let best = Math.hypot(dx, dy, dz) - volume.radius;
  for (const { center, half, inverse: m } of volume.boxes) {
    const ox = dx - center[0];
    const oy = dy - center[1];
    const oz = dz - center[2];
    const ex = Math.abs(m[0] * ox + m[1] * oy + m[2] * oz) - half[0];
    const ey = Math.abs(m[3] * ox + m[4] * oy + m[5] * oz) - half[1];
    const ez = Math.abs(m[6] * ox + m[7] * oy + m[8] * oz) - half[2];
    best = Math.min(
      best,
      Math.hypot(Math.max(ex, 0), Math.max(ey, 0), Math.max(ez, 0)),
    );
  }
  return Math.max(best, 0);
}

/** Whether any recorded joint of the hand is within `limit` of the volume at `p`. */
function handWithin(
  hand: HandSample,
  volume: ObjectVolume,
  p: Vec3,
  limit: number,
  rule: RestRule,
): boolean {
  const q = hand.positions;
  // Joint 1 is the wrist; every other joint is within handSpan of it.
  if (!Number.isNaN(q[3])) {
    const wrist = Math.hypot(q[3] - p[0], q[4] - p[1], q[5] - p[2]);
    if (wrist - rule.handSpanM - volume.bound > limit) return false;
  }
  for (let j = 1; j < HAND_JOINTS; j++) {
    const x = q[j * 3];
    if (Number.isNaN(x)) continue;
    if (distanceTo(volume, p, x, q[j * 3 + 1], q[j * 3 + 2]) <= limit) {
      return true;
    }
  }
  return false;
}

/** Walks a time-ordered list forward: the newest item at or before the time asked. */
class Cursor<T extends { t_us: number }> {
  index = -1;
  constructor(
    readonly items: readonly T[],
    readonly onPass: (item: T) => void = () => {},
  ) {}

  at(tUs: number): T | null {
    while (
      this.index + 1 < this.items.length &&
      this.items[this.index + 1].t_us <= tUs
    ) {
      this.index++;
      this.onPass(this.items[this.index]);
    }
    return this.items[this.index] ?? null;
  }
}

/**
 * Flips every run of `of` shorter than `minSteps` to the other value. With `onlyBetween`, a run
 * that is the whole timeline is kept.
 */
function closeRuns(
  flags: Uint8Array,
  of: 0 | 1,
  minSteps: number,
  onlyBetween: boolean,
): void {
  const n = flags.length;
  let k = 0;
  while (k < n) {
    let end = k;
    while (end < n && flags[end] === flags[k]) end++;
    const bounded = !onlyBetween || k > 0 || end < n;
    if (flags[k] === of && end - k < minSteps && bounded) {
      flags.fill(of === 1 ? 0 : 1, k, end);
    }
    k = end;
  }
}

/** Index of the last item at or before `tUs`, or -1. */
function indexAt(samples: readonly { tUs: number }[], tUs: number): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid].tUs <= tUs) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

const median = (values: number[]): number => {
  values.sort((a, b) => a - b);
  const mid = values.length >>> 1;
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
};

/**
 * The pose of a rest stretch: of the estimates in force during [startUs, endUs) (the one at its
 * start and every later one before its end), the one nearest their per-axis median. Without one,
 * the position drawn at the start. Null when there is nothing to draw.
 */
function restPose(
  track: RestTrack,
  startUs: number,
  endUs: number,
): { position: Vec3; rotation: Quat | null } | null {
  const { estimates, samples } = track;
  const candidates: RestEstimate[] = [];
  for (
    let i = Math.max(0, indexAt(estimates, startUs));
    i < estimates.length && estimates[i].tUs < endUs;
    i++
  ) {
    candidates.push(estimates[i]);
  }
  if (candidates.length === 0) {
    for (let i = indexAt(samples, startUs); i >= 0; i--) {
      const position = samples[i].position;
      if (position) return { position, rotation: samples[i].rotation };
    }
    return null;
  }
  const m = [0, 1, 2].map((axis) =>
    median(candidates.map((e) => e.position[axis])),
  );
  let best = candidates[0];
  let bestD = Infinity;
  for (const e of candidates) {
    const p = e.position;
    const d = Math.hypot(p[0] - m[0], p[1] - m[1], p[2] - m[2]);
    if (d < bestD) {
      best = e;
      bestD = d;
    }
  }
  return { position: best.position, rotation: best.rotation };
}

/**
 * Where the object rests: its timeline split into stretches where a hand could be touching it and
 * rest stretches where none could, each rest stretch with its one pose. The capture gives the
 * hands and the head; `track` is the object as the scene draws it.
 */
export function restPlan(
  capture: Capture,
  track: RestTrack,
  rule: RestRule = REST_RULE,
): RestPlan {
  const { samples, volume } = track;
  const first = samples.findIndex((s) => s.position !== null);
  if (first < 0) return NO_REST;
  const t0 = samples[first].tUs;
  const last = samples[samples.length - 1].tUs;
  const end = Number.isFinite(track.endUs)
    ? track.endUs
    : Math.max(capture.endUs, last) + 1;
  const step = rule.stepUs;
  const n = Math.max(1, Math.ceil((end - t0) / step));
  const near = new Uint8Array(n);

  for (const [start, stop] of track.held) {
    const a = Math.max(0, Math.ceil((start - t0) / step));
    const b = stop === null ? n : Math.min(n, Math.ceil((stop - t0) / step));
    if (b > a) near.fill(1, a, b);
  }

  const head = new Cursor<PoseSample>(capture.headset()?.samples ?? []);
  const lastTracked: Record<"left" | "right", HandSample | null> = {
    left: null,
    right: null,
  };
  const hands = (["left", "right"] as const).map((side) => ({
    side,
    cursor: new Cursor<HandSample>(capture.hands[side].samples, (s) => {
      if (s.active) lastTracked[side] = s;
    }),
  }));

  let i = first;
  let known = samples[first].position as Vec3;
  for (let k = 0; k < n; k++) {
    const t = t0 + k * step;
    while (i + 1 < samples.length && samples[i + 1].tUs <= t) {
      i++;
      known = samples[i].position ?? known;
    }
    const headAt = head.at(t);
    const headNow =
      headAt && t - headAt.t_us <= rule.frameGapUs
        ? headAt.location.translation
        : null;
    let reach = near[k] === 1;
    for (const { side, cursor } of hands) {
      const hand = cursor.at(t);
      if (reach) continue;
      if (hand && hand.active && t - hand.t_us <= rule.frameGapUs) {
        reach = handWithin(hand, volume, known, rule.contactMarginM, rule);
        continue;
      }
      // Not tracked now: anywhere an arm reaches from the head, and no farther from where it was
      // last tracked than it could have moved since. Either bound alone rules it out.
      if (headNow && distanceTo(volume, known, ...headNow) > rule.armReachM) {
        continue;
      }
      const seen = lastTracked[side];
      reach =
        !seen ||
        handWithin(
          seen,
          volume,
          known,
          rule.contactMarginM + (rule.handSpeedMS * (t - seen.t_us)) / 1e6,
          rule,
        );
    }
    near[k] = reach ? 1 : 0;
  }

  // A short gap in reach is still reach; then a short reach is none.
  closeRuns(near, 0, Math.ceil(rule.minRestUs / step), false);
  closeRuns(near, 1, Math.ceil(rule.minReachUs / step), true);

  const stretches: RestStretch[] = [];
  let k = 0;
  while (k < n) {
    let stop = k;
    while (stop < n && near[stop] === near[k]) stop++;
    if (near[k] === 0) {
      const startUs = t0 + k * step;
      const endUs = stop === n ? Infinity : t0 + stop * step;
      const pose = restPose(track, startUs, endUs);
      if (pose) {
        stretches.push({
          startUs,
          endUs,
          ...pose,
          easeIn: k > 0,
          easeOut: stop < n,
        });
      }
    }
    k = stop;
  }
  return stretches.length === 0 ? NO_REST : { stretches };
}

const smoothstep = (k: number) => {
  const x = Math.min(1, Math.max(0, k));
  return x * x * (3 - 2 * x);
};

/**
 * The rest stretch at `tUs` and how far the drawn position has eased into its pose: 1 at rest, 0
 * at a stretch's eased edge. Null outside every rest stretch.
 */
export function restAt(
  plan: RestPlan,
  tUs: number,
  rule: RestRule = REST_RULE,
): { stretch: RestStretch; weight: number } | null {
  const { stretches } = plan;
  let lo = 0;
  let hi = stretches.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (stretches[mid].startUs <= tUs) lo = mid + 1;
    else hi = mid;
  }
  const stretch = stretches[lo - 1];
  if (!stretch || tUs >= stretch.endUs) return null;
  let weight = 1;
  if (stretch.easeIn) {
    weight = Math.min(
      weight,
      smoothstep((tUs - stretch.startUs) / rule.easeUs),
    );
  }
  if (stretch.easeOut) {
    weight = Math.min(weight, smoothstep((stretch.endUs - tUs) / rule.easeUs));
  }
  return { stretch, weight };
}

/**
 * What the scene draws at `tUs` for an object whose drawn track says `position` and `rotation`:
 * the same while a hand could reach it, its rest pose while none could, and between the two at a
 * stretch's eased edges. The rotation switches halfway through an ease.
 */
export function restedPose(
  plan: RestPlan,
  tUs: number,
  position: Vec3,
  rotation: Quat | null,
  rule: RestRule = REST_RULE,
): { position: Vec3; rotation: Quat | null; resting: boolean } {
  const at = restAt(plan, tUs, rule);
  if (!at) return { position, rotation, resting: false };
  const { stretch, weight: w } = at;
  const r = stretch.position;
  return {
    position:
      w === 1
        ? r
        : [
            position[0] + (r[0] - position[0]) * w,
            position[1] + (r[1] - position[1]) * w,
            position[2] + (r[2] - position[2]) * w,
          ],
    rotation: w >= 0.5 ? stretch.rotation : rotation,
    resting: true,
  };
}

/**
 * The drawn path over the `windowUs` up to `tUs`, as polylines of `points` evenly spaced times in
 * all (the last is `tUs`): where the object was drawn, so a resting object leaves no trail. A time
 * where it is not drawn, or where its position is carried over from before a loss, ends a line.
 */
export function restedTrail(
  track: RestTrack,
  plan: RestPlan,
  tUs: number,
  windowUs: number,
  points: number,
  rule: RestRule = REST_RULE,
): Vec3[][] {
  const { samples } = track;
  const lines: Vec3[][] = [];
  let line: Vec3[] = [];
  const from = tUs - windowUs;
  let i = indexAt(samples, from);
  for (let j = 0; j < points; j++) {
    const t = j === points - 1 ? tUs : from + (windowUs * j) / (points - 1);
    while (i + 1 < samples.length && samples[i + 1].tUs <= t) i++;
    const s = samples[i];
    if (!s?.position || s.lost || t >= track.endUs) {
      if (line.length > 1) lines.push(line);
      line = [];
      continue;
    }
    line.push(restedPose(plan, t, s.position, null, rule).position);
  }
  if (line.length > 1) lines.push(line);
  return lines;
}

const has = (flags: number, bit: number) => (flags & bit) === bit;

/**
 * An object's raw estimates as the scene draws them (object-display.ts): each sample's valid
 * position, or the last valid one while its position is lost. Null for an object with no
 * estimates (a static prop stands still anyway).
 */
export function rawRestTrack(
  capture: Capture,
  entityId: string,
  volume: ObjectVolume,
): RestTrack | null {
  const series = capture.poses.get(entityId);
  if (!series || series.samples.length === 0) return null;
  const samples: TrackSample[] = [];
  const estimates: RestEstimate[] = [];
  let lastValid: Vec3 | null = null;
  for (const s of series.samples) {
    const flags = s.location.location_flags;
    const position = has(flags, POSITION_VALID) ? s.location.translation : null;
    const rotation = has(flags, ORIENTATION_VALID) ? s.location.rotation : null;
    if (position) {
      lastValid = position;
      estimates.push({ tUs: s.t_us, position, rotation });
    }
    samples.push({
      tUs: s.t_us,
      position: lastValid,
      rotation,
      lost: !position,
    });
  }
  const held = capture
    .heldSpans(entityId)
    .map((span) => [span.startUs, span.endUs] as const);
  return { samples, endUs: Infinity, estimates, held, volume };
}

/**
 * An object's compiled series as the scene draws it (compiled-objects.ts): the grid frame in force,
 * nothing where the compile has no position or more than one grid step after the last frame. The
 * rest pose is chosen from `estimates`, the raw estimates the compile resampled; without them, from
 * the grid frames themselves.
 */
export function compiledRestTrack(
  tracks: TracksDoc,
  track: CompiledObjectTrack,
  volume: ObjectVolume,
  estimates: RestEstimate[] | null = null,
): RestTrack | null {
  if (tracks.t.length === 0) return null;
  const samples: TrackSample[] = tracks.t.map((tMs, i) => {
    const p = track.position[i];
    const q = track.orientation[i];
    return {
      tUs: Math.round(tMs * 1000),
      position: p ? rosFromW(p) : null,
      rotation: q ? rosQuatFromW(q) : null,
      lost: false,
    };
  });
  const lastUs = samples[samples.length - 1].tUs;
  const held = track.heldSpans.map(
    (span) =>
      [
        Math.round(span.startT * 1000),
        span.endT === null ? null : Math.round(span.endT * 1000),
      ] as const,
  );
  const fromGrid = (): RestEstimate[] =>
    samples.flatMap((s) =>
      s.position
        ? [{ tUs: s.tUs, position: s.position, rotation: s.rotation }]
        : [],
    );
  return {
    samples,
    endUs: Math.floor(lastUs + 1e6 / tracks.fps) + 1,
    estimates: estimates && estimates.length > 0 ? estimates : fromGrid(),
    held,
    volume,
  };
}

/** An object's drawn track and where it rests. */
export interface ObjectRest {
  track: RestTrack;
  plan: RestPlan;
}

interface RestMemo {
  revision: number;
  tracks: TracksDoc | null;
  shapes: ShapesDoc | null;
  objects: Map<string, ObjectRest | null>;
}

const memo = new WeakMap<Capture, RestMemo>();

/**
 * The object's drawn track and rest plan, from its compiled series when `tracks` has it (as the
 * objects layer draws it then), otherwise from its raw estimates. Worked out once per capture,
 * revision and compiled documents, so the scene and the inspector share it and a frame only looks
 * it up. Null for an object with nothing to hold still.
 */
export function objectRest(
  capture: Capture,
  revision: number,
  entityId: string,
  tracks: TracksDoc | null = null,
  shapes: ShapesDoc | null = null,
): ObjectRest | null {
  let entry = memo.get(capture);
  if (
    !entry ||
    entry.revision !== revision ||
    entry.tracks !== tracks ||
    entry.shapes !== shapes
  ) {
    entry = { revision, tracks, shapes, objects: new Map() };
    memo.set(capture, entry);
  }
  if (entry.objects.has(entityId)) return entry.objects.get(entityId) ?? null;
  const entity = capture.entities.get(entityId);
  let rest: ObjectRest | null = null;
  if (entity && entity.role === "object") {
    const compiled = tracks?.objects.find((o) => o.id === entityId) ?? null;
    const shape = shapes?.objects.find((o) => o.id === entityId) ?? null;
    const volume = objectVolume(
      entity.extensions?.radius_m ?? DEFAULT_RADIUS,
      compiled,
      shape,
    );
    const raw = rawRestTrack(capture, entityId, volume);
    const track =
      tracks && compiled
        ? compiledRestTrack(tracks, compiled, volume, raw?.estimates)
        : raw;
    if (track) rest = { track, plan: restPlan(capture, track) };
  }
  entry.objects.set(entityId, rest);
  return rest;
}

/**
 * The inspector's note while the object is drawn still: an inferred value, with the stretch in
 * its tooltip. Null while a hand could reach it.
 */
export function restRow(
  plan: RestPlan,
  tUs: number,
  rule: RestRule = REST_RULE,
): InspectorRow | null {
  const at = restAt(plan, tUs, rule);
  if (!at) return null;
  const { startUs, endUs } = at.stretch;
  const when = Number.isFinite(endUs)
    ? `from ${formatTime(startUs)} to ${formatTime(endUs)}`
    : `from ${formatTime(startUs)} on`;
  return {
    label: "Shown",
    value: "Still, out of reach",
    basis: "inferred",
    title: `No hand could reach it ${when}, so it is drawn at one recorded position. Position is the newest estimate.`,
  };
}
