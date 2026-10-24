import { HAND_JOINTS, type HandSample, JOINT_STRIDE } from '@clio/protocol';
import {
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';

// A hand drawn as joint spheres and bone capsules (instanced: two draw calls per hand). Driven by
// positions and radii only, so it renders recorded and synthesized clips identically.

const CHAINS = [
  [0, 1, 2, 3, 4],
  [0, 5, 6, 7, 8, 9],
  [0, 10, 11, 12, 13, 14],
  [0, 15, 16, 17, 18, 19],
  [0, 20, 21, 22, 23, 24],
];
const BONES: [number, number][] = CHAINS.flatMap((chain) =>
  chain.slice(1).map((j, i): [number, number] => [chain[i] ?? 0, j]),
);

const UP = new Vector3(0, 1, 0);
const m = new Matrix4();
const a = new Vector3();
const b = new Vector3();
const dir = new Vector3();
const q = new Quaternion();
const s = new Vector3();

export class HandMesh {
  readonly object = new Group();
  private readonly joints: InstancedMesh;
  private readonly bones: InstancedMesh;

  constructor(color: number, opacity: number) {
    const material = new MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.6,
      transparent: true,
      opacity,
      depthWrite: false,
      roughness: 0.4,
    });
    this.joints = new InstancedMesh(new SphereGeometry(1, 10, 8), material, HAND_JOINTS.length);
    const cylinder = new CylinderGeometry(1, 1, 1, 8, 1, true);
    cylinder.translate(0, 0.5, 0);
    this.bones = new InstancedMesh(cylinder, material, BONES.length);
    this.joints.frustumCulled = false;
    this.bones.frustumCulled = false;
    this.object.add(this.joints, this.bones);
    this.object.visible = false;
  }

  update(hand: HandSample | null): void {
    if (!hand) {
      this.object.visible = false;
      return;
    }
    this.object.visible = true;
    const j = hand.joints;
    const pos = (i: number, out: Vector3) =>
      out.set(j[i * JOINT_STRIDE] ?? 0, j[i * JOINT_STRIDE + 1] ?? 0, j[i * JOINT_STRIDE + 2] ?? 0);
    const radius = (i: number) => Math.max(0.004, j[i * JOINT_STRIDE + 7] ?? 0.008);

    for (let i = 0; i < HAND_JOINTS.length; i++) {
      const r = radius(i);
      m.compose(pos(i, a), q.identity(), s.set(r, r, r));
      this.joints.setMatrixAt(i, m);
    }
    BONES.forEach(([from, to], i) => {
      pos(from, a);
      pos(to, b);
      dir.subVectors(b, a);
      const len = dir.length();
      const r = Math.min(radius(from), radius(to)) * 0.7;
      q.setFromUnitVectors(UP, len > 1e-6 ? dir.divideScalar(len) : UP);
      m.compose(a, q, s.set(r, len, r));
      this.bones.setMatrixAt(i, m);
    });
    this.joints.instanceMatrix.needsUpdate = true;
    this.bones.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.joints.geometry.dispose();
    this.bones.geometry.dispose();
    (this.joints.material as MeshStandardMaterial).dispose();
  }
}
