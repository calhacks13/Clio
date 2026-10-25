import { createLogger } from '../../core/log';
import {
  cross,
  dot,
  invertPose,
  madd,
  normalize,
  type Pose,
  scale,
  sub,
  transformPoint,
  type Vec3,
} from '../../core/math';
import type { Ray } from '../../domain/world/camera-model';
import type { DepthHit, DepthSource } from '../../domain/world/depth-source';

// How far along a world-space ray the real world is, from the WebXR Depth Sensing API: the
// headset's own depth map of whatever is in front of it, hands and hand-held objects included,
// where hit-test (depth.ts) only knows the room's planes and scene mesh.
//
// A depth map belongs to one view (an eye, or a depth camera of its own). A ray from the
// passthrough camera starts a few centimeters from that view, so the depth along it is found by
// marching: points along the ray are projected into the depth view, and the first one that is no
// nearer than the surface the map sees at its pixel is where the ray meets the world. Each read
// is the median of a 3x3 block (the map is noisy), and the crossing is refined by solving for the
// distance at which the ray's depth in the view equals the sensed depth.
//
// Two ways to get the map:
//   cpu-optimized  frame.getDepthInformation(view).getDepthInMeters(x, y)
//   gpu-optimized  XRWebGLBinding.getDepthInformation(view).texture, valid during the frame only.
//                  It is drawn (as meters, packed into RGBA8) into a small render target and read
//                  back asynchronously (a pixel buffer and a fence, collected on a later call). When
//                  the info has depthNear (Quest Browser, IWER) the texture holds window-space
//                  depth; without it the value is raw * rawValueToMeters. Window depth is decoded
//                  with no far plane (d = near / (1 - v)) unless a finite depthFar is reported:
//                  Quest Browser 154 on a Quest 3 reports depthNear 0.1 and depthFar null (measured:
//                  0.926 is 1.36 m, 0.8445 is 0.643 m), a 320x320 'texture-array' with imageIndex 0
//                  (left) / 1 (right), and the depth camera's own projection and transform. IWER
//                  (Meta's Quest emulator) also encodes 1 - near / d but reports depthFar = the
//                  render far plane, so the emulator needs windowFar: 'infinite'.
// Coordinates: CPU normalized view coordinates have their origin at the top left; a GPU texture
// has GL's, at the bottom left. normDepthBufferFromNormView maps either to the buffer.
//
// Diagnostics: DepthSampler.stats counts what each call did (maps asked for, reads started,
// completed and dropped, why an attempt read nothing, the last error), so a headset run that sees
// no depth says why. depth.html puts it on window.clioDepth.

const log = createLogger('depth-sensing');

/** Column-major 4x4, as WebXR hands out projection and rigid-transform matrices. */
export type Mat4 = ArrayLike<number>;
type Ndc = readonly [number, number];

/** What a depth map was taken from: its pose in the world and its projection. */
export interface DepthView {
  worldFromView: Pose;
  projection: Mat4;
}

/** Planar depth (m along the view's -z) the map sees at a point of the view, or null if unknown. */
export type DepthLookup = (ndc: Ndc) => number | null;

// ---- pure geometry -----------------------------------------------------------------------------

const m = (a: Mat4, i: number): number => a[i] ?? 0;

/** Where a world point lands in the view: NDC x, y in [-1, 1] and its planar depth (m, > 0). */
export function projectToView(
  view: DepthView,
  point: Readonly<Vec3>,
): { ndc: [number, number]; depth: number } | null {
  const [x, y, z] = transformPoint(invertPose(view.worldFromView), point);
  if (z >= 0) return null;
  const P = view.projection;
  const w = m(P, 3) * x + m(P, 7) * y + m(P, 11) * z + m(P, 15);
  if (w <= 1e-9) return null;
  const nx = (m(P, 0) * x + m(P, 4) * y + m(P, 8) * z + m(P, 12)) / w;
  const ny = (m(P, 1) * x + m(P, 5) * y + m(P, 9) * z + m(P, 13)) / w;
  if (nx < -1 || nx > 1 || ny < -1 || ny > 1) return null;
  return { ndc: [nx, ny], depth: -z };
}

/** The world point seen at `ndc` at planar depth `depth` (m): the inverse of projectToView. */
export function unprojectFromView(view: DepthView, ndc: Ndc, depth: number): Vec3 | null {
  const P = view.projection;
  const z = -depth;
  const [nx, ny] = ndc;
  const wz = m(P, 11) * z + m(P, 15);
  // nx * w = P0 x + P4 y + P8 z + P12 with w = P3 x + P7 y + P11 z + P15; same for y. Solve for x, y.
  const a1 = m(P, 0) - nx * m(P, 3);
  const b1 = m(P, 4) - nx * m(P, 7);
  const c1 = nx * wz - m(P, 8) * z - m(P, 12);
  const a2 = m(P, 1) - ny * m(P, 3);
  const b2 = m(P, 5) - ny * m(P, 7);
  const c2 = ny * wz - m(P, 9) * z - m(P, 13);
  const det = a1 * b2 - a2 * b1;
  if (Math.abs(det) < 1e-12) return null;
  const x = (c1 * b2 - c2 * b1) / det;
  const y = (a1 * c2 - a2 * c1) / det;
  return transformPoint(view.worldFromView, [x, y, z]);
}

/** NDC to normalized view coordinates, origin at the top left (CPU) or bottom left (GL texture). */
export function ndcToNormView([x, y]: Ndc, originTop: boolean): [number, number] {
  return [(x + 1) / 2, originTop ? (1 - y) / 2 : (y + 1) / 2];
}

