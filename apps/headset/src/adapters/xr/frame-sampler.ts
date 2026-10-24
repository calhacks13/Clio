import { HAND_JOINTS, type HandSample, JOINT_STRIDE } from '@clio/protocol';
import { distance, type Pose, quatFromBasis, type Vec3 } from '../../core/math';
import type { TrackedFrame } from '../../domain/hands/types';

// Reads one XRFrame into a TrackedFrame (world space): the viewer pose and both hands' 25 joints.
// Uses the batch APIs (fillPoses / fillJointRadii) when present, per-joint getJointPose otherwise.

const N = HAND_JOINTS.length;

/** Pose from a column-major 4x4 rigid transform at `offset` in `m`. */
export function poseFromMatrix(m: Float32Array | Float64Array, offset = 0): Pose {
  const c = (i: number) => m[offset + i] ?? 0;
  return {
    p: [c(12), c(13), c(14)],
    q: quatFromBasis([c(0), c(1), c(2)], [c(4), c(5), c(6)], [c(8), c(9), c(10)]),
  };
}

export class FrameSampler {
  private readonly matrices = new Float32Array(16 * N);
  private readonly radii = new Float32Array(N);

  sample(frame: XRFrame, space: XRReferenceSpace, t: number): TrackedFrame | null {
    const viewer = frame.getViewerPose(space);
    if (!viewer) return null;
    const head = poseFromMatrix(viewer.transform.matrix);
    let left: HandSample | null = null;
    let right: HandSample | null = null;
    for (const source of frame.session.inputSources) {
      if (!source.hand) continue;
      const hand = this.sampleHand(frame, source.hand, space);
      if (source.handedness === 'left') left = hand;
      else if (source.handedness === 'right') right = hand;
    }
    return { t, head, left, right };
  }

  private sampleHand(frame: XRFrame, hand: XRHand, space: XRReferenceSpace): HandSample | null {
    const spaces: XRJointSpace[] = [];
    for (const name of HAND_JOINTS) {
      const joint = hand.get(name);
      if (!joint) return null;
      spaces.push(joint);
    }
    const joints = new Array<number>(N * JOINT_STRIDE);
    const write = (i: number, pose: Pose, radius: number) => {
      const o = i * JOINT_STRIDE;
      joints[o] = pose.p[0];
      joints[o + 1] = pose.p[1];
      joints[o + 2] = pose.p[2];
      joints[o + 3] = pose.q[0];
      joints[o + 4] = pose.q[1];
      joints[o + 5] = pose.q[2];
      joints[o + 6] = pose.q[3];
      joints[o + 7] = radius;
    };

    if (frame.fillPoses && frame.fillJointRadii) {
      if (
        !frame.fillPoses(spaces, space, this.matrices) ||
        !frame.fillJointRadii(spaces, this.radii)
      ) {
        return null;
      }
      for (let i = 0; i < N; i++)
        write(i, poseFromMatrix(this.matrices, i * 16), this.radii[i] ?? 0);
    } else {
      for (let i = 0; i < N; i++) {
        const joint = spaces[i];
        const pose = joint && frame.getJointPose?.(joint, space);
        if (!pose) return null;
        write(i, poseFromMatrix(pose.transform.matrix), pose.radius ?? 0);
      }
    }
    const at = (i: number): Vec3 => [
      joints[i * 8] ?? 0,
      joints[i * 8 + 1] ?? 0,
      joints[i * 8 + 2] ?? 0,
    ];
    return { joints, pinch: distance(at(4), at(9)) };
  }
}
