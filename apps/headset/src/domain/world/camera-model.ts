import {
  composePose,
  dot,
  madd,
  normalize,
  type Pose,
  rotateVec,
  type Vec3,
} from '../../core/math';

// Pinhole model of a passthrough camera, and the geometry that lifts a 2D detection into 3D.
// Image coordinates are normalized 0..1 (x right, y down). The camera frame follows WebXR: x right,
// y up, looking down -z.

export interface CameraIntrinsics {
  /** Resolution the focal lengths and principal point refer to. */
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

export interface CameraModel {
  intrinsics: CameraIntrinsics;
  /** Camera pose in the head (XR viewer) frame. */
  headFromCamera: Pose;
}

export interface Ray {
  origin: Vec3;
  /** Unit length. */
  direction: Vec3;
}

export function pixelRay(
  model: CameraModel,
  uv: readonly [number, number],
  worldFromHead: Pose,
): Ray {
  const { width, height, fx, fy, cx, cy } = model.intrinsics;
  const x = (uv[0] * width - cx) / fx;
  const y = -(uv[1] * height - cy) / fy;
  const worldFromCamera = composePose(worldFromHead, model.headFromCamera);
  return {
    origin: worldFromCamera.p,
    direction: normalize(rotateVec(worldFromCamera.q, normalize([x, y, -1]))),
  };
}

/** Where a ray meets the plane y = h, or null if it is parallel or the plane is behind it. */
export function intersectPlaneY(ray: Ray, h: number): Vec3 | null {
  const dy = ray.direction[1];
  if (Math.abs(dy) < 1e-9) return null;
  const s = (h - ray.origin[1]) / dy;
  return s > 0 ? madd(ray.origin, ray.direction, s) : null;
}

/** The point on a ray closest (horizontally) to the vertical line through `base`. */
function pointAboveBase(ray: Ray, base: Readonly<Vec3>): Vec3 | null {
  const dh: Vec3 = [ray.direction[0], 0, ray.direction[2]];
  const dh2 = dot(dh, dh);
  if (dh2 < 1e-9) return null;
  const toBase: Vec3 = [base[0] - ray.origin[0], 0, base[2] - ray.origin[2]];
  const s = dot(toBase, dh) / dh2;
  if (s <= 0) return null;
  const p = madd(ray.origin, ray.direction, s);
  return [base[0], p[1], base[2]];
}

export interface Detection2D {
  /** Best point on the object, normalized image coordinates. */
  point: readonly [number, number] | null;
  /** [x0, y0, x1, y1], normalized image coordinates. */
  box: readonly [number, number, number, number] | null;
}

/**
 * Lift a detection on a surface at height `surfaceY` (world) to a 3D point. Depth comes from where
 * the box's bottom center meets the surface (objects rest on it); height comes from the detection
 * point straight above that base. Without a box, the point's ray meets the surface directly.
 */
export function liftDetection(
  det: Detection2D,
  model: CameraModel,
  worldFromHead: Pose,
  surfaceY: number,
): Vec3 | null {
  if (det.box) {
    const [x0, , x1, y1] = det.box;
    const base = intersectPlaneY(pixelRay(model, [(x0 + x1) / 2, y1], worldFromHead), surfaceY);
    if (base) {
      if (!det.point) return base;
      return pointAboveBase(pixelRay(model, det.point, worldFromHead), base) ?? base;
    }
  }
  return det.point ? intersectPlaneY(pixelRay(model, det.point, worldFromHead), surfaceY) : null;
}
