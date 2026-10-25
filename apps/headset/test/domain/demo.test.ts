import { type Action, type ActionInput, ActionSchema } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { distance, midpoint, rotateVec, type Vec3 } from '../../src/core/math';
import { ClipPlayer } from '../../src/domain/demo/clip-player';
import { handShape } from '../../src/domain/demo/hand-shapes';
import { synthesizeDemo } from '../../src/domain/demo/synthesizer';
import { jointPose, jointPosition } from '../../src/domain/hands/features';
import { makeHand } from '../support/hands';

const JOINTS = { thumbTip: 4, indexTip: 9, middleIntermediate: 12 };
const action = (a: ActionInput): Action => ActionSchema.parse(a);

describe('hand shapes', () => {
  it('a pinch brings the thumb and index tips together', () => {
    const s = handShape('pinch', 'right');
    expect(distance(s[JOINTS.thumbTip] as Vec3, s[JOINTS.indexTip] as Vec3)).toBeLessThan(0.015);
  });

  it('an open hand keeps them well apart', () => {
    const s = handShape('open', 'right');
    expect(distance(s[JOINTS.thumbTip] as Vec3, s[JOINTS.indexTip] as Vec3)).toBeGreaterThan(0.04);
  });

  it('the left hand mirrors the right across the wrist', () => {
    const right = handShape('grasp', 'right');
    const left = handShape('grasp', 'left');
    left.forEach((p, i) => {
      const r = right[i] as Vec3;
      expect(p[0]).toBeCloseTo(-r[0]);
      expect(p[1]).toBeCloseTo(r[1]);
      expect(p[2]).toBeCloseTo(r[2]);
    });
  });
});

const jug: Vec3 = [0.3, 0.1, -0.3];
const cup: Vec3 = [0.5, 0.07, -0.25];
const positions: Record<string, Vec3> = { jug, cup, cap: [0.2, 0.15, -0.3] };
const demo = (a: ActionInput) =>
  synthesizeDemo({ stepId: 's', action: action(a), position: (id) => positions[id] });

const graspPoint = (hand: ReturnType<ClipPlayer['sample']>, which: 'left' | 'right' = 'right') => {
  const h = hand?.[which];
  if (!h) throw new Error('no hand');
  return midpoint(
    jointPosition(h, 'thumb-tip'),
    jointPosition(h, 'middle-finger-phalanx-intermediate'),
  );
};

function sampleAt(d: NonNullable<ReturnType<typeof demo>>, t: number) {
  const player = new ClipPlayer();
  player.play(d.clip, 0);
  return player.sample(t);
}

