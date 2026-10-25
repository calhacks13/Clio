import { type Pose, quatNormalize, rotateVec, transformPoint, type Vec3 } from '../../core/math';
import type { DetectedPlane } from '../../domain/world/environment';

// Plane detection is available before a lesson names any objects. Reserve bounded furniture so
// the idle prompt does not sit over the table while the learner is deciding what to learn.
// These points are presentation obstacles only; they never alter or record room measurements.
const FURNITURE = new Set([
  'table',
  'desk',
  'counter',
  'couch',
  'sofa',
  'chair',
  'stool',
  'bed',
  'cabinet',
  'shelf',
  'dresser',
]);
const WORK_SURFACES = new Set(['table', 'desk', 'counter']);
const MAX_DISTANCE_M = 3;
const MAX_FURNITURE_SPAN_M = 3.2;
const MAX_FURNITURE_AREA_M2 = 6;
const MAX_UNLABELED_SPAN_M = 2.5;
const MAX_UNLABELED_AREA_M2 = 4;
const HORIZONTAL_COS = Math.cos((20 * Math.PI) / 180);
/** UI clearance above a measured work surface, not a detected object height. */
const WORKSPACE_CLEARANCE_M = 0.18;

const finite = (values: readonly number[]) => values.every(Number.isFinite);

function normalizedPose(pose: Pose): Pose | null {
  if (!finite(pose.p) || !finite(pose.q)) return null;
  const norm = Math.hypot(...pose.q);
  return norm > 1e-6 && Number.isFinite(norm) ? { p: pose.p, q: quatNormalize(pose.q) } : null;
}

/** Nearby measured furniture plus a modest reserve for objects resting on task surfaces. */
export function panelRoomObstacles(
  planes: readonly DetectedPlane[],
  head: Pose,
): readonly (readonly Vec3[])[] {
  if (!normalizedPose(head)) return [];
  const groups: Vec3[][] = [];
  for (const plane of planes) {
    const label = plane.label?.trim().toLowerCase() ?? '';
    const labeledFurniture = FURNITURE.has(label);
    // Unknown labels do not establish furniture. In particular, walls, floors, ceilings,
    // doors, windows and whole-room planes must not consume all of the available UI space.
    if (label && !labeledFurniture) continue;
    const pose = normalizedPose(plane.pose);
    if (!pose || plane.polygon.length < 3 || !plane.polygon.every(finite)) continue;
    const normal = rotateVec(pose.q, [0, 1, 0]);
    const horizontal = plane.orientation === 'horizontal' && Math.abs(normal[1]) >= HORIZONTAL_COS;
    if (!labeledFurniture && !horizontal) continue;

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let twiceArea = 0;
    for (let i = 0; i < plane.polygon.length; i++) {
      const [x, z] = plane.polygon[i] ?? [0, 0];
      const [nextX, nextZ] = plane.polygon[(i + 1) % plane.polygon.length] ?? [0, 0];
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
      twiceArea += x * nextZ - nextX * z;
    }
    const span = Math.max(maxX - minX, maxZ - minZ);
    const area = Math.abs(twiceArea) / 2;
    const maxSpan = labeledFurniture ? MAX_FURNITURE_SPAN_M : MAX_UNLABELED_SPAN_M;
    const maxArea = labeledFurniture ? MAX_FURNITURE_AREA_M2 : MAX_UNLABELED_AREA_M2;
    if (!Number.isFinite(span + area) || span > maxSpan || area < 0.0025 || area > maxArea) {
      continue;
    }

    const points = plane.polygon.map(([x, z]) => transformPoint(pose, [x, 0, z]));
    if (!points.every(finite)) continue;
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    let meanY = 0;
    for (const point of points) {
      for (const axis of [0, 1, 2] as const) {
        min[axis] = Math.min(min[axis], point[axis]);
        max[axis] = Math.max(max[axis], point[axis]);
      }
      meanY += point[1] / points.length;
    }
    // Distance to the surface's world bounds keeps the nearby end of a table even when its
    // origin is farther away. Background furniture contributes no projection group.
    const distance = Math.hypot(
      Math.max(min[0] - head.p[0], 0, head.p[0] - max[0]),
      Math.max(min[1] - head.p[1], 0, head.p[1] - max[1]),
      Math.max(min[2] - head.p[2], 0, head.p[2] - max[2]),
    );
    if (distance > MAX_DISTANCE_M) continue;
    if (!labeledFurniture) {
      // Unlabeled horizontal geometry is a possible worktop only when it is below the eyes,
      // within standing/seated reach. This excludes an unclassified floor or overhead slab.
      const drop = head.p[1] - meanY;
      if (drop < 0.25 || drop > 1.15) continue;
    }
    const workSurface = horizontal && (!label || WORK_SURFACES.has(label));
    if (workSurface) {
      points.push(...points.map(([x, y, z]): Vec3 => [x, y + WORKSPACE_CLEARANCE_M, z]));
    }
    groups.push(points);
  }
  return groups;
}
