import type { Vec3 } from '../../core/math';
import type { Ray } from '../../domain/world/camera-model';
import type { SurfaceRaycaster } from '../../domain/world/grounding';
import { raycastHorizontalSurfaces, type Surface } from '../../domain/world/surfaces';
import { poseFromMatrix } from './frame-sampler';

/**
 * Horizontal surfaces from WebXR plane detection (Quest's room setup: tables, counters, the floor;
 * IWER's synthetic rooms on desktop), so camera detections can be lifted onto real geometry even
 * without a calibrated table. Needs the 'plane-detection' feature; otherwise it simply never hits.
 */
export class XrPlaneSurfaces implements SurfaceRaycaster {
  private surfaces: Surface[] = [];

  update(frame: XRFrame, space: XRReferenceSpace): void {
    const planes = frame.detectedPlanes;
    if (!planes) return;
    const next: Surface[] = [];
    for (const plane of planes) {
      if (plane.orientation !== 'horizontal' || plane.polygon.length < 3) continue;
      const pose = frame.getPose(plane.planeSpace, space);
      if (!pose) continue;
      next.push({
        pose: poseFromMatrix(pose.transform.matrix),
        polygon: plane.polygon.map((p) => [p.x, p.z] as const),
      });
    }
    this.surfaces = next;
  }

  get count(): number {
    return this.surfaces.length;
  }

  cast(ray: Ray): Vec3 | null {
    return raycastHorizontalSurfaces(ray, this.surfaces);
  }
}
