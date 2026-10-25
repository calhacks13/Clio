import { describe, expect, it } from 'vitest';
import {
  isInstructionPanelClear,
  PANEL_DISTANCE,
  PANEL_MASK_GAP,
  PANEL_VIEW,
  panelTarget,
} from '../../src/adapters/render/panel-placement';
import type { PresentContext } from '../../src/adapters/render/presenter';
import {
  add,
  composePose,
  distance,
  identityPose,
  invertPose,
  type Pose,
  quatFromAxisAngle,
  quatMultiply,
  rotateVec,
  sub,
  transformPoint,
  type Vec3,
} from '../../src/core/math';
import type { ObjectEstimate } from '../../src/domain/world/object-registry';
import { billboard, outlinePoint } from '../../src/domain/world/outline';
import type { Placement } from '../../src/domain/world/placement';

const WIDTH = 0.28;
const HEIGHT = 0.16;
const TOP = 0.15;
const turn = (degrees: number, axis: Vec3 = [0, 1, 0]) =>
  quatFromAxisAngle(axis, (degrees * Math.PI) / 180);

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

/** A followed object the step lights, with its live mask (identity workspace). */
function lit(ctx: PresentContext, id: string, center: Vec3, w = 0.12, h = 0.1): Placement {
  const mask = rectMask(center, w, h);
  ctx.objects = [...ctx.objects, estimate(id, center)];
  ctx.objectMasks = [...(ctx.objectMasks ?? []), mask];
  ctx.snapshot.highlights.push({ objectId: id, style: 'target', source: 'auto', until: null });
  return mask;
}

const target = (ctx: PresentContext, previous: Parameters<typeof panelTarget>[4] = null) =>
  panelTarget(ctx, WIDTH, HEIGHT, TOP, previous);

/** Card corners as the cyclopean eye sees them on the reference plane. */
function screen(ctx: PresentContext, pose: Pose, width = WIDTH, height = HEIGHT, top = TOP) {
  const view = invertPose(ctx.head);
  const points = [
    [-width / 2, top, 0],
    [width / 2, top, 0],
    [width / 2, top - height, 0],
    [-width / 2, top - height, 0],
  ].map((p) => {
    const [x, y, z] = transformPoint(view, transformPoint(pose, p as Vec3));
    expect(z).toBeLessThan(-0.03);
    return [(x * PANEL_DISTANCE) / -z, (y * PANEL_DISTANCE) / -z] as const;
  });
  return {
    left: Math.min(...points.map(([x]) => x)),
    right: Math.max(...points.map(([x]) => x)),
    bottom: Math.min(...points.map(([, y]) => y)),
    top: Math.max(...points.map(([, y]) => y)),
  };
}

function maskScreen(ctx: PresentContext, mask: Placement) {
  const plane = billboard(mask.center, ctx.head.p);
  if (!plane) throw new Error('Mask at the eye');
  const view = invertPose(ctx.head);
  const points = mask.outline.points.map((p) => {
    const [x, y, z] = transformPoint(view, outlinePoint(plane, mask.center, p));
    return [(x * PANEL_DISTANCE) / -z, (y * PANEL_DISTANCE) / -z] as const;
  });
  return {
    left: Math.min(...points.map(([x]) => x)),
    right: Math.max(...points.map(([x]) => x)),
    bottom: Math.min(...points.map(([, y]) => y)),
    top: Math.max(...points.map(([, y]) => y)),
  };
}

