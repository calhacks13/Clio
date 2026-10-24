import {
  type Pose,
  quatFromBasis,
  rotateVec,
  transformPoint,
  type Vec3,
  yawOnly,
} from '../../core/math';
import type { Surface } from './surfaces';

// Snapping the workspace to the real table when a session starts, from WebXR plane detection (on
// Quest, the room setup's planes, labeled table, desk, floor and so on). The result keeps the frame
// of docs/ARCHITECTURE.md §9: origin on the table's near edge, +x along that edge to the user's
// right, +y up, +z toward the user.

/** A detected horizontal plane and its semantic label, when the runtime gives one. */
export interface TablePlane extends Surface {
  label: string | null;
}

export interface TableChoice {
  plane: TablePlane;
  /** label: the nearest plane labeled table or desk. size: the largest plane at table height. */
  by: 'label' | 'size';
}

export interface TableFit {
  /** World from workspace. */
  pose: Pose;
  /** The table top's extent along the near edge and away from the user (m). */
  size: [number, number];
}

const TABLE_LABELS = ['table', 'desk'];
/** Horizontal planes that are never the work surface, whatever their height. */
const NOT_TABLES = ['floor', 'ceiling', 'couch', 'bed'];
/**
 * Furthest the table's nearest point may be from the head, measured on the floor (m): a step or
 * two, since the user may start the session before walking up to the table.
 */
const REACH_M = 1.8;
/** Widest angle between the heading and the direction to the table's nearest point. */
const AHEAD_RAD = Math.PI / 3;
/** Height of an unlabeled table top (m); local-floor puts the floor at y = 0. */
const TABLE_HEIGHT_M = [0.5, 1.2] as const;
/** Smallest table top (m²), so a stool or a sliver of detected plane never wins. */
const MIN_AREA_M2 = 0.09;
/** Work-area width, as in workspaceInFrontOf. */
const WORK_WIDTH_M = 0.6;

/** A point on the floor plane: world x, z. */
type Point = readonly [number, number];

/** The plane the workspace should snap to, or null when none is in reach in front of the user. */
export function chooseTablePlane(planes: readonly TablePlane[], head: Pose): TableChoice | null {
  const usable = planes
    .map((plane) => ({ plane, label: plane.label?.toLowerCase() ?? '', ...measure(plane, head) }))
    .filter((c) => c.ahead && c.reach <= REACH_M && c.area >= MIN_AREA_M2 && c.height < head.p[1]);
  const labeled = usable
    .filter((c) => TABLE_LABELS.includes(c.label))
    .sort((a, b) => a.reach - b.reach || b.area - a.area)[0];
  if (labeled) return { plane: labeled.plane, by: 'label' };
  const [low, high] = TABLE_HEIGHT_M;
  const largest = usable
    .filter((c) => !NOT_TABLES.includes(c.label) && c.height >= low && c.height <= high)
    .sort((a, b) => b.area - a.area)[0];
  return largest ? { plane: largest.plane, by: 'size' } : null;
}

/**
 * The workspace on a table top. +z is square to the table's edges on the side facing the user, so
 * +x runs along the near edge. The origin is the left end of the work area on that edge: the
 * table's near-left corner, or on a table wider than the work area, the point that centers the
 * work area on the user without leaving the table. A round top gets the user's heading instead.
 */
export function fitTable(plane: Surface, head: Pose, width = WORK_WIDTH_M): TableFit {
  const { points, height } = footprint(plane);
  const user: Point = [head.p[0], head.p[2]];
  const forward = heading(head);
  const edge = edgeAngle(points);
  let z: Point = [-forward[0], -forward[1]];
  if (edge !== null) {
    const toUser = facingUser(points, user, forward);
    let best = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < 4; k++) {
      const a = edge + (k * Math.PI) / 2;
      const d: Point = [Math.cos(a), Math.sin(a)];
      const score = along(d, toUser);
      if (score > best) [best, z] = [score, d];
    }
  }
  const x: Point = [z[1], -z[0]]; // y × z
  const u = points.map((p) => along(p, x));
  const v = points.map((p) => along(p, z));
  const [left, right] = [Math.min(...u), Math.max(...u)];
  const [far, near] = [Math.min(...v), Math.max(...v)];
  const start =
    right - left <= width
      ? left
      : Math.min(Math.max(along(user, x) - width / 2, left), right - width);
  const origin: Vec3 = [x[0] * start + z[0] * near, height, x[1] * start + z[1] * near];
  return {
    pose: { p: origin, q: quatFromBasis([x[0], 0, x[1]], [0, 1, 0], [z[0], 0, z[1]]) },
    size: [right - left, near - far],
  };
}

