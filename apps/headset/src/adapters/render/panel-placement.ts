import {
  add,
  distance,
  invertPose,
  normalize,
  type Pose,
  type Quat,
  quatFromAxisAngle,
  quatMultiply,
  rotateVec,
  scale,
  sub,
  transformPoint,
  type Vec3,
  yawOnly,
} from '../../core/math';
import type { ObjectEstimate } from '../../domain/world/object-registry';
import { billboard, type ObjectOutline, outlinePoint } from '../../domain/world/outline';
import type { PresentContext } from './presenter';

// Where the instruction card belongs this frame. It sits beside what the step is about: just above
// the lit objects as the eye sees them (else below, right or left of them), at their depth, and
// always inside a comfortable view. With nothing lit in view it takes a gaze slot in the lower
// periphery, or the upper one when the lower is blocked. The side the card is on is kept while it
// stays clear, so it does not hop around. The card's face points at the eye, tilting back when it
// is below the eye, but never rolls: its top edge stays level with the horizon. panel-motion.ts
// decides when the card goes there, and how smoothly, and keeps it facing the eye.
//
// Screen positions are measured on a reference plane PANEL_DISTANCE in front of the eye. Cards
// and objects are projected corner by corner, so perspective and depth cannot hide an overlap.
export const PANEL_DISTANCE = 0.65;
export const PANEL_MASK_GAP = 0.06;
/** A new slot leaves this much more than the hard gap, so detector jitter does not move the card. */
const SLOT_CUSHION = 0.025;
const HALF_IPD = 0.032;
const NEAR = 0.03;
/** The whole card stays in here: about 35 degrees either side, 35 down and 28 up. */
export const PANEL_VIEW = { left: -0.46, right: 0.46, bottom: -0.46, top: 0.35 };
/** A lit object anchors the card once its center is in PANEL_VIEW, and until it leaves this. */
const KEEP_VIEW = { left: -0.65, right: 0.65, bottom: -0.65, top: 0.55 };
/** Gaze slots: card centers about 21 degrees below and 14 degrees above the line of sight. */
const LOW: Point = [0, -0.25];
const HIGH: Point = [0, 0.16];
/** Lit objects spread wider than this are not one anchor; the most important one leads. */
const MAX_ANCHOR_SPAN = 0.45;
/** The card goes to the anchor's depth, within comfortable reading distance. */
const NEAREST_CARD = 0.45;
const FARTHEST_CARD = 0.85;
/** A live mask this close to an object's estimate is that object's silhouette. */
const MASK_MATCH_M = 0.12;

/** Beside the lit objects (above, below, right, left), or a gaze slot with nothing lit in view. */
export type PanelSlot = 'above' | 'below' | 'right' | 'left' | 'low' | 'high';
const OBJECT_SLOTS: readonly PanelSlot[] = ['above', 'below', 'right', 'left'];
const GAZE_SLOTS: readonly PanelSlot[] = ['low', 'high'];
export const besideObjects = (slot: PanelSlot): boolean => OBJECT_SLOTS.includes(slot);

export interface PanelTarget {
  pose: Pose;
  slot: PanelSlot;
}

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

interface Card {
  width: number;
  height: number;
  top: number;
}

/** What the card sits beside: the lit objects' projected bounds and the depth to read them at. */
interface Anchor {
  rect: Rect;
  depth: number;
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

const union = (a: Rect, b: Rect): Rect => ({
  left: Math.min(a.left, b.left),
  right: Math.max(a.right, b.right),
  bottom: Math.min(a.bottom, b.bottom),
  top: Math.max(a.top, b.top),
});

const contains = (rect: Rect, [x, y]: Point) =>
  x >= rect.left && x <= rect.right && y >= rect.bottom && y <= rect.top;

function maskPoints(center: Vec3, outline: ObjectOutline, eye: Vec3): Vec3[] {
  const plane = billboard(center, eye);
  return plane ? outline.points.map((p) => outlinePoint(plane, center, p)) : [];
}

function radiusBox(center: Vec3, radius: number): Vec3[] {
  const r = Math.max(0.03, radius);
  const points: Vec3[] = [];
  for (const x of [-r, r]) {
    for (const y of [-r, r]) {
      for (const z of [-r, r]) points.push(add(center, [x, y, z]));
    }
  }
  return points;
}

/** Everything the card keeps clear of; furniture only when `scene` (gaze slots, before a lesson). */
function obstacleGeometry(ctx: PresentContext, scene: boolean): (readonly Vec3[])[] {
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
    geometry.push(radiusBox(center, object.spec.radius));
  }
  if (scene) geometry.push(...(ctx.sceneObstacles ?? []));
  return geometry.filter((points) => points.some(finitePoint));
}

