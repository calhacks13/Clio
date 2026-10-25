import type { Action, ClipFrame, Handedness } from '@clio/protocol';
import {
  add,
  midpoint,
  type Pose,
  type Quat,
  quatFromAxisAngle,
  quatMultiply,
  rotateVec,
  sub,
  type Vec3,
} from '../../core/math';
import { gripPoint, type HandShapeId } from './hand-shapes';
import { type Keyframe, sampleTrack } from './keyframes';
import type { DemoMark, Demonstration, Glyph } from './types';

// "Clio figures out how to show it." Each action verb has a choreography: a short sequence of
// wrist poses and hand shapes placed relative to the real objects' positions. No recording needed,
// so any AI-generated step with an action gets a ghost-hand demo. Recorded expert clips, when they
// exist, are preferred (see DemoLibrary).

export interface DemoInput {
  stepId: string;
  action: Action;
  /** Workspace position of an object, if known. */
  position(id: string): Vec3 | undefined;
  /** Object size in meters (used to choose a pinch or a grasp). */
  radius?(id: string): number | undefined;
  fps?: number;
}

const deg = (d: number) => (d * Math.PI) / 180;
/** Fingers forward and down toward the table, palm down. */
const Q_REACH: Quat = quatFromAxisAngle([1, 0, 0], deg(-50));
/** Fingers pointing almost straight down, for caps, buttons and knobs. */
const Q_DOWN: Quat = quatFromAxisAngle([1, 0, 0], deg(-80));
const Q_FLAT: Quat = quatFromAxisAngle([1, 0, 0], deg(-15));
const up = (p: Vec3, h: number): Vec3 => [p[0], p[1] + h, p[2]];

/** Wrist pose that puts the shape's grip point at `grip`. */
function wristAt(shape: HandShapeId, hand: Handedness, grip: Vec3, q: Quat): Pose {
  return { p: sub(grip, rotateVec(q, gripPoint(shape, hand))), q };
}

class Choreo {
  readonly track: Keyframe[] = [];
  readonly marks: Partial<Record<DemoMark, number>> = {};
  readonly captions: { t: number; text: string }[] = [];
  readonly glyphs: Glyph[] = [];
  private t = 0;

  constructor(readonly hand: Handedness) {}

  /** Keyframe whose wrist puts `gripShape`'s grip point at `at`, displaying `shape`. */
  key(ms: number, at: Vec3, shape: HandShapeId, q: Quat, gripShape: HandShapeId = shape): this {
    this.t += this.track.length === 0 ? 0 : ms;
    this.track.push({ t: this.t, wrist: wristAt(gripShape, this.hand, at, q), shape });
    return this;
  }

  hold(ms: number): this {
    const last = this.track.at(-1);
    if (last) {
      this.t += ms;
      this.track.push({ ...last, t: this.t });
    }
    return this;
  }

  mark(name: DemoMark, caption?: string): this {
    this.marks[name] = this.t;
    if (caption) this.captions.push({ t: this.t, text: caption });
    return this;
  }
}

/** Approach from above and in front, then close the hand on the object. */
function reachAndGrip(c: Choreo, o: Vec3, grip: HandShapeId, q: Quat = Q_REACH): void {
  c.key(0, add(o, [0, 0.16, 0.16]), 'relaxed', q, grip)
    .key(700, add(o, [0, 0.08, 0.04]), 'open', q, grip)
    .mark('reach')
    .key(450, o, 'open', q, grip)
    .key(350, o, grip, q)
    .mark('grip', 'Grip');
}