/** normDepthBufferFromNormView applied to a 2D point (z = 0, w = 1); identity when null. */
export function applyNormTransform(matrix: Mat4 | null, [u, v]: readonly [number, number]) {
  if (!matrix) return [u, v] as [number, number];
  const w = m(matrix, 3) * u + m(matrix, 7) * v + m(matrix, 15) || 1;
  return [
    (m(matrix, 0) * u + m(matrix, 4) * v + m(matrix, 12)) / w,
    (m(matrix, 1) * u + m(matrix, 5) * v + m(matrix, 13)) / w,
  ] as [number, number];
}

/**
 * Window-space depth (0..1, as written to a depth buffer) to planar meters for a projection with
 * these near and far planes (far may be Infinity). Null for the far plane or invalid values.
 */
export function windowDepthToMeters(w: number, near: number, far: number): number | null {
  if (!(w > 0) || w >= 1 || !(near > 0)) return null;
  if (!Number.isFinite(far)) return near / (1 - w);
  const ndc = 2 * w - 1;
  return (2 * near * far) / (far + near - ndc * (far - near));
}

/** Median of the valid (finite, > 0) values, or null. */
export function median(values: readonly number[]): number | null {
  const ok = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (ok.length === 0) return null;
  const mid = ok.length >> 1;
  return ok.length % 2 ? (ok[mid] ?? null) : ((ok[mid - 1] ?? 0) + (ok[mid] ?? 0)) / 2;
}

/** A depth map in memory: planar meters per pixel (0 or NaN = unknown), row 0 at `originTop`. */
export interface DepthImage {
  width: number;
  height: number;
  meters: Float32Array;
  originTop: boolean;
  /** normDepthBufferFromNormView, or null for identity. */
  normTransform: Mat4 | null;
}

/** Lookup into an image: NDC to buffer pixel, then the median of the 3x3 block around it. */
export function imageLookup(image: DepthImage): DepthLookup {
  const { width, height, meters } = image;
  return (ndc) => {
    const [u, v] = applyNormTransform(image.normTransform, ndcToNormView(ndc, image.originTop));
    if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return null;
    const cx = Math.min(width - 1, Math.floor(u * width));
    const cy = Math.min(height - 1, Math.floor(v * height));
    const block: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx;
        if (x >= 0 && x < width) block.push(meters[y * width + x] ?? Number.NaN);
      }
    }
    return median(block);
  };
}

export interface MarchOptions {
  /** Nearest distance along the ray to consider (m). */
  minM?: number;
  /** Farthest (m). */
  maxM?: number;
  /** Map resolution, for the step between neighbors when estimating the normal. */
  pixels?: number;
}

const MIN_M = 0.1;
const MAX_M = 5;
/** Step along the ray: 1.5% of the distance, at least 5 mm. */
const STEP_FRACTION = 0.015;
const MIN_STEP_M = 0.005;
const REFINE_STEPS = 3;

/**
 * Where `ray` meets the surface the depth map sees: the nearest crossing between minM and maxM,
 * or null where the map has nothing along it. The normal comes from the map's neighborhood.
 */
export function marchRay(
  ray: Ray,
  view: DepthView,
  lookup: DepthLookup,
  { minM = MIN_M, maxM = MAX_M, pixels = 160 }: MarchOptions = {},
): DepthHit | null {
  // The ray's planar depth in the view is linear in t: depth(t) = d0 + t * k.
  const fromWorld = invertPose(view.worldFromView);
  const o = transformPoint(fromWorld, ray.origin);
  const e = transformPoint(fromWorld, madd(ray.origin, ray.direction, 1));
  const d0 = -o[2];
  const k = -(e[2] - o[2]);
  let prev: { t: number; gap: number } | null = null;
  for (let t = minM; t <= maxM; t += Math.max(MIN_STEP_M, t * STEP_FRACTION)) {
    const seen = projectToView(view, madd(ray.origin, ray.direction, t));
    const sensed = seen && lookup(seen.ndc);
    if (!seen || sensed === null) {
      prev = null;
      continue;
    }
    // > 0: this point is still in front of the surface.
    const gap = sensed - seen.depth;
    if (gap > 0) {
      prev = { t, gap };
      continue;
    }
    let hit = prev ? prev.t + ((t - prev.t) * prev.gap) / (prev.gap - gap) : t;
    if (k > 1e-6) {
      for (let i = 0; i < REFINE_STEPS; i++) {
        const at = projectToView(view, madd(ray.origin, ray.direction, hit));
        const d = at && lookup(at.ndc);
        if (d === null || d === undefined) break;
        const next = (d - d0) / k;
        if (!(next > 0) || Math.abs(next - hit) < 1e-4) {
          if (next > 0) hit = next;
          break;
        }
        hit = next;
      }
    }
    const point = madd(ray.origin, ray.direction, hit);
    return {
      point,
      normal: surfaceNormal(view, lookup, point, ray.direction, pixels),
      distance: hit,
      sensed: true,
    };
  }
  return null;
}

/**
 * The surface's normal at `point` from the map around it (two pixels each way), facing back along
 * the ray; straight back along the ray where the neighbors are unknown.
 */
