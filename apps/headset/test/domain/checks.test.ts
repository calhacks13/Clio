import { type CheckInput, CheckSchema } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { createCheck } from '../../src/domain/procedure/checks';
import { ctx } from '../support/context';
import { makeHand, pinchingHand } from '../support/hands';

const check = (input: CheckInput) => createCheck(CheckSchema.parse(input));
const cup: [number, number, number] = [0.2, 0.07, -0.2];

describe('pinch_near', () => {
  it('needs the selected hand to be pinching within the radius', () => {
    const c = check({ type: 'pinch_near', object: 'cup', hand: 'left', radius: 0.04 });
    const objects = { cup };
    expect(c.update(ctx({ t: 0, left: pinchingHand([0.2, 0.07, -0.17]), objects })).satisfied).toBe(
      false,
    );
    expect(
      c.update(
        ctx({ t: 1, left: pinchingHand([0.2, 0.07, -0.17]), pinching: { left: true }, objects }),
      ).satisfied,
    ).toBe(true);
  });

  it('ignores the other hand', () => {
    const c = check({ type: 'pinch_near', object: 'cup', hand: 'left' });
    const s = c.update(
      ctx({ t: 0, right: pinchingHand(cup), pinching: { right: true }, objects: { cup } }),
    );
    expect(s.satisfied).toBe(false);
  });

  it('is never satisfied while the object has no position yet', () => {
    const c = check({ type: 'pinch_near', object: 'cup' });
    expect(
      c.update(ctx({ t: 0, left: pinchingHand(cup), pinching: { left: true } })).satisfied,
    ).toBe(false);
  });
});

describe('hand_near', () => {
  it('requires the hand to stay near for the dwell time', () => {
    const c = check({ type: 'hand_near', object: 'cup', radius: 0.06, dwellMs: 300 });
    const near = { right: pinchingHand(cup), objects: { cup } };
    expect(c.update(ctx({ t: 0, ...near })).satisfied).toBe(false);
    const half = c.update(ctx({ t: 150, ...near }));
    expect(half.satisfied).toBe(false);
    expect(half.progress).toBeCloseTo(0.5);
    expect(c.update(ctx({ t: 300, ...near })).satisfied).toBe(true);
  });

  it('tolerates a single-frame tracking dropout but resets after a real departure', () => {
    const c = check({ type: 'hand_near', object: 'cup', dwellMs: 300 });
    const near = { right: pinchingHand(cup), objects: { cup } };
    const away = { right: pinchingHand([0.9, 0.07, -0.2]), objects: { cup } };
    c.update(ctx({ t: 0, ...near }));
    c.update(ctx({ t: 100, objects: { cup } })); // hand lost for one frame
    expect(c.update(ctx({ t: 300, ...near })).satisfied).toBe(true);

    const d = check({ type: 'hand_near', object: 'cup', dwellMs: 300 });
    d.update(ctx({ t: 0, ...near }));
    d.update(ctx({ t: 100, ...away }));
    d.update(ctx({ t: 400, ...away }));
    expect(d.update(ctx({ t: 500, ...near })).satisfied).toBe(false);
  });
});

describe('lift', () => {
  it('measures height above the workspace surface (y = 0)', () => {
    const c = check({ type: 'lift', hand: 'right', height: 0.2, dwellMs: 0 });
    const low = makeHand({ wrist: [0, 0.1, -0.2] });
    const high = makeHand({ wrist: [0, 0.25, -0.2] });
    expect(c.update(ctx({ t: 0, right: low })).satisfied).toBe(false);
    expect(c.update(ctx({ t: 1, right: high })).satisfied).toBe(true);
  });
});

describe('object_near', () => {
  it('compares two tracked objects', () => {
    const c = check({
      type: 'object_near',
      object: 'syringe',
      target: 'cup',
      radius: 0.05,
      dwellMs: 0,
    });
    expect(c.update(ctx({ t: 0, objects: { cup, syringe: [0.5, 0.1, -0.2] } })).satisfied).toBe(
      false,
    );
    expect(c.update(ctx({ t: 1, objects: { cup, syringe: [0.21, 0.1, -0.2] } })).satisfied).toBe(
      true,
    );
  });
});

describe('confirm and elapsed', () => {
  it('confirm waits for the right confirmer', () => {
    const c = check({ type: 'confirm', by: 'coach' });
    expect(c.update(ctx({ t: 0, confirmations: { user: true } })).satisfied).toBe(false);
    expect(c.update(ctx({ t: 1, confirmations: { coach: true } })).satisfied).toBe(true);
  });

  it('elapsed counts from the start of the step', () => {
    const c = check({ type: 'elapsed', ms: 1000 });
    expect(c.update(ctx({ t: 1400, stepStartT: 500 })).satisfied).toBe(false);
    expect(c.update(ctx({ t: 1500, stepStartT: 500 })).satisfied).toBe(true);
  });
});

describe('composites', () => {
  const pinchAt = (p: [number, number, number]) => pinchingHand(p);
  const shoulder: [number, number, number] = [0.14, 0, -0.18];
  const middle: [number, number, number] = [0.4, 0, -0.18];
  const objects = { shoulder, middle };

  it('all needs every child in the same frame', () => {
    const c = check({
      type: 'all',
      of: [
        { type: 'pinch_near', object: 'shoulder', hand: 'left' },
        { type: 'pinch_near', object: 'middle', hand: 'right' },
      ],
    });
    expect(
      c.update(ctx({ t: 0, left: pinchAt(shoulder), pinching: { left: true }, objects })).satisfied,
    ).toBe(false);
    expect(
      c.update(
        ctx({
          t: 1,
          left: pinchAt(shoulder),
          right: pinchAt(middle),
          pinching: { left: true, right: true },
          objects,
        }),
      ).satisfied,
    ).toBe(true);
  });

  it('sequence latches each child in order', () => {
    const c = check({
      type: 'sequence',
      of: [
        { type: 'hand_near', object: 'shoulder', dwellMs: 0 },
        { type: 'hand_near', object: 'middle', dwellMs: 0 },
      ],
    });
    // Visiting the second target first doesn't count.
    expect(c.update(ctx({ t: 0, right: pinchAt(middle), objects })).progress).toBe(0);
    expect(c.update(ctx({ t: 1, right: pinchAt(shoulder), objects })).progress).toBeCloseTo(0.5);
    // The first child stays latched after the hand leaves it.
    const done = c.update(ctx({ t: 2, right: pinchAt(middle), objects }));
    expect(done.satisfied).toBe(true);
  });

  it('any is satisfied by whichever child holds', () => {
    const c = check({
      type: 'any',
      of: [
        { type: 'confirm', by: 'user' },
        { type: 'hand_near', object: 'middle', dwellMs: 0 },
      ],
    });
    expect(c.update(ctx({ t: 0, right: pinchAt(middle), objects })).satisfied).toBe(true);
  });
});
