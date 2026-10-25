import { describe, expect, it } from 'vitest';
import {
  isInstructionPanelClear,
  PANEL_DISTANCE,
  PANEL_MASK_GAP,
  placeInstructionPanel,
} from '../../src/adapters/render/panel-placement';
import type { PresentContext } from '../../src/adapters/render/presenter';
import {
  add,
  composePose,
  identityPose,
  invertPose,
  type Pose,
  quatFromAxisAngle,
  quatMultiply,
  rotateVec,
  sub,
  transformPoint,
  type Vec3,
  yawOnly,
} from '../../src/core/math';
import type { ObjectEstimate } from '../../src/domain/world/object-registry';
import { billboard, outlinePoint } from '../../src/domain/world/outline';
import type { Placement } from '../../src/domain/world/placement';

const WIDTH = 0.3;
const TOP = WIDTH / 2;
const rectMask = (center: Vec3, w = 0.2, h = 0.2): Placement => ({
  center,
  outline: {
    shape: 'contour',
    points: [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2],
    ],
  },
  points: [],
  label: add(center, [0, h / 2, 0]),
  depth: 'point',
});

function context(masks: Placement[] = []): PresentContext {
  return {
    t: 0,
    dt: 16,
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
    objectMasks: masks,
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

function estimate(id: string, position: Vec3, radius = 0.03): ObjectEstimate {
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
      radius,
      hidden: false,
      placement: { method: 'detect', hint: id },
    },
  };
}

/** Independently compare projected card corners against each real mask's projected vertices. */
function expectClear(
  ctx: PresentContext,
  pose: Pose,
  masks: Placement[],
  height = WIDTH,
  width = WIDTH,
  top = TOP,
  eyeX = 0,
  requiredGap = PANEL_MASK_GAP,
) {
  const view = invertPose({ p: transformPoint(ctx.head, [eyeX, 0, 0]), q: ctx.head.q });
  const project = (p: Vec3) => {
    const [x, y, z] = transformPoint(view, p);
    return [(x * PANEL_DISTANCE) / -z, (y * PANEL_DISTANCE) / -z];
  };
  const corners = [
    [-width / 2, top, 0],
    [width / 2, top, 0],
    [width / 2, top - height, 0],
    [-width / 2, top - height, 0],
  ].map((p) => transformPoint(pose, p as Vec3));
  const projectedCard = corners.map(project);
  const card = [
    [
      Math.min(...projectedCard.map(([x]) => x ?? 0)),
      Math.min(...projectedCard.map(([, y]) => y ?? 0)),
    ],
    [
      Math.max(...projectedCard.map(([x]) => x ?? 0)),
      Math.max(...projectedCard.map(([, y]) => y ?? 0)),
    ],
  ];
  const nearDepth = Math.min(...corners.map((p) => -transformPoint(view, p)[2]));
  for (const mask of masks) {
    const plane = billboard(mask.center, ctx.head.p);
    if (!plane) throw new Error('Mask at the eye');
    const projected = mask.outline.points.map((p) => project(outlinePoint(plane, mask.center, p)));
    const xs = projected.map((p) => p[0] ?? 0);
    const ys = projected.map((p) => p[1] ?? 0);
    const gap = (requiredGap * PANEL_DISTANCE) / nearDepth - 1e-7;
    expect(
      (card[1]?.[0] ?? 0) <= Math.min(...xs) - gap ||
        (card[0]?.[0] ?? 0) >= Math.max(...xs) + gap ||
        (card[1]?.[1] ?? 0) <= Math.min(...ys) - gap ||
        (card[0]?.[1] ?? 0) >= Math.max(...ys) + gap,
    ).toBe(true);
  }
}

