import { HAND_JOINTS } from '@clio/protocol';
import {
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { occlusionSettings } from './glow/depth-occlusion';

// Invisible stand-ins for the real hands, so virtual light behind a hand stays behind it. Quest's
// depth map does not contain hands (a fingertip reads the surface behind it), so the hands are
// rebuilt from the tracked joints: a sphere per joint and a cylinder per bone (capsules), plus
// cross-bones that fill the palm, each a hair larger than the joint radius the runtime reports
// (a wider margin shows as a gap around the hand). They write depth only (no colour, so passthrough shows the real hand)
// after the opaque scene and before anything transparent, so what is drawn later and lies behind
// a hand fails the depth test. The edge is hard: a feathered one would need a second pass. Only
// the glow is meant to be hidden: panels and object names skip the depth test (on-top.ts), so a
// hand raised near the face never takes the instructions away.

const N = HAND_JOINTS.length;
const CHAINS = [
  [0, 1, 2, 3, 4],
  [0, 5, 6, 7, 8, 9],
  [0, 10, 11, 12, 13, 14],
  [0, 15, 16, 17, 18, 19],
  [0, 20, 21, 22, 23, 24],
];
/** Joints of the palm: the metacarpal bases and the knuckles. */
const PALM = new Set([0, 1, 5, 6, 10, 11, 15, 16, 20, 21]);
/** Across the palm: the metacarpal bases, the knuckles, and the thumb's base to the index. */
const PALM_BONES: [number, number][] = [
  [5, 10],
  [10, 15],
  [15, 20],
  [6, 11],
  [11, 16],
  [16, 21],
  [1, 5],
];
export const OCCLUDER_BONES: readonly (readonly [number, number])[] = [
  ...CHAINS.flatMap((chain) => chain.slice(1).map((j, i): [number, number] => [chain[i] ?? 0, j])),
  ...PALM_BONES,
];
/**
 * Grow each joint's reported radius by this factor and margin (m), kept small: anything more
 * shows as a visible gap around the real hand where the glow is cut away...
 */
const INFLATE = 1;
const MARGIN_M = 0.001;
/** ...and give palm joints at least this radius (m), so the bones between them fill the palm. */
const PALM_MIN_M = 0.012;
/** When the runtime reports no radius (m). */
const DEFAULT_RADIUS_M = 0.008;
/** Drawn after the opaque scene (the hand skeletons stay visible inside), before the glow. */
export const OCCLUDER_RENDER_ORDER = 5;

/** The occluder's radius at joint `i` for the runtime's joint radius (m). */
export function occluderRadius(i: number, radius: number): number {
  const r = radius > 0 ? radius : DEFAULT_RADIUS_M;
  return Math.max(PALM.has(i) ? PALM_MIN_M : 0, r) * INFLATE + MARGIN_M;
}

const UP = new Vector3(0, 1, 0);
const m = new Matrix4();
const a = new Vector3();
const b = new Vector3();
const dir = new Vector3();
const s = new Vector3();
const q = new Quaternion();

class HandOccluder {
  readonly object = new Group();
  private readonly joints: InstancedMesh;
  private readonly bones: InstancedMesh;
  private readonly matrices = new Float32Array(16 * N);
  private readonly radii = new Float32Array(N);
  private spaces: XRJointSpace[] = [];
  private source: XRHand | null = null;

  constructor(material: MeshBasicMaterial) {
    this.joints = new InstancedMesh(new SphereGeometry(1, 10, 8), material, N);
    const rod = new CylinderGeometry(1, 1, 1, 10, 1, true);
    rod.translate(0, 0.5, 0);
    this.bones = new InstancedMesh(rod, material, OCCLUDER_BONES.length);
    for (const mesh of [this.joints, this.bones]) {
      mesh.frustumCulled = false;
      mesh.renderOrder = OCCLUDER_RENDER_ORDER;
    }
    this.object.add(this.joints, this.bones);
    this.object.visible = false;
  }

  update(frame: XRFrame, space: XRReferenceSpace, hand: XRHand | null): boolean {
    const tracked = hand !== null && this.read(frame, space, hand);
    this.object.visible = tracked;
    if (tracked) this.place(this.matrices, this.radii);
    return tracked;
  }

  /** Lays the capsules along joints given as column-major matrices (16 per joint) and radii. */
  place(matrices: ArrayLike<number>, radii: ArrayLike<number>): void {
    for (let i = 0; i < N; i++) {
      const r = occluderRadius(i, radii[i] ?? 0);
      m.makeScale(r, r, r).setPosition(position(matrices, i, a));
      this.joints.setMatrixAt(i, m);
    }
    for (let i = 0; i < OCCLUDER_BONES.length; i++) {
      const [from, to] = OCCLUDER_BONES[i] as [number, number];
      position(matrices, from, a);
      dir.subVectors(position(matrices, to, b), a);
      const length = dir.length();
      // The thinner end's radius, so a cone-shaped finger is never over-covered at its tip.
      const r = Math.min(
        occluderRadius(from, radii[from] ?? 0),
        occluderRadius(to, radii[to] ?? 0),
      );
      q.setFromUnitVectors(UP, length > 1e-6 ? dir.divideScalar(length) : UP);
      m.compose(a, q, s.set(r, length, r));
      this.bones.setMatrixAt(i, m);
    }
    this.joints.instanceMatrix.needsUpdate = true;
    this.bones.instanceMatrix.needsUpdate = true;
    this.object.visible = true;
  }

  dispose(): void {
    this.joints.geometry.dispose();
    this.bones.geometry.dispose();
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
}

function position(matrices: ArrayLike<number>, i: number, out: Vector3): Vector3 {
  const o = i * 16;
  return out.set(matrices[o + 12] ?? 0, matrices[o + 13] ?? 0, matrices[o + 14] ?? 0);
}

/** Both hands' depth-only occluders; add `object` to the scene and update every XR frame. */
export class HandOccluders {
  readonly object = new Group();
  readonly material = new MeshBasicMaterial({ colorWrite: false, depthWrite: true });
  readonly left = new HandOccluder(this.material);
  readonly right = new HandOccluder(this.material);

  constructor() {
    this.object.add(this.left.object, this.right.object);
  }

  update(frame: XRFrame, space: XRReferenceSpace): void {
    // window.__occlusion.setHands(false) turns them off live.
    this.object.visible = occlusionSettings.hands;
    let left: XRHand | null = null;
    let right: XRHand | null = null;
    const sources = frame.session.inputSources;
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      if (!source?.hand) continue;
      if (source.handedness === 'left') left = source.hand;
      else if (source.handedness === 'right') right = source.hand;
    }
    this.left.update(frame, space, left);
    this.right.update(frame, space, right);
  }

  hide(): void {
    this.left.object.visible = false;
    this.right.object.visible = false;
  }

  dispose(): void {
    this.left.dispose();
    this.right.dispose();
    this.material.dispose();
  }
}