/** World points covering one object: its lesson outline, its live mask and its declared size. */
function objectPoints(ctx: PresentContext, object: ObjectEstimate, center: Vec3): Vec3[] {
  const points = radiusBox(center, object.spec.radius);
  const item = ctx.snapshot.outlines.find((o) => o.objectId === object.id);
  if (item) {
    const eye = transformPoint(invertPose(ctx.worldFromWorkspace), ctx.head.p);
    for (const p of maskPoints(add(object.position, item.offset), item.outline, eye)) {
      points.push(transformPoint(ctx.worldFromWorkspace, p));
    }
  }
  for (const mask of ctx.objectMasks ?? []) {
    if (distance(mask.center, center) <= MASK_MATCH_M) {
      points.push(...maskPoints(mask.center, mask.outline, ctx.head.p));
    }
  }
  return points;
}

/**
 * The lit objects in view, most important first (the step's outlines by rank, then its lights):
 * the first one in view leads, and the others join it while they stay close together.
 */
function findAnchor(ctx: PresentContext, viewFromWorld: Pose, keep: boolean): Anchor | null {
  if (ctx.calibration) return null;
  const ids = new Set([
    ...ctx.snapshot.outlines.map((o) => o.objectId),
    ...ctx.snapshot.highlights.map((h) => h.objectId),
  ]);
  let anchor: Anchor | null = null;
  for (const id of ids) {
    const object = ctx.objects.find((o) => o.id === id);
    if (!object || object.lostAt !== undefined || object.spec.hidden) continue;
    const center = transformPoint(ctx.worldFromWorkspace, object.position);
    const [x, y, z] = transformPoint(viewFromWorld, center);
    if (!finitePoint([x, y, z]) || z > -NEAR) continue;
    const onScreen: Point = [(x * PANEL_DISTANCE) / -z, (y * PANEL_DISTANCE) / -z];
    if (!contains(keep ? KEEP_VIEW : PANEL_VIEW, onScreen)) continue;
    const projection = project(objectPoints(ctx, object, center), viewFromWorld);
    if (!projection) continue;
    if (!anchor) {
      const depth = distance(ctx.head.p, center);
      anchor = {
        rect: projection.rect,
        depth: Math.min(FARTHEST_CARD, Math.max(NEAREST_CARD, depth)),
      };
      continue;
    }
    const joined = union(anchor.rect, projection.rect);
    if (
      joined.right - joined.left <= MAX_ANCHOR_SPAN &&
      joined.top - joined.bottom <= MAX_ANCHOR_SPAN
    ) {
      anchor.rect = joined;
    }
  }
  return anchor;
}

function cardCorners(width: number, height: number, top: number, pose: Pose): Vec3[] {
  return [
    [-width / 2, top, 0],
    [width / 2, top, 0],
    [width / 2, top - height, 0],
    [-width / 2, top - height, 0],
  ].map((point) => transformPoint(pose, point as Vec3));
}

/** Upright and level, turned about the vertical to face the eye. */
/**
 * A card at `center` with its face (+z) toward the eye: turned about the vertical, then tilted
 * about its own horizontal axis, so its top edge stays level with the horizon.
 */