function expectFullyVisible(
  ctx: PresentContext,
  pose: Pose,
  width: number,
  height: number,
  top = TOP,
) {
  const view = invertPose(ctx.head);
  const center = transformPoint(view, transformPoint(pose, [0, top - height / 2, 0]));
  expect(center[2]).toBeCloseTo(-PANEL_DISTANCE);
  for (const point of [
    [-width / 2, top, 0],
    [width / 2, top, 0],
    [width / 2, top - height, 0],
    [-width / 2, top - height, 0],
  ]) {
    const [x, y, z] = transformPoint(view, transformPoint(pose, point as Vec3));
    expect(z).toBeLessThan(-0.03);
    const projectedX = (x * PANEL_DISTANCE) / -z;
    const projectedY = (y * PANEL_DISTANCE) / -z;
    expect(projectedX).toBeGreaterThanOrEqual(-0.58 - 1e-8);
    expect(projectedX).toBeLessThanOrEqual(0.58 + 1e-8);
    expect(projectedY).toBeGreaterThanOrEqual(-0.48 - 1e-8);
    expect(projectedY).toBeLessThanOrEqual(0.4 + 1e-8);
  }
}

describe('instruction panel placement', () => {
  it('keeps the card center in the actual gaze while its up and right axes follow the world horizon', () => {
    const ctx = context();
    ctx.head = {
      p: [2, 1.6, 3],
      q: quatMultiply(
        quatFromAxisAngle([0, 1, 0], 0.7),
        quatMultiply(quatFromAxisAngle([1, 0, 0], -1.05), quatFromAxisAngle([0, 0, 1], 0.4)),
      ),
    };
    const pose = placeInstructionPanel(ctx, 0.28, 0.2, TOP, null);
    const center = transformPoint(invertPose(ctx.head), transformPoint(pose, [0, TOP - 0.1, 0]));
    expect(center[0]).toBeCloseTo(0);
    expect(center[1]).toBeCloseTo(-0.08);
    expect(center[2]).toBeCloseTo(-PANEL_DISTANCE);
    expect(rotateVec(pose.q, [0, 1, 0])).toEqual([0, 1, 0]);
    expect(rotateVec(pose.q, [1, 0, 0])[1]).toBeCloseTo(0);
    expectFullyVisible(ctx, pose, 0.28, 0.2);
  });

  it.each([
    [-0.35, 0.3],
    [-0.9, -0.55],
    [-1.25, 0.45],
  ])(
    'fits and clears all four level-card corners from both eyes at pitch %s and roll %s',
    (pitch, roll) => {
      const ctx = context();
      ctx.head = {
        p: [0, 1.6, 0],
        q: quatMultiply(quatFromAxisAngle([1, 0, 0], pitch), quatFromAxisAngle([0, 0, 1], roll)),
      };
      const mask = rectMask(transformPoint(ctx.head, [0.03, -0.04, -0.9]), 0.22, 0.2);
      ctx.objectMasks = [mask];
      const width = 0.28;
      const height = 0.2;
      const pose = placeInstructionPanel(ctx, width, height, TOP, null);
      expect(rotateVec(pose.q, [0, 1, 0])).toEqual([0, 1, 0]);
      expectFullyVisible(ctx, pose, width, height);
      expect(isInstructionPanelClear(ctx, width, height, TOP, pose)).toBe(true);
      for (const eyeX of [-0.032, 0.032]) expectClear(ctx, pose, [mask], height, width, TOP, eyeX);
    },
  );

  it('levels a legacy tilted anchor once around its center and then preserves the exact level pose', () => {
    const ctx = context();
    const q = quatMultiply(
      quatFromAxisAngle([0, 1, 0], 0.12),
      quatMultiply(quatFromAxisAngle([1, 0, 0], -0.2), quatFromAxisAngle([0, 0, 1], 0.25)),
    );
    const center: Vec3 = [0, -0.08, -0.65];
    const old: Pose = { p: sub(center, rotateVec(q, [0, TOP - 0.1, 0])), q };
    const leveled = placeInstructionPanel(ctx, 0.28, 0.2, TOP, old);
    expect(leveled).not.toBe(old);
    expect(rotateVec(leveled.q, [0, 1, 0])).toEqual([0, 1, 0]);
    transformPoint(leveled, [0, TOP - 0.1, 0]).forEach((value, i) => {
      expect(value).toBeCloseTo(center[i] ?? 0);
    });
    ctx.head.q = quatMultiply(ctx.head.q, quatFromAxisAngle([0, 0, 1], 0.1));
    expect(placeInstructionPanel(ctx, 0.28, 0.2, TOP, leveled)).toBe(leveled);
  });

  it('keeps every corner in front of the near plane for an unusually tall level card at a steep gaze', () => {
    const ctx = context();
    ctx.head.q = quatFromAxisAngle([1, 0, 0], -1.4);
    const pose = placeInstructionPanel(ctx, 0.3, 1.6, TOP, null);
    expect(pose.p.every(Number.isFinite)).toBe(true);
    for (const point of [
      [-0.15, TOP, 0],
      [0.15, TOP, 0],
      [-0.15, TOP - 1.6, 0],
      [0.15, TOP - 1.6, 0],
    ]) {
      expect(
        transformPoint(invertPose(ctx.head), transformPoint(pose, point as Vec3))[2],
      ).toBeLessThan(-0.03);
    }
  });

  it('gives a real initial target enough slack to preserve its world pose through modest head motion', () => {
    const ctx = context([rectMask([0, -0.2, -0.75], 0.16, 0.12)]);
    const anchored = placeInstructionPanel(ctx, 0.26, 0.18, TOP, null);
    const frozen = structuredClone(anchored);
    expectClear(
      ctx,
      anchored,
      [...(ctx.objectMasks ?? [])],
      0.18,
      0.26,
      TOP,
      0,
      PANEL_MASK_GAP * 2,
    );
    ctx.head = {
      p: [0.025, 0.015, 0.035],
      q: quatMultiply(
        quatFromAxisAngle([0, 1, 0], 0.07),
        quatMultiply(quatFromAxisAngle([1, 0, 0], -0.08), quatFromAxisAngle([0, 0, 1], 0.05)),
      ),
    };
    expect(isInstructionPanelClear(ctx, 0.26, 0.18, TOP, anchored)).toBe(true);
    expect(placeInstructionPanel(ctx, 0.26, 0.18, TOP, anchored)).toBe(anchored);
    expect(anchored).toEqual(frozen);
    for (const eyeX of [-0.032, 0.032])
      expectClear(ctx, anchored, [...(ctx.objectMasks ?? [])], 0.18, 0.26, TOP, eyeX);
  });

  it('detects a nearby object crossing a frozen card after a small lateral head movement', () => {
    const ctx = context();
    const anchored = placeInstructionPanel(ctx, 0.26, 0.18, TOP, null);
    ctx.objectMasks = [rectMask([0.14, -0.08, -0.3], 0.03, 0.06)];
    expect(isInstructionPanelClear(ctx, 0.26, 0.18, TOP, anchored)).toBe(true);
    ctx.head.p[0] = 0.08;
    expect(isInstructionPanelClear(ctx, 0.26, 0.18, TOP, anchored)).toBe(false);
    const relocated = placeInstructionPanel(ctx, 0.26, 0.18, TOP, null);
    expect(isInstructionPanelClear(ctx, 0.26, 0.18, TOP, relocated)).toBe(true);
  });

  it.each([0.325, 1.3])(
    'scales the reserved physical gap to the actual card depth %s',
    (distance) => {
      const ctx = context();
      const anchored: Pose = { p: [0, 0, -distance], q: identityPose().q };
      const side = (gap: number): Vec3[] => [
        [0.15 + gap, -0.08, -distance],
        [0.25 + gap, -0.08, -distance],
        [0.25 + gap, 0.08, -distance],
        [0.15 + gap, 0.08, -distance],
      ];
      ctx.sceneObstacles = [side(PANEL_MASK_GAP - 0.01)];
      expect(isInstructionPanelClear(ctx, 0.3, 0.2, 0.1, anchored)).toBe(false);
      ctx.sceneObstacles = [side(PANEL_MASK_GAP + 0.01)];
      expect(isInstructionPanelClear(ctx, 0.3, 0.2, 0.1, anchored)).toBe(true);
    },
  );

  it('checks all four corners of a tilted frozen card instead of a diagonal pair', () => {
    const ctx = context();
    const anchored: Pose = { p: [0, 0, -0.65], q: quatFromAxisAngle([0, 0, 1], Math.PI / 4) };
    // This catches the right-hand corner, which extends far beyond the other diagonal's x range.
    ctx.sceneObstacles = [
      [
        [0.165, 0.02, -0.65],
        [0.185, 0.02, -0.65],
        [0.185, 0.05, -0.65],
        [0.165, 0.05, -0.65],
      ],
    ];
    expect(isInstructionPanelClear(ctx, 0.3, 0.2, 0.1, anchored)).toBe(false);
  });

  it('rejects a pose that is clear at the midpoint but overlaps for one eye at a different depth', () => {
    const mask = rectMask([0.066, 0, -0.25], 0.02, 0.1);
    const ctx = context([mask]);
    const anchored: Pose = { p: [0, 0, -0.8], q: identityPose().q };
    expectClear(ctx, anchored, [mask], 0.1, 0.2, 0.05);
    expect(isInstructionPanelClear(ctx, 0.2, 0.1, 0.05, anchored)).toBe(false);
    const relocated = placeInstructionPanel(ctx, 0.2, 0.1, 0.05, null);
    expect(isInstructionPanelClear(ctx, 0.2, 0.1, 0.05, relocated)).toBe(true);
    for (const eyeX of [-0.032, 0.032]) expectClear(ctx, relocated, [mask], 0.1, 0.2, 0.05, eyeX);
  });

  it('keeps pre-lesson cards clear of detected furniture and ignores invalid scene vertices', () => {
    const ctx = context();
    ctx.snapshot.phase = 'idle';
    const anchored = placeInstructionPanel(ctx, 0.25, 0.14, TOP, null);
    ctx.sceneObstacles = [
      [
        [-0.25, -0.25, -0.65],
        [0.25, -0.25, -0.65],
        [0.25, 0.1, -0.65],
        [-0.25, 0.1, -0.65],
      ],
      [
        [Number.NaN, 0, -0.5],
        [Infinity, 0, -0.5],
      ],
    ];
    expect(isInstructionPanelClear(ctx, 0.25, 0.14, TOP, anchored)).toBe(false);
    const relocated = placeInstructionPanel(ctx, 0.25, 0.14, TOP, null);
    expect(isInstructionPanelClear(ctx, 0.25, 0.14, TOP, relocated)).toBe(true);
    expectFullyVisible(ctx, relocated, 0.25, 0.14);
  });

  it('rechecks the actual frozen footprint when content grows in either axis', () => {
    const ctx = context();
    const anchored = placeInstructionPanel(ctx, 0.2, 0.12, TOP, null);
    ctx.sceneObstacles = [
      [
        [0.19, -0.2, -0.65],
        [0.25, -0.2, -0.65],
        [0.25, 0.05, -0.65],
        [0.19, 0.05, -0.65],
      ],
    ];
    expect(isInstructionPanelClear(ctx, 0.2, 0.12, TOP, anchored)).toBe(true);
    expect(isInstructionPanelClear(ctx, 0.38, 0.24, TOP, anchored)).toBe(false);
  });

  it('leaves look-away timing to motion for behind-eye and peripheral near-plane cards', () => {
    const ctx = context();
    const anchored = placeInstructionPanel(ctx, 0.25, 0.14, TOP, null);
    ctx.sceneObstacles = [
      [
        [0.2, -0.1, -0.5],
        [0.4, 0.1, -0.5],
      ],
    ];
    for (const angle of [Math.PI, Math.PI / 2]) {
      ctx.head.q = quatFromAxisAngle([0, 1, 0], angle);
      expect(isInstructionPanelClear(ctx, 0.25, 0.14, TOP, anchored)).toBe(true);
    }
    ctx.sceneObstacles = [];
    expect(isInstructionPanelClear(ctx, 0.25, 0.14, TOP, anchored)).toBe(true);
  });

  it('rejects a partly eye-crossing card that could still occupy the visible scene', () => {
    const ctx = context();
    ctx.sceneObstacles = [
      [
        [-0.2, -0.2, -0.6],
        [0.2, 0.2, -0.6],
      ],
    ];
    const crossing: Pose = { p: [0, 0, -0.03], q: quatFromAxisAngle([0, 1, 0], Math.PI / 2) };
    expect(isInstructionPanelClear(ctx, 0.3, 0.2, 0.1, crossing)).toBe(false);
  });

  it('rests near the gaze without preferring an arbitrary side when no objects are known', () => {
    const pose = placeInstructionPanel(context(), WIDTH, WIDTH, TOP, null);
    expect(pose.p[0]).toBe(0);
    expect(Math.abs(pose.p[1])).toBeLessThan(WIDTH / 2);
    expect(pose.p[2]).toBe(-PANEL_DISTANCE);
  });

  it('fits compact, wide and tall content beside the same obstacles using their real dimensions', () => {
    const masks = [
      rectMask([0, -0.12, -0.65], 0.28, 0.22),
      rectMask([-0.32, 0.16, -0.65], 0.15, 0.14),
    ];
    const ctx = context(masks);
    const dimensions = [
      [0.18, 0.12],
      [0.78, 0.17],
      [0.22, 0.62],
    ] as const;
    const positions = dimensions.map(([width, height]) => {
      const pose = placeInstructionPanel(ctx, width, height, TOP, null);
      expectClear(ctx, pose, masks, height, width);
      expectFullyVisible(ctx, pose, width, height);
      return pose.p;
    });
    expect(positions[0]).not.toEqual(positions[1]);
    expect(positions[1]).not.toEqual(positions[2]);
    // The tall text needs a side column, while the wide text uses a horizontal gap.
    expect(Math.abs(positions[2]?.[0] ?? 0)).toBeGreaterThan(Math.abs(positions[1]?.[0] ?? 0));
  });

  it('slides a wide card along a viewport-edge task instead of placing its edges offscreen', () => {
    const mask = rectMask([-0.5, 0.31, -0.65], 0.17, 0.13);
    const ctx = context([mask]);
    const width = 0.75;
    const height = 0.2;
    const pose = placeInstructionPanel(ctx, width, height, TOP, null);
    expectClear(ctx, pose, [mask], height, width);
    expectFullyVisible(ctx, pose, width, height);
    expect(pose.p[0]).toBeGreaterThan(mask.center[0]);
  });

  it('rechecks width growth and keeps a comfortable clear placement when content shrinks', () => {
    const mask = rectMask([0, -0.12, -0.65], 0.3, 0.25);
    const ctx = context([mask]);
    const wide = placeInstructionPanel(ctx, 0.54, 0.18, TOP, null);
    const narrow = placeInstructionPanel(ctx, 0.28, 0.18, TOP, wide);
    expect(narrow.p).toEqual(wide.p);
    expectClear(ctx, narrow, [mask], 0.18, 0.28);
    const grown = placeInstructionPanel(ctx, 0.85, 0.28, TOP, narrow);
    expectClear(ctx, grown, [mask], 0.28, 0.85);
    expectFullyVisible(ctx, grown, 0.85, 0.28);
  });

  it('keeps the reading position when both width and height shrink modestly', () => {
    const mask = rectMask([0, -0.12, -0.65], 0.28, 0.2);
    const ctx = context([mask]);
    const before = placeInstructionPanel(ctx, 0.38, 0.26, TOP, null);
    const after = placeInstructionPanel(ctx, 0.24, 0.16, TOP, before);
    for (const [i, coordinate] of after.p.entries())
      expect(coordinate).toBeCloseTo(before.p[i] ?? 0, 10);
    expectClear(ctx, after, [mask], 0.16, 0.24);
    expectFullyVisible(ctx, after, 0.24, 0.16);
  });

  it('keeps a clear world anchor when the task shifts without crossing it', () => {
    const ctx = context([rectMask([-0.4, -0.1, -0.65], 0.1, 0.12)]);
    const before = placeInstructionPanel(ctx, 0.2, 0.15, TOP, null);
    const mask = rectMask([0.4, -0.1, -0.65], 0.1, 0.12);
    ctx.objectMasks = [mask];
    const after = placeInstructionPanel(ctx, 0.2, 0.15, TOP, before);
    expect(after).toBe(before);
    expectClear(ctx, after, [mask], 0.15, 0.2);
  });

  it('keeps the reserved gap from a close object for both eyes', () => {
    const mask = rectMask([0, -0.08, -0.25], 0.12, 0.8);
    const ctx = context([mask]);
    const width = 0.25;
    const height = 0.2;
    const pose = placeInstructionPanel(ctx, width, height, TOP, null);
    for (const eyeX of [-0.032, 0.032]) expectClear(ctx, pose, [mask], height, width, TOP, eyeX);
  });

  it('starts next to an off-center task rather than leaving the card across the view', () => {
    const mask = rectMask([-0.35, -0.05, -0.65], 0.1, 0.1);
    const ctx = context([mask]);
    const pose = placeInstructionPanel(ctx, WIDTH, WIDTH, TOP, null);
    expectClear(ctx, pose, [mask]);
    // The center of gaze is clear but far away; the real task is on the left.
    expect(pose.p[0]).toBeLessThan(0.1);
    const plane = billboard(mask.center, ctx.head.p);
    if (!plane) throw new Error('Mask at the eye');
    const projected = mask.outline.points.map((p) => {
      const [x, y, z] = outlinePoint(plane, mask.center, p);
      return [(x * PANEL_DISTANCE) / -z, (y * PANEL_DISTANCE) / -z];
    });
    const xs = projected.map(([x]) => x ?? 0);
    const ys = projected.map(([, y]) => y ?? 0);
    const edgeDistance = Math.hypot(
      Math.max(0, Math.min(...xs) - pose.p[0] - WIDTH / 2, pose.p[0] - WIDTH / 2 - Math.max(...xs)),
      Math.max(0, Math.min(...ys) - pose.p[1] - WIDTH / 2, pose.p[1] - WIDTH / 2 - Math.max(...ys)),
    );
    expect(edgeDistance).toBeLessThan(PANEL_MASK_GAP * 2 + 0.015);
  });

  it.each([
    ['a wide object', rectMask([0.1, -0.12, -0.65], 0.75, 0.1)],
    ['a tall object', rectMask([0.28, -0.12, -0.65], 0.15, 0.65)],
    ['a nearer object', rectMask([0.12, -0.1, -0.3], 0.24, 0.2)],
    ['a distant object', rectMask([0.4, -0.3, -1.4], 0.65, 0.65)],
  ])('leaves visible space beside %s', (_name, mask) => {
    const ctx = context([mask]);
    expectClear(ctx, placeInstructionPanel(ctx, WIDTH, WIDTH, TOP, null), [mask]);
  });

  it('avoids every silhouette when several objects share the view', () => {
    const masks = [
      rectMask([0.3, -0.1, -0.65], 0.25, 0.35),
      rectMask([-0.15, -0.1, -0.6], 0.3, 0.25),
    ];
    const ctx = context(masks);
    expectClear(ctx, placeInstructionPanel(ctx, WIDTH, WIDTH, TOP, null), masks);
  });

  it('keeps an unobstructed settled card stable and relocates it immediately when a mask moves in', () => {
    const ctx = context();
    const settled = placeInstructionPanel(ctx, WIDTH, WIDTH, TOP, null);
    expect(placeInstructionPanel(ctx, WIDTH, WIDTH, TOP, settled)).toEqual(settled);
    const mask = rectMask([...settled.p]);
    ctx.objectMasks = [mask];
    const moved = placeInstructionPanel(ctx, WIDTH, WIDTH, TOP, settled);
    expect(moved).not.toEqual(settled);
    expectClear(ctx, moved, [mask]);
  });

  it('rechecks clearance after longer text grows the card downward', () => {
    const mask = rectMask([0.31, -0.4, -0.65], 0.25, 0.1);
    const ctx = context([mask]);
    const short = placeInstructionPanel(ctx, WIDTH, WIDTH, TOP, null);
    const tall = placeInstructionPanel(ctx, WIDTH, 0.6, TOP, short);
    expectClear(ctx, tall, [mask], 0.6);
  });

  it('uses an off-center, non-overlapping fallback when masks fill the preferred viewport', () => {
    const mask = rectMask([0, 0, -0.65], 1.8, 1.5);
    const ctx = context([mask]);
    const pose = placeInstructionPanel(ctx, WIDTH, WIDTH, TOP, null);
    expect(pose.p.every(Number.isFinite)).toBe(true);
    expectClear(ctx, pose, [mask]);
  });

  it('transforms lesson outlines from a shifted and rotated workspace', () => {
    const ctx = context();
    ctx.head = { p: [2, 1.6, 3], q: quatFromAxisAngle([0, 1, 0], Math.PI / 3) };
    ctx.worldFromWorkspace = composePose(ctx.head, {
      p: [0.2, -0.15, 0],
      q: quatFromAxisAngle([0, 1, 0], 0.2),
    });
    const object = estimate('tool', [0, 0, -0.65]);
    ctx.objects = [object];
    const outline = rectMask([0, 0, 0], 0.3, 0.3).outline;
    ctx.snapshot.outlines = [
      {
        objectId: object.id,
        outline,
        offset: [0.05, 0, 0],
        rank: 0,
        role: 'act',
        accent: { color: 0x24d4ed, opacity: 1 },
        phrase: 'tool',
      },
    ];
    const center = transformPoint(ctx.worldFromWorkspace, add(object.position, [0.05, 0, 0]));
    // A workspace with yaw rotation still uses an upright billboard, matching the live view.
    const worldMask = { ...rectMask(center), outline };
    expectClear(ctx, placeInstructionPanel(ctx, WIDTH, WIDTH, TOP, null), [worldMask]);
  });

  it('stays horizon-level near a downward, rolled gaze and clear of a table mask in an offset workspace', () => {
    const ctx = context();
    ctx.head = {
      p: [2, 1.6, 3],
      q: quatMultiply(
        quatFromAxisAngle([0, 1, 0], 0.5),
        quatMultiply(quatFromAxisAngle([1, 0, 0], -0.9), quatFromAxisAngle([0, 0, 1], 0.2)),
      ),
    };
    ctx.worldFromWorkspace = { p: [1.7, 0.75, 2.3], q: quatFromAxisAngle([0, 1, 0], 0.4) };
    const center = transformPoint(ctx.head, [0.08, -0.03, -0.95]);
    const object = estimate(
      'table-tool',
      transformPoint(invertPose(ctx.worldFromWorkspace), center),
    );
    const outline = rectMask([0, 0, 0], 0.25, 0.22).outline;
    const offset: Vec3 = [0.04, 0, 0];
    ctx.objects = [object];
    ctx.snapshot.outlines = [
      {
        objectId: object.id,
        outline,
        offset,
        rank: 0,
        role: 'act',
        accent: { color: 0x24d4ed, opacity: 1 },
        phrase: 'tool',
      },
    ];
    const mask = {
      ...rectMask(transformPoint(ctx.worldFromWorkspace, add(object.position, offset))),
      outline,
    };
    const pose = placeInstructionPanel(ctx, WIDTH, WIDTH, TOP, null);
    expect(pose.q).toEqual(yawOnly(ctx.head.q));
    const up = rotateVec(pose.q, [0, 1, 0]);
    const right = rotateVec(pose.q, [1, 0, 0]);
    expect(up[0]).toBeCloseTo(0);
    expect(up[1]).toBeCloseTo(1);
    expect(up[2]).toBeCloseTo(0);
    expect(right[1]).toBeCloseTo(0);
    expectFullyVisible(ctx, pose, WIDTH, WIDTH);
    expect(isInstructionPanelClear(ctx, WIDTH, WIDTH, TOP, pose)).toBe(true);
    for (const eyeX of [-0.032, 0.032]) expectClear(ctx, pose, [mask], WIDTH, WIDTH, TOP, eyeX);
  });

  it('protects the declared radius when no mask is available', () => {
    const ctx = context();
    ctx.objects = [estimate('large-tool', [0.31, -0.12, -0.65], 0.22)];
    const mask = rectMask([0.31, -0.12, -0.65], 0.44, 0.44);
    expectClear(ctx, placeInstructionPanel(ctx, WIDTH, WIDTH, TOP, null), [mask]);
  });

  it('ignores lost, hidden and clearly behind-the-head estimates', () => {
    const ctx = context();
    const initial = placeInstructionPanel(ctx, WIDTH, WIDTH, TOP, null);
    const lost = { ...estimate('lost', [...initial.p], 0.5), lostAt: 0 };
    const hidden = estimate('hidden', [...initial.p], 0.5);
    hidden.spec.hidden = true;
    ctx.objects = [lost, hidden, estimate('behind', [0.31, -0.12, 1], 0.1)];
    expect(placeInstructionPanel(ctx, WIDTH, WIDTH, TOP, null)).toEqual(initial);
  });
});
