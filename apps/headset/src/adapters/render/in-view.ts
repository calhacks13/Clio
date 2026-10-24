import { type Quat, quatFromAxisAngle, quatMultiply, rotateVec, type Vec3 } from '../../core/math';

// Where a panel that trails the head goes: the lesson's instruction card, the debug HUDs, the
// tracking page's counts. Each rests a little below the line of sight, ahead on the head's
// heading. Placed by heading alone, a panel drops out of view as soon as the learner looks down:
// leaning over the table to work on something 10 to 40 cm away puts the gaze 50 to 80 degrees
// down, and a card at eye height is then above the top of the view. So its elevation follows the
// gaze's pitch: it stays at its rest elevation while that is within IN_VIEW_RAD of the gaze, and
// that far from the gaze otherwise (above it when looking down, so it never covers the work), at
// the same distance from the head. The heading comes from the up vector as well as the forward
// one, so it stays defined (and steady) when the gaze is straight down, where forward has none.

/**
 * A panel stays within this angle of the gaze (rad): inside the sharp middle of Quest 3's
 * 96-degree vertical view, with room for the panel itself.
 */
export const IN_VIEW_RAD = (20 * Math.PI) / 180;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The gaze's pitch (rad, + up) for a head orientation. */
export function gazePitch(q: Readonly<Quat>): number {
  return Math.asin(clamp(rotateVec(q, [0, 0, -1])[1], -1, 1));
}

/**
 * The head's heading on the floor, a unit [x, z], however far it looks up or down: its forward
 * vector plus its up vector, which leans forward when looking down and back when looking up.
 * Null only for a degenerate orientation.
 */
export function gazeHeading(q: Readonly<Quat>): [number, number] | null {
  const f = rotateVec(q, [0, 0, -1]);
  const u = rotateVec(q, [0, 1, 0]);
  const s = f[1] < 0 ? 1 : -1;
  const x = f[0] + s * u[0];
  const z = f[2] + s * u[2];
  const l = Math.hypot(x, z);
  return l > 1e-6 ? [x / l, z / l] : null;
}

/** The elevation (rad) of a panel resting at `rest` while the gaze is pitched `pitch`. */
export function keepInView(rest: number, pitch: number, within = IN_VIEW_RAD): number {
  return clamp(rest, pitch - within, pitch + within);
}

export interface PanelPlace {
  /** World space. */
  point: Vec3;
  /** The heading used (unit [x, z]). */
  heading: [number, number];
  /** Elevation from the eye (rad, + up). */
  elevation: number;
}

/**
 * Where a panel that rests `ahead` m in front of the head and `drop` m below eye height goes for
 * this head pose: the same distance from the head, raised or lowered to stay in view. `last` is
 * the heading to keep should this orientation have none.
 */
export function panelPlace(
  head: { p: Readonly<Vec3>; q: Readonly<Quat> },
  ahead: number,
  drop: number,
  last: readonly [number, number] = [0, -1],
  within = IN_VIEW_RAD,
): PanelPlace {
  const heading = gazeHeading(head.q) ?? [last[0], last[1]];
  const elevation = keepInView(Math.atan2(-drop, ahead), gazePitch(head.q), within);
  const distance = Math.hypot(ahead, drop);
  const level = Math.cos(elevation) * distance;
  return {
    point: [
      head.p[0] + heading[0] * level,
      head.p[1] + Math.sin(elevation) * distance,
      head.p[2] + heading[1] * level,
    ],
    heading,
    elevation,
  };
}

/**
 * The orientation of a panel (a plane facing +z) at `elevation` on `heading` that faces the eye:
 * turned to the heading, then tilted by the elevation, its x axis kept level.
 */
export function facingEye(heading: readonly [number, number], elevation: number): Quat {
  const yaw = quatFromAxisAngle([0, 1, 0], Math.atan2(-heading[0], -heading[1]));
  return quatMultiply(yaw, quatFromAxisAngle([1, 0, 0], elevation));
}
