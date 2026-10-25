import { composePose, dot, length, madd, type Pose, sub, type Vec3 } from '../../core/math';
import {
  type CameraModel,
  intersectPlaneY,
  pixelRay,
  type Ray,
  type SurfaceCast,
} from './camera-model';
import type { DepthHit, DepthSource } from './depth-source';
import type { SurfaceRaycaster } from './grounding';
import {
  billboard,
  boxPolygon,
  fitRelief,
  liftOutline,
  type ObjectOutline,
  outlinePoint,
  type Relief,
} from './outline';
import { workspaceInFrontOf } from './workspace';

// Where the main object is in the room. The camera saw it along rays from where it was at capture
// time (head pose at the frame, then the camera's offset); the outline must also be at the
// object's real distance along those rays, or it lines up only for the eye next to the camera.
//
// Distance, best first:
//   contact  the ray through the mask's contact point (where the object meets the table or the
//            floor) lands on an upward-facing surface: the object stands there. If the inner
//            point's ray lands on that same surface, the object is lying flat (it is not in the
//            scene mesh, and the table shows under its middle): its middle is there. If the point's
//            ray stops nearer, the object is in front of that surface: its middle is that hit.
//   point    the ray through the mask's inner point meets the depth map (depth sensing sees the
//            object itself, at any distance), or hit-test along it lands on something within reach
//            and no farther than the planes below it (the object itself in the scene mesh). A small
//            object usually isn't in the mesh, so a far hit-test hit is the wall or shelf behind it.
//   surface  the contact ray meets a detected plane, else the level plane a table would be on
//            (45 cm below the head): a guess for a room without a scan, the last resort but one.
//   fixed    a set distance along the point's ray.
// The floor is a surface like any other: a lesson on the carpet stands its objects on it.
// The outline goes on a plane through the object that faces the camera, every vertex on its own
// camera ray, so from the camera (and from both eyes, now that the depth is right) it covers the
// object. Asked for, the rays through a grid inside the outline are measured in the same frame,
// from the depth map only: where it sees the object's surface along them, the outline gets that
// surface's relief (outline.ts), so a long object is lit at its own depth from end to end.

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
  /** Its surface about the outline's plane, where the depth map saw it through the grid rays. */
  relief?: Relief;
  /** World space: where each grid ray asked along met something (any hit); with grid rays only. */
  samples?: Vec3[];
}

export interface Placement {
  /** World space: the object, and the center of its outline's plane. */
  center: Vec3;
  /** The outline on that plane (x right, y up as seen from the camera), with its relief. */
  outline: ObjectOutline;
  /** World space: the outline's vertices, each on its camera ray at the object's distance. */
  points: Vec3[];
  /** World space: the top center of the outline, where the name goes (just above). */
  label: Vec3;
  depth: DepthKind;
  /** World space: the camera the outline was seen from (its plane faces it). */
  eye?: Vec3;
}

/**
 * Real surfaces first, the floor among them, else the plane the lesson's default workspace sits
 * on (level, about 45 cm below the head at capture time).
 */
