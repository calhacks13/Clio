import { add, invertPose, type Pose, transformPoint, type Vec3 } from '../../core/math';
import { billboard, type ObjectOutline, outlinePoint } from '../../domain/world/outline';
import type { PresentContext } from './presenter';

// Work in the gaze-relative plane of the card, including looking down at the table and tilting
// the head. Comparing world distances would let a
// nearer card cover an object farther away; perspective-project both masks and card into this
// plane instead. Conservative silhouette bounds also reserve the space inside a concave mask.
export const PANEL_DISTANCE = 0.65;
export const PANEL_MASK_GAP = 0.035;
const HALF_IPD = 0.032;
const NEAR = 0.03;
const VIEW = { left: -0.58, right: 0.58, bottom: -0.48, top: 0.4 };
/** Reading rests slightly below straight ahead; no preferred left/right side. */
const REST: Point = [0, -0.08];
/** A settled card may keep this much extra task/gaze travel before a new position is useful. */
const SETTLED_SLACK = 0.16;

type Point = [number, number];
interface Rect {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

function bounds(points: readonly Vec3[], viewFromWorld: Pose): Rect | null {
  let left = Infinity;
  let right = -Infinity;
  let bottom = Infinity;
  let top = -Infinity;
  let stereo = 0;
  for (const point of points) {
    const [x, y, z] = transformPoint(viewFromWorld, point);
    if (z >= -NEAR) continue;
    const scale = PANEL_DISTANCE / -z;
    left = Math.min(left, x * scale);
    right = Math.max(right, x * scale);
    bottom = Math.min(bottom, y * scale);
    top = Math.max(top, y * scale);
    // Reserve the disparity between the midpoint projection and either eye as well as the gap.
    stereo = Math.max(stereo, HALF_IPD * Math.abs(1 - scale));
  }
  if (!Number.isFinite(left + right + bottom + top)) return null;
  const gap = PANEL_MASK_GAP + stereo;
  return { left: left - gap, right: right + gap, bottom: bottom - gap, top: top + gap };
}

function maskPoints(center: Vec3, outline: ObjectOutline, eye: Vec3): Vec3[] {
  const plane = billboard(center, eye);
  return plane ? outline.points.map((p) => outlinePoint(plane, center, p)) : [];
}

function obstacles(ctx: PresentContext, viewFromWorld: Pose): Rect[] {
  const rects: Rect[] = [];
  const masked = new Set<string>();
  const eye = transformPoint(invertPose(ctx.worldFromWorkspace), ctx.head.p);
  for (const item of ctx.snapshot.outlines) {
    const object = ctx.objects.find((o) => o.id === item.objectId);
    if (!object || object.lostAt !== undefined || object.heldBy) continue;
    const points = maskPoints(add(object.position, item.offset), item.outline, eye).map((p) =>
      transformPoint(ctx.worldFromWorkspace, p),
    );
    const rect = bounds(points, viewFromWorld);
    if (rect) {
      rects.push(rect);
      masked.add(object.id);
    }
  }
  // Live tracker masks are already in world space and may be more recent than the lesson's
  // snapshot outlines. They use the same current-eye billboard as LiveHighlightsPresenter.
  for (const mask of ctx.objectMasks ?? []) {
    const rect = bounds(maskPoints(mask.center, mask.outline, ctx.head.p), viewFromWorld);
    if (rect) rects.push(rect);
  }
  for (const object of ctx.objects) {
    if (masked.has(object.id) || object.lostAt !== undefined || object.spec.hidden) continue;
    const center = transformPoint(ctx.worldFromWorkspace, object.position);
    const radius = Math.max(0.03, object.spec.radius);
    // Without a mask, protect a conservative cube around the estimate, including its near face.
    const points: Vec3[] = [];
    for (const x of [-radius, radius]) {
      for (const y of [-radius, radius]) {
        for (const z of [-radius, radius]) points.push(add(center, [x, y, z]));
      }
    }
    const rect = bounds(points, viewFromWorld);
    if (rect) rects.push(rect);
  }
  return rects;
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
  const masks = obstacles(ctx, viewFromWorld);
  const halfW = width / 2;
  const halfH = height / 2;
  const box = ([x, y]: Point): Rect => ({
    left: x - halfW,
    right: x + halfW,
    bottom: y - halfH,
    top: y + halfH,
  });
  const clear = (point: Point) => masks.every((mask) => !overlaps(box(point), mask));
  const pose = ([x, y]: Point): Pose => ({
    p: transformPoint(worldFromView, [x, y - top + halfH, -PANEL_DISTANCE]),
    q: worldFromView.q,
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
  for (const mask of masks) {
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
  const useful = inView.length ? inView : safe;
  useful.sort((a, b) => overflow(a) - overflow(b) || score(a) - score(b));
  const best: Point = useful[0] ?? (union ? [REST[0], union.top + halfH + PANEL_MASK_GAP] : REST);

  if (previous) {
    const center = transformPoint(previous, [0, top - halfH, 0]);
    const [x, y, z] = transformPoint(viewFromWorld, center);
    if (z < -NEAR) {
      const point: Point = [(x * PANEL_DISTANCE) / -z, (y * PANEL_DISTANCE) / -z];
      // Test the current dimensions, including the card's fixed top edge when it grows/shrinks.
      // Modest extra clearance/travel is worth avoiding a jump while the learner is reading.
      if (
        inside(box(point), VIEW) &&
        clear(point) &&
        taskGap(point) <= SETTLED_SLACK &&
        gazeTravel(point) <= gazeTravel(best) + SETTLED_SLACK
      )
        return pose(point);
    }
  }
  return pose(best);
}
