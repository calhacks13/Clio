import { describe, expect, it } from 'vitest';
import { CalibrationFlow } from '../../src/domain/world/calibration';

const pinch = (point: [number, number, number], phase: 'start' | 'end' = 'start') => ({
  hand: 'right' as const,
  phase,
  point,
  t: 0,
});

describe('CalibrationFlow', () => {
  it('asks for the near-left corner, then the near-right corner, then yields the workspace', () => {
    const flow = new CalibrationFlow();
    expect(flow.prompt.step).toBe('first');
    expect(flow.onPinch(pinch([-0.4, 0.75, -0.5]))).toBeNull();
    expect(flow.prompt.step).toBe('second');
    const pose = flow.onPinch(pinch([0.4, 0.75, -0.5]));
    expect(pose?.p).toEqual([-0.4, 0.75, -0.5]);
    expect(flow.prompt.step).toBe('done');
  });

  it('ignores pinch releases', () => {
    const flow = new CalibrationFlow();
    flow.onPinch(pinch([0, 0.75, -0.5], 'end'));
    expect(flow.prompt.step).toBe('first');
  });

  it('stays on the second corner, explaining why, when the corners are too close', () => {
    const flow = new CalibrationFlow();
    flow.onPinch(pinch([0, 0.75, -0.5]));
    expect(flow.onPinch(pinch([0.03, 0.75, -0.5]))).toBeNull();
    expect(flow.prompt.step).toBe('second');
    expect(flow.prompt.error).toMatch(/too close/);
  });
});
