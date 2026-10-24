import type { Vec3 } from '../../core/math';
import type { Ray } from './camera-model';

// The port placement.ts measures objects through: how far along a world-space camera ray the real
// world is. adapters/xr implements it with WebXR hit-test (depth.ts) and depth sensing
// (depth-sensing.ts).

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
