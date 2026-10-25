import { dot, length, madd, scale, sub, type Vec3 } from '../../core/math';
import { billboard, type ObjectOutline, outlinePoint, type Point2 } from './outline';
import type { DepthKind, Placement } from './placement';

// The tracked object's outline, steadied and brought up to date before it is drawn. The tracker
// answers ~25 masks a second, each placed in the room from a frame captured ~60-100 ms earlier,
// and each a little different from the last: the outline jitters around a still object and trails
// a moving one. Here, in world space (so turning the head moves nothing):
//
// - The outline's anchor (the middle of its shape, in the room) goes through a One Euro filter:
//   strong smoothing while it is still, little while it moves. Its distance along the camera's
//   line of sight is noisier than its sideways position, so that part has its own, stronger one.
// - Its shape (meters on the plane facing the camera, about the anchor) is resampled to a fixed
//   number of points, lined up with the last shape, and blended toward the new one by a One Euro
//   rate driven by how fast the shape changes.
// - It is drawn where the object is now: the anchor moved on by its velocity for the time since
//   its frame was captured plus the filter's own lag, at most `predictMs` and `maxSpeed`. The
//   velocity counts only as far as it stands out from its noise, so a still object stays put.
// - A loss is held: the last outline stays (its prediction coasting to a stop) for `holdMs`, and
//   only then fades, so a few missed frames don't blink it.

export interface MotionSmoothingOptions {
  /** Sideways anchor: cutoff while still (Hz). Lower is steadier and laggier. */
  minCutoff: number;
  /** ...rising by this much per m/s of speed (Hz per m/s). Higher follows motion more closely. */
  beta: number;
  /** Velocity estimate's cutoff (Hz). */
  dCutoff: number;
  /** Anchor along the line of sight (depth): cutoff while still (Hz). */
  depthMinCutoff: number;
  /** ...rising by this much per m/s of depth change (Hz per m/s). */
  depthBeta: number;
  /** Shape: cutoff while it holds still (Hz). */
  shapeMinCutoff: number;
  /** ...rising by this much per m/s of mean point speed about the anchor (Hz per m/s). */
  shapeBeta: number;
  /** A contour is resampled to this many points. */
  points: number;
  /** Most the outline is drawn ahead of its frame (ms); 0 turns prediction off. */
  predictMs: number;
  /** Fastest the outline is predicted to move (m/s). */
  maxSpeed: number;
  /** A lost outline stays this long before it fades (ms). */
  holdMs: number;
  /** An anchor this far (m) from the smoothed one starts over there (another object, or a depth fix). */
  snapM: number;
  /** No sample for this long (ms) starts over at the next one. */
  resetAfterMs: number;
}

export const DEFAULT_MOTION_OPTIONS: Readonly<MotionSmoothingOptions> = Object.freeze({
  minCutoff: 0.3,
  beta: 30,
  dCutoff: 1.5,
  depthMinCutoff: 0.2,
  depthBeta: 10,
  shapeMinCutoff: 1.0,
  shapeBeta: 20,
  points: 64,
  predictMs: 120,
  maxSpeed: 1.0,
  holdMs: 400,
  snapM: 0.25,
  resetAfterMs: 1000,
});

/**
 * ?smooth=0 turns smoothing off (null); ?minCutoff=, ?beta=, ?dCutoff=, ?depthMinCutoff=,
 * ?depthBeta=, ?shapeMinCutoff=, ?shapeBeta=, ?points=, ?predictMs=, ?maxSpeed=, ?holdMs=, ?snapM=
 * and ?resetAfterMs= replace the defaults. A value that isn't a non-negative number is ignored.
 */
export function motionOptionsFromParams(params: URLSearchParams): MotionSmoothingOptions | null {
  if (params.get('smooth') === '0') return null;
  const options: MotionSmoothingOptions = { ...DEFAULT_MOTION_OPTIONS };
  for (const key of Object.keys(options) as (keyof MotionSmoothingOptions)[]) {
    const raw = params.get(key);
    const value = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
    if (Number.isFinite(value) && value >= 0) options[key] = value;
  }
  options.points = Math.max(8, Math.round(options.points));
  return options;
}

// ---- One Euro pieces -----------------------------------------------------------------------------

/** A first-order low-pass's blend for one step of `dtS` seconds at `cutoffHz`. */
export function oneEuroAlpha(cutoffHz: number, dtS: number): number {
  if (!(dtS > 0)) return 0;
  if (!(cutoffHz > 0)) return 0;
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtS);
}

