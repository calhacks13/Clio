import {
  dot,
  invertPose,
  madd,
  type Pose,
  rotateVec,
  sub,
  transformPoint,
  type Vec3,
} from '../../core/math';
import type { Ray } from './camera-model';

// Real surfaces the headset knows about (WebXR plane detection: tables, counters, the floor), used
// to lift camera detections into 3D when there's no calibrated table.

/** A horizontal surface: its pose (local +y is the normal) and its outline in local x/z. */
export interface Surface {
  pose: Pose;
  polygon: readonly (readonly [number, number])[];
}

function inside([x, z]: readonly [number, number], polygon: Surface['polygon']): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i] ?? [0, 0];
    const [xj, zj] = polygon[j] ?? [0, 0];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/** Nearest point where the ray meets one of the surfaces inside its outline, or null. */
export function raycastHorizontalSurfaces(ray: Ray, surfaces: readonly Surface[]): Vec3 | null {
  let best: { s: number; point: Vec3 } | null = null;
  for (const surface of surfaces) {
    const normal = rotateVec(surface.pose.q, [0, 1, 0]);
    const denom = dot(normal, ray.direction);
    if (Math.abs(denom) < 1e-9) continue;
    const s = dot(sub(surface.pose.p, ray.origin), normal) / denom;
    if (s <= 0 || (best && s >= best.s)) continue;
    const point = madd(ray.origin, ray.direction, s);
    const local = transformPoint(invertPose(surface.pose), point);
    if (inside([local[0], local[2]], surface.polygon)) best = { s, point };
  }
  return best?.point ?? null;
}
