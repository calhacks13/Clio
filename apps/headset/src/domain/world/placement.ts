import { composePose, dot, madd, type Pose, sub, type Vec3 } from '../../core/math';
import {
  type CameraModel,
  intersectPlaneY,
  pixelRay,
  type Ray,
  type SurfaceCast,
} from './camera-model';
import type { DepthHit, DepthSource } from './depth-source';
import type { SurfaceRaycaster } from './grounding';
import { billboard, boxPolygon, liftOutline, type ObjectOutline, outlinePoint } from './outline';
import { workspaceInFrontOf } from './workspace';

// Where the main object is in the room. The camera saw it along rays from where it was at capture
// time (head pose at the frame, then the camera's offset); the outline must also be at the
// object's real distance along those rays, or it lines up only for the eye next to the camera.
//
// Distance, best first:
//   contact  hit-test along the ray through the mask's contact point (where the object meets the
//            table) lands on an upward-facing surface: the object stands there. If the inner
//            point's ray lands on that same surface, the object is lying flat (it is not in the
//            scene mesh, and the table shows under its middle): its middle is there. If the point's
//            ray stops nearer, the object is in front of that surface: its middle is that hit.
//   point    hit-test along the ray through the mask's inner point lands on something within reach
//            and no farther than the planes below it (the object itself in the scene mesh). A small
//            object usually isn't in the mesh, so a far hit is the wall or shelf behind it.
//   surface  the contact ray meets a detected plane, else the level plane a table would be on.
//   fixed    a set distance along the point's ray.
// The outline goes on a plane through the object that faces the camera, every vertex on its own
// camera ray, so from the camera (and from both eyes, now that the depth is right) it covers the
// object.

/**
 * Hits lower than this (m above the floor; local-floor puts it at y = 0) are the floor, which
 * every room setup has. The demo object sits on a table, so a ray that misses the room's tables
 * and reaches the floor means the table isn't in room setup, not that the object is on the floor.
 */
const FLOOR_CLEARANCE_M = 0.3;
/** A hit whose normal is within this of straight up is something an object can stand on. */
const SUPPORT_COS = Math.cos((30 * Math.PI) / 180);
/** The last resort's distance along the point's ray (m): about arm's length. */
const FIXED_DEPTH_M = 0.6;
/** A point-ray hit farther than this (m) is behind the object, not on it: past arm's reach. */
const POINT_REACH_M = 1.5;
/** ...or farther than this (m) beyond where the point's ray meets the planes below it. */
const POINT_PAST_SURFACE_M = 0.15;
/** Two hits this close in height (m) are on the same surface. */
const SAME_SURFACE_M = 0.03;
/** The point's ray stopping this much nearer (m) than the standing object means it hit something. */
const IN_FRONT_M = 0.03;

type Uv = readonly [number, number];

/** A segmenter's or finder's answer in normalized image coordinates (origin top left). */
export interface ObjectMask {
  /** A point well inside the object. */
  point: Uv | null;
  /** [left, top, right, bottom]. */
  box: readonly [number, number, number, number] | null;
  outline: readonly Uv[] | null;
  /** Where the object meets the surface under it; defaults to the box's bottom center. */
  contact?: Uv | null;
}

export type DepthKind = 'contact' | 'point' | 'surface' | 'fixed';

/** How far the object is: the point the outline's plane passes through. */
export interface ObjectDepth {
  /** World space. */
  center: Vec3;
  kind: DepthKind;
}

export interface Placement {
  /** World space: the object, and the center of its outline's plane. */
  center: Vec3;
  /** The outline on that plane (x right, y up as seen from the camera). */
  outline: ObjectOutline;
  /** World space: the outline's vertices, each on its camera ray at the object's distance. */
  points: Vec3[];
  /** World space: the top center of the outline, where the name goes (just above). */
  label: Vec3;
  depth: DepthKind;
}

/**
 * Real surfaces above the floor first, else the plane the lesson's default workspace sits on
 * (level, about 45 cm below the head at capture time).
 */
export function surfaceOrTable(surfaces: SurfaceRaycaster | null, head: Pose): SurfaceCast {
  const tableY = workspaceInFrontOf(head).p[1];
  return (ray) => {
    const hit = surfaces?.cast(ray);
    return hit && hit[1] >= FLOOR_CLEARANCE_M ? hit : intersectPlaneY(ray, tableY);
  };
}

const boxCenter = ([x0, y0, x1, y1]: NonNullable<ObjectMask['box']>): Uv => [
  (x0 + x1) / 2,
  (y0 + y1) / 2,
];

const bottomCenter = ([x0, , x1, y1]: NonNullable<ObjectMask['box']>): Uv => [(x0 + x1) / 2, y1];

function centroid(outline: readonly Uv[]): Uv | null {
  if (outline.length === 0) return null;
  const sum = outline.reduce<[number, number]>((s, [x, y]) => [s[0] + x, s[1] + y], [0, 0]);
  return [sum[0] / outline.length, sum[1] / outline.length];
}

/** The image points to measure along: the object's inner point and its contact with a surface. */
export function maskRays(
  mask: ObjectMask,
  model: CameraModel,
  head: Pose,
): { point: Ray; contact: Ray | null } | null {
  const point = mask.point ?? (mask.box && boxCenter(mask.box)) ?? centroid(mask.outline ?? []);
  if (!point) return null;
  const contact = mask.contact ?? (mask.box && bottomCenter(mask.box));
  return {
    point: pixelRay(model, point, head),
    contact: contact ? pixelRay(model, contact, head) : null,
  };
}

