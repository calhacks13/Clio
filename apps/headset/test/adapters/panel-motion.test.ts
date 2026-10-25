import { HAND_SAMPLE_LENGTH, jointOffset } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { InstructionPanelMotion } from '../../src/adapters/render/panel-motion';
import {
  isInstructionPanelClear,
  placeInstructionPanel,
} from '../../src/adapters/render/panel-placement';
import type { PresentContext } from '../../src/adapters/render/presenter';
import {
  add,
  distance,
  identityPose,
  lerpPose,
  type Pose,
  quatFromAxisAngle,
  quatMultiply,
  rotateVec,
  transformPoint,
  type Vec3,
} from '../../src/core/math';
import type { Placement } from '../../src/domain/world/placement';

const WIDTH = 0.24;
const HEIGHT = 0.17;
const TOP = 0.15;
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

function mask(center: Vec3, width = 0.12, height = 0.14): Placement {
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

function context(t = 0): PresentContext {
  return {
    t,
    dt: 1000 / 90,
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

function startCatchUp(
  motion: InstructionPanelMotion,
  ctx: PresentContext,
): { anchor: Pose; target: Pose } {
  const anchor = motion.update(ctx, WIDTH, HEIGHT, TOP);
  ctx.head = { p: [0, 0, 0], q: turn(75) };
  ctx.t = 100;
  expect(motion.update(ctx, WIDTH, HEIGHT, TOP)).toEqual(anchor);
  ctx.t = 900;
  expect(motion.update(ctx, WIDTH, HEIGHT, TOP)).toEqual(anchor);
  return { anchor, target: placeInstructionPanel(ctx, WIDTH, HEIGHT, TOP, null) };
}

describe('instruction panel room anchoring', () => {
  it.each([
    ['roll', quatMultiply(turn(35), turn(28, [0, 0, 1]))],
    ['pitch', quatMultiply(turn(35), turn(-32, [1, 0, 0]))],
    [
      'pitch and roll',
      quatMultiply(turn(35), quatMultiply(turn(-32, [1, 0, 0]), turn(28, [0, 0, 1]))),
    ],
  ] as const)('starts level with the world horizon while the head has %s', (_name, orientation) => {
    const ctx = context();
    ctx.head = { p: [2, 1.6, -3], q: [...orientation] };
    const motion = new InstructionPanelMotion();
    const anchor = motion.update(ctx, WIDTH, HEIGHT, TOP);
    expectHorizonLevel(anchor);
    expect(anchor.q).not.toEqual(ctx.head.q);
  });

  it('keeps its level world orientation while the learner rolls an already tilted head', () => {
    const ctx = context();
    ctx.head.q = quatMultiply(turn(35), quatMultiply(turn(-20, [1, 0, 0]), turn(25, [0, 0, 1])));
    const motion = new InstructionPanelMotion();
    const anchor = motion.update(ctx, WIDTH, HEIGHT, TOP);
    expectHorizonLevel(anchor);
    for (const roll of [-30, -15, 0, 15, 30]) {
      ctx.head.q = quatMultiply(
        turn(35),
        quatMultiply(turn(-20, [1, 0, 0]), turn(roll, [0, 0, 1])),
      );
      for (let frame = 0; frame < 12; frame++) {
        ctx.t += 100;
        const pose = motion.update(ctx, WIDTH, HEIGHT, TOP);
        expect(pose).toEqual(anchor);
        expectHorizonLevel(pose);
      }
    }
  });

  it('stays horizon-level through every frame of a recovery toward a pitched, rolled gaze', () => {
    const ctx = context();
    ctx.head.q = quatMultiply(turn(25), quatMultiply(turn(-20, [1, 0, 0]), turn(20, [0, 0, 1])));
    const motion = new InstructionPanelMotion();
    const anchor = motion.update(ctx, WIDTH, HEIGHT, TOP);
    expectHorizonLevel(anchor);
    ctx.head.q = quatMultiply(turn(125), quatMultiply(turn(-40, [1, 0, 0]), turn(-30, [0, 0, 1])));
    ctx.t = 100;
    expect(motion.update(ctx, WIDTH, HEIGHT, TOP)).toEqual(anchor);
    ctx.t = 900;
    expect(motion.update(ctx, WIDTH, HEIGHT, TOP)).toEqual(anchor);
    const target = placeInstructionPanel(ctx, WIDTH, HEIGHT, TOP, null);
    expectHorizonLevel(target);
    let settled = anchor;
    for (let t = 925; t <= 2500; t += 25) {
      ctx.t = t;
      settled = motion.update(ctx, WIDTH, HEIGHT, TOP);
      expectHorizonLevel(settled);
      expect(isInstructionPanelClear(ctx, WIDTH, HEIGHT, TOP, settled)).toBe(true);
    }
    expect(distance(settled.p, anchor.p)).toBeGreaterThan(0.1);
    expect(settled).toEqual(target);
  });

  it.each([
    ['yaw', { p: [0, 0, 0], q: turn(35) }],
    ['pitch', { p: [0, 0, 0], q: turn(-20, [1, 0, 0]) }],
    ['roll', { p: [0, 0, 0], q: turn(25, [0, 0, 1]) }],
    ['head bob', { p: [0, 0.06, 0], q: [0, 0, 0, 1] }],
    ['translation', { p: [0.12, 0.02, 0.08], q: [0, 0, 0, 1] }],
    [
      'combined motion',
      {
        p: [0.03, 0.02, 0],
        q: quatMultiply(turn(25), quatMultiply(turn(-15, [1, 0, 0]), turn(15, [0, 0, 1]))),
      },
    ],
  ] as const)('keeps the exact world pose during ordinary %s', (_name, head) => {
    const ctx = context();
    const motion = new InstructionPanelMotion();
    const anchor = motion.update(ctx, WIDTH, HEIGHT, TOP);
    ctx.head = { p: [...head.p], q: [...head.q] };
    for (let t = 100; t <= 5000; t += 100) {
      ctx.t = t;
      expect(motion.update(ctx, WIDTH, HEIGHT, TOP)).toEqual(anchor);
    }
  });

  it.each([false, true])(
    'stays anchored during a brief look away, including crossing the eye plane (objects: %s)',
    (withObjects) => {
      const ctx = context();
      const motion = new InstructionPanelMotion();
      if (withObjects) ctx.objectMasks = [mask([-0.35, -0.1, -0.9])];
      const anchor = motion.update(ctx, WIDTH, HEIGHT, TOP);
      for (const degrees of [80, 100, 120, 90, 0]) {
        ctx.head.q = turn(degrees);
        ctx.t += 140;
        expect(motion.update(ctx, WIDTH, HEIGHT, TOP)).toEqual(anchor);
      }
      ctx.t = 3000;
      expect(motion.update(ctx, WIDTH, HEIGHT, TOP)).toEqual(anchor);
    },
  );

  it('catches up softly only after a sustained look away and settles at a captured world target', () => {
    const ctx = context();
    const motion = new InstructionPanelMotion();
    const { anchor, target } = startCatchUp(motion, ctx);
    ctx.t = 1000;
    const first = motion.update(ctx, WIDTH, HEIGHT, TOP);
    expect(first).not.toEqual(anchor);
    expect(distance(first.p, anchor.p)).toBeLessThan(distance(target.p, anchor.p) / 3);
    expect(distance(first.p, target.p)).toBeGreaterThan(0.1);
    // Turning farther while the elastic catch-up runs must not retarget it frame by frame.
    ctx.head.q = turn(115);
    for (let t = 1100; t <= 2500; t += 100) {
      ctx.t = t;
      motion.update(ctx, WIDTH, HEIGHT, TOP);
    }
    const settled = motion.update(ctx, WIDTH, HEIGHT, TOP);
    expect(settled).toEqual(target);
    ctx.t = 3500;
    expect(motion.update(ctx, WIDTH, HEIGHT, TOP)).toEqual(target);
  });

  it('does not integrate spring motion more than once at the same frame timestamp', () => {
    const ctx = context();
    const motion = new InstructionPanelMotion();
    startCatchUp(motion, ctx);
    ctx.t = 1200;
    const once = motion.update(ctx, WIDTH, HEIGHT, TOP);
    for (let call = 0; call < 12; call++)
      expect(motion.update(ctx, WIDTH, HEIGHT, TOP)).toEqual(once);
  });

  it('has the same response at 60 and 90 frames per second', () => {
    function run(fps: number): Pose {
      const ctx = context();
      ctx.dt = 1000 / fps;
      const motion = new InstructionPanelMotion();
      startCatchUp(motion, ctx);
      for (let elapsed = ctx.dt; elapsed < 800; elapsed += ctx.dt) {
        ctx.t = 900 + elapsed;
        motion.update(ctx, WIDTH, HEIGHT, TOP);
      }
      ctx.t = 1700;
      return motion.update(ctx, WIDTH, HEIGHT, TOP);
    }
    const sixty = run(60);
    const ninety = run(90);
    for (let index = 0; index < 3; index++)
      expect(sixty.p[index]).toBeCloseTo(ninety.p[index] ?? 0, 12);
    for (let index = 0; index < 4; index++)
      expect(sixty.q[index]).toBeCloseTo(ninety.q[index] ?? 0, 12);
  });

  it('relocates an unsafe anchor immediately when a moving mask occupies it', () => {
    const ctx = context();
    const motion = new InstructionPanelMotion();
    const anchor = motion.update(ctx, WIDTH, HEIGHT, TOP);
    ctx.objectMasks = [mask(cardCenter(anchor))];
    ctx.t = 16;
    expect(isInstructionPanelClear(ctx, WIDTH, HEIGHT, TOP, anchor)).toBe(false);
    const next = motion.update(ctx, WIDTH, HEIGHT, TOP);
    expect(next).not.toEqual(anchor);
    expect(isInstructionPanelClear(ctx, WIDTH, HEIGHT, TOP, next)).toBe(true);
  });

  it('revalidates larger content even when asynchronous resizing reuses the same timestamp', () => {
    const ctx = context();
    const motion = new InstructionPanelMotion();
    const anchor = motion.update(ctx, 0.2, HEIGHT, TOP);
    ctx.objectMasks = [mask(add(cardCenter(anchor), [0.23, 0, 0]), 0.1, 0.12)];
    expect(isInstructionPanelClear(ctx, 0.2, HEIGHT, TOP, anchor)).toBe(true);
    expect(motion.update(ctx, 0.2, HEIGHT, TOP)).toEqual(anchor);
    expect(isInstructionPanelClear(ctx, 0.55, HEIGHT, TOP, anchor)).toBe(false);
    const larger = motion.update(ctx, 0.55, HEIGHT, TOP);
    expect(larger).not.toEqual(anchor);
    expect(isInstructionPanelClear(ctx, 0.55, HEIGHT, TOP, larger)).toBe(true);
  });

  it('never sweeps a catch-up card through a mask that enters its path', () => {
    const ctx = context();
    const motion = new InstructionPanelMotion();
    const { anchor, target } = startCatchUp(motion, ctx);
    ctx.objectMasks = [mask(cardCenter(lerpPose(anchor, target, 0.5)), 0.14, 0.2)];
    for (let t = 920; t <= 3000; t += 20) {
      ctx.t = t;
      const pose = motion.update(ctx, WIDTH, HEIGHT, TOP);
      expect(isInstructionPanelClear(ctx, WIDTH, HEIGHT, TOP, pose)).toBe(true);
    }
  });

  it('holds the card under a nearby fingertip while the learner looks away', () => {
    const ctx = context();
    const motion = new InstructionPanelMotion();
    const anchor = motion.update(ctx, WIDTH, HEIGHT, TOP);
    const joints = new Array<number>(HAND_SAMPLE_LENGTH).fill(0);
    joints.splice(
      jointOffset('index-finger-tip'),
      3,
      ...transformPoint(anchor, [0, TOP - HEIGHT + 0.04, 0.02]),
    );
    ctx.hands = { t: 0, head: ctx.head, left: { joints, pinch: 0.02 }, right: null };
    ctx.head.q = turn(100);
    for (let t = 100; t <= 4000; t += 100) {
      ctx.t = t;
      expect(motion.update(ctx, WIDTH, HEIGHT, TOP)).toEqual(anchor);
    }
  });

  it('keeps reduced-motion anchors fixed except for necessary object clearance', () => {
    const ctx = context();
    const motion = new InstructionPanelMotion({ reducedMotion: () => true });
    const anchor = motion.update(ctx, WIDTH, HEIGHT, TOP);
    ctx.head.q = turn(85);
    for (let t = 100; t <= 4000; t += 100) {
      ctx.t = t;
      expect(motion.update(ctx, WIDTH, HEIGHT, TOP)).toEqual(anchor);
    }
    ctx.head.q = [0, 0, 0, 1];
    ctx.objectMasks = [mask(cardCenter(anchor))];
    const clear = motion.update(ctx, WIDTH, HEIGHT, TOP);
    expect(clear).not.toEqual(anchor);
    expect(isInstructionPanelClear(ctx, WIDTH, HEIGHT, TOP, clear)).toBe(true);
  });
});
