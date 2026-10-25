import { dot, madd, sub } from '../../core/math';
import type { Ray } from './camera-model';
import type { Relief } from './outline';
import type { DepthKind, ObjectDepth, ObjectMask } from './placement';

// The tracker's masks come 20 to 30 times a second, and measuring an object's distance with
// hit-test takes a few XR frames (depth.ts). So once a target's distance is measured, its next
// masks are placed at once, at that same distance along their own camera rays (an object and a
// head barely move in a tenth of a second), and the distance is measured again in the background:
// every REFRESH_MS, or sooner when the mask moved or changed size by more than MOVE_SHARE of the
// frame. A new target (a new name, or found again after it was lost) is measured first, and so is
// a mask more than twice MOVE_SHARE from the one last measured: the target moved far, or the
// tracker moved it to another object of the same name, and the old distance would misplace it.
// The object's relief (its surface about the outline's plane, outline.ts) is reused with it.

export interface DepthMemoryOptions {
  /** Measure the target again this often (ms). */
  refreshMs?: number;
  /** ...or when an edge of its box moved more than this share of the frame since. */
  moveShare?: number;
  /** A distance is not reused for a box that moved more than this share since it was measured. */
  reuseMoveShare?: number;
  /** A distance measured longer ago than this is not reused (ms). */
  maxAgeMs?: number;
}

const REFRESH_MS = 100;
const MOVE_SHARE = 0.08;
const MAX_AGE_MS = 1000;

type Box = readonly [number, number, number, number];

interface Measured {
  target: string;
  /** Meters along the mask's point ray. */
  distance: number;
  kind: DepthKind;
  relief: Relief | null;
  /** The box of the mask measured. */
  box: Box | null;
  t: number;
}

/** A mask's box, or its point as an empty box. */
function boxOf(mask: ObjectMask): Box | null {
  if (mask.box) return mask.box;
  return mask.point ? [mask.point[0], mask.point[1], mask.point[0], mask.point[1]] : null;
}

function moved(a: Box, b: Box): number {
  return Math.max(...a.map((v, i) => Math.abs(v - (b[i] ?? v))));
}

export class DepthMemory {
  private measured: Measured | null = null;
  /** The last measurement asked for. */
  private asked: { target: string; box: Box | null; t: number } | null = null;
  private forgotten = 0;

  /** Bumped by forget(): a measurement started before that is not remembered. */
  get epoch(): number {
    return this.forgotten;
  }

  constructor(private readonly options: DepthMemoryOptions = {}) {}

  /**
   * Where `target` is along `pointRay` (the point ray of its new `mask`), at the distance last
   * measured for it; null when it has none yet, or `mask` moved too far since.
   */
  reuse(target: string, mask: ObjectMask, pointRay: Ray, now: number): ObjectDepth | null {
    const m = this.measured;
    if (!m || m.target !== target || now - m.t > (this.options.maxAgeMs ?? MAX_AGE_MS)) {
      return null;
    }
    const box = boxOf(mask);
    const maxMove = this.options.reuseMoveShare ?? 2 * MOVE_SHARE;
    if (box !== null && m.box !== null && moved(box, m.box) > maxMove) return null;
    const center = madd(pointRay.origin, pointRay.direction, m.distance);
    return m.relief ? { center, kind: m.kind, relief: m.relief } : { center, kind: m.kind };
  }

  /** Whether to measure `target` in `mask` now; true counts as asking. */
  shouldMeasure(target: string, mask: ObjectMask, now: number): boolean {
    const box = boxOf(mask);
    const a = this.asked;
    const due =
      !a ||
      a.target !== target ||
      now - a.t >= (this.options.refreshMs ?? REFRESH_MS) ||
      (box !== null &&
        a.box !== null &&
        moved(box, a.box) > (this.options.moveShare ?? MOVE_SHARE));
    if (due) this.asked = { target, box, t: now };
    return due;
  }

  /**
   * A distance measured for `target` in `mask` along `pointRay` (the mask's point ray), in a
   * measurement started at `epoch`.
   */
  remember(
    target: string,
    mask: ObjectMask,
    pointRay: Ray,
    depth: ObjectDepth,
    now: number,
    epoch: number,
  ): void {
    const distance = dot(sub(depth.center, pointRay.origin), pointRay.direction);
    if (epoch !== this.forgotten || !(distance > 0)) return;
    this.measured = {
      target,
      distance,
      kind: depth.kind,
      relief: depth.relief ?? null,
      box: boxOf(mask),
      t: now,
    };
  }

  /** The target was lost or replaced: measure the next one first. */
  forget(): void {
    this.measured = null;
    this.asked = null;
    this.forgotten++;
  }
}
