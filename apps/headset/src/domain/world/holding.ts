import type { Handedness, ObjectSpec } from '@clio/protocol';
import type { Pose } from '../../core/math';
import { gripClosure, palmPoint, wristPose } from '../hands/features';
import type { PinchTransition } from '../hands/pinch-detector';
import { HANDS, handOf, type TrackedFrame } from '../hands/types';
import type { ObjectRegistry } from './object-registry';

// Kinematic tracking of handled objects: when the learner pinches or grips a movable object, it is
// attached to that hand and rides with the wrist (tracked at frame rate) until released. This is
// what keeps a moving syringe or jug tracked without continuous vision.

export interface GraspOptions {
  /** Pinch reach beyond the object's radius (m). */
  pinchReach?: number;
  /** Palm reach beyond the object's radius for a fist grasp (m). */
  palmReach?: number;
  /** Mean fingertip-to-palm distance below which the hand counts as closed (m). */
  closedBelow?: number;
  /** ...and above which a fist grasp is released (m). */
  openAbove?: number;
}

const MOVABLE_KINDS = new Set<ObjectSpec['kind']>(['item', 'tool', 'container']);
const isMovable = (spec: ObjectSpec) => MOVABLE_KINDS.has(spec.kind) && !spec.hidden;

export class GraspTracker {
  private readonly fist: Record<Handedness, boolean> = { left: false, right: false };
  private readonly o: Required<GraspOptions>;

  constructor(
    private readonly registry: ObjectRegistry,
    options: GraspOptions = {},
  ) {
    this.o = { pinchReach: 0.04, palmReach: 0.06, closedBelow: 0.045, openAbove: 0.06, ...options };
  }

  /** Handle a pinch transition. Returns the ids of objects released (so they can be re-located). */
  onPinch(transition: PinchTransition, frame: TrackedFrame): string[] {
    const hand = handOf(frame, transition.hand);
    if (transition.phase === 'start') {
      if (hand)
        this.pickUp(
          transition.hand,
          transition.point,
          wristPose(hand),
          this.o.pinchReach,
          transition.t,
        );
      return [];
    }
    if (this.fist[transition.hand]) return [];
    return this.release(transition.hand, transition.t);
  }

  /** Per frame: fist grasps, then move held objects with their wrists. Returns released ids. */
  update(frame: TrackedFrame): string[] {
    const released: string[] = [];
    const wrists: Partial<Record<Handedness, Pose>> = {};
    for (const which of HANDS) {
      const hand = handOf(frame, which);
      if (!hand) continue;
      const wrist = wristPose(hand);
      wrists[which] = wrist;
      const closure = gripClosure(hand);
      if (!this.fist[which] && closure < this.o.closedBelow) {
        this.fist[which] = this.pickUp(which, palmPoint(hand), wrist, this.o.palmReach, frame.t);
      } else if (this.fist[which] && closure > this.o.openAbove) {
        this.fist[which] = false;
        released.push(...this.release(which, frame.t));
      }
    }
    this.registry.updateHeld(wrists, frame.t);
    return released;
  }

  private pickUp(
    hand: Handedness,
    point: Pose['p'],
    wrist: Pose,
    reach: number,
    t: number,
  ): boolean {
    let best: { id: string; d: number } | null = null;
    for (const est of this.registry.all()) {
      if (est.heldBy || !isMovable(est.spec)) continue;
      const d = Math.hypot(
        point[0] - est.position[0],
        point[1] - est.position[1],
        point[2] - est.position[2],
      );
      if (d <= est.spec.radius + reach && (!best || d < best.d)) best = { id: est.id, d };
    }
    return best ? this.registry.attach(best.id, hand, wrist, t) : false;
  }

  private release(hand: Handedness, t: number): string[] {
    const held = this.registry.heldBy(hand);
    for (const id of held) this.registry.detach(id, t);
    return held;
  }
}