// ---- geometry on the floor plane --------------------------------------------------------------

interface Footprint {
  points: Point[];
  /** Mean height of the outline (m). */
  height: number;
  area: number;
}

function footprint(plane: Surface): Footprint {
  const world = plane.polygon.map(([x, z]) => transformPoint(plane.pose, [x, 0, z]));
  const points = world.map(([x, , z]): Point => [x, z]);
  let twice = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, zi] = points[i] ?? [0, 0];
    const [xj, zj] = points[j] ?? [0, 0];
    twice += xj * zi - xi * zj;
  }
  const height = world.reduce((sum, p) => sum + p[1], 0) / Math.max(world.length, 1);
  return { points, height, area: Math.abs(twice) / 2 };
}

function measure(plane: TablePlane, head: Pose): Footprint & { reach: number; ahead: boolean } {
  const shape = footprint(plane);
  const user: Point = [head.p[0], head.p[2]];
  const [nx, nz] = nearestPoint(shape.points, user);
  const reach = Math.hypot(nx - user[0], nz - user[1]);
  const ahead =
    reach < 1e-6 ||
    along([(nx - user[0]) / reach, (nz - user[1]) / reach], heading(head)) >= Math.cos(AHEAD_RAD);
  return { ...shape, reach, ahead };
}

const along = (p: Point, axis: Point) => p[0] * axis[0] + p[1] * axis[1];

/** Where the head faces, level. */
function heading(head: Pose): Point {
  const f = rotateVec(yawOnly(head.q), [0, 0, -1]);
  return [f[0], f[2]];
}

/** Unit direction from the table toward the user: the side they are at, then the way they look. */
function facingUser(points: readonly Point[], user: Point, forward: Point): Point {
  const [nx, nz] = nearestPoint(points, user);
  const d = Math.hypot(user[0] - nx, user[1] - nz);
  const side: Point = d > 1e-6 ? [(user[0] - nx) / d, (user[1] - nz) / d] : [0, 0];
  const sum: Point = [side[0] - forward[0], side[1] - forward[1]];
  const l = Math.hypot(sum[0], sum[1]);
  return l > 1e-6 ? [sum[0] / l, sum[1] / l] : [-forward[0], -forward[1]];
}

/** Direction of the outline's straight edges (mod 90°), or null when no direction dominates. */
function edgeAngle(points: readonly Point[]): number | null {
  let c = 0;
  let s = 0;
  let perimeter = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, zi] = points[i] ?? [0, 0];
    const [xj, zj] = points[j] ?? [0, 0];
    const length = Math.hypot(xi - xj, zi - zj);
    const angle = Math.atan2(zi - zj, xi - xj);
    c += length * Math.cos(4 * angle);
    s += length * Math.sin(4 * angle);
    perimeter += length;
  }
  // Edges square to each other agree on 4 × their angle; a round outline's edges cancel out.
  return Math.hypot(c, s) > perimeter / 2 ? Math.atan2(s, c) / 4 : null;
}

function contains(points: readonly Point[], [x, z]: Point): boolean {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, zi] = points[i] ?? [0, 0];
    const [xj, zj] = points[j] ?? [0, 0];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/** The outline's nearest point to p (p itself when p is over the outline). */
function nearestPoint(points: readonly Point[], p: Point): Point {
  if (contains(points, p)) return p;
  let best: Point = p;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, az] = points[j] ?? p;
    const [bx, bz] = points[i] ?? p;
    const [ex, ez] = [bx - ax, bz - az];
    const len2 = ex * ex + ez * ez;
    const s = len2 > 0 ? Math.min(Math.max(((p[0] - ax) * ex + (p[1] - az) * ez) / len2, 0), 1) : 0;
    const q: Point = [ax + ex * s, az + ez * s];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < bestD) [best, bestD] = [q, d];
  }
  return best;
}