export function surfaceOrTable(surfaces: SurfaceRaycaster | null, head: Pose): SurfaceCast {
  const tableY = workspaceInFrontOf(head).p[1];
  return (ray) => surfaces?.cast(ray) ?? intersectPlaneY(ray, tableY);
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

/** Even-odd test: whether an image point is inside the polygon (crossings to its left). */
function insidePolygon([x, y]: Uv, polygon: readonly Uv[]): boolean {
  let inside = false;
  let [xj, yj] = polygon[polygon.length - 1] ?? [Number.NaN, Number.NaN];
  for (const [xi, yi] of polygon) {
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    xj = xi;
    yj = yi;
  }
  return inside;
}

/**
 * Camera rays to measure the object's surface along: through a grid of image points inside the
 * outline (the box when there is none), about sqrt(max) cells per side over the outline's bounds,
 * the first `max` of them inside. None when the mask has no outline or box.
 */
export function surfaceRays(mask: ObjectMask, model: CameraModel, head: Pose, max = 24): Ray[] {
  const outline = mask.outline && mask.outline.length >= 3 ? mask.outline : null;
  const polygon = outline ?? (mask.box && boxPolygon([...mask.box]));
  if (!polygon || max < 1) return [];
  const us = polygon.map(([u]) => u);
  const vs = polygon.map(([, v]) => v);
  const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
  const cells = Math.ceil(Math.sqrt(max));
  const rays: Ray[] = [];
  for (let row = 0; row < cells && rays.length < max; row++) {
    const v = v0 + ((row + 0.5) * (v1 - v0)) / cells;
    for (let col = 0; col < cells && rays.length < max; col++) {
      const u = u0 + ((col + 0.5) * (u1 - u0)) / cells;
      if (insidePolygon([u, v], polygon)) rays.push(pixelRay(model, [u, v], head));
    }
  }
  return rays;
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

/** Something to stand on: facing up (a table, a shelf, the floor). */
const isSupport = (hit: DepthHit | null): hit is DepthHit =>
  hit !== null && hit.normal[1] >= SUPPORT_COS;

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
    if (point && point.distance < along - IN_FRONT_M) {
      return { center: point.point, kind: 'point' };
    }
    return { center: standing, kind: 'contact' };
  }
  // The depth map sees the object itself at any distance; the room mesh's far hits are behind it.
  if (point && (point.sensed || point.distance <= reach)) {
    return { center: point.point, kind: 'point' };
  }
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
 * probe), else from `surface`. Null only when the mask has no geometry. `grid` (surfaceRays) is
 * measured alongside, from the depth map only: a distance measured on the object then comes with
 * the grid's hits (`samples`) and the relief of what the depth map saw of its surface.
 */
export async function measureDepth(
  mask: ObjectMask,
  model: CameraModel,
  head: Pose,
  probe: DepthSource | null,
  surface: SurfaceCast,
  grid: readonly Ray[] = [],
): Promise<ObjectDepth | null> {
  const rays = maskRays(mask, model, head);
  if (!rays) return null;
  if (probe) {
    const asked = rays.contact ? [rays.contact, rays.point] : [rays.point];
    // In the same frame, so both are answered from one depth map.
    const [hits, gridHits] = await Promise.all([
      probe.measure(asked),
      grid.length > 0
        ? probe.measure(grid, { mapOnly: true })
        : Promise.resolve<(DepthHit | null)[]>([]),
    ]);
    const contact = rays.contact ? (hits[0] ?? null) : null;
    const point = hits[asked.length - 1] ?? null;
    const below = surface(rays.point);
    const reach = below
      ? Math.min(POINT_REACH_M, Math.hypot(...sub(below, rays.point.origin)) + POINT_PAST_SURFACE_M)
      : POINT_REACH_M;
    const measured = depthFromHits(rays, contact, point, reach);
    if (measured && grid.length > 0) {
      const found = gridHits.filter((hit): hit is DepthHit => hit !== null);
      // Only the depth map sees a small object itself; the room mesh's hits are the room behind.
      const seen = found.flatMap((hit) => (hit.sensed ? [hit.point] : []));
      const relief = fitRelief(seen, measured.center, rays.point.origin);
      return { ...measured, ...(relief ? { relief } : {}), samples: found.map((hit) => hit.point) };
    }
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
  const eye = composePose(head, model.headFromCamera).p;
  const plane = billboard(depth.center, eye);
  if (!points2 || !plane) return null;
  const xs = points2.map(([x]) => x);
  const top = Math.max(...points2.map(([, y]) => y));
  // A relief measured on another frame (a distance reused) is seen from this frame's camera.
  const relief = depth.relief && { ...depth.relief, distance: length(sub(eye, depth.center)) };
  const outline: ObjectOutline = {
    points: points2,
    shape: mask.outline ? 'contour' : 'box',
    ...(relief ? { relief } : {}),
  };
  const labelAt: [number, number] = [(Math.min(...xs) + Math.max(...xs)) / 2, top];
  return {
    center: depth.center,
    outline,
    points: points2.map((p) => outlinePoint(plane, depth.center, p, relief)),
    label: outlinePoint(plane, depth.center, labelAt, relief),
    depth: depth.kind,
    eye,
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