/** The point on `ray` straight above (or below) `base`: an object standing at its base. */
function standingAt(ray: Ray, base: Readonly<Vec3>): Vec3 {
  const dh: Vec3 = [ray.direction[0], 0, ray.direction[2]];
  const dh2 = dot(dh, dh);
  if (dh2 < 1e-9) return [base[0], base[1], base[2]];
  const toBase: Vec3 = [base[0] - ray.origin[0], 0, base[2] - ray.origin[2]];
  const s = dot(toBase, dh) / dh2;
  if (s <= 0) return [base[0], base[1], base[2]];
  return [base[0], madd(ray.origin, ray.direction, s)[1], base[2]];
}

const aboveFloor = (hit: DepthHit | null): hit is DepthHit =>
  hit !== null && hit.point[1] >= FLOOR_CLEARANCE_M;

/** Something to stand on: above the floor and facing up. */
const isSupport = (hit: DepthHit | null): hit is DepthHit =>
  aboveFloor(hit) && hit.normal[1] >= SUPPORT_COS;

/**
 * From hit-test answers along the contact and point rays, or null when neither will do. A point
 * hit alone counts only within `reach` (m along the point's ray).
 */
export function depthFromHits(
  rays: { point: Ray; contact: Ray | null },
  contact: DepthHit | null,
  point: DepthHit | null,
  reach = POINT_REACH_M,
): ObjectDepth | null {
  if (rays.contact && isSupport(contact)) {
    if (isSupport(point) && Math.abs(point.point[1] - contact.point[1]) <= SAME_SURFACE_M) {
      return { center: point.point, kind: 'contact' };
    }
    const standing = standingAt(rays.point, contact.point);
    const along = dot(sub(standing, rays.point.origin), rays.point.direction);
    if (aboveFloor(point) && point.distance < along - IN_FRONT_M) {
      return { center: point.point, kind: 'point' };
    }
    return { center: standing, kind: 'contact' };
  }
  if (aboveFloor(point) && point.distance <= reach) return { center: point.point, kind: 'point' };
  return null;
}

/** Where the contact ray meets a surface, else where the point ray does, else a fixed distance. */
export function depthFromSurface(
  rays: { point: Ray; contact: Ray | null },
  surface: SurfaceCast,
): ObjectDepth {
  const base = rays.contact && surface(rays.contact);
  if (base) return { center: standingAt(rays.point, base), kind: 'surface' };
  const center = surface(rays.point);
  if (center) return { center, kind: 'surface' };
  return { center: madd(rays.point.origin, rays.point.direction, FIXED_DEPTH_M), kind: 'fixed' };
}

/**
 * How far the object in `mask` is, measured along its camera rays with hit-test (when there is a
 * probe), else from `surface`. Null only when the mask has no geometry.
 */
export async function measureDepth(
  mask: ObjectMask,
  model: CameraModel,
  head: Pose,
  probe: DepthSource | null,
  surface: SurfaceCast,
): Promise<ObjectDepth | null> {
  const rays = maskRays(mask, model, head);
  if (!rays) return null;
  if (probe) {
    const asked = rays.contact ? [rays.contact, rays.point] : [rays.point];
    const hits = await probe.measure(asked);
    const contact = rays.contact ? (hits[0] ?? null) : null;
    const point = hits[asked.length - 1] ?? null;
    const below = surface(rays.point);
    const reach = below
      ? Math.min(POINT_REACH_M, Math.hypot(...sub(below, rays.point.origin)) + POINT_PAST_SURFACE_M)
      : POINT_REACH_M;
    const measured = depthFromHits(rays, contact, point, reach);
    if (measured) return measured;
  }
  return depthFromSurface(rays, surface);
}

/**
 * The outline at the object's distance: on the plane through `depth.center` that faces the camera,
 * every vertex on its own camera ray. Null when the mask has no outline or box, or a vertex's ray
 * misses the plane.
 */
export function placeOutline(
  mask: ObjectMask,
  head: Pose,
  model: CameraModel,
  depth: ObjectDepth,
): Placement | null {
  const polygon = mask.outline ?? (mask.box && boxPolygon([...mask.box]));
  const points2 = polygon && liftOutline(polygon, model, head, depth.center);
  const plane = billboard(depth.center, composePose(head, model.headFromCamera).p);
  if (!points2 || !plane) return null;
  const xs = points2.map(([x]) => x);
  const top = Math.max(...points2.map(([, y]) => y));
  return {
    center: depth.center,
    outline: { points: points2, shape: mask.outline ? 'contour' : 'box' },
    points: points2.map((p) => outlinePoint(plane, depth.center, p)),
    label: outlinePoint(plane, depth.center, [(Math.min(...xs) + Math.max(...xs)) / 2, top]),
    depth: depth.kind,
  };
}

/**
 * Without hit-test: depth from where the box's bottom meets `surface`. Null when the detection's
 * rays miss every surface (e.g. it is above the horizon).
 */
export function placeDetection(
  detection: ObjectMask,
  model: CameraModel,
  head: Pose,
  surface: SurfaceCast,
): Placement | null {
  const rays = maskRays(detection, model, head);
  const depth = rays && depthFromSurface(rays, surface);
  return depth && depth.kind !== 'fixed' ? placeOutline(detection, head, model, depth) : null;
}