export function surfaceNormal(
  view: DepthView,
  lookup: DepthLookup,
  point: Readonly<Vec3>,
  direction: Readonly<Vec3>,
  pixels = 160,
): Vec3 {
  const back = scale(direction, -1);
  const seen = projectToView(view, point);
  if (!seen) return back;
  const h = 4 / pixels;
  const at = (dx: number, dy: number): Vec3 | null => {
    const ndc: Ndc = [seen.ndc[0] + dx, seen.ndc[1] + dy];
    const d = lookup(ndc);
    return d === null ? null : unprojectFromView(view, ndc, d);
  };
  const right = at(h, 0);
  const left = at(-h, 0);
  const up = at(0, h);
  const down = at(0, -h);
  if (!right || !left || !up || !down) return back;
  const n = cross(sub(right, left), sub(up, down));
  if (Math.hypot(...n) < 1e-9) return back;
  const unit = normalize(n);
  return dot(unit, back) >= 0 ? unit : scale(unit, -1);
}

// ---- session -----------------------------------------------------------------------------------

/** Add to requestSession: the feature (optional) and the preferences. */
export function depthSensingInit(usage: XRDepthUsage[] = ['cpu-optimized', 'gpu-optimized']): {
  optionalFeatures: string[];
  depthSensing: XRDepthStateInit;
} {
  return {
    optionalFeatures: ['depth-sensing'],
    depthSensing: {
      usagePreference: usage,
      dataFormatPreference: ['luminance-alpha', 'float32', 'unsigned-short'],
    },
  };
}

/**
 * The session's depth usage, or null without depth sensing. Reading session.depthUsage on a
 * session that did not enable the feature throws (the spec's InvalidStateError; Quest Browser does
 * when the runtime refused it or it was not asked for), and inside an XR frame that would stop the
 * render loop, so the feature list is checked first; a runtime that lists no features (IWER) gets
 * the benefit of the doubt.
 */
export function depthUsageOf(session: XRSession | null | undefined): XRDepthUsage | null {
  if (!session) return null;
  const features = session.enabledFeatures;
  if (features && !features.includes('depth-sensing')) return null;
  try {
    return session.depthUsage ?? null;
  } catch {
    return null;
  }
}

/**
 * three.js (0.186) turns on depth occlusion by itself whenever the session has gpu-optimized
 * depth (Quest offers nothing else): every frame it draws the sensed depth into the depth buffer
 * before the scene, so anything with depthTest (outlines, labels, panels) disappears wherever a
 * real surface is nearer, including the tracked object's own front, which is in front of an
 * outline placed at its contact plane. Call once, after creating the renderer, to keep the
 * depth map for measuring only. (three still moves the XR cameras' near plane to the map's
 * depthNear, 0.1 m on Quest, which would clip content up close: keepNearPlane, near-plane.ts,
 * holds it at the cameras' own.)
 */
export function disableXrDepthOcclusion(renderer: {
  xr: { getDepthSensingMesh: () => unknown };
}): void {
  renderer.xr.getDepthSensingMesh = () => null;
}

export type WindowFar = 'reported' | 'infinite';

/**
 * The far plane to decode GPU window depth with. With no finite far plane reported (Quest Browser
 * reports depthFar null), always none: d = near / (1 - v). With a finite one, 'reported' uses it
 * (the standard projection three.js's occlusion assumes) and 'infinite' ignores it, IWER's
 * encoding (1 - near / d) although IWER reports depthFar = the render far plane.
 */
export function decodeFarPlane(policy: WindowFar, reported: number | null | undefined): number {
  const finite = typeof reported === 'number' && Number.isFinite(reported) && reported > 0;
  return finite && policy === 'reported' ? reported : Number.POSITIVE_INFINITY;
}

/**
 * The layer of a texture-array depth map that belongs to `eye`: the info's imageIndex, else the
 * eye's index (left 0, right 1), as three.js's occlusion shader assumes. 0 for a plain texture.
 */
export function depthLayer(
  info: { textureType?: string; imageIndex?: number | null },
  eye: XREye,
): number {
  if (info.textureType === 'texture') return 0;
  if (typeof info.imageIndex === 'number') return info.imageIndex;
  return eye === 'right' ? 1 : 0;
}

export type DepthMode = 'cpu' | 'gpu';

/** What the last frame's map was (for the test page and logs). */
export interface DepthInfoSummary {
  mode: DepthMode;
  format: string;
  width: number;
  height: number;
  /** The map has its own view (matchDepthView false), not the eye's. */
  ownView: boolean;
  /** GPU texture values are window depth for these planes; null when raw * rawValueToMeters. */
  near: number | null;
  /** The far plane the info reports. */
  far: number | null;
  /** The far plane the values were decoded with (GPU window depth only). */
  decodeFar: number | null;
  /** Texture-array layer read (GPU only). */
  layer: number | null;
  rawValueToMeters: number;
  /** normDepthBufferFromNormView (column-major), or null when absent or the identity. */
  normTransform: number[] | null;
}

/** What the sampler has done so far: enough to tell from a headset run why there is no depth. */
export interface DepthSamplerStats {
  /** sample() and update() calls. */
  calls: number;
  /** Distinct XRFrame objects seen (a runtime may hand out the same object every frame). */
  frames: number;
  /** getDepthInformation calls (the binding's for GPU maps, the frame's for CPU maps). */
  infoCalls: number;
  /** GPU readbacks started, collected, and dropped because their fence never passed. */
  readsStarted: number;
  readsCompleted: number;
  readsDropped: number;
  /** Attempts that read no map, by reason ('no viewer pose', 'no info', 'invalid', ...). */
  skipped: Record<string, number>;
  lastSkip: string | null;
  errors: number;
  lastError: string | null;
  /** Reads are paused after errors in a row, until this time (ms, the sampler's clock). */
  pausedUntil: number | null;
  /** The sampler made its own XRWebGLBinding after the one it was given failed. */
  ownBinding: boolean;
  /** Planar depth (m) at the center of the last map read, or null. */
  mapCenterM: number | null;
}

