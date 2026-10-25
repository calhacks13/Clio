import type { Handedness } from '@clio/protocol';
import type { Vec3 } from '../../../core/math';

// Pressing a widget with an index fingertip (pure; one latch per hand). A press needs a front
// approach: the fingertip first hovers at least 2 cm in front of a target (armed), then comes
// within 8 mm of its surface or a little through it, and fires once. Resting in the card never
// repeats; a fingertip arriving from behind or from the side never fires. A target is inert just
// after it appears or moves, and each widget cools down after a press. Coordinates are the dock
// column's frame: x right, y up, z toward the eye, metres.

export interface HitTarget {
  widgetId: string;
  index: number;
  /** Centre and size of the target's rectangle on the card plane (m). */
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export type TouchPhase = 'idle' | 'near' | 'armed';

export const TOUCH = {
  /** Hover within this far in front of a target. */
  nearZ: 0.06,
  /** Armed at least this far in front of a target. */
  armZ: 0.02,
  /** Pressed within this far in front of the surface... */
  pressZ: 0.008,
  /** ...down to this far behind it (a finger pushes through a card it can't feel). */
  behindZ: -0.03,
  /** Targets grow by this on every side for the hit test. */
  inflate: 0.004,
  cooldownMs: 600,
  settleMs: 500,
  /** Leaving the armed target's rectangle by more than this disarms and re-arms the latch. */
  leave: 0.01,
} as const;

/** Most targets a latch tracks for its settle delay (5 checklist rows or 3 options per card). */
const MAX_TARGETS = 24;

/** Per-widget press times, shared by both hands' latches. */
export class TouchCooldowns {
  private readonly ids: string[] = [];
  private readonly times: number[] = [];

  /** When `widgetId` was last pressed, or -Infinity. */
  last(widgetId: string): number {
    for (let i = 0; i < this.ids.length; i++) {
      if (this.ids[i] === widgetId) return this.times[i] ?? Number.NEGATIVE_INFINITY;
    }
    return Number.NEGATIVE_INFINITY;
  }

  mark(widgetId: string, t: number): void {
    for (let i = 0; i < this.ids.length; i++) {
      if (this.ids[i] === widgetId) {
        this.times[i] = t;
        return;
      }
    }
    this.ids.push(widgetId);
    this.times.push(t);
  }
}

export interface TouchResult {
  /** The target the fingertip hovers, or null. */
  near: HitTarget | null;
  /** The target pressed on this update, or null. */
  pressed: HitTarget | null;
  phase: TouchPhase;
}

/** Whether (x, y) is inside the target grown by `grow` on every side. */
export function inside(target: HitTarget, x: number, y: number, grow: number): boolean {
  return (
    Math.abs(x - target.cx) <= target.w / 2 + grow && Math.abs(y - target.cy) <= target.h / 2 + grow
  );
}

/** How far (x, y) lies outside the target's rectangle (m), 0 inside. */
export function outside(target: HitTarget, x: number, y: number): number {
  const dx = Math.max(0, Math.abs(x - target.cx) - target.w / 2);
  const dy = Math.max(0, Math.abs(y - target.cy) - target.h / 2);
  return Math.hypot(dx, dy);
}

/** The target under (x, y) with inflation; where inflated targets overlap, the nearest centre. */
export function hitTest(targets: readonly HitTarget[], x: number, y: number): HitTarget | null {
  let best: HitTarget | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const target of targets) {
    if (!inside(target, x, y, TOUCH.inflate)) continue;
    const d = (x - target.cx) ** 2 + (y - target.cy) ** 2;
    if (d < bestD) {
      best = target;
      bestD = d;
    }
  }
  return best;
}

export class TouchLatch {
  private armedId: string | null = null;
  private armedIndex = -1;
  /** Pressed, and waiting to be re-armed (pulled back past armZ, or slid off). */
  private latched = false;
  private readonly seenId: string[] = new Array<string>(MAX_TARGETS).fill('');
  private readonly seenIndex = new Int32Array(MAX_TARGETS).fill(-1);
  private readonly seenCx = new Float64Array(MAX_TARGETS);
  private readonly seenCy = new Float64Array(MAX_TARGETS);
  private readonly since = new Float64Array(MAX_TARGETS);
  private readonly result: TouchResult = { near: null, pressed: null, phase: 'idle' };

  constructor(
    readonly hand: Handedness,
    private readonly cooldowns: TouchCooldowns = new TouchCooldowns(),
  ) {}

  /**
   * Local fingertip (column frame) or null; returns what is hovered and what was pressed now. The
   * result object is reused: read it before the next update.
   */
  update(tip: Readonly<Vec3> | null, targets: readonly HitTarget[], t: number): TouchResult {
    this.track(targets, t);
    const r = this.result;
    r.near = null;
    r.pressed = null;
    if (!tip) {
      this.disarm();
      this.latched = false;
      r.phase = 'idle';
      return r;
    }
    const x = tip[0];
    const y = tip[1];
    const z = tip[2];
    const hit = hitTest(targets, x, y);

    if (this.armedId !== null) {
      const armed = this.find(targets, this.armedId, this.armedIndex);
      if (armed < 0 || outside(targets[armed] as HitTarget, x, y) > TOUCH.leave) {
        this.disarm();
        this.latched = false;
      }
    }
    if (this.latched && z > TOUCH.armZ) this.latched = false;
    if (!this.latched && hit && z >= TOUCH.armZ) {
      this.armedId = hit.widgetId;
      this.armedIndex = hit.index;
    }
    if (z < TOUCH.behindZ) this.disarm();

    if (
      !this.latched &&
      hit &&
      hit.widgetId === this.armedId &&
      hit.index === this.armedIndex &&
      z >= TOUCH.behindZ &&
      z <= TOUCH.pressZ
    ) {
      // The press is used up either way: a finger resting through a settling or cooling target
      // must not fire once the wait is over.
      this.latched = true;
      const i = this.find(targets, hit.widgetId, hit.index);
      const settled = i < 0 || t - (this.since[i] ?? t) >= TOUCH.settleMs;
      if (settled && t - this.cooldowns.last(hit.widgetId) >= TOUCH.cooldownMs) {
        this.cooldowns.mark(hit.widgetId, t);
        r.pressed = hit;
      }
    }

    if (hit && z >= TOUCH.behindZ && z <= TOUCH.nearZ) r.near = hit;
    r.phase = this.armedId !== null && !this.latched ? 'armed' : r.near ? 'near' : 'idle';
    return r;
  }

  /** Notes when each target appeared or last moved, for the settle delay. */
  private track(targets: readonly HitTarget[], t: number): void {
    const n = Math.min(targets.length, MAX_TARGETS);
    for (let i = 0; i < n; i++) {
      const target = targets[i] as HitTarget;
      if (
        this.seenId[i] !== target.widgetId ||
        this.seenIndex[i] !== target.index ||
        Math.abs((this.seenCx[i] ?? 0) - target.cx) > 1e-4 ||
        Math.abs((this.seenCy[i] ?? 0) - target.cy) > 1e-4
      ) {
        this.seenId[i] = target.widgetId;
        this.seenIndex[i] = target.index;
        this.seenCx[i] = target.cx;
        this.seenCy[i] = target.cy;
        this.since[i] = t;
      }
    }
    for (let i = n; i < MAX_TARGETS; i++) this.seenId[i] = '';
  }

  private find(targets: readonly HitTarget[], widgetId: string, index: number): number {
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i] as HitTarget;
      if (target.widgetId === widgetId && target.index === index) return i;
    }
    return -1;
  }

  private disarm(): void {
    this.armedId = null;
    this.armedIndex = -1;
  }
}