/** How far (s) a first-order low-pass at `cutoffHz` trails a steady motion. */
export const filterLagS = (cutoffHz: number): number =>
  cutoffHz > 0 ? 1 / (2 * Math.PI * cutoffHz) : 0;

/** The One Euro filter on one number (Casiez et al. 2012), with the reference's raw derivative. */
export class OneEuroFilter {
  private x: number | null = null;
  private raw = 0;
  private dx = 0;
  private t = 0;

  constructor(
    private readonly minCutoff: number,
    private readonly beta: number,
    private readonly dCutoff = 1,
  ) {}

  /** The filtered value of `x` sampled at `tMs`. */
  filter(x: number, tMs: number): number {
    if (this.x === null || !(tMs > this.t)) {
      if (this.x === null) {
        this.x = x;
        this.raw = x;
        this.t = tMs;
      }
      return this.x;
    }
    const dt = (tMs - this.t) / 1000;
    const dxRaw = (x - this.raw) / dt;
    this.dx += oneEuroAlpha(this.dCutoff, dt) * (dxRaw - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += oneEuroAlpha(cutoff, dt) * (x - this.x);
    this.raw = x;
    this.t = tMs;
    return this.x;
  }

  get value(): number | null {
    return this.x;
  }
}

// ---- prediction ----------------------------------------------------------------------------------

/**
 * How far ahead to draw (ms) for `wantedMs`: itself up to three quarters of `capMs`, then easing
 * into `capMs` (continuous, with a continuous slope), so a lead that keeps growing (a loss) slows
 * to a stop instead of hitting a wall.
 */
export function leadMs(wantedMs: number, capMs: number): number {
  if (!(capMs > 0) || !(wantedMs > 0)) return 0;
  const knee = 0.75 * capMs;
  if (wantedMs <= knee) return wantedMs;
  const room = capMs - knee;
  return knee + room * (1 - Math.exp(-(wantedMs - knee) / room));
}

/**
 * How much of a velocity to trust for prediction, from 0 to 1: its square against the noise of
 * the raw velocities around it (a Wiener-style gain), so a jittering still object isn't pushed
 * around and a steadily moving one is predicted in full.
 */
export function predictionGain(speed: number, noiseVariance: number): number {
  const s2 = speed * speed;
  if (!(s2 > 0)) return 0;
  return s2 / (s2 + Math.max(0, noiseVariance));
}

/** `v`, no longer than `max`. */
export function capSpeed(v: Readonly<Vec3>, max: number): Vec3 {
  const s = length(v);
  return s > max && s > 0 ? scale(v, max / s) : [v[0], v[1], v[2]];
}

// ---- shapes --------------------------------------------------------------------------------------

/** Twice the signed area of a closed polygon: positive when counter-clockwise (x right, y up). */
function signedArea2(points: readonly Point2[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Point2;
    const b = points[(i + 1) % points.length] as Point2;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum;
}

/**
 * A closed polygon as `n` points evenly spaced along its perimeter, starting at its first vertex,
 * counter-clockwise. Null for fewer than three vertices or no perimeter.
 */
export function resampleClosed(points: readonly Point2[], n: number): Point2[] | null {
  if (points.length < 3 || n < 3) return null;
  const ring = signedArea2(points) < 0 ? [...points].reverse() : [...points];
  const m = ring.length;
  const cumulative = [0];
  for (let i = 0; i < m; i++) {
    const a = ring[i] as Point2;
    const b = ring[(i + 1) % m] as Point2;
    cumulative.push((cumulative[i] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const perimeter = cumulative[m] as number;
  if (!(perimeter > 0)) return null;
  const out: Point2[] = [];
  let edge = 0;
  for (let k = 0; k < n; k++) {
    const s = (k / n) * perimeter;
    while (edge < m - 1 && (cumulative[edge + 1] as number) < s) edge++;
    const a = ring[edge] as Point2;
    const b = ring[(edge + 1) % m] as Point2;
    const start = cumulative[edge] as number;
    const span = (cumulative[edge + 1] as number) - start;
    const f = span > 0 ? (s - start) / span : 0;
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  return out;
}

/** `points` rotated (cyclically) to line up best with `reference` (same length). */
export function alignCyclic(points: readonly Point2[], reference: readonly Point2[]): Point2[] {
  const n = points.length;
  if (n !== reference.length || n === 0) return [...points];
  let best = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let shift = 0; shift < n; shift++) {
    let cost = 0;
    for (let i = 0; i < n && cost < bestCost; i++) {
      const p = points[(i + shift) % n] as Point2;
      const r = reference[i] as Point2;
      cost += (p[0] - r[0]) ** 2 + (p[1] - r[1]) ** 2;
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = shift;
    }
  }
  return points.map((_, i) => points[(i + best) % n] as Point2);
}

function mean2(points: readonly Point2[]): Point2 {
  let x = 0;
  let y = 0;
  for (const [px, py] of points) {
    x += px;
    y += py;
  }
  return [x / points.length, y / points.length];
}

// ---- the smoother --------------------------------------------------------------------------------

export interface MotionSample {
  /** What is outlined (the target's name): another one starts over. */
  key: string;
  placement: Placement;
  /** When its frame was captured (performance.now() clock, ms). */
  t: number;
  /** World space: the camera at capture time (the outline's plane faces it). */
  eye: Readonly<Vec3>;
}

export interface MotionFrame {
  placement: Placement;
  /** Bumped whenever the shape changes (a new sample); between them only the center moves. */
  shapeVersion: number;
  /** Holding a lost outline. */
  holding: boolean;
}

export type MotionState = 'idle' | 'tracking' | 'holding' | 'faded';

interface Track {
  key: string;
  t: number;
  eye: Vec3;
  kind: DepthKind;
  shapeKind: ObjectOutline['shape'];
  /** Filtered anchor (world). */
  center: Vec3;
  /** Last raw anchor. */
  raw: Vec3;
  /** Filtered velocity (m/s). */
  velocity: Vec3;
  /** Variance of raw velocity about the filtered one, sideways and along the sight line. */
  noiseLateral: number;
  noiseRadial: number;
  /** Filtered shape about the anchor, and the last raw one (aligned). */
  shape: Point2[];
  rawShape: Point2[];
  /** Each shape point's filtered velocity (m/s), their mean speed, and their residual's variance. */
  shapeVelocity: Point2[];
  shapeSpeed: number;
  shapeNoise: number;
  /** Cutoffs used by the last update (Hz), for prediction lag and stats. */
  cutoffLateral: number;
  cutoffRadial: number;
  cutoffShape: number;
}

const copyTrack = (t: Track): Track => ({
  ...t,
  eye: [...t.eye],
  center: [...t.center],
  raw: [...t.raw],
  velocity: [...t.velocity],
  shape: t.shape.map(([x, y]): Point2 => [x, y]),
  rawShape: t.rawShape.map(([x, y]): Point2 => [x, y]),
  shapeVelocity: t.shapeVelocity.map(([x, y]): Point2 => [x, y]),
});

/** Split `v` into its part along unit `u` and the rest. */
function split(v: Readonly<Vec3>, u: Readonly<Vec3>): { along: Vec3; across: Vec3 } {
  const along = scale(u, dot(v, u));
  return { along, across: sub(v, along) };
}

/** After a loss, the prediction's clock runs on but slows to a stop with this time constant (ms). */
const LOSS_COAST_MS = 60;

export class OutlineMotion {
  private track: Track | null = null;
  /** The track before its last sample, so a re-measured sample of the same frame replaces it. */
  private before: Track | null = null;
  private lostAt: number | null = null;
  private version = 0;
  private snaps = 0;
  private last: { leadMs: number; gain: number; speed: number } = { leadMs: 0, gain: 0, speed: 0 };

  constructor(readonly options: Readonly<MotionSmoothingOptions> = DEFAULT_MOTION_OPTIONS) {}

  /** A newly placed outline. */
  add({ key, placement, t, eye }: MotionSample): void {
    const shape = this.shapeOf(placement.outline);
    if (!shape) return;
    const anchor2 = mean2(shape);
    const relative = shape.map(([x, y]): Point2 => [x - anchor2[0], y - anchor2[1]]);
    const plane = billboard(placement.center, eye);
    if (!plane) return;
    const anchor = outlinePoint(plane, placement.center, anchor2);
    const sample = {
      key,
      t,
      eye: [eye[0], eye[1], eye[2]] as Vec3,
      kind: placement.depth,
      shapeKind: placement.outline.shape,
      anchor,
      relative,
    };

    const previous = this.track;
    if (previous && previous.key === key && t < previous.t) return;
    // The same frame placed again (its distance re-measured) replaces that frame's sample.
    const base = previous && previous.key === key && t === previous.t ? this.before : previous;
    const fresh =
      !base ||
      base.key !== key ||
      (this.lostAt !== null && t - this.lostAt >= this.options.holdMs) ||
      t - base.t > this.options.resetAfterMs ||
      base.shapeKind !== sample.shapeKind ||
      base.shape.length !== relative.length;
    const snapped =
      !fresh && base !== null && length(sub(anchor, base.center)) > this.options.snapM;
    if (snapped) this.snaps++;
    this.lostAt = null;
    this.version++;
    if (fresh || snapped) {
      this.before = null;
      this.track = this.start(sample);
      return;
    }
    this.before = copyTrack(base);
    this.track = this.step(copyTrack(base), sample);
  }

  /** The tracker lost the object (or it couldn't be placed): hold, then fade. */
  lose(now: number): void {
    if (this.track && this.lostAt === null) this.lostAt = now;
  }

  /** Forget everything (the session ended). */
  reset(): void {
    this.track = null;
    this.before = null;
    this.lostAt = null;
    this.last = { leadMs: 0, gain: 0, speed: 0 };
  }

  get state(): MotionState {
    if (!this.track) return 'idle';
    if (this.lostAt === null) return 'tracking';
    return this.faded(performance.now()) ? 'faded' : 'holding';
  }

  /** What to draw at `now` (ms, performance.now() clock); null when nothing should show. */
  at(now: number): MotionFrame | null {
    const track = this.track;
    if (!track || this.faded(now)) return null;
    const { options } = this;
    let elapsed = now - track.t;
    if (this.lostAt !== null) {
      const sinceLoss = Math.max(0, now - this.lostAt);
      elapsed = this.lostAt - track.t + LOSS_COAST_MS * (1 - Math.exp(-sinceLoss / LOSS_COAST_MS));
    }
    const u = sightLine(track.center, track.eye);
    const v = capSpeed(track.velocity, options.maxSpeed);
    const { along, across } = split(v, u);
    const gainLateral = predictionGain(length(across), track.noiseLateral);
    const gainRadial = predictionGain(length(along), track.noiseRadial);
    const leadLateral = leadMs(elapsed + 1000 * filterLagS(track.cutoffLateral), options.predictMs);
    const leadRadial = leadMs(elapsed + 1000 * filterLagS(track.cutoffRadial), options.predictMs);
    const offset = madd(
      scale(across, (gainLateral * leadLateral) / 1000),
      along,
      (gainRadial * leadRadial) / 1000,
    );
    const center = madd(track.center, offset, 1);
    this.last = { leadMs: leadLateral, gain: gainLateral, speed: length(across) };
    return {
      placement: placementAt(center, track),
      shapeVersion: this.version,
      holding: this.lostAt !== null,
    };
  }

  /** What window.__primaryStats shows. */
  get stats() {
    const t = this.track;
    const round = (x: number, places = 3) => Number(x.toFixed(places));
    return {
      state: this.state,
      speed: round(this.last.speed),
      predictGain: round(this.last.gain, 2),
      leadMs: Math.round(this.last.leadMs),
      cutoffHz: t ? round(t.cutoffLateral, 2) : null,
      depthCutoffHz: t ? round(t.cutoffRadial, 2) : null,
      shapeCutoffHz: t ? round(t.cutoffShape, 2) : null,
      snaps: this.snaps,
    };
  }

  private faded(now: number): boolean {
    return this.lostAt !== null && now - this.lostAt >= this.options.holdMs;
  }

  private shapeOf(outline: ObjectOutline): Point2[] | null {
    if (outline.shape === 'box') {
      return outline.points.length >= 3 ? outline.points.map(([x, y]): Point2 => [x, y]) : null;
    }
    return resampleClosed(outline.points, this.options.points);
  }

  private start(s: {
    key: string;
    t: number;
    eye: Vec3;
    kind: DepthKind;
    shapeKind: ObjectOutline['shape'];
    anchor: Vec3;
    relative: Point2[];
  }): Track {
    const { options } = this;
    return {
      key: s.key,
      t: s.t,
      eye: s.eye,
      kind: s.kind,
      shapeKind: s.shapeKind,
      center: [...s.anchor],
      raw: [...s.anchor],
      velocity: [0, 0, 0],
      noiseLateral: 0,
      noiseRadial: 0,
      shape: s.relative.map(([x, y]): Point2 => [x, y]),
      rawShape: s.relative,
      shapeVelocity: s.relative.map((): Point2 => [0, 0]),
      shapeSpeed: 0,
      shapeNoise: 0,
      cutoffLateral: options.minCutoff,
      cutoffRadial: options.depthMinCutoff,
      cutoffShape: options.shapeMinCutoff,
    };
  }

  private step(
    track: Track,
    s: {
      t: number;
      eye: Vec3;
      kind: DepthKind;
      anchor: Vec3;
      relative: Point2[];
    },
  ): Track {
    const { options } = this;
    const dt = Math.max(1e-3, (s.t - track.t) / 1000);
    const aD = oneEuroAlpha(options.dCutoff, dt);

    // Anchor: velocity from raw differences, then sideways and depth filtered separately.
    const u = sightLine(s.anchor, s.eye);
    const rawVelocity = scale(sub(s.anchor, track.raw), 1 / dt);
    const residual = split(sub(rawVelocity, track.velocity), u);
    track.noiseLateral += aD * (dot(residual.across, residual.across) - track.noiseLateral);
    track.noiseRadial += aD * (dot(residual.along, residual.along) - track.noiseRadial);
    track.velocity = madd(track.velocity, sub(rawVelocity, track.velocity), aD);
    const velocity = split(track.velocity, u);
    // A still object's velocity estimate wanders with its jitter (by about the residual's spread
    // after the velocity's own smoothing); only speed beyond that raises the cutoff.
    const wander = aD / (2 - aD);
    const beyond = (speed: number, variance: number) =>
      Math.max(0, speed - Math.sqrt(variance * wander));
    track.cutoffLateral =
      options.minCutoff + options.beta * beyond(length(velocity.across), track.noiseLateral);
    track.cutoffRadial =
      options.depthMinCutoff +
      options.depthBeta * beyond(length(velocity.along), track.noiseRadial);
    const move = split(sub(s.anchor, track.center), u);
    track.center = madd(
      madd(track.center, move.across, oneEuroAlpha(track.cutoffLateral, dt)),
      move.along,
      oneEuroAlpha(track.cutoffRadial, dt),
    );
    track.raw = s.anchor;

    // Shape: line the new one up with the last, then filter each point: its velocity first, and
    // the blend from how fast the points move on average, beyond what their jitter accounts for.
    const shape = track.shapeKind === 'contour' ? alignCyclic(s.relative, track.shape) : s.relative;
    let speed = 0;
    let residual2 = 0;
    for (let i = 0; i < shape.length; i++) {
      const p = shape[i] as Point2;
      const q = track.rawShape[i] as Point2;
      const v = track.shapeVelocity[i] as Point2;
      const vx = (p[0] - q[0]) / dt;
      const vy = (p[1] - q[1]) / dt;
      residual2 += (vx - v[0]) ** 2 + (vy - v[1]) ** 2;
      v[0] += aD * (vx - v[0]);
      v[1] += aD * (vy - v[1]);
      speed += Math.hypot(v[0], v[1]);
    }
    track.shapeNoise += aD * (residual2 / shape.length - track.shapeNoise);
    track.shapeSpeed = speed / shape.length;
    track.cutoffShape =
      options.shapeMinCutoff + options.shapeBeta * beyond(track.shapeSpeed, track.shapeNoise);
    const a = oneEuroAlpha(track.cutoffShape, dt);
    track.shape = track.shape.map(([x, y], i): Point2 => {
      const p = shape[i] as Point2;
      return [x + a * (p[0] - x), y + a * (p[1] - y)];
    });
    track.rawShape = shape;

    track.t = s.t;
    track.eye = s.eye;
    track.kind = s.kind;
    return track;
  }
}

/** The unit vector from the camera to `p`. */
function sightLine(p: Readonly<Vec3>, eye: Readonly<Vec3>): Vec3 {
  const d = sub(p, eye);
  const l = length(d);
  return l > 1e-9 ? scale(d, 1 / l) : [0, 0, -1];
}

/** The track's shape around `center`, on the plane facing its camera. */
function placementAt(center: Vec3, track: Track): Placement {
  const outline: ObjectOutline = {
    points: track.shape.map(([x, y]): Point2 => [x, y]),
    shape: track.shapeKind,
  };
  const plane = billboard(center, track.eye);
  const xs = outline.points.map(([x]) => x);
  const top = Math.max(...outline.points.map(([, y]) => y));
  const labelAt: Point2 = [(Math.min(...xs) + Math.max(...xs)) / 2, top];
  return {
    center,
    outline,
    points: plane ? outline.points.map((p) => outlinePoint(plane, center, p)) : [],
    label: plane ? outlinePoint(plane, center, labelAt) : center,
    depth: track.kind,
  };
}