export interface DepthSamplerOptions {
  /** The reference space rays are in (the renderer's local-floor). */
  space: XRReferenceSpace;
  /** The WebGL2 context the session renders with; needed for gpu-optimized depth. */
  gl?: WebGL2RenderingContext | null;
  /** XRWebGLBinding to read GPU depth with (e.g. three's renderer.xr.getBinding()). */
  binding?: XRWebGLBinding | null;
  /** Which view's map to use: the passthrough camera Clio streams is the right one. */
  eye?: XREye;
  /**
   * After touching GL state. Not needed with three.js: the readback restores every binding it
   * changes, so three's state cache stays valid (renderer.resetState() would make three rebind
   * everything on the next draw).
   */
  onGlStateChanged?: () => void;
  /** Largest side of the GPU readback (px). */
  maxReadPx?: number;
  /**
   * Decoding GPU window depth when a finite far plane is reported (see decodeFarPlane):
   * 'infinite' for IWER only. Without one (Quest Browser) there is no far plane either way.
   */
  windowFar?: WindowFar;
  /** Frames to wait for a map before answering queued rays with null (default 4 CPU, 8 GPU). */
  maxFrames?: number;
  minM?: number;
  maxM?: number;
  /** Clock (ms), for read timeouts, stale maps and the pause after errors. */
  now?: () => number;
}

interface FrameMap {
  view: DepthView;
  lookup: DepthLookup;
  pixels: number;
  summary: DepthInfoSummary;
  /** When the map was read (the sampler's clock, ms). */
  at: number;
}

interface Queued {
  rays: readonly Ray[];
  resolve(hits: (DepthHit | null)[]): void;
  frames: number;
  /** GPU: maps completed when the rays were queued; any later one answers them. */
  after: number;
}

/** Fields Quest Browser and IWER add to XRWebGLDepthInformation beyond @types/webxr. */
type GpuDepthInfo = XRWebGLDepthInformation & {
  depthNear?: number | null;
  depthFar?: number | null;
  isValid?: boolean;
};

/** Errors in a row before reads pause for RETRY_MS (then they are tried again). */
const MAX_ERRORS = 10;
const RETRY_MS = 2000;
/** A GPU map older than this is not used by sample(). */
const STALE_MS = 500;
/** Distinct error messages logged (each once), so a runtime that keeps failing can't flood the log. */
const MAX_WARNINGS = 8;

const poseOf = (t: XRRigidTransform): Pose => ({
  p: [t.position.x, t.position.y, t.position.z],
  q: [t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w],
});

/** A copy: the runtime's arrays belong to the frame and may be reused or detached after it. */
const copyMatrix = (a: ArrayLike<number>): number[] => Array.from(a);

const isIdentity = (a: ArrayLike<number>): boolean =>
  a.length === 16 && Array.from(a).every((v, i) => v === (i % 5 === 0 ? 1 : 0));

/** The info's own view when it has one (matchDepthView false), else the eye's. */
function depthViewOf(view: XRView, info: XRDepthInformation): { view: DepthView; own: boolean } {
  if (info.transform && info.projectionMatrix) {
    return {
      view: {
        worldFromView: poseOf(info.transform),
        projection: copyMatrix(info.projectionMatrix),
      },
      own: true,
    };
  }
  return {
    view: { worldFromView: poseOf(view.transform), projection: copyMatrix(view.projectionMatrix) },
    own: false,
  };
}

/** normDepthBufferFromNormView as a copy, or null when absent or the identity. */
function normTransformOf(info: XRDepthInformation): number[] | null {
  const matrix = info.normDepthBufferFromNormView?.matrix;
  return matrix && !isIdentity(matrix) ? copyMatrix(matrix) : null;
}

const errorText = (err: unknown): string =>
  err instanceof Error || (typeof DOMException !== 'undefined' && err instanceof DOMException)
    ? `${err.name}: ${err.message}`
    : String(err);

/**
 * Depth along world-space rays from the session's depth maps. Implements the same port as the
 * hit-test probe: measure() answers on a later update(frame). sample() answers at once inside an
 * XR frame callback: from this frame's map (CPU), or from the latest GPU map read back.
 *
 * GPU maps are read back asynchronously: a call draws the texture (valid during that frame only)
 * into a small target and copies it into a pixel buffer with a fence; a later call collects it
 * once the fence has passed, so the frame callback never waits on the GPU. The map keeps the view
 * pose of the frame it was drawn in, so the rays are still projected correctly.
 */
export class DepthSampler implements DepthSource {
  readonly mode: DepthMode;
  /** The last map's description, or null before the first one. */
  info: DepthInfoSummary | null = null;
  readonly stats: DepthSamplerStats = {
    calls: 0,
    frames: 0,
    infoCalls: 0,
    readsStarted: 0,
    readsCompleted: 0,
    readsDropped: 0,
    skipped: {},
    lastSkip: null,
    errors: 0,
    lastError: null,
    pausedUntil: null,
    ownBinding: false,
    mapCenterM: null,
  };
  private readonly queue: Queued[] = [];
  /** CPU: this frame's map. GPU: the latest map read back. */
  private latest: FrameMap | null = null;
  private latestFrame: XRFrame | null = null;
  private lastFrame: XRFrame | null = null;
  private reader: GpuDepthReader<Omit<FrameMap, 'lookup' | 'at'>> | null = null;
  private binding: XRWebGLBinding | null = null;
  private warnedLayer = false;
  private readonly warned = new Set<string>();
  private errorsInRow = 0;
  private closed = false;
  private readonly now: () => number;

