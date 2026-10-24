import { describe, expect, it } from 'vitest';
import { LocateResponseSchema, PlanRequestSchema } from '../src/index';

const jpeg = { mimeType: 'image/jpeg', data: 'AAAA' };

describe('planner API', () => {
  it('caps plan requests at three camera images', () => {
    expect(
      PlanRequestSchema.safeParse({ goal: 'fold a shirt', images: [jpeg, jpeg, jpeg] }).success,
    ).toBe(true);
    expect(
      PlanRequestSchema.safeParse({ goal: 'fold a shirt', images: [jpeg, jpeg, jpeg, jpeg] })
        .success,
    ).toBe(false);
  });
});

describe('vision API', () => {
  const detection = { id: 'cup_a', found: true, point: [0.5, 0.25], box: null, confidence: 0.8 };

  it('accepts detections in normalized image coordinates', () => {
    const r = LocateResponseSchema.safeParse({
      detections: [detection],
      model: 'm',
      latencyMs: 900,
    });
    expect(r.success).toBe(true);
  });

  it('rejects points outside the image', () => {
    const bad = { ...detection, point: [1.2, 0.5] };
    const r = LocateResponseSchema.safeParse({ detections: [bad], model: 'm', latencyMs: 900 });
    expect(r.success).toBe(false);
  });
});
