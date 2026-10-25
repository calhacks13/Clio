import { describe, expect, it } from 'vitest';
import { ObjectObservationSchema } from '../src/index';

// Depth samples on an observation (docs/data-format.md): where camera rays inside the outline met
// the depth map on the object, in the workspace frame, so a shape can be fused after the episode.

const observation = {
  t: 1250,
  observedT: 1190,
  objectId: 'syringe',
  status: 'measured',
  role: 'tracker',
  source: 'yoloe-26l-seg',
  box: [0.4, 0.3, 0.5, 0.45],
  outline: null,
  point: [0.45, 0.36],
  contact: [0.45, 0.45],
  score: 0.81,
  frame: { seq: 42, width: 480, height: 360 },
  trackId: '7',
};

describe('observation depth samples', () => {
  it('keeps the samples measured on the object, in the workspace frame', () => {
    const surface = [
      [0.3, 0.02, -0.2],
      [0.31, 0.03, -0.19],
    ];
    expect(ObjectObservationSchema.parse({ ...observation, surface }).surface).toEqual(surface);
  });

  it('leaves them out when none were taken, as older recordings do', () => {
    expect(ObjectObservationSchema.parse(observation).surface).toBeUndefined();
  });

  it('rejects more than 64 samples on one frame', () => {
    const surface = Array.from({ length: 65 }, (_, i) => [i / 100, 0, 0]);
    expect(ObjectObservationSchema.safeParse({ ...observation, surface }).success).toBe(false);
  });
});