  constructor(
    private readonly session: XRSession,
    private readonly options: DepthSamplerOptions,
  ) {
    this.mode = session.depthUsage === 'gpu-optimized' ? 'gpu' : 'cpu';
    this.now = options.now ?? (() => performance.now());
    session.addEventListener('end', () => this.close());
  }

  /** Where `ray` meets the world in the current depth map, or null. */
  sample(frame: XRFrame, ray: Ray): DepthHit | null {
    this.tick(frame);
    let map: FrameMap | null;
    if (this.mode === 'gpu') {
      this.startRead(frame);
      map = this.latest && this.now() - this.latest.at <= STALE_MS ? this.latest : null;
    } else {
      map = this.cpuFrameMap(frame);
    }
    return map ? marchRay(ray, map.view, map.lookup, this.march(map)) : null;
  }

  measure(rays: readonly Ray[]): Promise<(DepthHit | null)[]> {
    if (this.closed || this.paused()) return Promise.resolve(rays.map(() => null));
    return new Promise((resolve) =>
      this.queue.push({ rays, resolve, frames: 0, after: this.stats.readsCompleted }),
    );
  }

  /** Per XR frame (inside the frame callback): answer queued rays from the newest map. */
  update(frame: XRFrame): void {
    this.tick(frame);
    if (this.queue.length === 0) return;
    const gpu = this.mode === 'gpu';
    const map = gpu ? this.latest : this.cpuFrameMap(frame);
    const maxFrames = this.options.maxFrames ?? (gpu ? 8 : 4);
    const paused = this.paused();
    for (const q of [...this.queue]) {
      q.frames++;
      const answer = map !== null && (!gpu || this.stats.readsCompleted > q.after);
      if (!answer && q.frames < maxFrames && !paused) continue;
      this.queue.splice(this.queue.indexOf(q), 1);
      q.resolve(
        q.rays.map((ray) =>
          answer && map ? marchRay(ray, map.view, map.lookup, this.march(map)) : null,
        ),
      );
    }
    // Rays still waiting need a map read after they were asked.
    if (gpu && this.queue.length > 0) this.startRead(frame);
  }

  close(): void {
    this.closed = true;
    for (const q of this.queue.splice(0)) q.resolve(q.rays.map(() => null));
    this.reader?.dispose();
    this.reader = null;
    this.latest = null;
    this.latestFrame = null;
    this.lastFrame = null;
  }

  private march(map: FrameMap): MarchOptions {
    return { minM: this.options.minM, maxM: this.options.maxM, pixels: map.pixels };
  }

  /**
   * Every call: count it, and collect a finished GPU readback. Not only on a new XRFrame object:
   * a runtime that hands out the same object every frame would otherwise leave the read in
   * flight forever, and no new one would start.
   */
  private tick(frame: XRFrame): void {
    this.stats.calls++;
    if (frame !== this.lastFrame) {
      this.lastFrame = frame;
      this.stats.frames++;
    }
    if (this.mode !== 'gpu' || !this.reader?.busy || this.closed) return;
    this.guard(() => {
      const reader = this.reader;
      if (!reader) return;
      let done: ReturnType<typeof reader.poll>;
      try {
        done = reader.poll(this.now());
      } catch (err) {
        this.stats.readsDropped++;
        throw err;
      }
      if (!done) return;
      const { image, tag } = done;
      this.stats.mapCenterM = imageLookup(image)([0, 0]);
      this.install({ ...tag, lookup: imageLookup(image), at: this.now() });
      this.stats.readsCompleted++;
    });
  }

  private install(map: FrameMap): void {
    this.latest = map;
    this.info = map.summary;
  }

  private paused(): boolean {
    const until = this.stats.pausedUntil;
    if (until === null) return false;
    if (this.now() < until) return true;
    this.stats.pausedUntil = null;
    return false;
  }

  private skip(reason: string): void {
    this.stats.skipped[reason] = (this.stats.skipped[reason] ?? 0) + 1;
    this.stats.lastSkip = reason;
  }

  /**
   * Runs a read. Its error is recorded (and logged once per message); after MAX_ERRORS in a row
   * reads pause for RETRY_MS (rays are answered null meanwhile), then they are tried again.
   */
  private guard(read: () => void): void {
    if (this.closed) {
      this.skip('closed');
      return;
    }
    if (this.paused()) {
      this.skip('paused after errors');
      return;
    }
    try {
      read();
      this.errorsInRow = 0;
    } catch (err) {
      const message = errorText(err);
      this.stats.errors++;
      this.stats.lastError = message;
      if (!this.warned.has(message) && this.warned.size < MAX_WARNINGS) {
        this.warned.add(message);
        log.warn(`depth sensing read failed: ${message}`);
      }
      if (++this.errorsInRow >= MAX_ERRORS) {
        this.errorsInRow = 0;
        this.stats.pausedUntil = this.now() + RETRY_MS;
        log.warn(`depth sensing: ${MAX_ERRORS} errors in a row, retrying in ${RETRY_MS} ms`);
      }
    }
  }

  private eyeView(frame: XRFrame): XRView | null {
    const pose = frame.getViewerPose(this.options.space);
    if (!pose) {
      this.skip('no viewer pose');
      return null;
    }
    const eye = this.options.eye ?? 'right';
    const view = pose.views.find((v) => v.eye === eye) ?? pose.views[0] ?? null;
    if (!view) this.skip('no view');
    return view;
  }