export function facingEye(center: Readonly<Vec3>, head: Pose): Quat {
  const toEye = sub(head.p, center);
  const across = Math.hypot(toEye[0], toEye[2]);
  const heading =
    across < 1e-6 ? yawOnly(head.q) : quatFromAxisAngle([0, 1, 0], Math.atan2(toEye[0], toEye[2]));
  return quatMultiply(heading, quatFromAxisAngle([1, 0, 0], -Math.atan2(toEye[1], across)));
}

/** The pose of a card `height` tall whose top edge is `top` above its origin, by its center. */
export function cardAround(center: Readonly<Vec3>, q: Quat, height: number, top: number): Pose {
  return { p: sub(center, rotateVec(q, [0, top - height / 2, 0])), q };
}

/** The card whose center the eye sees at `point` on the reference plane, `depth` metres away. */
function cardAt(ctx: PresentContext, card: Card, point: Point, depth: number): Pose {
  const direction = normalize(rotateVec(ctx.head.q, [point[0], point[1], -PANEL_DISTANCE]));
  const center = add(ctx.head.p, scale(direction, depth));
  return cardAround(center, facingEye(center, ctx.head), card.height, card.top);
}

/** How far to move `rect` so it lies inside `bounds`, centered on any axis it cannot fit. */
function intoView(rect: Rect, bounds: Rect): Point {
  const axis = (low: number, high: number, min: number, max: number) =>
    high - low > max - min
      ? (min + max) / 2 - (low + high) / 2
      : Math.max(0, min - low) - Math.max(0, high - max);
  return [
    axis(rect.left, rect.right, bounds.left, bounds.right),
    axis(rect.bottom, rect.top, bounds.bottom, bounds.top),
  ];
}

/**
 * Starting from `start`, move the card by what `want` asks of its projected bounds, then into
 * view. A few rounds absorb the perspective of a card that is not straight ahead. A card far
 * bigger than the view has no stable fit (its corners swing toward the eye plane), so it stays at
 * `start`; one still not wholly in front goes farther away until it is.
 */
function fitCard(
  ctx: PresentContext,
  viewFromWorld: Pose,
  card: Card,
  depth: number,
  start: Point,
  want: (rect: Rect) => Point,
): Pose {
  let point = start;
  for (let round = 0; round < 8; round++) {
    const projection = project(
      cardCorners(card.width, card.height, card.top, cardAt(ctx, card, point, depth)),
      viewFromWorld,
    );
    if (!projection) {
      point = start;
      break;
    }
    const [dx, dy] = want(projection.rect);
    const { rect } = projection;
    const moved = {
      left: rect.left + dx,
      right: rect.right + dx,
      bottom: rect.bottom + dy,
      top: rect.top + dy,
    };
    const [vx, vy] = intoView(moved, PANEL_VIEW);
    if (Math.abs(dx + vx) < 1e-6 && Math.abs(dy + vy) < 1e-6) break;
    point = [point[0] + dx + vx, point[1] + dy + vy];
    if (Math.hypot(...point) > RUNAWAY) {
      point = start;
      break;
    }
  }
  let pose = cardAt(ctx, card, point, depth);
  for (let farther = depth; farther < 4 * depth && !inFront(pose, card, viewFromWorld); ) {
    farther *= 1.25;
    pose = cardAt(ctx, card, point, farther);
  }
  return pose;
}

const inFront = (pose: Pose, card: Card, viewFromWorld: Pose) =>
  cardCorners(card.width, card.height, card.top, pose).every(
    (p) => transformPoint(viewFromWorld, p)[2] < -NEAR - 0.02,
  );

/** A fit this far off the line of sight (about 60 degrees) is running away, not converging. */
const RUNAWAY = 1.15;

const midX = (r: Rect) => (r.left + r.right) / 2;
const midY = (r: Rect) => (r.bottom + r.top) / 2;

/**
 * Where `slot` asks the card's projected bounds to be: `gap` away from the anchor, or for a gaze
 * slot, `gap` farther out toward the edge of the view (down for low, up for high).
 */
