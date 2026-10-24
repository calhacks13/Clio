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

export type Point2 = [number, number];

export interface ObjectOutline {
  /** Vertices in meters on the plane through the object: x right, y up as seen from the camera. */
  points: Point2[];
  /** A segmenter's contour, or only a box (drawn as corner brackets). */
  shape: 'contour' | 'box';
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

/** A billboard point back in 3D: `center` + x·right + y·up. */
export function outlinePoint(plane: Billboard, center: Readonly<Vec3>, [x, y]: Point2): Vec3 {
  return madd(madd(center, plane.right, x), plane.up, y);
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
