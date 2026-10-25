import { HAND_SAMPLE_LENGTH, jointOffset } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { InstructionPanelMotion } from '../../src/adapters/render/panel-motion';
import { isInstructionPanelClear, panelTarget } from '../../src/adapters/render/panel-placement';
import type { PresentContext } from '../../src/adapters/render/presenter';
import {
  add,
  distance,
  identityPose,
  invertPose,
  type Pose,
  quatFromAxisAngle,
  quatMultiply,
  rotateVec,
  transformPoint,
  type Vec3,
} from '../../src/core/math';
import type { ObjectEstimate } from '../../src/domain/world/object-registry';
import type { Placement } from '../../src/domain/world/placement';

const WIDTH = 0.24;
const HEIGHT = 0.17;
const TOP = 0.15;
const FRAME = 1000 / 90;
const turn = (degrees: number, axis: Vec3 = [0, 1, 0]) =>
  quatFromAxisAngle(axis, (degrees * Math.PI) / 180);
const cardCenter = (pose: Pose) => transformPoint(pose, [0, TOP - HEIGHT / 2, 0]);

function expectHorizonLevel(pose: Pose): void {
  const right = rotateVec(pose.q, [1, 0, 0]);
  const up = rotateVec(pose.q, [0, 1, 0]);
  expect(right[1]).toBeCloseTo(0, 12);
  expect(up[0]).toBeCloseTo(0, 12);
  expect(up[1]).toBeCloseTo(1, 12);
  expect(up[2]).toBeCloseTo(0, 12);
}

function mask(center: Vec3, width = 0.12, height = 0.1): Placement {
  return {
    center,
    outline: {
      shape: 'contour',
      points: [
        [-width / 2, -height / 2],
        [width / 2, -height / 2],
        [width / 2, height / 2],
        [-width / 2, height / 2],
      ],
    },
    label: add(center, [0, height / 2, 0]),
    points: [],
    depth: 'point',
  };
}

function estimate(id: string, position: Vec3): ObjectEstimate {
  return {
    id,
    position,
    orientation: null,
    confidence: 1,
    source: 'detector',
    t: 0,
    heldBy: null,
    spec: {
      id,
      label: id,
      kind: 'tool',
      radius: 0.03,
      hidden: false,
      placement: { method: 'detect', hint: id },
    },
  };
}

function context(t = 0): PresentContext {
  return {
    t,
    dt: FRAME,
    snapshot: {
      phase: 'lesson',
      title: null,
      instruction: null,
      highlights: [],
      outlines: [],
      toast: null,
      demoStepId: null,
      caption: null,
      coach: 'off',
      voice: 'off',
      recording: null,
      missing: [],
    },
    objects: [],
    objectMasks: [],
    procedure: null,
    demo: null,
    demoHands: null,
    hands: null,
    head: identityPose(),
    worldFromWorkspace: identityPose(),
    calibration: null,
    debug: false,
  };
}

/** The step lights only `id`, a followed object at `center` with its live mask. */
function light(ctx: PresentContext, id: string, center: Vec3): void {
  ctx.objects = [estimate(id, center)];
  ctx.objectMasks = [mask(center)];
  ctx.snapshot.highlights = [{ objectId: id, style: 'target', source: 'auto', until: null }];
}

/** Runs frames until `until`, returning every pose. */
function run(motion: InstructionPanelMotion, ctx: PresentContext, until: number, step = FRAME) {
  const poses: Pose[] = [];
  for (let t = ctx.t + step; t <= until + 1e-9; t += step) {
    ctx.t = t;
    poses.push(motion.update(ctx, WIDTH, HEIGHT, TOP));
  }
  return poses;
}

/**
 * The largest distance the card moved between two frames, as a share of the whole move. A jump
 * would be the whole move; the glide peaks near 2.5% a frame at 90 frames per second.
 */
