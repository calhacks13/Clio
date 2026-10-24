import type { Vec3 } from '@clio/protocol';
import { type BufferGeometry, LineLoop } from 'three';
import { describe, expect, it } from 'vitest';
import type { Detection } from '../../src/viewer/episode-data';
import { DetectionMarker } from '../../src/viewer/scene';

function detection(position: Vec3): Detection {
  return {
    t: 1000,
    type: 'object.detected',
    objectId: 'beaker',
    stepId: null,
    phrase: null,
    description: 'beaker',
    found: true,
    point: [0.5, 0.5],
    box: [0.4, 0.4, 0.6, 0.6],
    outline: null,
    confidence: 0.9,
    position,
    source: 'gemini',
    latencyMs: 80,
  };
}

/** A closed loop of `n` points on a 5 cm circle around `center`. */
function loop(n: number, center: Vec3): Vec3[] {
  return Array.from({ length: n }, (_, i): Vec3 => {
    const a = (i / n) * Math.PI * 2;
    return [center[0] + 0.05 * Math.cos(a), center[1] + 0.05 * Math.sin(a), center[2]];
  });
}

function outlineGeometry(marker: DetectionMarker): BufferGeometry {
  const line = marker.object.children.find((c) => c instanceof LineLoop);
  if (!line) throw new Error('no outline');
  return (line as LineLoop).geometry;
}

describe('DetectionMarker', () => {
  it('sizes the outline to each detection, whatever the one before it had', () => {
    const marker = new DetectionMarker();
    const near: Vec3 = [0.1, 0.05, -0.1];
    const far: Vec3 = [0.9, 0.05, -0.6];

    marker.update(detection(near), loop(4, near));
    const first = outlineGeometry(marker);
    expect(first.getAttribute('position').count).toBe(4);
    first.computeBoundingSphere(); // as the first render's frustum test would

    marker.update(detection(far), loop(18, far));
    const grown = outlineGeometry(marker);
    expect(grown.getAttribute('position').count).toBe(18);
    if (!grown.boundingSphere) grown.computeBoundingSphere();
    expect(grown.boundingSphere?.center.x).toBeCloseTo(far[0]);

    marker.update(detection(near), loop(4, near));
    expect(outlineGeometry(marker).getAttribute('position').count).toBe(4);
  });

  it('keeps the geometry while the outline stays the same', () => {
    const marker = new DetectionMarker();
    const at: Vec3 = [0.3, 0.05, -0.2];
    const outline = loop(6, at);
    marker.update(detection(at), outline);
    const first = outlineGeometry(marker);
    marker.update(detection(at), outline);
    expect(outlineGeometry(marker)).toBe(first);
  });
});
