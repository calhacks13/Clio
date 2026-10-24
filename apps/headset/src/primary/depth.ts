import { createLogger } from '../core/log';
import { dot, madd, rotateVec, sub, type Vec3 } from '../core/math';
import type { Ray } from '../domain/world/camera-model';

// How far along a camera ray the real world is, from WebXR hit-test against the room's geometry
// (Quest's room setup: planes and the scene mesh; IWER's synthetic room on desktop). The outline
// has to sit at the object's real distance: the camera sees from one point, near one eye, so an
// outline on the right ray but at the wrong depth lines up for that eye only.
//
// Rays are fixed in world space (the head pose when the frame was captured), so each one gets its
// own hit-test source in the reference space, read on the next frames and cancelled at once. To
// keep sources few, a recent answer is reused for a ray that passes through the same spot (a
// still object seen from a still head), and a ray already being measured is not asked twice.

const log = createLogger('depth');

export interface DepthHit {
  /** World space (the probe's reference space), on the ray. */
  point: Vec3;
  /** Unit normal of the surface that was hit. */
  normal: Vec3;
  /** Meters along the ray from its origin. */
  distance: number;
}

/** Port: hits along world-space rays. */
export interface DepthSource {
  /** One answer per ray, in order: the nearest hit, or null where the ray meets nothing known. */
  measure(rays: readonly Ray[]): Promise<(DepthHit | null)[]>;
}

export interface DepthProbeOptions {
  /** Reuse a hit for a new ray that passes this close to it (m). */
  reuseRadiusM?: number;
  /** ...if it was measured this recently (ms). */
  reuseMs?: number;
  /** Frames to wait for a new source's results before calling the ray a miss. */
  maxFrames?: number;
  /** Rays measured at once; more are answered null (the caller falls back to planes). */
  maxInFlight?: number;
  now?: () => number;
}

const DEFAULTS: Required<DepthProbeOptions> = {
  reuseRadiusM: 0.01,
  reuseMs: 300,
  maxFrames: 4,
  maxInFlight: 4,
  now: () => performance.now(),
};

/** Rays this alike (origins within 2 cm, directions within about 1°) are measured once. */
const SAME_ORIGIN_M = 0.02;
const SAME_DIRECTION_COS = Math.cos((1 * Math.PI) / 180);
const RECENT = 8;

interface Measured {
  ray: Ray;
  hit: DepthHit | null;
  t: number;
}

interface Pending {
  ray: Ray;
  promise: Promise<DepthHit | null>;
  resolve(hit: DepthHit | null): void;
  source: XRHitTestSource | null;
  frames: number;
  done: boolean;
}

const alike = (a: Ray, b: Ray): boolean =>
  dot(a.direction, b.direction) >= SAME_DIRECTION_COS &&
  Math.hypot(...sub(a.origin, b.origin)) <= SAME_ORIGIN_M;

/** A hit moved onto `ray`: the point on it closest to the hit, or null if that is behind it. */
function onRay(ray: Ray, hit: DepthHit): DepthHit | null {
  const distance = dot(sub(hit.point, ray.origin), ray.direction);
  return distance > 0
    ? { point: madd(ray.origin, ray.direction, distance), normal: hit.normal, distance }
    : null;
}

/** Distance from a point to the line of a ray. */
function offRay(ray: Ray, p: Readonly<Vec3>): number {
  const toP = sub(p, ray.origin);
  const along = dot(toP, ray.direction);
  return Math.hypot(...madd(toP, ray.direction, -along));
}

function cancel(source: XRHitTestSource | null): void {
  try {
    source?.cancel();
  } catch {
    // Already cancelled along with its session.
  }
}

/**
 * Hit-test along world-space rays. Call update() on every XR frame; measure() answers on a later
 * frame (or at once from a recent answer).
 */
export class XrDepthProbe implements DepthSource {
  private readonly options: Required<DepthProbeOptions>;
  private readonly pending = new Set<Pending>();
  private recent: Measured[] = [];
  /** Asked for first; dropped if the runtime refuses it (the default is planes only). */
  private entityTypes: XRHitTestTrackableType[] | null = ['plane', 'mesh'];
  private broken = false;
  private closed = false;

  constructor(
    private readonly session: XRSession,
    private readonly space: XRReferenceSpace,
    options: DepthProbeOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
    session.addEventListener('end', () => this.close());
  }

  measure(rays: readonly Ray[]): Promise<(DepthHit | null)[]> {
    return Promise.all(rays.map((ray) => this.measureOne(ray)));
  }

