import {
  add,
  invertPose,
  type Pose,
  rotateVec,
  sub,
  transformPoint,
  type Vec3,
  yawOnly,
} from '../../core/math';
import { billboard, type ObjectOutline, outlinePoint } from '../../domain/world/outline';
import type { PresentContext } from './presenter';

// Placement stays near the actual gaze, but cards keep the room's horizon: yaw only, no head
// pitch or roll. Project all four level-card corners and object masks into the gaze frame so
// perspective and depth differences cannot hide an overlap. Bounds stay conservative for concave masks.
export const PANEL_DISTANCE = 0.65;
export const PANEL_MASK_GAP = 0.06;
/** New anchors leave slack for head motion and detector jitter before the hard gap is reached. */
const PLACEMENT_CUSHION = 0.06;
const HALF_IPD = 0.032;
const NEAR = 0.03;
const VIEW = { left: -0.58, right: 0.58, bottom: -0.48, top: 0.4 };
/** Reading rests slightly below straight ahead; no preferred left/right side. */
const REST: Point = [0, -0.08];

type Point = [number, number];
interface Rect {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

interface Projection {
  rect: Rect;
  minDepth: number;
  maxDepth: number;
}

const finitePoint = (p: readonly number[]) => p.length === 3 && p.every(Number.isFinite);

function project(points: readonly Vec3[], viewFromWorld: Pose): Projection | null {
  const local = points.filter(finitePoint).map((p) => transformPoint(viewFromWorld, p));
  if (!local.some(([, , z]) => z < 0)) return null;
  let left = Infinity;
  let right = -Infinity;
  let bottom = Infinity;
  let top = -Infinity;
  let minDepth = Infinity;
  let maxDepth = 0;
  for (const [x, y, z] of local) {
    // A geometry group straddling the eye plane needs conservative near-plane bounds rather
    // than dropping its near vertices and accidentally revealing a gap through furniture.
    const depth = Math.max(NEAR, -z);
    const scale = PANEL_DISTANCE / depth;
    left = Math.min(left, x * scale);
    right = Math.max(right, x * scale);
    bottom = Math.min(bottom, y * scale);
    top = Math.max(top, y * scale);
    minDepth = Math.min(minDepth, depth);
    maxDepth = Math.max(maxDepth, depth);
  }
  return { rect: { left, right, bottom, top }, minDepth, maxDepth };
}

const expand = (rect: Rect, gap: number): Rect => ({
  left: rect.left - gap,
  right: rect.right + gap,
  bottom: rect.bottom - gap,
  top: rect.top + gap,
});

function maskPoints(center: Vec3, outline: ObjectOutline, eye: Vec3): Vec3[] {
  const plane = billboard(center, eye);
  return plane ? outline.points.map((p) => outlinePoint(plane, center, p)) : [];
}

function obstacleGeometry(ctx: PresentContext): (readonly Vec3[])[] {
  const geometry: (readonly Vec3[])[] = [];
  const masked = new Set<string>();
  const eye = transformPoint(invertPose(ctx.worldFromWorkspace), ctx.head.p);
  for (const item of ctx.snapshot.outlines) {
    const object = ctx.objects.find((o) => o.id === item.objectId);
    if (!object || object.lostAt !== undefined || object.heldBy) continue;
    const points = maskPoints(add(object.position, item.offset), item.outline, eye).map((p) =>
      transformPoint(ctx.worldFromWorkspace, p),
    );
    if (points.some(finitePoint)) {
      geometry.push(points);
      masked.add(object.id);
    }
  }
  // Use the same current-eye upright billboards as the renderer, even while the card itself
  // keeps its own world orientation. Room geometry is already in world coordinates.
  for (const mask of ctx.objectMasks ?? []) {
    geometry.push(maskPoints(mask.center, mask.outline, ctx.head.p));
  }
  for (const object of ctx.objects) {
    if (masked.has(object.id) || object.lostAt !== undefined || object.spec.hidden) continue;
    const center = transformPoint(ctx.worldFromWorkspace, object.position);
    const radius = Math.max(0.03, object.spec.radius);
    const points: Vec3[] = [];
    for (const x of [-radius, radius]) {
      for (const y of [-radius, radius]) {
        for (const z of [-radius, radius]) points.push(add(center, [x, y, z]));
      }
    }
    geometry.push(points);
  }
  geometry.push(...(ctx.sceneObstacles ?? []));
  return geometry.filter((points) => points.some(finitePoint));
}

function cardCorners(width: number, height: number, top: number, pose: Pose): Vec3[] {
  return [
    [-width / 2, top, 0],
    [width / 2, top, 0],
    [width / 2, top - height, 0],
    [-width / 2, top - height, 0],
  ].map((point) => transformPoint(pose, point as Vec3));
}

/** Wider than the comfortable reading area: collision checks include the headset's periphery. */
const COLLISION_VIEW = { left: -1.3, right: 1.3, bottom: -1.15, top: 1.15 };

function outsideView(points: readonly Vec3[]): boolean {
  return (
    points.every(([, , z]) => z >= 0) ||
    points.every(([x, , z]) => x < (COLLISION_VIEW.left / PANEL_DISTANCE) * -z) ||
    points.every(([x, , z]) => x > (COLLISION_VIEW.right / PANEL_DISTANCE) * -z) ||
    points.every(([, y, z]) => y < (COLLISION_VIEW.bottom / PANEL_DISTANCE) * -z) ||
    points.every(([, y, z]) => y > (COLLISION_VIEW.top / PANEL_DISTANCE) * -z)
  );
}

function clearAtPose(
  ctx: PresentContext,
  width: number,
  height: number,
  top: number,
  pose: Pose,
  geometry: readonly (readonly Vec3[])[],
): boolean {
  if (!geometry.length) return true;
  const corners = cardCorners(width, height, top, pose);
  // Project the actual card and objects independently for both eyes. This handles a frozen,
  // tilted card at any distance without assuming head alignment or approximating stereo.
  for (const eyeX of [-HALF_IPD, HALF_IPD]) {
    const view = invertPose({ p: transformPoint(ctx.head, [eyeX, 0, 0]), q: ctx.head.q });
    const local = corners.map((p) => transformPoint(view, p));
    if (outsideView(local)) continue;
    if (local.some(([, , z]) => z >= -NEAR)) return false;
    const card = project(corners, view);
    if (!card) continue;
    // Convert a 6cm gap at the card's actual near edge into reference-plane screen units.
    const padded = expand(card.rect, (PANEL_MASK_GAP * PANEL_DISTANCE) / card.minDepth);
    for (const points of geometry) {
      const obstacle = project(points, view);
      if (obstacle && overlaps(padded, obstacle.rect)) return false;
    }
  }
  return true;
}

/** Whether this exact world-space card remains visually clear, regardless of its orientation. */
export function isInstructionPanelClear(
  ctx: PresentContext,
  width: number,
  height: number,
  top: number,
  pose: Pose,
): boolean {
  return clearAtPose(ctx, width, height, top, pose, obstacleGeometry(ctx));
}

function obstacles(
  geometry: readonly (readonly Vec3[])[],
  viewFromWorld: Pose,
  gap: number,
): Rect[] {
  return geometry.flatMap((points) => {
    const projection = project(points, viewFromWorld);
    if (!projection) return [];
    const { minDepth, maxDepth, rect } = projection;
    // Object disparity is measured against the reference plane. The caller adds the level
    // card's own disparity and its clearance scaled by the actual nearest corner depth.
    const stereo =
      HALF_IPD *
      Math.max(Math.abs(PANEL_DISTANCE / minDepth - 1), Math.abs(PANEL_DISTANCE / maxDepth - 1));
    return [expand(rect, gap + stereo)];
  });
}

const overlaps = (a: Rect, b: Rect) =>
  a.left < b.right - 1e-8 &&
  a.right > b.left + 1e-8 &&
  a.bottom < b.top - 1e-8 &&
  a.top > b.bottom + 1e-8;

const inside = (a: Rect, b: Rect) =>
  a.left >= b.left - 1e-8 &&
  a.right <= b.right + 1e-8 &&
  a.bottom >= b.bottom - 1e-8 &&
  a.top <= b.top + 1e-8;

/** A content-sized, world-level instruction card beside every known object silhouette. */
export function placeInstructionPanel(
  ctx: PresentContext,
  width: number,
  height: number,
  top: number,
  previous: Pose | null,
): Pose {
  const viewFromWorld = invertPose(ctx.head);
  const geometry = obstacleGeometry(ctx);
  if (previous) {
    const up = rotateVec(previous.q, [0, 1, 0]);
    const upright = Math.abs(up[0]) < 1e-8 && Math.abs(up[2]) < 1e-8 && up[1] > 0;
    const q = yawOnly(previous.q);
    const center = transformPoint(previous, [0, top - height / 2, 0]);
    // Level a legacy tilted card around its existing center once; a level anchor stays exact.
    const candidate: Pose = upright
      ? previous
      : {
          p: sub(center, rotateVec(q, [0, top - height / 2, 0])),
          q,
        };
    const corners = cardCorners(width, height, top, candidate);
    const projected = project(corners, viewFromWorld);
    if (
      projected &&
      corners.every((p) => transformPoint(viewFromWorld, p)[2] < -NEAR) &&
      inside(projected.rect, VIEW) &&
      clearAtPose(ctx, width, height, top, candidate, geometry)
    )
      return candidate;
  }

  const level = yawOnly(ctx.head.q);
  const halfW = width / 2;
  const halfH = height / 2;
  const centered: Vec3[] = [
    [-halfW, halfH, 0],
    [halfW, halfH, 0],
    [halfW, -halfH, 0],
    [-halfW, -halfH, 0],
  ];
  const offsets = centered.map((p) => rotateVec(viewFromWorld.q, rotateVec(level, p)));
  // Very large cards seen from a steep angle must remain wholly in front of the near plane.
  const distance = Math.max(PANEL_DISTANCE, ...offsets.map((p) => p[2] + NEAR + 0.02));
  const footprint = offsets.map(([dx, dy, dz]) => ({
    dx,
    dy,
    scale: PANEL_DISTANCE / (distance - dz),
  }));
  const pose = ([x, y]: Point): Pose => ({
    p: sub(transformPoint(ctx.head, [x, y, -distance]), rotateVec(level, [0, top - halfH, 0])),
    q: [...level],
  });
  const box = ([x, y]: Point): Rect => ({
    left: Math.min(...footprint.map((p) => (x + p.dx) * p.scale)),
    right: Math.max(...footprint.map((p) => (x + p.dx) * p.scale)),
    bottom: Math.min(...footprint.map((p) => (y + p.dy) * p.scale)),
    top: Math.max(...footprint.map((p) => (y + p.dy) * p.scale)),
  });
  const leftOf = (edge: number) => Math.min(...footprint.map((p) => edge / p.scale - p.dx));
  const rightOf = (edge: number) => Math.max(...footprint.map((p) => edge / p.scale - p.dx));
  const below = (edge: number) => Math.min(...footprint.map((p) => edge / p.scale - p.dy));
  const above = (edge: number) => Math.max(...footprint.map((p) => edge / p.scale - p.dy));
  const maxScale = Math.max(...footprint.map((p) => p.scale));
  const cardStereo = HALF_IPD * Math.max(...footprint.map((p) => Math.abs(p.scale - 1)));
  const required = obstacles(geometry, viewFromWorld, PANEL_MASK_GAP * maxScale + cardStereo);
  const masks = obstacles(
    geometry,
    viewFromWorld,
    (PANEL_MASK_GAP + PLACEMENT_CUSHION) * maxScale + cardStereo,
  );
  const clear = (point: Point) => required.every((mask) => !overlaps(box(point), mask));
  const buffered = (point: Point) => masks.every((mask) => !overlaps(box(point), mask));
  const taskGap = (point: Point) => {
    const r = box(point);
    return masks.length
      ? Math.min(
          ...masks.map((mask) =>
            Math.hypot(
              Math.max(0, mask.left - r.right, r.left - mask.right),
              Math.max(0, mask.bottom - r.top, r.bottom - mask.top),
            ),
          ),
        )
      : 0;
  };
  const score = (point: Point) => {
    const r = box(point);
    const gazeTravel = Math.hypot(
      (point[0] * PANEL_DISTANCE) / distance - REST[0],
      (point[1] * PANEL_DISTANCE) / distance - REST[1],
    );
    const readingReach = Math.hypot(
      Math.max(Math.abs(r.left), Math.abs(r.right)),
      Math.max(Math.abs(r.bottom - REST[1]), Math.abs(r.top - REST[1])),
    );
    return 4 * taskGap(point) + gazeTravel + 0.15 * readingReach;
  };
  const overflow = (point: Point) => {
    const r = box(point);
    return (
      Math.max(0, VIEW.left - r.left - 1e-8) +
      Math.max(0, r.right - VIEW.right - 1e-8) +
      Math.max(0, VIEW.bottom - r.bottom - 1e-8) +
      Math.max(0, r.top - VIEW.top - 1e-8)
    );
  };
  const clamp = (value: number, low: number, high: number) =>
    low <= high ? Math.min(high, Math.max(low, value)) : (low + high) / 2;
  const xMin = rightOf(VIEW.left);
  const xMax = leftOf(VIEW.right);
  const yMin = above(VIEW.bottom);
  const yMax = below(VIEW.top);
  const fitX = (x: number) => clamp(x, xMin, xMax);
  const fitY = (y: number) => clamp(y, yMin, yMax);
  const actual = (projected: number) => (projected * distance) / PANEL_DISTANCE;
  const xs = new Set([fitX(actual(REST[0])), xMin, xMax]);
  const ys = new Set([fitY(actual(REST[1])), yMin, yMax]);
  const union: Rect | null = masks.length
    ? {
        left: Math.min(...masks.map((r) => r.left)),
        right: Math.max(...masks.map((r) => r.right)),
        bottom: Math.min(...masks.map((r) => r.bottom)),
        top: Math.max(...masks.map((r) => r.top)),
      }
    : null;
  for (const mask of [...masks, ...required]) {
    xs.add(fitX(leftOf(mask.left)));
    xs.add(fitX(rightOf(mask.right)));
    xs.add(fitX(actual((mask.left + mask.right) / 2)));
    ys.add(fitY(below(mask.bottom)));
    ys.add(fitY(above(mask.top)));
    ys.add(fitY(actual((mask.bottom + mask.top) / 2)));
  }
  const candidates: Point[] = [];
  for (const x of xs) for (const y of ys) candidates.push([x, y]);
  if (union) {
    const x = fitX(actual((union.left + union.right) / 2));
    const y = fitY(actual((union.bottom + union.top) / 2));
    candidates.push(
      [leftOf(union.left), y],
      [rightOf(union.right), y],
      [x, below(union.bottom)],
      [x, above(union.top)],
    );
  }
  const safe = candidates.filter(clear);
  const inView = safe.filter((point) => inside(box(point), VIEW));
  const withCushion = safe.filter(buffered);
  const cushionedInView = withCushion.filter((point) => inside(box(point), VIEW));
  const priority = [cushionedInView, inView, withCushion, safe];
  // Every returned target passes the same exact binocular test used while anchored and moving.
  for (const group of priority) {
    group.sort((a, b) => overflow(a) - overflow(b) || score(a) - score(b));
    const point = group.find((p) => clearAtPose(ctx, width, height, top, pose(p), geometry));
    if (point) return pose(point);
  }
  // Finite bounds always leave this position above their union, even in a fully crowded view.
  return pose([
    fitX(actual(REST[0])),
    union ? above(union.top + PANEL_MASK_GAP * maxScale) : fitY(actual(REST[1])),
  ]);
}
