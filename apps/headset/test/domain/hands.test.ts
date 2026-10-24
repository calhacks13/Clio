import { describe, expect, it } from 'vitest';
import { handPoint, jointPosition, pinchPoint } from '../../src/domain/hands/features';
import { PinchDetector } from '../../src/domain/hands/pinch-detector';
import { makeHand } from '../support/hands';

describe('hand features', () => {
  const hand = makeHand({
    wrist: [0, 1, 0],
    'thumb-tip': [0.1, 1, -0.1],
    'index-finger-tip': [0.12, 1.02, -0.1],
    'middle-finger-phalanx-proximal': [0, 1, -0.08],
  });

  it('reads a joint from the flat sample', () => {
    expect(jointPosition(hand, 'index-finger-tip')).toEqual([0.12, 1.02, -0.1]);
  });

  it('puts the pinch point between thumb and index tips', () => {
    const p = pinchPoint(hand);
    expect(p[0]).toBeCloseTo(0.11);
    expect(p[1]).toBeCloseTo(1.01);
    expect(p[2]).toBeCloseTo(-0.1);
  });

  it('puts the palm between the wrist and the middle knuckle', () => {
    expect(handPoint(hand, 'palm')).toEqual([0, 1, -0.04]);
  });
});

describe('PinchDetector', () => {
  const tips = (gap: number) =>
    makeHand({ 'thumb-tip': [0, 1, -0.3], 'index-finger-tip': [gap, 1, -0.3] });

  it('starts a pinch only once the tips are close, and ends it only once clearly apart', () => {
    const d = new PinchDetector({ startDistance: 0.02, endDistance: 0.035 });
    expect(d.update('right', tips(0.025), 0)).toBeNull();
    expect(d.update('right', tips(0.015), 10)?.phase).toBe('start');
    expect(d.update('right', tips(0.03), 20)).toBeNull();
    expect(d.isPinching('right')).toBe(true);
    expect(d.update('right', tips(0.04), 30)?.phase).toBe('end');
    expect(d.isPinching('right')).toBe(false);
  });

  it('ends an active pinch when the hand stops being tracked', () => {
    const d = new PinchDetector({ startDistance: 0.02, endDistance: 0.035 });
    d.update('left', tips(0.01), 0);
    expect(d.update('left', null, 10)?.phase).toBe('end');
  });

  it('reports where the pinch happened', () => {
    const d = new PinchDetector({ startDistance: 0.02, endDistance: 0.035 });
    const start = d.update('left', tips(0.01), 0);
    expect(start?.point[0]).toBeCloseTo(0.005);
    expect(start?.point[2]).toBeCloseTo(-0.3);
  });
});
