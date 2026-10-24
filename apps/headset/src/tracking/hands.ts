import { HAND_JOINTS, type Handedness } from '@clio/protocol';
import {
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from 'three';
import { HAND_COLORS } from './palette';
import { PinchLatch } from './pinch-latch';

// Both hands as skeletons: a sphere per joint (sized by the joint radius the runtime reports) and
// a thin rod per bone, plus a ring at the pinch point that lights up while the hand pinches. Joint
// poses are read straight from the XRFrame into fixed buffers, so nothing is allocated per frame.

const N = HAND_JOINTS.length;
const THUMB_TIP = HAND_JOINTS.indexOf('thumb-tip');
const INDEX_TIP = HAND_JOINTS.indexOf('index-finger-tip');
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
const JOINT_SCALE = 0.5;
const BONE_RADIUS = 0.0015;
const RING_LIT_SCALE = 1.3;

const UP = new Vector3(0, 1, 0);
const m = new Matrix4();
const a = new Vector3();
const b = new Vector3();
const dir = new Vector3();
const s = new Vector3();
const q = new Quaternion();

class HandSkeleton {
  readonly object = new Group();
  private readonly joints: InstancedMesh;
  private readonly bones: InstancedMesh;
  private readonly ring: Mesh;
  private readonly ringIdle: MeshBasicMaterial;
  private readonly ringLit = new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide });
  private readonly latch = new PinchLatch();
  private readonly matrices = new Float32Array(16 * N);
  private readonly radii = new Float32Array(N);
  private spaces: XRJointSpace[] = [];
  private source: XRHand | null = null;

  constructor(color: number) {
    const material = new MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.5,
      roughness: 0.5,
    });
    this.joints = new InstancedMesh(new SphereGeometry(1, 12, 8), material, N);
    const rod = new CylinderGeometry(1, 1, 1, 6, 1, true);
    rod.translate(0, 0.5, 0);
    this.bones = new InstancedMesh(rod, material, BONES.length);
    this.joints.frustumCulled = false;
    this.bones.frustumCulled = false;
    this.ringIdle = new MeshBasicMaterial({
      color: new Color(color).multiplyScalar(0.4),
      side: DoubleSide,
    });
    this.ring = new Mesh(new RingGeometry(0.012, 0.016, 40), this.ringIdle);
    this.object.add(this.joints, this.bones, this.ring);
    this.object.visible = false;
  }

  /** Draws the hand from this frame; returns whether it is tracked. */
  update(
    frame: XRFrame,
    space: XRReferenceSpace,
    hand: XRHand | null,
    t: number,
    head: Quaternion,
  ): boolean {
    const tracked = hand !== null && this.read(frame, space, hand);
    const pinching = this.latch.update(tracked ? this.gap() : null, t);
    this.object.visible = tracked;
    if (!tracked) return false;

    for (let i = 0; i < N; i++) {
      const r = Math.max(0.003, (this.radii[i] ?? 0.008) * JOINT_SCALE);
      m.makeScale(r, r, r).setPosition(this.position(i, a));
      this.joints.setMatrixAt(i, m);
    }
    for (let i = 0; i < BONES.length; i++) {
      const [from, to] = BONES[i] as [number, number];
      this.position(from, a);
      dir.subVectors(this.position(to, b), a);
      const len = dir.length();
      q.setFromUnitVectors(UP, len > 1e-6 ? dir.divideScalar(len) : UP);
      m.compose(a, q, s.set(BONE_RADIUS, len, BONE_RADIUS));
      this.bones.setMatrixAt(i, m);
    }
    this.joints.instanceMatrix.needsUpdate = true;
    this.bones.instanceMatrix.needsUpdate = true;

    this.position(THUMB_TIP, a);
    this.ring.position.addVectors(a, this.position(INDEX_TIP, b)).multiplyScalar(0.5);
    this.ring.quaternion.copy(head);
    this.ring.scale.setScalar(pinching ? RING_LIT_SCALE : 1);
    this.ring.material = pinching ? this.ringLit : this.ringIdle;
    return true;
  }

  /** Fills the joint matrices and radii; false when any joint has no pose this frame. */
  private read(frame: XRFrame, space: XRReferenceSpace, hand: XRHand): boolean {
    if (hand !== this.source) {
      this.source = hand;
      this.spaces = [];
      for (const name of HAND_JOINTS) {
        const joint = hand.get(name);
        if (joint) this.spaces.push(joint);
      }
    }
    if (this.spaces.length !== N) return false;
    if (frame.fillPoses && frame.fillJointRadii) {
      return (
        frame.fillPoses(this.spaces, space, this.matrices) &&
        frame.fillJointRadii(this.spaces, this.radii)
      );
    }
    for (let i = 0; i < N; i++) {
      const joint = this.spaces[i];
      const pose = joint && frame.getJointPose?.(joint, space);
      if (!pose) return false;
      this.matrices.set(pose.transform.matrix, i * 16);
      this.radii[i] = pose.radius ?? 0;
    }
    return true;
  }

  private position(i: number, out: Vector3): Vector3 {
    const o = i * 16;
    return out.set(
      this.matrices[o + 12] ?? 0,
      this.matrices[o + 13] ?? 0,
      this.matrices[o + 14] ?? 0,
    );
  }

  private gap(): number {
    return this.position(THUMB_TIP, a).distanceTo(this.position(INDEX_TIP, b));
  }
}

export class HandsView {
  readonly object = new Group();
  readonly tracked: Record<Handedness, boolean> = { left: false, right: false };
  private readonly left = new HandSkeleton(HAND_COLORS.left);
  private readonly right = new HandSkeleton(HAND_COLORS.right);

  constructor() {
    this.object.add(this.left.object, this.right.object);
  }

  update(frame: XRFrame, space: XRReferenceSpace, t: number, head: Quaternion): void {
    let left: XRHand | null = null;
    let right: XRHand | null = null;
    const sources = frame.session.inputSources;
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      if (!source?.hand) continue;
      if (source.handedness === 'left') left = source.hand;
      else if (source.handedness === 'right') right = source.hand;
    }
    this.tracked.left = this.left.update(frame, space, left, t, head);
    this.tracked.right = this.right.update(frame, space, right, t, head);
  }

  hide(): void {
    this.tracked.left = false;
    this.tracked.right = false;
    this.left.object.visible = false;
    this.right.object.visible = false;
  }
}
