import type { NormalizedBox, NormalizedPolygon } from '@clio/protocol';
import {
  composePose,
  cross,
  dot,
  length,
  madd,
  normalize,
  type Pose,
  sub,
  type Vec3,
} from '../../core/math';
import { type CameraModel, pixelRay } from './camera-model';

// Outlines: an object finder's 2D outline (or box) lifted onto a plane through the object that
// faces the camera. The AR layer turns that plane toward the viewer every frame, so the outline
// stays around the real object as the learner moves, and it rides with the object's estimate when
// the object is carried.
//
// An object is rarely at one distance: a tube looked down on has its top nearer than its foot, a
// pen lying on the table its near end nearer than its far one. On one plane its light would be at
// the right depth only at its middle, and each eye (a few cm from the camera) would see the ends
// off the object. Where the depth map sees its surface, that surface is fitted with a plane (its
// relief, fitRelief) and the light is drawn on it instead: every outline point where its camera ray
// meets the relief, so from the camera it covers the same silhouette, and from each eye every part
// of it is as far away as the part of the object behind it.

export type Point2 = [number, number];

/**
 * The object's surface in the outline's frame (x right, y up, z toward the camera; meters about the
 * outline's center): the plane z = offset + slopeX x + slopeY y. An outline point (x, y) belongs
 * where its camera ray, from `distance` m in front of the center, meets it.
 */
export interface Relief {
  offset: number;
  slopeX: number;
  slopeY: number;
  /** How far the camera the outline was seen from is from its center (m), along +z. */
  distance: number;
}

export interface ObjectOutline {
  /** Vertices in meters on the plane through the object: x right, y up as seen from the camera. */
  points: Point2[];
  /** A segmenter's contour, or only a box (drawn as corner brackets). */
  shape: 'contour' | 'box';
  /** Where the object's surface is when it isn't on the outline's plane. */
  relief?: Relief;
}

/** An upright plane: `normal` points at the eye, `right` stays level, `up` completes the frame. */
export interface Billboard {
  right: Vec3;
  up: Vec3;
  normal: Vec3;
}

const UP: Vec3 = [0, 1, 0];

/** The plane through `center` facing `eye`, upright in a +y-up frame (world or workspace). */
export function billboard(center: Readonly<Vec3>, eye: Readonly<Vec3>): Billboard | null {
  const toEye = sub(eye, center);
  if (length(toEye) < 1e-6) return null;
  const normal = normalize(toEye);
  const level = cross(UP, normal);
  // Seen from straight above, "right" is a free choice; keep it along +x.
  const right: Vec3 = length(level) < 1e-6 ? [1, 0, 0] : normalize(level);
  return { right, up: cross(normal, right), normal };
}

/**
 * A billboard point back in 3D: `center` + x·right + y·up, or with a relief, where its camera
 * ray meets that.
 */
export function outlinePoint(
  plane: Billboard,
  center: Readonly<Vec3>,
  p: Point2,
  relief?: Relief | null,
): Vec3 {
  const [x, y, z] = reliefPoint(relief, p);
  return madd(madd(madd(center, plane.right, x), plane.up, y), plane.normal, z);
}

/** The relief's points are kept between half and twice the plane's distance from the camera. */
export const RELIEF_MIN_SCALE = 0.5;
export const RELIEF_MAX_SCALE = 2;

/**
 * Where the camera ray through outline point (x, y) meets `relief`, in the outline's frame; the
 * point itself (z = 0) without one. The glow's vertex shader (glow/shader.ts) does the same.
 */
export function reliefPoint(relief: Relief | null | undefined, [x, y]: Point2): Vec3 {
  if (!relief || !(relief.distance > 0)) return [x, y, 0];
  const { offset, slopeX, slopeY, distance } = relief;
  // The ray from (0, 0, distance) through (x, y, 0), at s along it: (s x, s y, distance (1 - s)).
  const across = distance + slopeX * x + slopeY * y;
  const s =
    across > 0
      ? Math.min(RELIEF_MAX_SCALE, Math.max(RELIEF_MIN_SCALE, (distance - offset) / across))
      : RELIEF_MAX_SCALE;
  return [x * s, y * s, distance * (1 - s)];
}

/** Fewer samples on the object than this fit no relief. */
const RELIEF_MIN_SAMPLES = 6;
/** Samples farther than this from the object's center (m) are the room behind it... */
const RELIEF_REACH_M = 0.3;
/** ...and so are those farther than this in depth (m) from the samples' median. */
const RELIEF_WINDOW_M = 0.12;
/**
 * The slopes are damped as if every direction had at least this spread of samples (m): across a
 * thin object (a tube, a pen) the samples are too close together to tell a tilt from noise.
 */
const RELIEF_SPREAD_M = 0.008;
/** A sample is kept within this of the fitted plane (m), or 2.5 times the fit's RMS if more. */
const RELIEF_INLIER_M = 0.015;
/** Steepest relief (depth change per meter across): about 68° from facing the camera. */
const RELIEF_MAX_SLOPE = 2.5;
/** Furthest the relief's middle is from the outline's plane (m): the plane is the object's. */
const RELIEF_MAX_OFFSET_M = 0.15;

