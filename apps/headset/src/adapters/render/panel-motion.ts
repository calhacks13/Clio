import {
  distance,
  invertPose,
  normalize,
  type Pose,
  quatFromAxisAngle,
  sub,
  transformPoint,
  type Vec3,
} from '../../core/math';
import { jointPosition } from '../../domain/hands/features';
import {
  besideObjects,
  isInstructionPanelClear,
  type PanelSlot,
  type PanelTarget,
  panelTarget,
} from './panel-placement';
import type { PresentContext } from './presenter';

// The card follows lazily. It rests exactly where it is while its target (panel-placement.ts) stays
// close: within 4 degrees of its spot beside the lit objects, or 10 degrees of its gaze slot when
// nothing lit is in view. Once the target is farther, changes side, or something covers the card,
// it glides there on a critically damped spring, tracking the target until it arrives, then rests
// again. Head bob and tracker jitter never move it; a step's new object or a turn of the head
// does, smoothly. Only the first placement is a jump. Reduced motion jumps instead of gliding.
export const OBJECT_SLACK_DEG = 4;
export const GAZE_SLACK_DEG = 10;
/** Natural frequency of the glide: about 0.8 s to 95% of the way there. */
const OMEGA = 6;
/** Depth changes this large move the card even when its direction holds. */
const DEPTH_SLACK_M = 0.1;
const ARRIVED_M = 0.003;
const ARRIVED_SPEED = 0.02;
const ARRIVED_YAW = (0.5 * Math.PI) / 180;
/** Longest frame the spring integrates, so a stalled frame does not fling the card. */
const MAX_STEP_MS = 100;

export interface PanelMotionOptions {
  /** Reduced motion moves the card in one step, and only when it has to. */
  reducedMotion?: () => boolean;
}

export class InstructionPanelMotion {
  private pose: Pose | null = null;
  private slot: PanelSlot | null = null;
  private moving = false;
  private velocity: Vec3 = [0, 0, 0];
  private yawVelocity = 0;
  private last = 0;

  constructor(private readonly options: PanelMotionOptions = {}) {}

  update(ctx: PresentContext, width: number, height: number, top: number): Pose {
    const target = panelTarget(ctx, width, height, top, this.slot);
    if (!this.pose) {
      this.last = ctx.t;
      return this.arrive(target);
    }
    // A second call at the same timestamp (text that finished laying out) integrates nothing.
    const dt = Math.min(MAX_STEP_MS, Math.max(0, ctx.t - this.last)) / 1000;
    this.last = Math.max(this.last, ctx.t);
    if (handNearCard(ctx, this.pose, width, height, top)) {
      this.halt();
      return this.pose;
    }
    if (!this.moving && !this.needsToMove(ctx, target, width, height, top)) return this.pose;
    this.moving = true;
    this.slot = target.slot;
    if (this.options.reducedMotion?.()) return this.arrive(target);

    const goalYaw = yawOf(target.pose.q);
    let yaw = yawOf(this.pose.q);
    const p: Vec3 = [0, 0, 0];
    for (const axis of [0, 1, 2] as const) {
      const step = spring(this.pose.p[axis] - target.pose.p[axis], this.velocity[axis], dt);
      p[axis] = target.pose.p[axis] + step.offset;
      this.velocity[axis] = step.velocity;
    }
    const turn = spring(wrapAngle(yaw - goalYaw), this.yawVelocity, dt);
    yaw = goalYaw + turn.offset;
    this.yawVelocity = turn.velocity;
    this.pose = { p, q: quatFromAxisAngle([0, 1, 0], yaw) };
    if (
      distance(p, target.pose.p) < ARRIVED_M &&
      Math.hypot(...this.velocity) < ARRIVED_SPEED &&
      Math.abs(turn.offset) < ARRIVED_YAW
    ) {
      return this.arrive(target);
    }
    return this.pose;
  }

  private needsToMove(
    ctx: PresentContext,
    target: PanelTarget,
    width: number,
    height: number,
    top: number,
  ): boolean {
    if (!this.pose || target.slot !== this.slot) return true;
    const slot = this.slot;
    if (!isInstructionPanelClear(ctx, width, height, top, this.pose, !besideObjects(slot))) {
      return true;
    }
    const here = sub(cardCenter(this.pose, height, top), ctx.head.p);
    const there = sub(cardCenter(target.pose, height, top), ctx.head.p);
    const cos = Math.min(1, Math.max(-1, dotUnit(here, there)));
    const slack = besideObjects(slot) ? OBJECT_SLACK_DEG : GAZE_SLACK_DEG;
    return (
      Math.acos(cos) > (slack * Math.PI) / 180 ||
      Math.abs(Math.hypot(...here) - Math.hypot(...there)) > DEPTH_SLACK_M
    );
  }

  private arrive(target: PanelTarget): Pose {
    this.pose = { p: [...target.pose.p], q: [...target.pose.q] };
    this.slot = target.slot;
    this.halt();
    return this.pose;
  }

  private halt(): void {
    this.moving = false;
    this.velocity = [0, 0, 0];
    this.yawVelocity = 0;
  }
}

/**
 * Exact critically damped response over one step toward a fixed goal, so the glide is the same
 * at any frame rate: `offset` is the distance still to go, `velocity` its rate of change.
 */
function spring(
  offset: number,
  velocity: number,
  dt: number,
): { offset: number; velocity: number } {
  const decay = Math.exp(-OMEGA * dt);
  const drift = velocity + OMEGA * offset;
  return {
    offset: (offset + drift * dt) * decay,
    velocity: (velocity - OMEGA * drift * dt) * decay,
  };
}

/** The heading of an upright, level card's orientation. */
const yawOf = (q: Pose['q']) => 2 * Math.atan2(q[1], q[3]);

const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

const cardCenter = (pose: Pose, height: number, top: number) =>
  transformPoint(pose, [0, top - height / 2, 0]);

function dotUnit(a: Vec3, b: Vec3): number {
  const [ax, ay, az] = normalize(a);
  const [bx, by, bz] = normalize(b);
  return ax * bx + ay * by + az * bz;
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