function slotWant(slot: PanelSlot, anchor: Anchor | null, gap: number): (rect: Rect) => Point {
  const a = anchor?.rect;
  if (a && slot === 'above') return (r) => [midX(a) - midX(r), a.top + gap - r.bottom];
  if (a && slot === 'below') return (r) => [midX(a) - midX(r), a.bottom - gap - r.top];
  if (a && slot === 'right') return (r) => [a.right + gap - r.left, midY(a) - midY(r)];
  if (a && slot === 'left') return (r) => [a.left - gap - r.right, midY(a) - midY(r)];
  const [x, y] = slot === 'high' ? [HIGH[0], HIGH[1] + gap] : [LOW[0], LOW[1] - gap];
  return (r) => [x - midX(r), y - midY(r)];
}

/** Gaze slots edge outward in these steps when objects are in the way, up to the view's edge. */
const GAZE_STEPS = [0, 0.06, 0.12, 0.18, 0.24];

/** Where the card belongs now. `previous` is the slot it is in, which it keeps while clear. */
export function panelTarget(
  ctx: PresentContext,
  width: number,
  height: number,
  top: number,
  previous: PanelSlot | null,
): PanelTarget {
  const viewFromWorld = invertPose(ctx.head);
  const card = { width, height, top };
  const wasBeside = previous !== null && besideObjects(previous);
  const anchor = findAnchor(ctx, viewFromWorld, wasBeside);
  const first = (slots: readonly PanelSlot[]) =>
    previous && slots.includes(previous)
      ? [previous, ...slots.filter((s) => s !== previous)]
      : slots;

  if (anchor) {
    const objects = obstacleGeometry(ctx, false);
    for (const slot of first(OBJECT_SLOTS)) {
      // Further out only if stereo disparity eats the cushion at an unusual depth.
      for (const spread of [1, 2]) {
        const gap = ((PANEL_MASK_GAP + SLOT_CUSHION) * spread * PANEL_DISTANCE) / anchor.depth;
        const start: Point = [midX(anchor.rect), midY(anchor.rect)];
        const pose = fitCard(
          ctx,
          viewFromWorld,
          card,
          anchor.depth,
          start,
          slotWant(slot, anchor, gap),
        );
        if (clearAtPose(ctx, width, height, top, pose, objects)) return { pose, slot };
      }
    }
  }
  const everything = obstacleGeometry(ctx, true);
  for (const slot of first(GAZE_SLOTS)) {
    const start = slot === 'high' ? HIGH : LOW;
    for (const step of GAZE_STEPS) {
      const want = slotWant(slot, null, step);
      const pose = fitCard(ctx, viewFromWorld, card, PANEL_DISTANCE, start, want);
      if (clearAtPose(ctx, width, height, top, pose, everything)) return { pose, slot };
    }
  }
  // Nothing is clear. Stay beside the lit objects if any are in view, else above the work.
  if (anchor) {
    const gap = ((PANEL_MASK_GAP + SLOT_CUSHION) * PANEL_DISTANCE) / anchor.depth;
    const start: Point = [midX(anchor.rect), anchor.rect.top];
    const pose = fitCard(
      ctx,
      viewFromWorld,
      card,
      anchor.depth,
      start,
      slotWant('above', anchor, gap),
    );
    return { pose, slot: 'above' };
  }
  return {
    pose: fitCard(ctx, viewFromWorld, card, PANEL_DISTANCE, HIGH, slotWant('high', null, 0)),
    slot: 'high',
  };
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
  // Project the actual card and objects independently for both eyes. This handles a card at any
  // distance and heading without assuming head alignment or approximating stereo.
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

/**
 * Whether this exact world-space card remains visually clear of every known object, and of
 * nearby furniture unless `scene` is false (a card beside the lit objects sits over the worktop).
 */
export function isInstructionPanelClear(
  ctx: PresentContext,
  width: number,
  height: number,
  top: number,
  pose: Pose,
  scene = true,
): boolean {
  return clearAtPose(ctx, width, height, top, pose, obstacleGeometry(ctx, scene));
}

const overlaps = (a: Rect, b: Rect) =>
  a.left < b.right - 1e-8 &&
  a.right > b.left + 1e-8 &&
  a.bottom < b.top - 1e-8 &&
  a.top > b.bottom + 1e-8;