const DIRECTIONS: Record<string, Vec3> = {
  toward: [0, 0, 1],
  away: [0, 0, -1],
  up: [0, 1, 0],
  down: [0, -1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
};

type Builder = (c: Choreo, a: Action, o: Vec3, t: Vec3 | undefined, grip: HandShapeId) => boolean;

const VERBS: Partial<Record<Action['verb'], Builder>> = {
  point_at(c, _a, o) {
    c.key(0, add(o, [0, 0.2, 0.2]), 'relaxed', Q_REACH, 'point')
      .key(800, add(o, [0, 0.1, 0.1]), 'point', Q_REACH)
      .mark('touch', 'This one')
      .hold(1000);
    return true;
  },
  touch(c, _a, o) {
    c.key(0, add(o, [0, 0.14, 0.12]), 'relaxed', Q_DOWN, 'point')
      .key(700, up(o, 0.06), 'point', Q_DOWN)
      .key(400, o, 'point', Q_DOWN)
      .mark('touch', 'Touch')
      .hold(500)
      .key(400, up(o, 0.05), 'point', Q_DOWN);
    return true;
  },
  pinch(c, _a, o) {
    reachAndGrip(c, o, 'pinch');
    c.hold(600);
    return true;
  },
  grasp(c, _a, o, _t, grip) {
    reachAndGrip(c, o, grip);
    c.hold(600);
    return true;
  },
  pick_up(c, a, o, _t, grip) {
    reachAndGrip(c, o, grip);
    c.key(700, up(o, a.amount ?? 0.15), grip, Q_REACH)
      .mark('lift', 'Lift')
      .hold(500);
    c.glyphs.push({ kind: 'arrow', from: o, to: up(o, a.amount ?? 0.15) });
    return true;
  },
  place(c, _a, o, t, grip) {
    if (!t) return false;
    reachAndGrip(c, o, grip);
    c.key(600, up(o, 0.12), grip, Q_REACH)
      .key(900, up(t, 0.12), grip, Q_REACH)
      .mark('carry', 'Carry')
      .key(600, up(t, 0.01), grip, Q_REACH)
      .mark('place', 'Set it down')
      .key(300, up(t, 0.01), 'open', Q_REACH, grip)
      .mark('release')
      .key(400, up(t, 0.1), 'open', Q_REACH, grip);
    c.glyphs.push({ kind: 'arrow', from: o, to: t });
    return true;
  },
  insert(c, _a, o, t, grip) {
    if (!t) return false;
    reachAndGrip(c, o, grip);
    c.key(600, up(o, 0.12), grip, Q_REACH)
      .key(900, up(t, 0.1), grip, Q_REACH)
      .mark('carry')
      .key(700, up(t, -0.03), grip, Q_REACH)
      .mark('place', 'Push it in')
      .hold(400);
    c.glyphs.push({ kind: 'arrow', from: o, to: t });
    return true;
  },
  pour(c, _a, o, t, grip) {
    if (!t) return false;
    const side = c.hand === 'right' ? 0.07 : -0.07;
    const over = add(t, [side, 0.14, 0.02]);
    const tilt = quatMultiply(
      quatFromAxisAngle([0, 0, -1], deg(c.hand === 'right' ? 100 : -100)),
      Q_REACH,
    );
    reachAndGrip(c, o, grip);
    c.key(600, up(o, 0.15), grip, Q_REACH)
      .mark('lift')
      .key(900, over, grip, Q_REACH)
      .mark('carry')
      .key(700, over, grip, tilt)
      .mark('pour', 'Pour')
      .hold(1000)
      .key(600, over, grip, Q_REACH);
    c.glyphs.push({ kind: 'arrow', from: o, to: t });
    return true;
  },
  twist(c, a, o) {
    const sign = a.direction === 'cw' ? -1 : 1;
    const strokes = Math.min(4, Math.max(1, Math.round((a.amount ?? 1) * 3)));
    reachAndGrip(c, o, 'grasp', Q_DOWN);
    const turned = quatMultiply(quatFromAxisAngle([0, 1, 0], sign * deg(110)), Q_DOWN);
    for (let i = 0; i < strokes; i++) {
      if (i === 0) c.mark('twist', sign > 0 ? 'Turn left' : 'Turn right');
      c.key(550, o, 'grasp', turned)
        .key(200, o, 'open', turned, 'grasp')
        .key(350, o, 'open', Q_DOWN, 'grasp')
        .key(200, o, 'grasp', Q_DOWN);
    }
    c.glyphs.push({
      kind: 'arc',
      center: o,
      axis: [0, 1, 0],
      radius: 0.06,
      angle: sign * Math.min(a.amount ?? 1, 2) * 2 * Math.PI,
    });
    return true;
  },
  press(c, _a, o) {
    c.key(0, up(o, 0.12), 'relaxed', Q_DOWN, 'point')
      .key(600, up(o, 0.04), 'point', Q_DOWN)
      .key(300, up(o, -0.012), 'point', Q_DOWN)
      .mark('press', 'Press')
      .hold(400)
      .key(300, up(o, 0.04), 'point', Q_DOWN);
    c.glyphs.push({ kind: 'press', at: o });
    return true;
  },
  pull(c, a, o, _t, grip) {
    const dir = DIRECTIONS[a.direction ?? 'toward'] ?? DIRECTIONS.toward ?? [0, 0, 1];
    const end = add(o, [
      dir[0] * (a.amount ?? 0.15),
      dir[1] * (a.amount ?? 0.15),
      dir[2] * (a.amount ?? 0.15),
    ]);
    reachAndGrip(c, o, grip);
    c.key(900, end, grip, Q_REACH).mark('pull', 'Pull').hold(500);
    c.glyphs.push({ kind: 'arrow', from: o, to: end });
    return true;
  },
  wipe(c, _a, o) {
    const left = add(o, [-0.08, 0, 0]);
    const right = add(o, [0.08, 0, 0]);
    c.key(0, up(o, 0.1), 'relaxed', Q_FLAT, 'flat')
      .key(600, o, 'flat', Q_FLAT)
      .mark('wipe', 'Wipe');
    for (let i = 0; i < 3; i++) c.key(400, right, 'flat', Q_FLAT).key(400, left, 'flat', Q_FLAT);
    c.key(300, o, 'flat', Q_FLAT);
    c.glyphs.push({ kind: 'sweep', from: left, to: right });
    return true;
  },
  fold(c, _a, o, t) {
    if (!t) return false;
    reachAndGrip(c, o, 'pinch');
    c.key(500, up(o, 0.1), 'pinch', Q_REACH)
      .key(500, up(midpoint(o, t), 0.18), 'pinch', Q_REACH)
      .key(500, up(t, 0.06), 'pinch', Q_REACH)
      .key(400, t, 'pinch', Q_REACH)
      .mark('fold', 'Fold over')
      .key(300, t, 'open', Q_REACH, 'pinch')
      .mark('release');
    c.glyphs.push({ kind: 'arrow', from: o, to: t });
    return true;
  },
  lift(c, a, o, _t, grip) {
    reachAndGrip(c, o, grip);
    c.key(700, up(o, a.amount ?? 0.2), grip, Q_REACH)
      .mark('lift', 'Lift')
      .hold(500);
    c.glyphs.push({ kind: 'arrow', from: o, to: up(o, a.amount ?? 0.2) });
    return true;
  },
};

const TAIL_MS = 300;
const BOTH_HANDS_OFFSET = 0.06;

export function synthesizeDemo(input: DemoInput): Demonstration | null {
  const { action, stepId } = input;
  const build = VERBS[action.verb];
  if (!build || !action.object) return null;
  const object = input.position(action.object);
  const target = action.target ? input.position(action.target) : undefined;
  if (!object || (action.target && !target)) return null;
  const grip: HandShapeId = (input.radius?.(action.object) ?? 0.03) <= 0.02 ? 'pinch' : 'grasp';

  const hands: { hand: Handedness; dx: number }[] =
    action.hand === 'both'
      ? [
          { hand: 'left', dx: -BOTH_HANDS_OFFSET },
          { hand: 'right', dx: BOTH_HANDS_OFFSET },
        ]
      : [{ hand: action.hand === 'left' ? 'left' : 'right', dx: 0 }];

  const choreos: Choreo[] = [];
  for (const { hand, dx } of hands) {
    const c = new Choreo(hand);
    const shift = (p: Vec3 | undefined) => p && add(p, [dx, 0, 0]);
    if (!build(c, action, shift(object) as Vec3, shift(target), grip)) return null;
    choreos.push(c);
  }
  const lead = choreos.at(-1);
  if (!lead) return null;

  const durationMs = Math.max(...choreos.map((c) => c.track.at(-1)?.t ?? 0)) + TAIL_MS;
  const step = 1000 / (input.fps ?? 30);
  const frames: ClipFrame[] = [];
  for (let t = 0; ; t = Math.min(durationMs, t + step)) {
    const frame: ClipFrame = { t, left: null, right: null };
    for (const c of choreos) frame[c.hand] = sampleTrack(c.track, t, c.hand);
    frames.push(frame);
    if (t >= durationMs) break;
  }

  return {
    stepId,
    verb: action.verb,
    source: 'synthesized',
    clip: { durationMs, frames },
    glyphs: lead.glyphs,
    marks: lead.marks,
    captions: lead.captions,
  };
}
