import type { NormalizedBox, NormalizedPoint } from '@clio/protocol';
import type { Vec3 } from '../core/math';
import { boxCenter } from './fit';

// The desk lab has no headset pose and no depth, so nothing it sees is placed in 3D. The lesson
// still asks the registry whether an object has been found: the coach's highlight answers
// "shown" only then, and an object never found is announced missing. So a seen object gets a
// stand-in position: its image point laid flat on the workspace, as if the camera looked straight
// down on the table (left to right along +x, the top of the picture far away at -z, the bottom at
// the near edge). It is never measured, and only coarse checks between objects can read anything
// into it. Nothing here is recorded: the desk lab writes no episode.

/** The workspace the stand-in positions lie on (m): the planner's default table. */
export const DESK_WORKSPACE: readonly [number, number] = [0.8, 0.6];

/** Where a normalized image point stands in on the workspace (workspace frame, meters). */
export function standInPosition(
  point: NormalizedPoint,
  size: readonly [number, number] = DESK_WORKSPACE,
): Vec3 {
  const [width, depth] = size;
  const u = Math.min(1, Math.max(0, point[0]));
  const v = Math.min(1, Math.max(0, point[1]));
  return [u * width, 0, -(1 - v) * depth];
}

/** The point an object is placed by: where it rests (contact), else its inside point, else its box. */
export function anchorPoint(d: {
  contact?: NormalizedPoint | null;
  point?: NormalizedPoint | null;
  box?: NormalizedBox | null;
}): NormalizedPoint | null {
  return d.contact ?? d.point ?? (d.box ? boxCenter(d.box) : null);
}