/** Independently compare projected card corners against each real mask's projected vertices. */
function expectClear(
  ctx: PresentContext,
  pose: Pose,
  masks: Placement[],
  height = HEIGHT,
  width = WIDTH,
  top = TOP,
  eyeX = 0,
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
  const xs = projectedCard.map(([x]) => x ?? 0);
  const ys = projectedCard.map(([, y]) => y ?? 0);
  const nearDepth = Math.min(...corners.map((p) => -transformPoint(view, p)[2]));
  for (const mask of masks) {
    const plane = billboard(mask.center, ctx.head.p);
    if (!plane) throw new Error('Mask at the eye');
    const projected = mask.outline.points.map((p) => project(outlinePoint(plane, mask.center, p)));
    const mx = projected.map((p) => p[0] ?? 0);
    const my = projected.map((p) => p[1] ?? 0);
    const gap = (PANEL_MASK_GAP * PANEL_DISTANCE) / nearDepth - 1e-7;
    expect(
      Math.max(...xs) <= Math.min(...mx) - gap ||
        Math.min(...xs) >= Math.max(...mx) + gap ||
        Math.max(...ys) <= Math.min(...my) - gap ||
        Math.min(...ys) >= Math.max(...my) + gap,
    ).toBe(true);
  }
}

function expectInView(ctx: PresentContext, pose: Pose, width = WIDTH, height = HEIGHT) {
  const rect = screen(ctx, pose, width, height);
  // Within a twentieth of a degree: the fit converges over a few rounds of perspective.
  expect(rect.left).toBeGreaterThanOrEqual(PANEL_VIEW.left - 5e-4);
  expect(rect.right).toBeLessThanOrEqual(PANEL_VIEW.right + 5e-4);
  expect(rect.bottom).toBeGreaterThanOrEqual(PANEL_VIEW.bottom - 5e-4);
  expect(rect.top).toBeLessThanOrEqual(PANEL_VIEW.top + 5e-4);
}

/** Its face points at the eye from its center, and its top edge stays level (no roll). */
function expectFacingEye(ctx: PresentContext, pose: Pose, height = HEIGHT, top = TOP) {
  const right = rotateVec(pose.q, [1, 0, 0]);
  expect(right[1]).toBeCloseTo(0, 10);
  const normal = rotateVec(pose.q, [0, 0, 1]);
  const toEye = sub(ctx.head.p, transformPoint(pose, [0, top - height / 2, 0]));
  const reach = Math.hypot(...toEye);
  for (const axis of [0, 1, 2] as const) {
    expect(normal[axis]).toBeCloseTo((toEye[axis] ?? 0) / reach, 10);
  }
  // Upright: its top is up, tilted back only as far as facing the eye needs.
  expect(rotateVec(pose.q, [0, 1, 0])[1]).toBeGreaterThan(0);
}

const cardCenter = (pose: Pose, height = HEIGHT, top = TOP) =>
  transformPoint(pose, [0, top - height / 2, 0]);

