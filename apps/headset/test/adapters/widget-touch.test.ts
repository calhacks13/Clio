import { describe, expect, it } from 'vitest';
import {
  type HitTarget,
  hitTest,
  TOUCH,
  TouchCooldowns,
  TouchLatch,
} from '../../src/adapters/render/widgets/touch';
import type { Vec3 } from '../../src/core/math';

// Pressing a widget with a fingertip: a front approach arms the latch, coming to the surface
// fires once, and nothing else does (resting, arriving from behind or the side, a settling
// target, a cooling widget).

const A: HitTarget = { widgetId: 'choices', index: 0, cx: 0, cy: -0.05, w: 0.148, h: 0.038 };
const B: HitTarget = { widgetId: 'choices', index: 1, cx: 0, cy: -0.096, w: 0.148, h: 0.038 };
const TARGETS = [A, B];
/** Long after the targets appeared, so they have settled. */
const SETTLED = 10_000;

const at = (target: HitTarget, z: number, dx = 0, dy = 0): Vec3 => [
  target.cx + dx,
  target.cy + dy,
  z,
];

/** Runs a path of fingertip positions, 16 ms apart, and returns what each step pressed. */
function run(latch: TouchLatch, path: (Vec3 | null)[], start = SETTLED, targets = TARGETS) {
  return path.map((tip, i) => {
    const r = latch.update(tip, targets, start + i * 16);
    return { near: r.near, pressed: r.pressed, phase: r.phase };
  });
}

function settled(hand: 'left' | 'right' = 'right', cooldowns?: TouchCooldowns): TouchLatch {
  const latch = new TouchLatch(hand, cooldowns);
  latch.update(null, TARGETS, 0);
  return latch;
}

describe('TouchLatch', () => {
  it('hovers near, arms in front and presses once at the surface', () => {
    const steps = run(settled(), [
      at(A, 0.1),
      at(A, 0.05),
      at(A, 0.03),
      at(A, 0.015),
      at(A, 0.005),
    ]);
    expect(steps.map((s) => s.phase)).toEqual(['armed', 'armed', 'armed', 'armed', 'near']);
    expect(steps[1]?.near).toBe(A);
    expect(steps[0]?.near).toBeNull();
    expect(steps.map((s) => s.pressed)).toEqual([null, null, null, null, A]);
  });

  it('does not repeat while the finger rests in the card', () => {
    const steps = run(settled(), [
      at(A, 0.03),
      at(A, 0.004),
      at(A, 0),
      at(A, -0.01),
      at(A, 0.002),
      at(A, 0.01),
    ]);
    expect(steps.filter((s) => s.pressed)).toHaveLength(1);
  });

  it('re-arms after pulling back past the arm distance', () => {
    const latch = settled();
    const first = run(latch, [at(A, 0.03), at(A, 0)]);
    const again = run(latch, [at(A, 0.03), at(A, 0)], SETTLED + 1000);
    expect(first.filter((s) => s.pressed)).toHaveLength(1);
    expect(again.filter((s) => s.pressed)).toHaveLength(1);
  });

  it('never fires for a fingertip arriving from behind', () => {
    const steps = run(settled(), [
      at(A, -0.08),
      at(A, -0.04),
      at(A, -0.02),
      at(A, 0),
      at(A, 0.005),
    ]);
    expect(steps.every((s) => s.pressed === null)).toBe(true);
  });

  it('never fires for a fingertip sliding in from the side at the surface', () => {
    const steps = run(settled(), [
      at(A, 0.005, 0.2),
      at(A, 0.005, 0.12),
      at(A, 0.005, 0.05),
      at(A, 0.005),
      at(A, 0),
    ]);
    expect(steps.every((s) => s.pressed === null)).toBe(true);
  });

  it('does not press a neighbour the finger slides onto after arming over another', () => {
    const steps = run(settled(), [at(A, 0.03), at(A, 0.012), at(B, 0.012), at(B, 0.004)]);
    expect(steps.every((s) => s.pressed === null)).toBe(true);
  });

  it('keeps a target inert while it settles after appearing or moving', () => {
    const latch = new TouchLatch('right');
    const fresh = run(latch, [at(A, 0.03), at(A, 0)], 0);
    expect(fresh.every((s) => s.pressed === null)).toBe(true);
    const later = run(latch, [at(A, 0.03), at(A, 0)], TOUCH.settleMs + 100);
    expect(later.filter((s) => s.pressed)).toHaveLength(1);
    const moved: HitTarget = { ...A, cy: A.cy - 0.02 };
    const afterMove = run(latch, [at(moved, 0.03), at(moved, 0)], TOUCH.settleMs + 2000, [
      moved,
      B,
    ]);
    expect(afterMove.every((s) => s.pressed === null)).toBe(true);
  });

  it('cools a widget down after a press, across both hands', () => {
    const cooldowns = new TouchCooldowns();
    const right = settled('right', cooldowns);
    const left = settled('left', cooldowns);
    const first = run(right, [at(A, 0.03), at(A, 0)]);
    const tooSoon = run(left, [at(B, 0.03), at(B, 0)], SETTLED + 100);
    const later = run(left, [at(B, 0.03), at(B, 0)], SETTLED + TOUCH.cooldownMs + 100);
    expect(first.filter((s) => s.pressed)).toHaveLength(1);
    expect(tooSoon.every((s) => s.pressed === null)).toBe(true);
    expect(later.filter((s) => s.pressed)).toHaveLength(1);
  });

  it('presses with either hand on its own latch', () => {
    const left = settled('left');
    const right = settled('right');
    expect(run(left, [at(A, 0.03), at(A, 0)]).at(-1)?.pressed).toBe(A);
    expect(run(right, [at(B, 0.03), at(B, 0)], SETTLED + 2000).at(-1)?.pressed).toBe(B);
    expect(left.hand).toBe('left');
  });

  it('hit-tests rectangles grown by 4 mm, nearest centre first', () => {
    expect(hitTest(TARGETS, A.w / 2 + 0.003, A.cy)).toBe(A);
    expect(hitTest(TARGETS, A.w / 2 + 0.005, A.cy)).toBeNull();
    expect(hitTest(TARGETS, 0, A.cy - A.h / 2 - 0.003)).toBe(A);
    // Between A and B (8 mm apart), each inflated edge meets the other: the nearer centre wins.
    expect(hitTest(TARGETS, 0, (A.cy + B.cy) / 2 + 0.001)).toBe(A);
    expect(hitTest(TARGETS, 0, (A.cy + B.cy) / 2 - 0.001)).toBe(B);
  });

  it('lets go when the finger leaves', () => {
    const latch = settled();
    run(latch, [at(A, 0.03)]);
    expect(latch.update(null, TARGETS, SETTLED + 100).phase).toBe('idle');
    expect(run(latch, [at(A, 0.004)], SETTLED + 200).every((s) => s.pressed === null)).toBe(true);
  });
});