  /** Per XR frame: collect the answers for rays being measured. */
  update(frame: XRFrame): void {
    for (const p of this.pending) {
      if (!p.source) continue;
      let hit: DepthHit | null = null;
      for (const result of frame.getHitTestResults(p.source)) {
        hit = this.hitFrom(result, p.ray);
        if (hit) break;
      }
      p.frames++;
      if (hit || p.frames >= this.options.maxFrames) this.finish(p, hit);
    }
  }

  /** Drop every source; rays still being measured are answered null. */
  close(): void {
    this.closed = true;
    for (const p of this.pending) this.finish(p, null);
  }

  private measureOne(ray: Ray): Promise<DepthHit | null> {
    const known = this.reuse(ray);
    if (known) return Promise.resolve(known.hit && onRay(ray, known.hit));
    for (const p of this.pending) {
      if (alike(p.ray, ray)) return p.promise.then((hit) => hit && onRay(ray, hit));
    }
    if (this.closed || this.broken || this.pending.size >= this.options.maxInFlight) {
      return Promise.resolve(null);
    }
    let resolve: (hit: DepthHit | null) => void = () => {};
    const promise = new Promise<DepthHit | null>((r) => {
      resolve = r;
    });
    const p: Pending = { ray, promise, resolve, source: null, frames: 0, done: false };
    this.pending.add(p);
    void this.start(p);
    return promise;
  }

  /** A recent answer that holds for `ray`: a hit it passes through, or a miss along the same ray. */
  private reuse(ray: Ray): Measured | null {
    const now = this.options.now();
    this.recent = this.recent.filter((m) => now - m.t <= this.options.reuseMs);
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const m = this.recent[i];
      if (!m) continue;
      if (m.hit ? offRay(ray, m.hit.point) <= this.options.reuseRadiusM : alike(m.ray, ray)) {
        return m;
      }
    }
    return null;
  }

  private async start(p: Pending): Promise<void> {
    try {
      const source = await this.request(p.ray);
      // The probe may have closed, or given up on the ray, while the source was being created.
      if (p.done) cancel(source);
      else p.source = source;
    } catch (err) {
      if (!this.broken) log.warn(`hit-test unavailable, using planes: ${String(err)}`);
      this.broken = true;
      this.finish(p, null);
    }
  }

  private async request(ray: Ray): Promise<XRHitTestSource> {
    const [ox, oy, oz] = ray.origin;
    const [dx, dy, dz] = ray.direction;
    const offsetRay = new XRRay({ x: ox, y: oy, z: oz, w: 1 }, { x: dx, y: dy, z: dz, w: 0 });
    const init: XRHitTestOptionsInit = { space: this.space, offsetRay };
    if (!this.entityTypes) return this.requestSource(init);
    try {
      return await this.requestSource({ ...init, entityTypes: this.entityTypes });
    } catch {
      this.entityTypes = null;
      return this.requestSource(init);
    }
  }

  private async requestSource(init: XRHitTestOptionsInit): Promise<XRHitTestSource> {
    const source = await this.session.requestHitTestSource?.(init);
    if (!source) throw new Error('requestHitTestSource is missing');
    return source;
  }

  private hitFrom(result: XRHitTestResult, ray: Ray): DepthHit | null {
    const pose = result.getPose(this.space);
    if (!pose) return null;
    const { position: p, orientation: q } = pose.transform;
    // A hit pose's +y is the surface normal.
    const normal = rotateVec([q.x, q.y, q.z, q.w], [0, 1, 0]);
    return onRay(ray, { point: [p.x, p.y, p.z], normal, distance: 0 });
  }

  private finish(p: Pending, hit: DepthHit | null): void {
    if (p.done) return;
    p.done = true;
    this.pending.delete(p);
    cancel(p.source);
    if (!this.closed) {
      this.recent.push({ ray: p.ray, hit, t: this.options.now() });
      if (this.recent.length > RECENT) this.recent.shift();
    }
    p.resolve(hit);
  }
}

/** A probe for the session, or null when it has no hit-test (placement then uses planes). */
export function createDepthProbe(
  session: XRSession,
  space: XRReferenceSpace,
  options?: DepthProbeOptions,
): XrDepthProbe | null {
  const enabled = session.enabledFeatures?.includes('hit-test') ?? true;
  if (!enabled || !session.requestHitTestSource || typeof XRRay === 'undefined') return null;
  return new XrDepthProbe(session, space, options);
}
