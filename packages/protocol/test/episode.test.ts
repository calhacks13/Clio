import { describe, expect, it } from 'vitest';
import {
  EpisodeBatchSchema,
  EpisodeEventSchema,
  FrameRecordSchema,
  jointOffset,
} from '../src/index';

const hand = (n = 200) => ({ joints: new Array(n).fill(0), pinch: 0.03 });
const head = [0, 1.6, 0, 0, 0, 0, 1];

describe('frame records', () => {
  it('accepts a frame where one hand is untracked', () => {
    const r = FrameRecordSchema.safeParse({ t: 12.5, head, left: hand(), right: null });
    expect(r.success).toBe(true);
  });

  it('rejects a hand sample with the wrong number of joint values', () => {
    const r = FrameRecordSchema.safeParse({ t: 0, head, left: hand(199), right: null });
    expect(r.success).toBe(false);
  });

  it('rejects non-finite numbers', () => {
    const r = FrameRecordSchema.safeParse({
      t: 0,
      head: [0, Number.NaN, 0, 0, 0, 0, 1],
      left: null,
      right: null,
    });
    expect(r.success).toBe(false);
  });
});

describe('hand layout', () => {
  it('stores joints in WebXR order with 8 values each', () => {
    expect(jointOffset('wrist')).toBe(0);
    expect(jointOffset('thumb-tip')).toBe(32);
    expect(jointOffset('index-finger-tip')).toBe(72);
    expect(jointOffset('pinky-finger-tip')).toBe(192);
  });
});

describe('episode events', () => {
  it('parses a completed step with its provenance', () => {
    const e = EpisodeEventSchema.parse({
      t: 1500,
      type: 'step.completed',
      stepId: 'pinch-shoulder',
      index: 1,
      by: 'coach',
      forced: true,
      durationMs: 4200,
    });
    expect(e.type === 'step.completed' && e.forced).toBe(true);
  });

  it('rejects an unknown event type', () => {
    expect(EpisodeEventSchema.safeParse({ t: 0, type: 'step.teleported' }).success).toBe(false);
  });

  it('rejects an event without a timestamp', () => {
    const r = EpisodeEventSchema.safeParse({ type: 'procedure.aborted', reason: 'user quit' });
    expect(r.success).toBe(false);
  });

  it('rejects a batch with a negative sequence number', () => {
    expect(EpisodeBatchSchema.safeParse({ seq: -1, frames: [], events: [] }).success).toBe(false);
  });
});
