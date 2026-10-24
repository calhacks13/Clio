import { HAND_JOINTS } from '@clio/protocol';
import { Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  HandOccluders,
  OCCLUDER_BONES,
  OCCLUDER_RENDER_ORDER,
  occluderRadius,
} from '../../src/tracking/hand-occluders';

const N = HAND_JOINTS.length;

/** A flat open right hand in the x-y plane: wrist at the origin, fingers up +y (m). */
function openHand(): { matrices: Float32Array; radii: Float32Array; at: (i: number) => Vector3 } {
  const positions: [number, number][] = [[0, 0]];
  // Thumb, then index to pinky: four joints each beyond its metacarpal base.
  const thumb: [number, number][] = [
    [-0.025, 0.02],
    [-0.045, 0.045],
    [-0.06, 0.07],
    [-0.07, 0.09],
  ];
  positions.push(...thumb);
  for (const x of [-0.025, -0.005, 0.015, 0.033]) {
    positions.push([x * 0.4, 0.02], [x, 0.09], [x, 0.13], [x, 0.155], [x, 0.175]);
  }
  const matrices = new Float32Array(16 * N);
  const radii = new Float32Array(N);
  positions.forEach(([x, y], i) => {
    matrices.set(new Matrix4().makeTranslation(x, y, 0).elements, i * 16);
    radii[i] = i === 0 ? 0.02 : 0.008;
  });
  const at = (i: number) => new Vector3(...(positions[i] ?? [0, 0]), 0);
  return { matrices, radii, at };
}

/** Whether point p lies in the occluders as placed for this hand (spheres and capsules). */
function covered(p: Vector3, hand: ReturnType<typeof openHand>): boolean {
  for (let i = 0; i < N; i++) {
    if (p.distanceTo(hand.at(i)) <= occluderRadius(i, hand.radii[i] ?? 0)) return true;
  }
  for (const [a, b] of OCCLUDER_BONES) {
    const pa = hand.at(a);
    const ab = hand.at(b).sub(pa);
    const t = Math.min(1, Math.max(0, p.clone().sub(pa).dot(ab) / ab.lengthSq()));
    const r = Math.min(
      occluderRadius(a, hand.radii[a] ?? 0),
      occluderRadius(b, hand.radii[b] ?? 0),
    );
    if (p.distanceTo(pa.add(ab.multiplyScalar(t))) <= r) return true;
  }
  return false;
}

describe('HandOccluders', () => {
  it('covers fingers and palm a little beyond the reported joint radii', () => {
    const hand = openHand();
    // A point on the index finger between joints, just beyond its 8 mm radius.
    expect(covered(new Vector3(-0.025, 0.11, 0.009), hand)).toBe(true);
    // The middle of the palm, between the metacarpals.
    expect(covered(new Vector3(0.005, 0.055, 0), hand)).toBe(true);
    // Beyond the fingertips, and well off the hand: open space.
    expect(covered(new Vector3(-0.015, 0.2, 0), hand)).toBe(false);
    expect(covered(new Vector3(0.1, 0.05, 0), hand)).toBe(false);
    expect(covered(new Vector3(0, 0.05, 0.04), hand)).toBe(false);
    for (let i = 0; i < N; i++) {
      expect(occluderRadius(i, 0.008)).toBeGreaterThan(0.008);
      expect(occluderRadius(i, 0.008)).toBeLessThan(0.02);
    }
  });

  it('writes depth only, after the opaque scene and before the glow', () => {
    const occluders = new HandOccluders();
    expect(occluders.material.colorWrite).toBe(false);
    expect(occluders.material.depthWrite).toBe(true);
    expect(occluders.material.transparent).toBe(false);
    const hand = openHand();
    occluders.right.place(hand.matrices, hand.radii);
    const [joints, bones] = occluders.right.object.children as [
      import('three').InstancedMesh,
      import('three').InstancedMesh,
    ];
    expect(joints.renderOrder).toBe(OCCLUDER_RENDER_ORDER);
    expect(OCCLUDER_RENDER_ORDER).toBeLessThan(9);
    expect(joints.count).toBe(N);
    expect(bones.count).toBe(OCCLUDER_BONES.length);
    // The index fingertip's sphere sits on the joint at the occluder radius.
    const m = new Matrix4();
    joints.getMatrixAt(9, m);
    const p = new Vector3().setFromMatrixPosition(m);
    expect(p.distanceTo(hand.at(9))).toBeLessThan(1e-6);
    expect(new Vector3().setFromMatrixScale(m).x).toBeCloseTo(occluderRadius(9, 0.008));
    expect(occluders.right.object.visible).toBe(true);
    occluders.hide();
    expect(occluders.right.object.visible).toBe(false);
    occluders.dispose();
  });
});
