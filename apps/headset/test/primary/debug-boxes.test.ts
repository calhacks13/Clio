import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { TrackerMask } from '../../src/adapters/net/tracker-client';
import type { Vec3 } from '../../src/core/math';
import {
  boxMask,
  boxRect,
  DebugBoxes,
  debugFlags,
  drawPanel,
  frameRibbon,
} from '../../src/primary/debug-boxes';

/** A 2D context that records what was called (no canvas in Node). */
function recordingContext() {
  const calls: { name: string; args: unknown[] }[] = [];
  const g = new Proxy({ calls } as Record<string, unknown>, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (key === 'measureText') return (text: string) => ({ width: text.length * 10 });
      return (...args: unknown[]) => calls.push({ name: key, args });
    },
    set(target, key: string, value) {
      target[key] = value;
      return true;
    },
  });
  return { g: g as unknown as CanvasRenderingContext2D, calls };
}

function fakeCanvas() {
  const { g, calls } = recordingContext();
  const canvas = { width: 0, height: 0, getContext: () => g } as unknown as HTMLCanvasElement;
  return { canvas, calls };
}

const frame = (seq: number, t: number) => ({
  seq,
  t,
  jpeg: { bytes: new Uint8Array([seq]), base64: '' },
});

const mask = (seq: number, t: number, extra: Partial<TrackerMask> = {}): TrackerMask => ({
  type: 'mask',
  seq,
  t,
  found: true,
  name: 'bottle',
  outline: [
    [0.3, 0.3],
    [0.6, 0.3],
    [0.6, 0.7],
  ],
  box: [0.3, 0.3, 0.6, 0.7],
  point: null,
  contact: null,
  score: 0.9,
  state: 'tracking',
  ms: null,
  model: null,
  ...extra,
});

describe('debugFlags', () => {
  it('reads comma lists and repeats', () => {
    expect([...debugFlags(new URLSearchParams('debug=1,boxes'))]).toEqual(['1', 'boxes']);
    expect([...debugFlags(new URLSearchParams('debug=1&debug=boxes'))]).toEqual(['1', 'boxes']);
    expect([...debugFlags(new URLSearchParams(''))]).toEqual(['1', 'boxes']);
    expect(debugFlags(new URLSearchParams('debug=0')).size).toBe(0);
    expect(debugFlags(new URLSearchParams('debug=off')).size).toBe(0);
  });
});

describe('box helpers', () => {
  it('turns a box into a 4-corner outline and pixels', () => {
    expect(boxMask([0.1, 0.2, 0.3, 0.4]).outline).toEqual([
      [0.1, 0.2],
      [0.3, 0.2],
      [0.3, 0.4],
      [0.1, 0.4],
    ]);
    expect(boxRect([0.25, 0.5, 0.75, 1], 640, 480)).toEqual([160, 240, 320, 240]);
  });

  it('builds a frame ribbon inset toward the middle', () => {
    const square: Vec3[] = [
      [-0.1, -0.1, -1],
      [0.1, -0.1, -1],
      [0.1, 0.1, -1],
      [-0.1, 0.1, -1],
    ];
    const { positions, index } = frameRibbon(square, 0.01);
    expect(positions.length).toBe(24);
    expect(index.length).toBe(24);
    // The first corner's inner vertex is 1 cm in on both axes.
    expect(positions[3]).toBeCloseTo(-0.09);
    expect(positions[4]).toBeCloseTo(-0.09);
    expect(positions[5]).toBeCloseTo(-1);
  });
});

describe('DebugBoxes', () => {
  it('shows the newest mask on its own frame, with the age of jev’s frame', () => {
    const { canvas } = fakeCanvas();
    const debug = new DebugBoxes({ canvas });
    debug.frameSent(frame(1, 100));
    debug.frameSent(frame(2, 133));
    debug.frameSent(frame(3, 166));
    debug.answer({ name: 'label', box: [0.4, 0.4, 0.5, 0.5], seq: 1, t: 100 });
    debug.mask(mask(2, 133));
    const view = debug.view();
    expect(view.frame?.seq).toBe(2);
    expect(view.mask?.seq).toBe(2);
    expect(view.answerAgeMs).toBe(33);
  });

  it('shows a look’s own capture without a tracker, and jev’s box at age 0 on its own frame', () => {
    const { canvas } = fakeCanvas();
    const debug = new DebugBoxes({ canvas });
    debug.lookFrame(500, 'AAAA');
    debug.answer({ name: 'label', box: [0.4, 0.4, 0.5, 0.5], seq: null, t: 500 });
    expect(debug.view().frame?.seq).toBeNull();
    expect(debug.view().answerAgeMs).toBe(0);
    expect(debug.view().mask).toBeNull();
  });

  it('exposes the raw values, and a lost mask reads as lost', () => {
    const { canvas } = fakeCanvas();
    const debug = new DebugBoxes({ canvas });
    debug.answer({ name: 'label', box: [0.4, 0.4, 0.5, 0.5], seq: 7, t: 1 });
    debug.mask(mask(8, 2, { found: false, box: null, outline: null, state: null }));
    debug.target({ type: 'target', seq: 7, box: [0.4, 0.4, 0.5, 0.5], name: 'label', part: true });
    const snap = debug.snapshot();
    expect(snap.answer).toEqual({
      name: 'label',
      box: [0.4, 0.4, 0.5, 0.5],
      seq: 7,
      t: 1,
      world: null,
    });
    expect(snap.mask).toMatchObject({ seq: 8, box: null, state: 'lost', outlinePoints: 0 });
    expect(snap.target?.part).toBe(true);
  });

  it('redraws at most 5 times a second, and only when something changed', async () => {
    const { canvas } = fakeCanvas();
    let decodes = 0;
    const debug = new DebugBoxes({
      canvas,
      decode: async () => {
        decodes++;
        return {} as ImageBitmap;
      },
    });
    const head = new Vector3(0, 1.6, 0);
    const q = new Quaternion();
    debug.frameSent(frame(1, 0));
    debug.update(head, q, 14, 0);
    await Promise.resolve();
    await Promise.resolve();
    debug.frameSent(frame(2, 30));
    debug.update(head, q, 14, 100);
    await Promise.resolve();
    expect(decodes).toBe(1);
    debug.update(head, q, 14, 250);
    await Promise.resolve();
    expect(decodes).toBe(2);
    debug.update(head, q, 14, 500);
    await Promise.resolve();
    expect(decodes).toBe(2);
    expect(debug.panel.visible).toBe(true);
    debug.hide();
    expect(debug.panel.visible).toBe(false);
  });
});

describe('drawPanel', () => {
  it('draws jev’s box in yellow and the tracker’s box and outline in cyan', () => {
    const { g, calls } = recordingContext();
    drawPanel(g, null, {
      frame: null,
      answer: { name: 'label', box: [0.25, 0.25, 0.5, 0.5], seq: 1, t: 0 },
      mask: {
        seq: 1,
        t: 0,
        box: [0.1, 0.1, 0.9, 0.9],
        state: 'coasting',
        score: 0.5,
        outline: [
          [0.1, 0.1],
          [0.9, 0.1],
          [0.9, 0.9],
        ],
      },
      answerAgeMs: 0,
    });
    const rects = calls.filter((c) => c.name === 'strokeRect').map((c) => c.args);
    expect(rects).toEqual([
      [64, 48, 512, 384],
      [160, 120, 160, 120],
    ]);
    const texts = calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
    expect(texts).toEqual(expect.arrayContaining(['label', 'coasting', '0', '0.50']));
    expect(calls.some((c) => c.name === 'stroke')).toBe(true);
  });
});
