import {
  distance,
  invertPose,
  lerp,
  lerpPose,
  type Pose,
  slerp,
  transformPoint,
} from '../../core/math';
import { jointPosition } from '../../domain/hands/features';
import { isInstructionPanelClear, placeInstructionPanel } from './panel-placement';
import type { PresentContext } from './presenter';

// The card is a room anchor, not a head-locked billboard. Ordinary turns, head bob and short
// glances leave both its world position and orientation exactly unchanged. A sustained loss of
// reading reach earns one slow catch-up to a captured world target; it never chases the next frame.
export const PANEL_RECENTER_DWELL_MS = 800;
const RECENTER_COOLDOWN_MS = 2200;
const MAX_YAW = (50 * Math.PI) / 180;
const MAX_PITCH = (40 * Math.PI) / 180;
const NEAR_REACH = 0.35;
const FAR_REACH = 1.45;
const POSITION_OMEGA = 7.5;
const ORIENTATION_OMEGA = 6;
const SETTLE_MS = 1600;

interface CatchUp {
  from: Pose;
  to: Pose;
  started: number;
}

export interface PanelMotionOptions {
  /** Reduced motion keeps the anchor fixed; only necessary collision relocations are immediate. */
  reducedMotion?: () => boolean;
}

export class InstructionPanelMotion {
  private pose: Pose | null = null;
  private catchUp: CatchUp | null = null;
  private outsideSince: number | null = null;
  private cooldownUntil = -Infinity;

  constructor(private readonly options: PanelMotionOptions = {}) {}

  update(ctx: PresentContext, width: number, height: number, top: number): Pose {
    if (!this.pose) return this.relocate(ctx, width, height, top);
    // This runs even for a second call at the same timestamp: asynchronous text can resize
    // between XR frames, and its newly occupied space must be checked before it renders.
    if (!isInstructionPanelClear(ctx, width, height, top, this.pose)) {
      return this.relocate(ctx, width, height, top);
    }
    if (this.options.reducedMotion?.() || handNearCard(ctx, this.pose, width, height, top)) {
      this.cancelCatchUp(ctx.t);
      return this.pose;
    }

    if (this.catchUp) {
      const flight = this.catchUp;
      const elapsed = Math.max(0, ctx.t - flight.started);
      const next: Pose = {
        p: lerp(flight.from.p, flight.to.p, response(elapsed, POSITION_OMEGA)),
        q: slerp(flight.from.q, flight.to.q, response(elapsed, ORIENTATION_OMEGA)),
      };
      // Check the short swept path too, so a delayed frame cannot tunnel across a silhouette.
      if (!clearPath(ctx, this.pose, next, width, height, top)) {
        this.cancelCatchUp(ctx.t);
        return this.pose;
      }
      this.pose = next;
      if (elapsed >= SETTLE_MS) {
        if (clearPath(ctx, this.pose, flight.to, width, height, top)) this.pose = flight.to;
        this.cancelCatchUp(ctx.t);
      }
      return this.pose;
    }

    if (ctx.t < this.cooldownUntil || !outsideReadingReach(ctx, this.pose, height, top)) {
      this.outsideSince = null;
      return this.pose;
    }
    this.outsideSince ??= ctx.t;
    if (ctx.t - this.outsideSince < PANEL_RECENTER_DWELL_MS) return this.pose;

    const target = copyPose(placeInstructionPanel(ctx, width, height, top, null));
    if (!isInstructionPanelClear(ctx, width, height, top, target)) {
      this.cancelCatchUp(ctx.t);
      return this.pose;
    }
    this.catchUp = { from: copyPose(this.pose), to: target, started: ctx.t };
    this.outsideSince = null;
    return this.pose;
  }

  private relocate(ctx: PresentContext, width: number, height: number, top: number): Pose {
    const wasAnchored = this.pose !== null;
    this.pose = copyPose(placeInstructionPanel(ctx, width, height, top, null));
    this.catchUp = null;
    this.outsideSince = null;
    // Initial anchoring should not impose a recovery delay; collision relocations should settle.
    this.cooldownUntil = wasAnchored ? ctx.t + RECENTER_COOLDOWN_MS : -Infinity;
    return this.pose;
  }

  private cancelCatchUp(t: number): void {
    if (this.catchUp) this.cooldownUntil = t + RECENTER_COOLDOWN_MS;
    this.catchUp = null;
    this.outsideSince = null;
  }
}

const copyPose = (pose: Pose): Pose => ({ p: [...pose.p], q: [...pose.q] });

/** Exact critically damped step response, independent of frame rate and repeated update calls. */
function response(elapsedMs: number, omega: number): number {
  const t = elapsedMs / 1000;
  return 1 - (1 + omega * t) * Math.exp(-omega * t);
}

function outsideReadingReach(
  ctx: PresentContext,
  pose: Pose,
  height: number,
  top: number,
): boolean {
  const center = transformPoint(pose, [0, top - height / 2, 0]);
  const [x, y, z] = transformPoint(invertPose(ctx.head), center);
  const reach = Math.hypot(x, y, z);
  return (
    Math.abs(Math.atan2(x, -z)) > MAX_YAW ||
    Math.abs(Math.atan2(y, Math.hypot(x, z))) > MAX_PITCH ||
    reach < NEAR_REACH ||
    reach > FAR_REACH
  );
}

function handNearCard(
  ctx: PresentContext,
  pose: Pose,
  width: number,
  height: number,
  top: number,
): boolean {
  if (!ctx.hands) return false;
  const cardFromWorld = invertPose(pose);
  for (const hand of [ctx.hands.left, ctx.hands.right]) {
    if (!hand) continue;
    const tip = transformPoint(ctx.worldFromWorkspace, jointPosition(hand, 'index-finger-tip'));
    const [x, y, z] = transformPoint(cardFromWorld, tip);
    if (
      Math.abs(x) < width / 2 + 0.08 &&
      y > top - height - 0.08 &&
      y < top + 0.08 &&
      Math.abs(z) < 0.12
    )
      return true;
  }
  return false;
}

function quaternionAngle(a: Pose['q'], b: Pose['q']): number {
  const dot = Math.abs(a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0));
  return 2 * Math.acos(Math.min(1, dot));
}

function clearPath(
  ctx: PresentContext,
  from: Pose,
  to: Pose,
  width: number,
  height: number,
  top: number,
): boolean {
  const steps = Math.max(
    1,
    Math.ceil(distance(from.p, to.p) / 0.015),
    Math.ceil(quaternionAngle(from.q, to.q) / 0.04),
  );
  for (let step = 1; step <= steps; step++) {
    if (!isInstructionPanelClear(ctx, width, height, top, lerpPose(from, to, step / steps)))
      return false;
  }
  return true;
}