describe('instruction card beside the lit objects', () => {
  it('sits just above the lit object, centered on it and at its depth', () => {
    const ctx = context();
    const object: Vec3 = [0.1, -0.28, -0.7];
    const mask = lit(ctx, 'cup', object);
    const { pose, slot } = target(ctx);
    expect(slot).toBe('above');
    const card = screen(ctx, pose);
    const seen = maskScreen(ctx, mask);
    expect((card.left + card.right) / 2).toBeCloseTo((seen.left + seen.right) / 2, 2);
    expect(card.bottom).toBeGreaterThan(seen.top);
    // Close: no more than the gap and its cushion, measured at the card's depth.
    expect(card.bottom - seen.top).toBeLessThan(((PANEL_MASK_GAP + 0.04) * PANEL_DISTANCE) / 0.75);
    expect(distance(cardCenter(pose), ctx.head.p)).toBeCloseTo(distance(object, ctx.head.p), 2);
    expectInView(ctx, pose);
    expectFacingEye(ctx, pose);
    for (const eyeX of [-0.032, 0.032]) expectClear(ctx, pose, [mask], HEIGHT, WIDTH, TOP, eyeX);
  });

  it('keeps a comfortable reading depth for a far or very near object', () => {
    const far = context();
    lit(far, 'fridge', [0, -0.3, -2.5], 0.6, 0.8);
    expect(distance(cardCenter(target(far).pose), far.head.p)).toBeCloseTo(0.85, 3);
    const near = context();
    lit(near, 'screw', [0, -0.12, -0.25], 0.03, 0.03);
    expect(distance(cardCenter(target(near).pose), near.head.p)).toBeCloseTo(0.45, 3);
  });

  it('goes below an object at the top of the view, and stays below once it is there', () => {
    const ctx = context();
    const mask = lit(ctx, 'shelf', [0, 0.27, -0.7]);
    const below = target(ctx);
    expect(below.slot).toBe('below');
    expect(screen(ctx, below.pose).top).toBeLessThan(maskScreen(ctx, mask).bottom);
    expectInView(ctx, below.pose);
    // The object drops to where "above" would fit, but the card keeps its side.
    ctx.objects = [estimate('shelf', [0, -0.05, -0.7])];
    ctx.objectMasks = [rectMask([0, -0.05, -0.7], 0.12, 0.1)];
    expect(target(ctx, 'below').slot).toBe('below');
    expect(target(ctx, null).slot).toBe('above');
  });

  it('moves to the side when another object blocks above and below', () => {
    const ctx = context();
    const mask = lit(ctx, 'cup', [0, -0.1, -0.7]);
    const blockers = [rectMask([0, 0.15, -0.7], 0.5, 0.15), rectMask([0, -0.36, -0.7], 0.5, 0.15)];
    ctx.objectMasks = [...(ctx.objectMasks ?? []), ...blockers];
    const { pose, slot } = target(ctx);
    expect(['right', 'left']).toContain(slot);
    expectClear(ctx, pose, [mask, ...blockers]);
    expectInView(ctx, pose);
  });

  it('slides inward along the view edge for an object near the side of the view', () => {
    const ctx = context();
    const mask = lit(ctx, 'tool', [0.38, -0.2, -0.7]);
    const { pose, slot } = target(ctx);
    expect(slot).toBe('above');
    expectInView(ctx, pose);
    expectClear(ctx, pose, [mask]);
    expect(cardCenter(pose)[0]).toBeGreaterThan(0.1);
  });

  it('sits above two lit objects that are close together, and follows the first when apart', () => {
    const close = context();
    const a = lit(close, 'cup', [-0.08, -0.25, -0.7]);
    const b = lit(close, 'plate', [0.1, -0.3, -0.7]);
    const together = screen(close, target(close).pose);
    const both = { left: maskScreen(close, a).left, right: maskScreen(close, b).right };
    expect((together.left + together.right) / 2).toBeCloseTo((both.left + both.right) / 2, 2);
    expect(together.bottom).toBeGreaterThan(maskScreen(close, a).top);

    const apart = context();
    const first = lit(apart, 'cup', [-0.3, -0.25, -0.7]);
    lit(apart, 'sink', [0.35, -0.25, -0.7]);
    const card = screen(apart, target(apart).pose);
    const seen = maskScreen(apart, first);
    expect((card.left + card.right) / 2).toBeCloseTo((seen.left + seen.right) / 2, 2);
  });

  it('leads with the step outline over the other lights', () => {
    const ctx = context();
    lit(ctx, 'plate', [0.3, -0.25, -0.7]);
    const tool = estimate('tool', [-0.3, -0.25, -0.7]);
    ctx.objects = [...ctx.objects, tool];
    ctx.snapshot.outlines = [
      {
        objectId: 'tool',
        outline: rectMask([0, 0, 0], 0.1, 0.1).outline,
        offset: [0, 0, 0],
        rank: 0,
        role: 'act',
        accent: { color: 0x24d4ed, opacity: 1 },
        phrase: 'tool',
      },
    ];
    expect(cardCenter(target(ctx).pose)[0]).toBeLessThan(-0.1);
  });

  it('keeps clear of furniture only in the gaze slots, not beside the work on a table', () => {
    const ctx = context();
    const mask = lit(ctx, 'cup', [0, -0.3, -0.7]);
    // An 18cm worktop reservation covering the whole lower view.
    ctx.sceneObstacles = [
      [
        [-1, -0.6, -0.3],
        [1, -0.6, -0.3],
        [1, -0.12, -1.2],
        [-1, -0.12, -1.2],
      ],
    ];
    const { pose, slot } = target(ctx);
    expect(slot).toBe('above');
    expect(screen(ctx, pose).bottom).toBeLessThan(maskScreen(ctx, mask).top + 0.15);
    expect(isInstructionPanelClear(ctx, WIDTH, HEIGHT, TOP, pose, false)).toBe(true);
  });

  it('places beside a lit object in a shifted and rotated workspace', () => {
    const ctx = context();
    ctx.head = { p: [2, 1.6, 3], q: turn(60) };
    ctx.worldFromWorkspace = composePose(ctx.head, { p: [0.2, -0.15, 0], q: turn(12) });
    const object = estimate('tool', [0, -0.15, -0.65]);
    ctx.objects = [object];
    const outline = rectMask([0, 0, 0], 0.15, 0.12).outline;
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
    const worldMask = { ...rectMask(center), outline };
    const { pose, slot } = target(ctx);
    expect(slot).toBe('above');
    expectClear(ctx, pose, [worldMask]);
    expectInView(ctx, pose);
    expect(screen(ctx, pose).bottom).toBeGreaterThan(maskScreen(ctx, worldMask).top);
  });

  it('faces the eye without rolling, in view, near a downward, rolled gaze at a table', () => {
    const ctx = context();
    ctx.head = {
      p: [0, 1.25, 0],
      q: quatMultiply(turn(30), quatMultiply(turn(-45, [1, 0, 0]), turn(12, [0, 0, 1]))),
    };
    const object = transformPoint(ctx.head, [0.05, -0.05, -0.7]);
    const mask = lit(ctx, 'cup', object);
    const { pose, slot } = target(ctx);
    expect(slot).toBe('above');
    expectFacingEye(ctx, pose);
    expectInView(ctx, pose);
    for (const eyeX of [-0.032, 0.032]) expectClear(ctx, pose, [mask], HEIGHT, WIDTH, TOP, eyeX);
  });
});

