import type {
  EnvironmentDoc,
  Pose7,
  RetargetDoc,
  SurfaceKind,
} from "@clio/protocol";
import { rosFromW } from "@clio-viewer/capture/from-clio";
import type { Handedness, Vec3 } from "@clio-viewer/capture/model";
import { type Plane, rotate } from "./object-display";

// What the scene draws from a compiled episode (derived.ts): the environment's table, floor and
// detected planes, and each retargeted robot arm at one recording time `tUs`. Compiled documents
// are in the workspace frame W, like the raw episode. Everything here comes out in the Capture's
// ROS frame (z up, meters), converted once with rosFromW, so the layers draw it inside the scene's
// ROS group exactly as they draw raw data. Pure: no DOM or three.js.

/** `local`, given in a pose's own frame, in W: the pose's position plus its rotation of `local`. */
function inPose(pose: Pose7, local: Vec3): Vec3 {
  const [px, py, pz, qx, qy, qz, qw] = pose;
  const norm = Math.hypot(qx, qy, qz, qw) || 1;
  const r = rotate([qx / norm, qy / norm, qz / norm, qw / norm], local);
  return [px + r[0], py + r[1], pz + r[2]];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (v: Vec3): Vec3 | null => {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 1e-9 ? [v[0] / n, v[1] / n, v[2] / n] : null;
};
const at = (p: Vec3, d: Vec3, k: number): Vec3 => [
  p[0] + d[0] * k,
  p[1] + d[1] * k,
  p[2] + d[2] * k,
];

const mean = (points: readonly Vec3[]): Vec3 => {
  const sum: Vec3 = [0, 0, 0];
  for (const p of points) for (let i = 0; i < 3; i++) sum[i] += p[i];
  const n = Math.max(1, points.length);
  return [sum[0] / n, sum[1] / n, sum[2] / n];
};

/** A detected plane as last seen, as a closed outline. */
export interface CompiledPlane {
  id: string;
  kind: SurfaceKind;
  /** The polygon's corners in ROS, in order; the last joins the first. */
  outline: Vec3[];
  /** The corners' mean in ROS, where a label goes. */
  center: Vec3;
}

/** Every detected plane: its plane-local [x, z] polygon placed by its W pose, then in ROS. */
export function compiledPlanes(env: EnvironmentDoc): CompiledPlane[] {
  return env.planes.map((plane) => {
    const outline = plane.polygon.map(([x, z]) =>
      rosFromW(inPose(plane.pose, [x, 0, z])),
    );
    return { id: plane.id, kind: plane.kind, outline, center: mean(outline) };
  });
}

export interface CompiledTable {
  /** The table surface's corners in ROS: its origin, then along +x, then the far corners. */
  corners: Vec3[];
  center: Vec3;
  source: EnvironmentDoc["table"]["source"];
}

/**
 * The compiled table surface: `size` is [along +x, along -z] in its pose's own frame, from the
 * pose's origin. That origin is the calibration corner for a table from calibration or the plan
 * (an identity pose spans the workspace box), or a corner of the detected table plane, turned
 * with it, for a table from planes. The whole pose places the rectangle in W, which then reaches
 * ROS once. Null when the size is unknown.
 */
export function compiledTable(env: EnvironmentDoc): CompiledTable | null {
  const { pose, size, source } = env.table;
  if (!size) return null;
  const [sx, sz] = size;
  const local: Vec3[] = [
    [0, 0, 0],
    [sx, 0, 0],
    [sx, 0, -sz],
    [0, 0, -sz],
  ];
  const corners = local.map((p) => rosFromW(inPose(pose, p)));
  return { corners, center: mean(corners), source };
}

/**
 * The compiled floor in ROS: its +y normal, and the W origin (the table corner) projected onto it.
 * The pose's own origin is where the XR session started, so it would move the floor grid away from
 * the table; the projection is the point calibratedFloor uses for the same worldFromWorkspace.
 * Reads only the pose: tableHeightM may be null.
 */
export function compiledFloor(env: EnvironmentDoc): Plane | null {
  if (!env.floor) return null;
  const { pose } = env.floor;
  const origin = inPose(pose, [0, 0, 0]);
  const normal = unit(sub(inPose(pose, [0, 1, 0]), origin));
  if (!normal) return null;
  // The W origin's projection onto the plane: (origin . normal) normal.
  const point = at([0, 0, 0], normal, dot(origin, normal));
  return { point: rosFromW(point), normal: rosFromW(normal) };
}

/**
 * The grid frame in force at `tUs`: the newest at or before it, or -1 before the first frame and
 * more than one frame interval after the last. Grid times are ms, compared as whole µs.
 */
export function gridFrameAt(
  t: readonly number[],
  fps: number,
  tUs: number,
): number {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (Math.round(t[mid] * 1000) <= tUs) lo = mid + 1;
    else hi = mid;
  }
  const i = lo - 1;
  if (i < 0) return -1;
  if (i === t.length - 1 && tUs - Math.round(t[i] * 1000) > 1e6 / fps) {
    return -1;
  }
  return i;
}

/** One retargeted arm at one grid frame. */
export interface ArmPose {
  hand: Handedness;
  /** Joint origins from the base to the tool, in ROS. */
  links: Vec3[];
  /** 0 open to 1 closed; null when not solved. */
  gripper: number | null;
}

/** Each arm of `doc` at `tUs`, or null where it has no solution (null q) or no grid frame. */
export function armsAt(doc: RetargetDoc, tUs: number): (ArmPose | null)[] {
  const i = gridFrameAt(doc.t, doc.fps, tUs);
  return doc.arms.map((arm) => {
    if (i < 0) return null;
    const links = arm.links[i];
    if (!arm.q[i] || !links || links.length === 0) return null;
    return {
      hand: arm.hand,
      links: links.map((p) => rosFromW(p)),
      gripper: arm.gripper[i] ?? null,
    };
  });
}

/** Where an arm's base stands, in ROS. */
export const armBase = (arm: RetargetDoc["arms"][number]): Vec3 =>
  rosFromW(arm.baseInWorkspace);

/** Gripper finger length and half the gap between the fingers, open and closed, in m. */
export const GRIPPER = { finger: 0.03, openHalf: 0.025, closedHalf: 0.006 };

/**
 * The gripper at the tool as three segments (six ROS points): a bar across the tool and a finger
 * from each end along the last link, apart by how open the gripper is. Null with fewer than two
 * links.
 */
export function gripperLines(
  links: readonly Vec3[],
  closed: number,
): Vec3[] | null {
  if (links.length < 2) return null;
  const tool = links[links.length - 1];
  const along = unit(sub(tool, links[links.length - 2])) ?? [0, 0, -1];
  const side = unit(cross(along, [0, 0, 1])) ??
    unit(cross(along, [1, 0, 0])) ?? [0, 1, 0];
  const k = Math.min(1, Math.max(0, closed));
  const half =
    GRIPPER.closedHalf + (GRIPPER.openHalf - GRIPPER.closedHalf) * (1 - k);
  const a = at(tool, side, half);
  const b = at(tool, side, -half);
  return [
    a,
    b,
    a,
    at(a, along, GRIPPER.finger),
    b,
    at(b, along, GRIPPER.finger),
  ];
}