  /** This frame's CPU map (read once per frame), or null. */
  private cpuFrameMap(frame: XRFrame): FrameMap | null {
    if (this.latestFrame === frame) return this.latest;
    this.latestFrame = frame;
    this.latest = null;
    this.guard(() => {
      const map = this.cpuMap(frame);
      if (map) this.install(map);
    });
    return this.latest;
  }

  private cpuMap(frame: XRFrame): FrameMap | null {
    const view = this.eyeView(frame);
    if (!view) return null;
    this.stats.infoCalls++;
    const info = frame.getDepthInformation(view);
    if (!info) {
      this.skip('no info');
      return null;
    }
    const { view: depthView, own } = depthViewOf(view, info);
    const du = 1 / info.width;
    const dv = 1 / info.height;
    const lookup: DepthLookup = (ndc) => {
      const [u, v] = ndcToNormView(ndc, true);
      const block: number[] = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = u + dx * du;
          const y = v + dy * dv;
          if (x < 0 || x >= 1 || y < 0 || y >= 1) continue;
          try {
            block.push(info.getDepthInMeters(x, y));
          } catch {
            // Outside the map.
          }
        }
      }
      return median(block);
    };
    const map: FrameMap = {
      view: depthView,
      lookup,
      pixels: Math.max(info.width, info.height),
      at: this.now(),
      summary: {
        mode: 'cpu',
        format: this.session.depthDataFormat ?? 'unknown',
        width: info.width,
        height: info.height,
        ownView: own,
        near: null,
        far: null,
        decodeFar: null,
        layer: null,
        rawValueToMeters: info.rawValueToMeters,
        normTransform: normTransformOf(info),
      },
    };
    this.stats.mapCenterM = lookup([0, 0]);
    return map;
  }

  /**
   * This frame's GPU depth information from the binding. If the binding given to the sampler
   * throws, the sampler tries once with a binding of its own before reporting the error.
   */
  private gpuInfo(view: XRView, gl: WebGL2RenderingContext): GpuDepthInfo | null {
    this.binding ??= this.options.binding ?? this.ownBinding(gl);
    this.stats.infoCalls++;
    try {
      return this.binding.getDepthInformation(view) as GpuDepthInfo | null;
    } catch (err) {
      if (this.stats.ownBinding || typeof XRWebGLBinding === 'undefined') throw err;
      log.warn(
        `depth sensing: the given XRWebGLBinding failed (${errorText(err)}), using a new one`,
      );
      this.binding = this.ownBinding(gl);
      this.stats.infoCalls++;
      return this.binding.getDepthInformation(view) as GpuDepthInfo | null;
    }
  }

  private ownBinding(gl: WebGL2RenderingContext): XRWebGLBinding {
    this.stats.ownBinding = true;
    return new XRWebGLBinding(this.session, gl);
  }

  /** Starts a GPU readback of this frame's map, unless one is in flight. */
  private startRead(frame: XRFrame): void {
    if (this.reader?.busy) {
      this.skip('read in flight');
      return;
    }
    this.guard(() => {
      const { gl } = this.options;
      if (!gl) throw new Error('gpu-optimized depth needs the WebGL2 context');
      const view = this.eyeView(frame);
      if (!view) return;
      const info = this.gpuInfo(view, gl);
      const unusable = !info
        ? 'no info'
        : info.isValid === false
          ? 'invalid'
          : !info.texture
            ? 'no texture'
            : null;
      if (unusable || !info) {
        this.skip(unusable ?? 'no info');
        return;
      }
      if (info.textureType !== 'texture' && typeof info.imageIndex !== 'number') {
        if (!this.warnedLayer) {
          log.warn(`depth texture array without imageIndex: reading the ${view.eye} eye's layer`);
          this.warnedLayer = true;
        }
      }
      const layer = depthLayer(info, view.eye);
      const near = typeof info.depthNear === 'number' && info.depthNear > 0 ? info.depthNear : null;
      const far =
        near !== null && typeof info.depthFar === 'number' && Number.isFinite(info.depthFar)
          ? info.depthFar
          : null;
      const decodeFar =
        near === null ? null : decodeFarPlane(this.options.windowFar ?? 'reported', far);
      const { view: depthView, own } = depthViewOf(view, info);
      const normTransform = normTransformOf(info);
      const maxPx = this.options.maxReadPx ?? 256;
      this.reader ??= new GpuDepthReader(gl);
      this.reader.start(info, layer, near, decodeFar, normTransform, maxPx, this.now(), {
        view: depthView,
        pixels: Math.max(Math.min(info.width, maxPx), Math.min(info.height, maxPx)),
        summary: {
          mode: 'gpu',
          format: this.session.depthDataFormat ?? 'unknown',
          width: info.width,
          height: info.height,
          ownView: own,
          near,
          far,
          decodeFar,
          layer,
          rawValueToMeters: info.rawValueToMeters,
          normTransform,
        },
      });
      this.stats.readsStarted++;
      this.options.onGlStateChanged?.();
    });
  }
}

/**
 * A sampler for the session, or null when depth sensing isn't enabled on it (the runtime refused
 * the optional feature, or it was not requested).
 */
export function createDepthSampler(
  session: XRSession,
  options: DepthSamplerOptions,
): DepthSampler | null {
  const enabled = session.enabledFeatures?.includes('depth-sensing') ?? false;
  if (!enabled) return null;
  if (session.depthUsage === 'gpu-optimized' && !options.gl) {
    log.warn('gpu-optimized depth sensing without a WebGL2 context: not used');
    return null;
  }
  return new DepthSampler(session, options);
}