/**
 * The plane of `samples` (world points on the object's surface, from the depth map) in the frame of
 * the outline through `center` that faces `eye`: a robust least-squares fit (the room behind the
 * object left out by distance, then outliers trimmed), its slopes damped across a thin spread and
 * capped. Null with too few samples on the object.
 */
export function fitRelief(
  samples: readonly Vec3[],
  center: Readonly<Vec3>,
  eye: Readonly<Vec3>,
): Relief | null {
  const plane = billboard(center, eye);
  if (!plane) return null;
  const local: Vec3[] = [];
  for (const p of samples) {
    const d = sub(p, center);
    if (length(d) <= RELIEF_REACH_M) {
      local.push([dot(d, plane.right), dot(d, plane.up), dot(d, plane.normal)]);
    }
  }
  if (local.length < RELIEF_MIN_SAMPLES) return null;
  const depths = local.map(([, , z]) => z).sort((a, b) => a - b);
  const median = depths[depths.length >> 1] as number;
  let keep = local.map(([, , z]) => Math.abs(z - median) <= RELIEF_WINDOW_M);
  let fit = fitPlane(local, keep);
  for (let pass = 0; fit && pass < 3; pass++) {
    const { offset, slopeX, slopeY } = fit;
    const residuals = local.map(([x, y, z]) => z - offset - slopeX * x - slopeY * y);
    let sum = 0;
    let n = 0;
    residuals.forEach((r, i) => {
      if (!keep[i]) return;
      sum += r * r;
      n++;
    });
    const band = Math.max(RELIEF_INLIER_M, 2.5 * Math.sqrt(sum / n));
    const next = residuals.map((r) => Math.abs(r) <= band);
    if (next.every((k, i) => k === keep[i])) break;
    keep = next;
    fit = fitPlane(local, keep);
  }
  if (!fit) return null;
  const slope = Math.hypot(fit.slopeX, fit.slopeY);
  const damp = slope > RELIEF_MAX_SLOPE ? RELIEF_MAX_SLOPE / slope : 1;
  return {
    offset: Math.min(RELIEF_MAX_OFFSET_M, Math.max(-RELIEF_MAX_OFFSET_M, fit.offset)),
    slopeX: fit.slopeX * damp,
    slopeY: fit.slopeY * damp,
    distance: length(sub(eye, center)),
  };
}

/** Least squares z = offset + slopeX x + slopeY y over the kept points, slopes damped. */
function fitPlane(
  points: readonly Vec3[],
  keep: readonly boolean[],
): Omit<Relief, 'distance'> | null {
  let n = 0;
  let mx = 0;
  let my = 0;
  let mz = 0;
  points.forEach(([x, y, z], i) => {
    if (!keep[i]) return;
    n++;
    mx += x;
    my += y;
    mz += z;
  });
  if (n < RELIEF_MIN_SAMPLES) return null;
  mx /= n;
  my /= n;
  mz /= n;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  let xz = 0;
  let yz = 0;
  points.forEach(([x, y, z], i) => {
    if (!keep[i]) return;
    const dx = x - mx;
    const dy = y - my;
    const dz = z - mz;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
    xz += dx * dz;
    yz += dy * dz;
  });
  // Ridge: as if each direction had at least RELIEF_SPREAD_M of spread. det > 0 always.
  const ridge = n * RELIEF_SPREAD_M * RELIEF_SPREAD_M;
  const a = xx + ridge;
  const d = yy + ridge;
  const det = a * d - xy * xy;
  const slopeX = (d * xz - xy * yz) / det;
  const slopeY = (a * yz - xy * xz) / det;
  return { offset: mz - slopeX * mx - slopeY * my, slopeX, slopeY };
}

export const boxPolygon = ([x0, y0, x1, y1]: NormalizedBox): NormalizedPolygon => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/**
 * Lift an outline in normalized image coordinates onto the plane through `center` (world space)
 * that faces the camera, as 2D coordinates on that plane. Null when a vertex's ray misses it.
 */
export function liftOutline(
  polygon: readonly (readonly [number, number])[],
  model: CameraModel,
  worldFromHead: Pose,
  center: Readonly<Vec3>,
): Point2[] | null {
  const eye = composePose(worldFromHead, model.headFromCamera).p;
  const plane = billboard(center, eye);
  if (!plane || polygon.length < 3) return null;
  const points: Point2[] = [];
  for (const uv of polygon) {
    const ray = pixelRay(model, uv, worldFromHead);
    const facing = dot(ray.direction, plane.normal);
    if (Math.abs(facing) < 1e-9) return null;
    const s = dot(sub(center, ray.origin), plane.normal) / facing;
    if (s <= 0) return null;
    const offset = sub(madd(ray.origin, ray.direction, s), center);
    points.push([dot(offset, plane.right), dot(offset, plane.up)]);
  }
  return points;
}