function largestStep(start: Pose, poses: readonly Pose[]): number {
  let previous = start;
  let largest = 0;
  for (const pose of poses) {
    largest = Math.max(largest, distance(pose.p, previous.p));
    previous = pose;
  }
  return largest / distance(start.p, poses.at(-1)?.p ?? start.p);
}

const where = (ctx: PresentContext) => panelTarget(ctx, WIDTH, HEIGHT, TOP, null);

describe('instruction card follow motion', () => {
  it.each([
    ['roll', quatMultiply(turn(35), turn(28, [0, 0, 1]))],
    ['pitch', quatMultiply(turn(35), turn(-32, [1, 0, 0]))],
    [
      'pitch and roll',
      quatMultiply(turn(35), quatMultiply(turn(-32, [1, 0, 0]), turn(28, [0, 0, 1]))),
    ],
  ] as const)('starts in place, level with the world horizon, while the head has %s', (_n, q) => {
    const ctx = context();
    ctx.head = { p: [2, 1.6, -3], q: [...q] };
    const first = new InstructionPanelMotion().update(ctx, WIDTH, HEIGHT, TOP);
    expectHorizonLevel(first);
    expect(first).toEqual(where(ctx).pose);
  });

  it.each([
    ['a small turn', { p: [0, 0, 0], q: turn(6) }],
    ['a small nod', { p: [0, 0, 0], q: turn(-5, [1, 0, 0]) }],
    ['a head tilt', { p: [0, 0, 0], q: turn(15, [0, 0, 1]) }],
    ['head bob', { p: [0, 0.03, 0], q: [0, 0, 0, 1] }],
    ['leaning', { p: [0.04, 0.01, 0.03], q: [0, 0, 0, 1] }],
  ] as const)('rests exactly where it is through %s', (_name, head) => {
    const ctx = context();
    const motion = new InstructionPanelMotion();
    const rest = motion.update(ctx, WIDTH, HEIGHT, TOP);
    ctx.head = { p: [...head.p], q: [...head.q] };
    for (const pose of run(motion, ctx, 3000, 100)) expect(pose).toEqual(rest);
  });

  it('glides after a larger turn without ever jumping, and arrives exactly in the gaze slot', () => {
    const ctx = context();
    const motion = new InstructionPanelMotion();
    const rest = motion.update(ctx, WIDTH, HEIGHT, TOP);
    ctx.head.q = turn(30);
    const poses = run(motion, ctx, 2500);
    expect(distance(poses[0]?.p ?? rest.p, rest.p)).toBeLessThan(0.002);
    expect(largestStep(rest, poses)).toBeLessThan(0.03);
    // About halfway after a third of a second, and there within two.
    const goal = where(ctx).pose;
    const third = poses[Math.round(330 / FRAME) - 1] ?? rest;
    const ratio = distance(third.p, rest.p) / distance(goal.p, rest.p);
    expect(ratio).toBeGreaterThan(0.25);
    expect(ratio).toBeLessThan(0.75);
    expect(poses.at(-1)).toEqual(goal);
  });

  it('trails a steady head turn without losing the card from view', () => {
    const ctx = context();
    const motion = new InstructionPanelMotion();
    motion.update(ctx, WIDTH, HEIGHT, TOP);
    for (let t = FRAME; t <= 3000; t += FRAME) {
      ctx.t = t;
      ctx.head.q = turn((45 * t) / 1000);
      const pose = motion.update(ctx, WIDTH, HEIGHT, TOP);
      const [x, , z] = transformPoint(invertPose(ctx.head), cardCenter(pose));
      expect(Math.abs(Math.atan2(x, -z))).toBeLessThan((30 * Math.PI) / 180);
      expectHorizonLevel(pose);
    }
  });

  it('holds still beside the object through detector jitter, then follows a real move', () => {
    const ctx = context();
    const object: Vec3 = [0, -0.25, -0.7];
    light(ctx, 'cup', object);
    const motion = new InstructionPanelMotion();
    const rest = motion.update(ctx, WIDTH, HEIGHT, TOP);
    expect(where(ctx).slot).toBe('above');
    for (const [i, nudge] of [0.01, -0.012, 0.008, -0.01, 0.012].entries()) {
      light(ctx, 'cup', add(object, [nudge, -nudge / 2, nudge / 3]));
      ctx.t = (i + 1) * 100;
      expect(motion.update(ctx, WIDTH, HEIGHT, TOP)).toEqual(rest);
    }
    light(ctx, 'cup', add(object, [0.15, 0, 0]));
    const poses = run(motion, ctx, 3000);
    expect(largestStep(rest, poses)).toBeLessThan(0.03);
    expect(poses.at(-1)).toEqual(where(ctx).pose);
    expect(cardCenter(poses.at(-1) ?? rest)[0]).toBeCloseTo(0.15, 1);
  });

  it('glides to the next step’s object instead of reappearing there', () => {
    const ctx = context();
    light(ctx, 'cup', [-0.25, -0.25, -0.7]);
    const motion = new InstructionPanelMotion();
    const rest = motion.update(ctx, WIDTH, HEIGHT, TOP);
    light(ctx, 'plate', [0.25, -0.25, -0.7]);
    const poses = run(motion, ctx, 3000);
    expect(distance(poses[0]?.p ?? rest.p, rest.p)).toBeLessThan(0.002);
    expect(largestStep(rest, poses)).toBeLessThan(0.03);
    expect(poses.at(-1)).toEqual(where(ctx).pose);
    expect(cardCenter(poses.at(-1) ?? rest)[0]).toBeGreaterThan(0.15);
  });

  it('leaves the object for the gaze slot when the learner looks away, and returns after', () => {
    const ctx = context();
    light(ctx, 'cup', [0, -0.25, -0.7]);
    const motion = new InstructionPanelMotion();
    const beside = motion.update(ctx, WIDTH, HEIGHT, TOP);
    ctx.head.q = turn(80);
    const away = run(motion, ctx, 2500);
    expect(largestStep(beside, away)).toBeLessThan(0.03);
    expect(where(ctx).slot).toBe('low');
    expect(away.at(-1)).toEqual(where(ctx).pose);
    ctx.head.q = [0, 0, 0, 1];
    const back = run(motion, ctx, 5000);
    expect(back.at(-1)).toEqual(beside);
  });

  it('does not integrate the glide more than once at the same frame timestamp', () => {
    const ctx = context();
    const motion = new InstructionPanelMotion();
    motion.update(ctx, WIDTH, HEIGHT, TOP);
    ctx.head.q = turn(30);
    run(motion, ctx, 200);
    const once = motion.update(ctx, WIDTH, HEIGHT, TOP);
    for (let call = 0; call < 12; call++)
      expect(motion.update(ctx, WIDTH, HEIGHT, TOP)).toEqual(once);
  });

  it('has the same response at 60 and 90 frames per second', () => {
    function glide(fps: number): Pose {
      const ctx = context();
      light(ctx, 'cup', [-0.25, -0.25, -0.7]);
      const motion = new InstructionPanelMotion();
      motion.update(ctx, WIDTH, HEIGHT, TOP);
      light(ctx, 'plate', [0.25, -0.25, -0.7]);
      // The glide starts on the first frame after the change, at the same time for both rates.
      ctx.t = 100;
      motion.update(ctx, WIDTH, HEIGHT, TOP);
      for (let frame = 1; frame <= (fps * 300) / 1000; frame++) {
        ctx.t = 100 + (frame * 1000) / fps;
        motion.update(ctx, WIDTH, HEIGHT, TOP);
      }
      return motion.update(ctx, WIDTH, HEIGHT, TOP);
    }
    const sixty = glide(60);
    const ninety = glide(90);
    for (let index = 0; index < 3; index++)
      expect(sixty.p[index]).toBeCloseTo(ninety.p[index] ?? 0, 9);
    for (let index = 0; index < 4; index++)
      expect(sixty.q[index]).toBeCloseTo(ninety.q[index] ?? 0, 9);
  });

  it('glides clear when an object moves over the card', () => {
    const ctx = context();
    const motion = new InstructionPanelMotion();
    const rest = motion.update(ctx, WIDTH, HEIGHT, TOP);
    ctx.objectMasks = [mask(cardCenter(rest), 0.2, 0.12)];
    expect(isInstructionPanelClear(ctx, WIDTH, HEIGHT, TOP, rest)).toBe(false);
    const poses = run(motion, ctx, 2500);
    expect(largestStep(rest, poses)).toBeLessThan(0.03);
    const settled = poses.at(-1) ?? rest;
    expect(settled).not.toEqual(rest);
    expect(isInstructionPanelClear(ctx, WIDTH, HEIGHT, TOP, settled)).toBe(true);
  });

  it('moves out of the way once larger content no longer fits where it rests', () => {
    const ctx = context();
    const motion = new InstructionPanelMotion();
    const rest = motion.update(ctx, 0.2, HEIGHT, TOP);
    ctx.objectMasks = [mask(add(cardCenter(rest), [0.23, 0, 0]), 0.1, 0.12)];
    expect(motion.update(ctx, 0.2, HEIGHT, TOP)).toEqual(rest);
    expect(isInstructionPanelClear(ctx, 0.55, HEIGHT, TOP, rest)).toBe(false);
    let pose = rest;
    for (let t = FRAME; t <= 2500; t += FRAME) {
      ctx.t = t;
      pose = motion.update(ctx, 0.55, HEIGHT, TOP);
    }
    expect(isInstructionPanelClear(ctx, 0.55, HEIGHT, TOP, pose)).toBe(true);
  });

  it('holds the card under a nearby fingertip while the learner looks away', () => {
    const ctx = context();
    const motion = new InstructionPanelMotion();
    const rest = motion.update(ctx, WIDTH, HEIGHT, TOP);
    const joints = new Array<number>(HAND_SAMPLE_LENGTH).fill(0);
    joints.splice(
      jointOffset('index-finger-tip'),
      3,
      ...transformPoint(rest, [0, TOP - HEIGHT + 0.04, 0.02]),
    );
    ctx.hands = { t: 0, head: ctx.head, left: { joints, pinch: 0.02 }, right: null };
    ctx.head.q = turn(40);
    for (const pose of run(motion, ctx, 3000, 100)) expect(pose).toEqual(rest);
  });

  it('jumps straight to where it must go under reduced motion, and rests otherwise', () => {
    const ctx = context();
    const motion = new InstructionPanelMotion({ reducedMotion: () => true });
    const rest = motion.update(ctx, WIDTH, HEIGHT, TOP);
    ctx.head.q = turn(6);
    for (const pose of run(motion, ctx, 1000, 100)) expect(pose).toEqual(rest);
    ctx.head.q = turn(30);
    ctx.t += 100;
    expect(motion.update(ctx, WIDTH, HEIGHT, TOP)).toEqual(where(ctx).pose);
  });

  it('stays horizon-level through every frame of a glide toward a pitched, rolled gaze', () => {
    const ctx = context();
    ctx.head.q = quatMultiply(turn(25), quatMultiply(turn(-20, [1, 0, 0]), turn(20, [0, 0, 1])));
    const motion = new InstructionPanelMotion();
    const rest = motion.update(ctx, WIDTH, HEIGHT, TOP);
    ctx.head.q = quatMultiply(turn(95), quatMultiply(turn(-40, [1, 0, 0]), turn(-30, [0, 0, 1])));
    const poses = run(motion, ctx, 2500);
    for (const pose of poses) expectHorizonLevel(pose);
    expect(distance(poses.at(-1)?.p ?? rest.p, rest.p)).toBeGreaterThan(0.1);
    expect(poses.at(-1)).toEqual(where(ctx).pose);
  });
});