describe('instruction card in the gaze slots', () => {
  it('rests centered in the lower periphery when nothing lit is in view', () => {
    const ctx = context();
    const { pose, slot } = target(ctx);
    expect(slot).toBe('low');
    const card = screen(ctx, pose);
    expect((card.left + card.right) / 2).toBeCloseTo(0, 6);
    expect((card.bottom + card.top) / 2).toBeCloseTo(-0.25, 2);
    expect(distance(cardCenter(pose), ctx.head.p)).toBeCloseTo(PANEL_DISTANCE, 6);
    expectFacingEye(ctx, pose);
    expectInView(ctx, pose);
  });

  it('follows the gaze heading and pitch, faces the eye, and never rolls with the head', () => {
    const ctx = context();
    ctx.head = {
      p: [2, 1.6, 3],
      q: quatMultiply(turn(40), quatMultiply(turn(-30, [1, 0, 0]), turn(20, [0, 0, 1]))),
    };
    const { pose } = target(ctx);
    expectFacingEye(ctx, pose);
    expectInView(ctx, pose);
  });

  it('takes the upper slot over detected furniture before a lesson', () => {
    const ctx = context();
    ctx.snapshot.phase = 'idle';
    ctx.sceneObstacles = [
      [
        [-0.5, -0.6, -0.65],
        [0.5, -0.6, -0.65],
        [0.5, -0.05, -0.65],
        [-0.5, -0.05, -0.65],
      ],
      [
        [Number.NaN, 0, -0.5],
        [Infinity, 0, -0.5],
      ],
    ];
    const { pose, slot } = target(ctx);
    expect(slot).toBe('high');
    expect(isInstructionPanelClear(ctx, WIDTH, HEIGHT, TOP, pose)).toBe(true);
    expectInView(ctx, pose);
  });

  it('keeps the slot it is in while that stays clear', () => {
    const ctx = context();
    expect(target(ctx, 'high').slot).toBe('high');
    expect(target(ctx, 'low').slot).toBe('low');
  });

  it('avoids unlit objects without anchoring to them', () => {
    const blocker = rectMask([0, -0.2, -0.65], 0.4, 0.15);
    const ctx = context([blocker]);
    ctx.objects = [estimate('unlit', [0, -0.2, -0.65])];
    const { pose, slot } = target(ctx);
    expect(slot).toBe('high');
    expectClear(ctx, pose, [blocker]);
  });

  it('ignores lit objects that are behind, lost, hidden or during calibration', () => {
    const behind = context();
    lit(behind, 'behind', [0, -0.2, 0.7]);
    expect(target(behind).slot).toBe('low');

    const lost = context();
    lit(lost, 'lost', [0, -0.3, -0.7]);
    lost.objects = [{ ...(lost.objects[0] as ObjectEstimate), lostAt: 0 }];
    lost.objectMasks = [];
    expect(target(lost).slot).toBe('low');

    const hidden = context();
    lit(hidden, 'hidden', [0, 0.25, -0.7]);
    (hidden.objects[0] as ObjectEstimate).spec.hidden = true;
    hidden.objectMasks = [];
    expect(target(hidden).slot).toBe('low');

    const calibrating = context();
    lit(calibrating, 'cup', [0, -0.25, -0.7]);
    calibrating.calibration = { text: 'Pinch a corner', error: null, firstCorner: null } as never;
    expect(['low', 'high']).toContain(target(calibrating).slot);
  });

  it('switches to a gaze slot once the lit object leaves the view, with some hysteresis', () => {
    const ctx = context();
    lit(ctx, 'cup', [0, -0.25, -0.7]);
    expect(target(ctx).slot).toBe('above');
    // About 38 degrees off to the side: kept while the card is beside it, not taken up anew.
    ctx.head.q = turn(38);
    expect(target(ctx, 'above').slot).toBe('above');
    expect(target(ctx, 'low').slot).toBe('low');
    ctx.head.q = turn(60);
    expect(target(ctx, 'above').slot).toBe('low');
  });

  it('keeps every corner in front of the eye for an unusually tall card at a steep gaze', () => {
    const ctx = context();
    ctx.head.q = turn(-80, [1, 0, 0]);
    const { pose } = panelTarget(ctx, 0.3, 1.6, TOP, null);
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

  it('protects a lit object’s declared radius when it has no mask', () => {
    const ctx = context();
    ctx.objects = [estimate('large-tool', [0.05, -0.2, -0.7], 0.12)];
    ctx.snapshot.highlights.push({
      objectId: 'large-tool',
      style: 'target',
      source: 'auto',
      until: null,
    });
    const { pose } = target(ctx);
    expectClear(ctx, pose, [rectMask([0.05, -0.2, -0.7], 0.24, 0.24)]);
  });
});

describe('instruction card clearance', () => {
  it('detects a nearby object crossing a resting card after a small lateral head movement', () => {
    const ctx = context();
    const resting: Pose = { p: [0, 0, -0.65], q: identityPose().q };
    ctx.objectMasks = [rectMask([0.14, 0.07, -0.3], 0.03, 0.06)];
    expect(isInstructionPanelClear(ctx, WIDTH, HEIGHT, TOP, resting)).toBe(true);
    ctx.head.p[0] = 0.08;
    expect(isInstructionPanelClear(ctx, WIDTH, HEIGHT, TOP, resting)).toBe(false);
  });

  it.each([0.325, 1.3])('scales the reserved physical gap to the actual card depth %s', (depth) => {
    const ctx = context();
    const resting: Pose = { p: [0, 0, -depth], q: identityPose().q };
    const side = (gap: number): Vec3[] => [
      [0.15 + gap, -0.08, -depth],
      [0.25 + gap, -0.08, -depth],
      [0.25 + gap, 0.08, -depth],
      [0.15 + gap, 0.08, -depth],
    ];
    ctx.sceneObstacles = [side(PANEL_MASK_GAP - 0.01)];
    expect(isInstructionPanelClear(ctx, 0.3, 0.2, 0.1, resting)).toBe(false);
    ctx.sceneObstacles = [side(PANEL_MASK_GAP + 0.01)];
    expect(isInstructionPanelClear(ctx, 0.3, 0.2, 0.1, resting)).toBe(true);
    // Beside the lit objects, furniture does not count.
    ctx.sceneObstacles = [side(PANEL_MASK_GAP - 0.01)];
    expect(isInstructionPanelClear(ctx, 0.3, 0.2, 0.1, resting, false)).toBe(true);
  });

  it('checks all four corners of a tilted card instead of a diagonal pair', () => {
    const ctx = context();
    const resting: Pose = { p: [0, 0, -0.65], q: quatFromAxisAngle([0, 0, 1], Math.PI / 4) };
    ctx.sceneObstacles = [
      [
        [0.165, 0.02, -0.65],
        [0.185, 0.02, -0.65],
        [0.185, 0.05, -0.65],
        [0.165, 0.05, -0.65],
      ],
    ];
    expect(isInstructionPanelClear(ctx, 0.3, 0.2, 0.1, resting)).toBe(false);
  });

  it('rejects a pose that is clear at the midpoint but overlaps for one eye at a different depth', () => {
    const mask = rectMask([0.066, 0, -0.25], 0.02, 0.1);
    const ctx = context([mask]);
    const resting: Pose = { p: [0, 0, -0.8], q: identityPose().q };
    expectClear(ctx, resting, [mask], 0.1, 0.2, 0.05);
    expect(isInstructionPanelClear(ctx, 0.2, 0.1, 0.05, resting)).toBe(false);
  });

  it('rechecks the actual footprint when content grows in either axis', () => {
    const ctx = context();
    const resting: Pose = { p: [0, 0.15, -0.65], q: identityPose().q };
    ctx.sceneObstacles = [
      [
        [0.19, -0.2, -0.65],
        [0.25, -0.2, -0.65],
        [0.25, 0.05, -0.65],
        [0.19, 0.05, -0.65],
      ],
    ];
    expect(isInstructionPanelClear(ctx, 0.2, 0.12, TOP, resting)).toBe(true);
    expect(isInstructionPanelClear(ctx, 0.38, 0.24, TOP, resting)).toBe(false);
  });

  it('ignores obstacles for a card that is behind the eye or out in the periphery', () => {
    const ctx = context();
    const resting: Pose = { p: [0, 0, -0.65], q: identityPose().q };
    ctx.sceneObstacles = [
      [
        [0.2, -0.1, -0.5],
        [0.4, 0.1, -0.5],
      ],
    ];
    for (const angle of [Math.PI, Math.PI / 2]) {
      ctx.head.q = quatFromAxisAngle([0, 1, 0], angle);
      expect(isInstructionPanelClear(ctx, 0.25, 0.14, TOP, resting)).toBe(true);
    }
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

  it('finds a clear target among several objects, or falls back above the lit one', () => {
    const masks = [
      rectMask([0.3, -0.1, -0.65], 0.25, 0.35),
      rectMask([-0.15, -0.1, -0.6], 0.3, 0.25),
    ];
    const ctx = context(masks);
    expectClear(ctx, target(ctx).pose, masks);

    const crowded = context([rectMask([0, 0, -0.65], 1.8, 1.5)]);
    lit(crowded, 'cup', [0, -0.2, -0.7]);
    const fallback = target(crowded);
    expect(fallback.slot).toBe('above');
    expect(fallback.pose.p.every(Number.isFinite)).toBe(true);
  });
});