describe('synthesized demonstrations', () => {
  it('pick_up grips the object, then lifts it about 15 cm', () => {
    const d = demo({ verb: 'pick_up', object: 'jug', hand: 'right' });
    if (!d) throw new Error('no demo');
    expect(distance(graspPoint(sampleAt(d, d.marks.grip ?? -1)), jug)).toBeLessThan(0.01);
    const end = graspPoint(sampleAt(d, d.clip.durationMs));
    expect(distance(end, [jug[0], jug[1] + 0.15, jug[2]])).toBeLessThan(0.01);
    expect(d.glyphs).toContainEqual({
      kind: 'arrow',
      from: jug,
      to: [jug[0], jug[1] + 0.15, jug[2]],
    });
  });

  it('lift draws the requested height as well as moving the hand there', () => {
    const d = demo({ verb: 'lift', object: 'jug', amount: 0.28 });
    expect(d?.glyphs).toContainEqual({
      kind: 'arrow',
      from: jug,
      to: [jug[0], jug[1] + 0.28, jug[2]],
    });
  });

  it('place carries the object to the target and lets go', () => {
    const d = demo({ verb: 'place', object: 'jug', target: 'cup', hand: 'right' });
    if (!d) throw new Error('no demo');
    const atPlace = graspPoint(sampleAt(d, d.marks.place ?? -1));
    expect(distance([atPlace[0], 0, atPlace[2]], [cup[0], 0, cup[2]])).toBeLessThan(0.01);
    const end = sampleAt(d, d.clip.durationMs)?.right;
    expect(
      end && distance(jointPosition(end, 'thumb-tip'), jointPosition(end, 'index-finger-tip')),
    ).toBeGreaterThan(0.04);
    expect(d.glyphs).toContainEqual({ kind: 'arrow', from: jug, to: cup });
  });

  it('pour tilts the held container over the target', () => {
    const d = demo({ verb: 'pour', object: 'jug', target: 'cup', hand: 'right' });
    if (!d) throw new Error('no demo');
    const s = sampleAt(d, (d.marks.pour ?? 0) + 300);
    const wrist = s?.right && jointPose(s.right, 'wrist');
    if (!wrist) throw new Error('no wrist');
    const up = rotateVec(wrist.q, [0, 1, 0]);
    expect((Math.acos(Math.min(1, up[1])) * 180) / Math.PI).toBeGreaterThan(70);
    const grip = graspPoint(s);
    expect(grip[1]).toBeGreaterThan(cup[1] + 0.05);
    expect(Math.hypot(grip[0] - cup[0], grip[2] - cup[2])).toBeLessThan(0.12);
  });

  it('twist turns the wrist the requested way and draws a matching arc', () => {
    const ccw = demo({ verb: 'twist', object: 'cap', direction: 'ccw', amount: 1 });
    const cw = demo({ verb: 'twist', object: 'cap', direction: 'cw', amount: 1 });
    if (!ccw || !cw) throw new Error('no demo');
    const yaw = (t: number, d: NonNullable<typeof ccw>) => {
      const w = sampleAt(d, t)?.right;
      if (!w) throw new Error('no hand');
      const f = rotateVec(jointPose(w, 'wrist').q, [1, 0, 0]);
      return Math.atan2(-f[2], f[0]);
    };
    const start = ccw.marks.twist ?? 0;
    expect(yaw(start + 550, ccw) - yaw(start, ccw)).toBeGreaterThan(1);
    expect(yaw(start + 550, cw) - yaw(start, cw)).toBeLessThan(-1);
    const arc = (d: NonNullable<typeof ccw>) => d.glyphs.find((g) => g.kind === 'arc');
    expect(arc(ccw)?.kind === 'arc' && arc(ccw)?.angle).toBeGreaterThan(0);
    expect(arc(cw)?.kind === 'arc' && arc(cw)?.angle).toBeLessThan(0);
  });

  it('has nothing to show for actions without hand motion, or without object positions', () => {
    expect(demo({ verb: 'observe', object: 'cup' })).toBeNull();
    expect(demo({ verb: 'pour', object: 'jug', target: 'sink' })).toBeNull();
  });
});

describe('ClipPlayer', () => {
  const frames = [
    { t: 0, left: null, right: makeHand({ 'index-finger-tip': [0, 0, 0] }) },
    { t: 100, left: null, right: makeHand({ 'index-finger-tip': [0.1, 0, 0] }) },
  ];
  const clip = { durationMs: 100, frames };

  it('interpolates between recorded frames', () => {
    const p = new ClipPlayer();
    p.play(clip, 1000);
    const right = p.sample(1050)?.right;
    expect(right && jointPosition(right, 'index-finger-tip')[0]).toBeCloseTo(0.05);
  });

  it('loops when asked, and otherwise holds the last frame and finishes', () => {
    const looping = new ClipPlayer();
    looping.play(clip, 0, { loop: true });
    const r = looping.sample(150)?.right;
    expect(r && jointPosition(r, 'index-finger-tip')[0]).toBeCloseTo(0.05);

    const once = new ClipPlayer();
    once.play(clip, 0);
    const last = once.sample(500)?.right;
    expect(last && jointPosition(last, 'index-finger-tip')[0]).toBeCloseTo(0.1);
    expect(once.finished(500)).toBe(true);
  });
});