/**
 * Depth sensing first, hit-test for the rays it can't answer: one port for measureDepth().
 * Either may be null; null when both are.
 */
export function preferDepthSensing(
  sensing: DepthSource | null,
  fallback: DepthSource | null,
): DepthSource | null {
  if (!sensing) return fallback;
  if (!fallback) return sensing;
  return {
    async measure(rays) {
      const sensed = await sensing.measure(rays);
      const missing = rays.flatMap((_, i) => (sensed[i] ? [] : [i]));
      if (missing.length === 0) return sensed;
      const filled = await fallback.measure(missing.map((i) => rays[i] as Ray));
      const out = [...sensed];
      missing.forEach((i, j) => {
        out[i] = filled[j] ?? null;
      });
      return out;
    },
  };
}

// ---- GPU readback ------------------------------------------------------------------------------

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Meters per texel, as millimeters in RGB (24 bits); alpha 0 where unknown. */
const fragment = (array: boolean) => `#version 300 es
precision highp float;
precision highp int;
uniform highp ${array ? 'sampler2DArray' : 'sampler2D'} depthMap;
uniform int layer;
uniform vec2 size;
uniform float near;
uniform float far;
uniform float rawToMeters;
out vec4 color;
void main() {
  vec2 uv = gl_FragCoord.xy / size;
  float raw = texture(depthMap, ${array ? 'vec3(uv, float(layer))' : 'uv'}).r;
  float meters;
  if (near > 0.0) {
    if (raw <= 0.0 || raw >= 1.0) { color = vec4(0.0); return; }
    meters = far > 0.0
      ? (2.0 * near * far) / (far + near - (2.0 * raw - 1.0) * (far - near))
      : near / (1.0 - raw);
  } else {
    meters = raw * rawToMeters;
  }
  if (!(meters > 0.0) || meters > 16000.0) { color = vec4(0.0); return; }
  float mm = floor(meters * 1000.0 + 0.5);
  float r = mod(mm, 256.0);
  float g = mod(floor(mm / 256.0), 256.0);
  float b = floor(mm / 65536.0);
  color = vec4(r / 255.0, g / 255.0, b / 255.0, 1.0);
}`;

/**
 * RGBA8 pixels packed by the shader above, back to meters (0 where unknown). Writes into `out`
 * when it has room for `count` values.
 */
export function unpackMillimeters(
  pixels: Uint8Array,
  count: number,
  out?: Float32Array,
): Float32Array {
  const meters = out && out.length >= count ? out : new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    meters[i] =
      (pixels[o + 3] ?? 0) < 128
        ? 0
        : ((pixels[o] ?? 0) + (pixels[o + 1] ?? 0) * 256 + (pixels[o + 2] ?? 0) * 65536) / 1000;
  }
  return meters;
}

/** How long a readback may stay unsignaled before it is dropped as lost (ms). */
const MAX_PENDING_MS = 1000;

interface PendingRead<T> {
  sync: WebGLSync;
  w: number;
  h: number;
  normTransform: Mat4 | null;
  tag: T;
  startedAt: number;
}

/**
 * Draws the depth texture into a small RGBA8 target and copies it into a pixel buffer behind a
 * fence (start); a later call collects it once the fence has passed (poll). One read in flight.
 * Restores every GL binding and capability it changes. The depth map is sampled as plain values
 * (compare mode NONE, NEAREST filtering): a depth-format texture with comparison or linear
 * filtering would read as 0 or be incomplete.
 */
class GpuDepthReader<T> {
  private programs = new Map<boolean, WebGLProgram>();
  private target: { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number } | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private pbo: WebGLBuffer | null = null;
  private pboBytes = 0;
  private pixels = new Uint8Array(0);
  private meters = new Float32Array(0);
  private pending: PendingRead<T> | null = null;
  /** Flush after each fence: set once a read was dropped unsignaled (nothing else flushed it). */
  private flush = false;

  constructor(private readonly gl: WebGL2RenderingContext) {}

  get busy(): boolean {
    return this.pending !== null;
  }

