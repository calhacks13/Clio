import { add, invertPose, type Pose, transformPoint, type Vec3 } from '../../core/math';
import { billboard, type ObjectOutline, outlinePoint } from '../../domain/world/outline';
import type { PresentContext } from './presenter';

// Work in the gaze-relative plane of the card, including looking down at the table and tilting
// the head. Comparing world distances would let a
// nearer card cover an object farther away; perspective-project both masks and card into this
// plane instead. Conservative silhouette bounds also reserve the space inside a concave mask.
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
    // Candidate cards start at PANEL_DISTANCE. Their midpoint bounds include the full binocular
    // disparity so a candidate selected here also satisfies the exact per-eye validator.
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

/** A content-sized instruction card beside, never over, any known object silhouette. */
export function placeInstructionPanel(
  ctx: PresentContext,
  width: number,
  height: number,
  top: number,
  previous: Pose | null,
): Pose {
  const worldFromView = ctx.head;
  const viewFromWorld = invertPose(worldFromView);
  const geometry = obstacleGeometry(ctx);
  if (previous) {
    const corners = cardCorners(width, height, top, previous);
    const projected = project(corners, viewFromWorld);
    const local = corners.map((p) => transformPoint(viewFromWorld, p));
    if (
      projected &&
      local.every(([, , z]) => z < -NEAR) &&
      inside(projected.rect, VIEW) &&
      clearAtPose(ctx, width, height, top, previous, geometry)
    )
      return previous;
  }
  const required = obstacles(geometry, viewFromWorld, PANEL_MASK_GAP);
  const masks = obstacles(geometry, viewFromWorld, PANEL_MASK_GAP + PLACEMENT_CUSHION);
  const halfW = width / 2;
  const halfH = height / 2;
  const box = ([x, y]: Point): Rect => ({
    left: x - halfW,
    right: x + halfW,
    bottom: y - halfH,
    top: y + halfH,
  });
  const clear = (point: Point) => required.every((mask) => !overlaps(box(point), mask));
  const buffered = (point: Point) => masks.every((mask) => !overlaps(box(point), mask));
  const pose = ([x, y]: Point): Pose => ({
    p: transformPoint(worldFromView, [x, y - top + halfH, -PANEL_DISTANCE]),
    q: [...worldFromView.q],
  });

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
  const gazeTravel = ([x, y]: Point) => Math.hypot(x - REST[0], y - REST[1]);
  const score = (point: Point) => {
    const r = box(point);
    // Include the reading reach of the whole card: a wide card needs useful horizontal room,
    // while a tall one needs useful vertical room, rather than merely keeping its center in view.
    const readingReach = Math.hypot(
      Math.max(Math.abs(r.left), Math.abs(r.right)),
      Math.max(Math.abs(r.bottom - REST[1]), Math.abs(r.top - REST[1])),
    );
    return 4 * taskGap(point) + gazeTravel(point) + 0.15 * readingReach;
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
  const fitX = (x: number) => clamp(x, VIEW.left + halfW, VIEW.right - halfW);
  const fitY = (y: number) => clamp(y, VIEW.bottom + halfH, VIEW.top - halfH);
  const xs = new Set([fitX(REST[0]), VIEW.left + halfW, VIEW.right - halfW]);
  const ys = new Set([fitY(REST[1]), VIEW.bottom + halfH, VIEW.top - halfH]);
  const union: Rect | null = masks.length
    ? {
        left: Math.min(...masks.map((r) => r.left)),
        right: Math.max(...masks.map((r) => r.right)),
        bottom: Math.min(...masks.map((r) => r.bottom)),
        top: Math.max(...masks.map((r) => r.top)),
      }
    : null;
  for (const mask of [...masks, ...required]) {
    xs.add(fitX(mask.left - halfW));
    xs.add(fitX(mask.right + halfW));
    xs.add(fitX((mask.left + mask.right) / 2));
    ys.add(fitY(mask.bottom - halfH));
    ys.add(fitY(mask.top + halfH));
    ys.add(fitY((mask.bottom + mask.top) / 2));
  }
  // Mask edges and viewport edges describe the useful gaps. Trying their intersections lets a
  // wide/tall card slide along a side to fit near a viewport edge or between several objects.
  const candidates: Point[] = [];
  for (const x of xs) for (const y of ys) candidates.push([x, y]);
  if (union) {
    const x = fitX((union.left + union.right) / 2);
    const y = fitY((union.bottom + union.top) / 2);
    // If the task fills the preferred view, these guarantee a clear finite fallback beside it.
    candidates.push(
      [union.left - halfW, y],
      [union.right + halfW, y],
      [x, union.bottom - halfH],
      [x, union.top + halfH],
    );
  }
  const safe = candidates.filter(clear);
  const inView = safe.filter((point) => inside(box(point), VIEW));
  const withCushion = safe.filter(buffered);
  const cushionedInView = withCushion.filter((point) => inside(box(point), VIEW));
  // Prefer a new anchor with breathing room. In a crowded scene, a fully visible card that
  // respects the hard gap is more useful than an offscreen card that preserves extra slack.
  const useful = cushionedInView.length
    ? cushionedInView
    : inView.length
      ? inView
      : withCushion.length
        ? withCushion
        : safe;
  useful.sort((a, b) => overflow(a) - overflow(b) || score(a) - score(b));
  // Validate the final world pose with the same exact binocular check used during motion.
  const best: Point =
    useful.find((point) => clearAtPose(ctx, width, height, top, pose(point), geometry)) ??
    (union ? [REST[0], union.top + halfH + PANEL_MASK_GAP] : REST);

  return pose(best);
}
