import { describe, expect, it } from 'vitest';
import { LocateRequestSchema, LocateResponseSchema, PlanRequestSchema } from '../src/index';

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

  it('carries an optional outline polygon, and defaults it to none', () => {
    const outline = [
      [0.4, 0.2],
      [0.6, 0.2],
      [0.6, 0.4],
    ];
    const withOutline = LocateResponseSchema.parse({
      detections: [{ ...detection, outline }],
      model: 'jev',
      latencyMs: 80,
    });
    expect(withOutline.detections[0]?.outline).toEqual(outline);
    const without = LocateResponseSchema.parse({
      detections: [detection],
      model: 'm',
      latencyMs: 1,
    });
    expect(without.detections[0]?.outline).toBeNull();
  });

  it('rejects outline points outside the image', () => {
    const bad = {
      ...detection,
      outline: [
        [0, 0],
        [1.5, 0],
        [0, 1],
      ],
    };
    expect(
      LocateResponseSchema.safeParse({ detections: [bad], model: 'm', latencyMs: 1 }).success,
    ).toBe(false);
  });

  it('sends each object with a full description and an optional short phrase', () => {
    const r = LocateRequestSchema.parse({
      image: jpeg,
      objects: [{ id: 'cap', query: 'The round blue cap with a wiper icon.', phrase: 'blue cap' }],
    });
    expect(r.objects[0]?.phrase).toBe('blue cap');
  });
});