  start(
    info: GpuDepthInfo,
    layer: number,
    near: number | null,
    far: number | null,
    normTransform: Mat4 | null,
    maxPx: number,
    now: number,
    tag: T,
  ): void {
    const { gl } = this;
    const array = info.textureType !== 'texture';
    const w = Math.max(1, Math.min(info.width, maxPx));
    const h = Math.max(1, Math.min(info.height, maxPx));
    const bytes = w * h * 4;
    const saved = saveState(gl);
    let sync: WebGLSync | null = null;
    try {
      const program = this.program(array);
      const target = this.renderTarget(w, h);
      this.vao ??= gl.createVertexArray();
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
      gl.viewport(0, 0, w, h);
      for (const cap of CAPS(gl)) gl.disable(cap);
      gl.colorMask(true, true, true, true);
      gl.useProgram(program);
      gl.bindVertexArray(this.vao);
      gl.activeTexture(gl.TEXTURE0);
      const kind = array ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D;
      gl.bindTexture(kind, info.texture);
      gl.texParameteri(kind, gl.TEXTURE_COMPARE_MODE, gl.NONE);
      gl.texParameteri(kind, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(kind, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.uniform1i(gl.getUniformLocation(program, 'depthMap'), 0);
      gl.uniform1i(gl.getUniformLocation(program, 'layer'), layer);
      gl.uniform2f(gl.getUniformLocation(program, 'size'), w, h);
      gl.uniform1f(gl.getUniformLocation(program, 'near'), near ?? 0);
      gl.uniform1f(
        gl.getUniformLocation(program, 'far'),
        far !== null && Number.isFinite(far) ? far : 0,
      );
      gl.uniform1f(gl.getUniformLocation(program, 'rawToMeters'), info.rawValueToMeters || 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.pbo ??= gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      if (this.pboBytes !== bytes) {
        gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
        this.pboBytes = bytes;
      }
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!sync) throw new Error('fenceSync failed');
      if (this.flush) gl.flush();
    } finally {
      restoreState(gl, saved);
    }
    this.pending = { sync, w, h, normTransform, tag, startedAt: now };
  }

  /** The finished read, or null while the GPU is still on it. Cheap enough to call often. */
  poll(now: number): { image: DepthImage; tag: T } | null {
    const p = this.pending;
    if (!p) return null;
    const { gl } = this;
    if (gl.getSyncParameter(p.sync, gl.SYNC_STATUS) !== gl.SIGNALED) {
      if (now - p.startedAt <= MAX_PENDING_MS) return null;
      gl.deleteSync(p.sync);
      this.pending = null;
      this.flush = true;
      throw new Error(`depth readback not finished after ${MAX_PENDING_MS} ms`);
    }
    gl.deleteSync(p.sync);
    this.pending = null;
    const count = p.w * p.h;
    if (this.pixels.length !== count * 4) this.pixels = new Uint8Array(count * 4);
    const previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.pixels, 0, count * 4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous);
    // One buffer, reused: only the latest map is ever looked up.
    if (this.meters.length !== count) this.meters = new Float32Array(count);
    unpackMillimeters(this.pixels, count, this.meters);
    return {
      image: {
        width: p.w,
        height: p.h,
        meters: this.meters,
        originTop: false,
        normTransform: p.normTransform,
      },
      tag: p.tag,
    };
  }

  dispose(): void {
    const { gl } = this;
    if (this.pending) gl.deleteSync(this.pending.sync);
    this.pending = null;
    for (const p of this.programs.values()) gl.deleteProgram(p);
    this.programs.clear();
    if (this.target) {
      gl.deleteFramebuffer(this.target.fb);
      gl.deleteTexture(this.target.tex);
    }
    this.target = null;
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.vao = null;
    if (this.pbo) gl.deleteBuffer(this.pbo);
    this.pbo = null;
    this.pboBytes = 0;
  }

  private program(array: boolean): WebGLProgram {
    const known = this.programs.get(array);
    if (known) return known;
    const { gl } = this;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('createShader failed');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`depth shader: ${gl.getShaderInfoLog(shader) ?? 'compile failed'}`);
      }
      return shader;
    };
    const program = gl.createProgram();
    const vs = compile(gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl.FRAGMENT_SHADER, fragment(array));
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`depth program: ${gl.getProgramInfoLog(program) ?? 'link failed'}`);
    }
    this.programs.set(array, program);
    return program;
  }

  private renderTarget(w: number, h: number) {
    const { gl } = this;
    if (this.target && this.target.w === w && this.target.h === h) return this.target;
    if (this.target) {
      gl.deleteFramebuffer(this.target.fb);
      gl.deleteTexture(this.target.tex);
    }
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('depth readback framebuffer is incomplete');
    }
    this.target = { fb, tex, w, h };
    return this.target;
  }
}

const CAPS = (gl: WebGL2RenderingContext) => [
  gl.SCISSOR_TEST,
  gl.DEPTH_TEST,
  gl.STENCIL_TEST,
  gl.BLEND,
  gl.CULL_FACE,
  gl.RASTERIZER_DISCARD,
];

interface GlState {
  drawFb: WebGLFramebuffer | null;
  readFb: WebGLFramebuffer | null;
  viewport: Int32Array;
  program: WebGLProgram | null;
  vao: WebGLVertexArrayObject | null;
  activeTexture: number;
  tex2d: WebGLTexture | null;
  texArray: WebGLTexture | null;
  packBuffer: WebGLBuffer | null;
  caps: [number, boolean][];
  colorMask: boolean[];
  packAlignment: number;
}

function saveState(gl: WebGL2RenderingContext): GlState {
  const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
  gl.activeTexture(gl.TEXTURE0);
  const state: GlState = {
    drawFb: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
    readFb: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
    viewport: gl.getParameter(gl.VIEWPORT),
    program: gl.getParameter(gl.CURRENT_PROGRAM),
    vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
    activeTexture,
    tex2d: gl.getParameter(gl.TEXTURE_BINDING_2D),
    texArray: gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY),
    packBuffer: gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING),
    caps: CAPS(gl).map((c) => [c, gl.isEnabled(c)]),
    colorMask: gl.getParameter(gl.COLOR_WRITEMASK),
    packAlignment: gl.getParameter(gl.PACK_ALIGNMENT),
  };
  gl.activeTexture(activeTexture);
  return state;
}

function restoreState(gl: WebGL2RenderingContext, s: GlState): void {
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, s.drawFb);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, s.readFb);
  gl.viewport(s.viewport[0] ?? 0, s.viewport[1] ?? 0, s.viewport[2] ?? 0, s.viewport[3] ?? 0);
  gl.useProgram(s.program);
  gl.bindVertexArray(s.vao);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, s.tex2d);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, s.texArray);
  gl.activeTexture(s.activeTexture);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.packBuffer);
  for (const [cap, on] of s.caps) {
    if (on) gl.enable(cap);
    else gl.disable(cap);
  }
  const [r = true, g = true, b = true, a = true] = s.colorMask;
  gl.colorMask(r, g, b, a);
  gl.pixelStorei(gl.PACK_ALIGNMENT, s.packAlignment);
}
