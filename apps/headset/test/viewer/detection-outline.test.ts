import type { Pose7 } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HEAD_FROM_CAMERA } from '../../src/adapters/camera/calibration';
import { composePose, dot, normalize, sub, type Vec3 } from '../../src/core/math';
import { detectionOutline } from '../../src/viewer/detection-outline';
import type { Detection } from '../../src/viewer/episode-data';

// Head 45 cm above the table, 40 cm toward the user, looking straight ahead (-z).
const HEAD: Pose7 = [0.3, 0.45, 0.4, 0, 0, 0, 1];
const CENTER: Vec3 = [0.3, 0.1, -0.3];

function detection(overrides: Partial<Detection> = {}): Detection {
  return {
    t: 1000,
    type: 'object.detected',
    objectId: 'cup',
    stepId: null,
    phrase: null,
    description: 'cup',
    found: true,
    point: [0.5, 0.5],
    box: [0.4, 0.4, 0.6, 0.6],
    outline: null,
    confidence: 0.9,
    position: CENTER,
    source: 'gemini',
    latencyMs: 80,
    ...overrides,
  };
}

describe('detectionOutline', () => {
  it('lifts a box onto the plane through the detection that faces the camera', () => {
    const loop = detectionOutline(detection(), HEAD);
    expect(loop).toHaveLength(4);
    const eye = composePose(
      { p: [HEAD[0], HEAD[1], HEAD[2]], q: [HEAD[3], HEAD[4], HEAD[5], HEAD[6]] },
      DEFAULT_HEAD_FROM_CAMERA,
    ).p;
    const normal = normalize(sub(eye, CENTER));
    for (const p of loop ?? []) expect(Math.abs(dot(sub(p, CENTER), normal))).toBeLessThan(1e-9);
    // A box centered in the image spans both sides of the detection, left to right.
    const xs = (loop ?? []).map((p) => p[0]);
    expect(Math.min(...xs)).toBeLessThan(CENTER[0]);
    expect(Math.max(...xs)).toBeGreaterThan(CENTER[0]);
  });

  it('prefers the contour to the box', () => {
    const outline: [number, number][] = [
      [0.45, 0.4],
      [0.55, 0.4],
      [0.6, 0.5],
      [0.5, 0.6],
      [0.4, 0.5],
    ];
    expect(detectionOutline(detection({ outline }), HEAD)).toHaveLength(5);
  });

  it('places nothing for a miss, an unlifted answer, or one without a shape', () => {
    expect(detectionOutline(detection({ found: false }), HEAD)).toBeNull();
    expect(detectionOutline(detection({ position: null }), HEAD)).toBeNull();
    expect(detectionOutline(detection({ box: null, outline: null }), HEAD)).toBeNull();
  });
});
