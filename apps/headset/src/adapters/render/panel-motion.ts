import {
  distance,
  invertPose,
  normalize,
  type Pose,
  type Quat,
  sub,
  transformPoint,
  type Vec3,
} from '../../core/math';
import { jointPosition } from '../../domain/hands/features';
import {
  besideObjects,
  cardAround,
  facingEye,
  isInstructionPanelClear,
  type PanelSlot,
  panelTarget,
} from './panel-placement';
import type { PresentContext } from './presenter';

// The card follows lazily and always faces the learner. Its center rests exactly where it is while
// its target (panel-placement.ts) stays close: within 4 degrees of its spot beside the lit objects,
// or 10 degrees of its gaze slot when nothing lit is in view. Once the target is farther, changes
// side, or something covers the card, the center glides there on a critically damped spring,
// tracking the target until it arrives, then rests again. Head bob and tracker jitter never move
// it; a step's new object or a turn of the head does, smoothly. Whether resting or gliding, its
// face turns to the eye every frame, about its center, without rolling. Only the first placement
// is a jump; reduced motion jumps instead of gliding. A fingertip near the card holds it still.
export const OBJECT_SLACK_DEG = 4;
export const GAZE_SLACK_DEG = 10;
/** Natural frequency of the glide: about 0.8 s to 95% of the way there. */
const OMEGA = 6;
/** Depth changes this large move the card even when its direction holds. */
const DEPTH_SLACK_M = 0.1;
const ARRIVED_M = 0.003;
const ARRIVED_SPEED = 0.02;
/** Longest frame the spring integrates, so a stalled frame does not fling the card. */
const MAX_STEP_MS = 100;

export interface PanelMotionOptions {
  /** Reduced motion moves the card in one step, and only when it has to. */
  reducedMotion?: () => boolean;
}

export class InstructionPanelMotion {
  /** The card's center, world space. */
  private center: Vec3 | null = null;
  /** Its last orientation, kept while a fingertip holds it. */
  private q: Quat = [0, 0, 0, 1];
  private slot: PanelSlot | null = null;
  private moving = false;
  private velocity: Vec3 = [0, 0, 0];
  private last = 0;

  constructor(private readonly options: PanelMotionOptions = {}) {}

  update(ctx: PresentContext, width: number, height: number, top: number): Pose {
    const target = panelTarget(ctx, width, height, top, this.slot);
    const goal = cardCenter(target.pose, height, top);
    if (!this.center) {
      this.last = ctx.t;
      return this.arrive(ctx, goal, target.slot, height, top);
    }
    // A second call at the same timestamp (text that finished laying out) integrates nothing.
    const dt = Math.min(MAX_STEP_MS, Math.max(0, ctx.t - this.last)) / 1000;
    this.last = Math.max(this.last, ctx.t);
    const held = cardAround(this.center, this.q, height, top);
    if (handNearCard(ctx, held, width, height, top)) {
      this.halt();
      return held;
    }
    if (!this.moving && !this.needsToMove(ctx, goal, target.slot, width, height, top)) {
      return this.facing(ctx, height, top);
    }
    this.moving = true;
    this.slot = target.slot;
    if (this.options.reducedMotion?.()) return this.arrive(ctx, goal, target.slot, height, top);

    const center: Vec3 = [0, 0, 0];
    for (const axis of [0, 1, 2] as const) {
      const step = spring(this.center[axis] - goal[axis], this.velocity[axis], dt);
      center[axis] = goal[axis] + step.offset;
      this.velocity[axis] = step.velocity;
    }
    this.center = center;
    if (distance(center, goal) < ARRIVED_M && Math.hypot(...this.velocity) < ARRIVED_SPEED) {
      return this.arrive(ctx, goal, target.slot, height, top);
    }
    return this.facing(ctx, height, top);
  }

  private needsToMove(
    ctx: PresentContext,
    goal: Vec3,
    slot: PanelSlot,
    width: number,
    height: number,
    top: number,
  ): boolean {
    if (!this.center || slot !== this.slot) return true;
    const now = cardAround(this.center, facingEye(this.center, ctx.head), height, top);
    if (!isInstructionPanelClear(ctx, width, height, top, now, !besideObjects(slot))) return true;
    const here = sub(this.center, ctx.head.p);
    const there = sub(goal, ctx.head.p);
    const cos = Math.min(1, Math.max(-1, dotUnit(here, there)));
    const slack = besideObjects(slot) ? OBJECT_SLACK_DEG : GAZE_SLACK_DEG;
    return (
      Math.acos(cos) > (slack * Math.PI) / 180 ||
      Math.abs(Math.hypot(...here) - Math.hypot(...there)) > DEPTH_SLACK_M
    );
  }

  /** The card at its center, turned to face the eye now. */
  private facing(ctx: PresentContext, height: number, top: number): Pose {
    const center = this.center ?? ctx.head.p;
    this.q = facingEye(center, ctx.head);
    return cardAround(center, this.q, height, top);
  }

  private arrive(
    ctx: PresentContext,
    goal: Vec3,
    slot: PanelSlot,
    height: number,
    top: number,
  ): Pose {
    this.center = [...goal];
    this.slot = slot;
    this.halt();
    return this.facing(ctx, height, top);
  }

  private halt(): void {
    this.moving = false;
    this.velocity = [0, 0, 0];
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
