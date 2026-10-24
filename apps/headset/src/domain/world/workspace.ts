import { type CalibrationMethod, HAND_JOINTS, type HandSample, JOINT_STRIDE } from '@clio/protocol';
import {
  composePose,
  cross,
  invertPose,
  length,
  madd,
  normalize,
  type Pose,
  quatFromBasis,
  rotateVec,
  transformPoint,
  type Vec3,
  yawOnly,
} from '../../core/math';
import type { TrackedFrame } from '../hands/types';

// The workspace frame W (docs/data-format.md): origin at the first calibration corner on the table
// surface, +x along the table edge toward the second corner, +y up, +z toward the user. Every
// spatial value in an episode is expressed in W.

const MIN_EDGE = 0.1;

/** W from two pinched corners: the near-left corner, then the near-right corner. */
export function workspaceFromCorners(first: Readonly<Vec3>, second: Readonly<Vec3>): Pose {
  const edge: Vec3 = [second[0] - first[0], 0, second[2] - first[2]];
  if (length(edge) < MIN_EDGE) {
    throw new Error(
      `Calibration corners are too close together (need at least ${MIN_EDGE * 100} cm)`,
    );
  }
  const x = normalize(edge);
  const y: Vec3 = [0, 1, 0];
  const z = cross(x, y);
  return { p: [first[0], (first[1] + second[1]) / 2, first[2]], q: quatFromBasis(x, y, z) };
}

export interface InFrontOptions {
  /** Horizontal distance ahead of the head (m). */
  forward: number;
  /** Drop below the head (m). */
  below: number;
  /** Workspace width; the origin is its left edge, so the user is centered on it. */
  width: number;
}

/** A level W in front of the user, for tasks without a calibrated table. Ignores head pitch. */
export function workspaceInFrontOf(
  head: Pose,
  { forward, below, width }: InFrontOptions = { forward: 0.45, below: 0.45, width: 0.6 },
): Pose {
  const yaw = yawOnly(head.q);
  const ahead = rotateVec(yaw, [0, 0, -1]);
  const right = rotateVec(yaw, [1, 0, 0]);
  const center = madd(madd(head.p, ahead, forward), [0, 1, 0], -below);
  return { p: madd(center, right, -width / 2), q: yaw };
}

export class Workspace {
  private worldFrom: Pose;
  private fromWorld: Pose;

  constructor(
    worldFromWorkspace: Pose,
    readonly method: CalibrationMethod = 'none',
    private anchoredFlag = false,
  ) {
    this.worldFrom = worldFromWorkspace;
    this.fromWorld = invertPose(worldFromWorkspace);
  }

  get worldFromWorkspace(): Pose {
    return this.worldFrom;
  }

  get anchored(): boolean {
    return this.anchoredFlag;
  }

  /** Height of the workspace surface in world space (W is level, so this is a plane y = h). */
  get surfaceY(): number {
    return this.worldFrom.p[1];
  }

  /** Refine the pose (e.g. when a tracked anchor updates). */
  update(worldFromWorkspace: Pose, anchored = this.anchoredFlag): void {
    this.worldFrom = worldFromWorkspace;
    this.fromWorld = invertPose(worldFromWorkspace);
    this.anchoredFlag = anchored;
  }

  toWorkspacePoint(p: Readonly<Vec3>): Vec3 {
    return transformPoint(this.fromWorld, p);
  }

  toWorldPoint(p: Readonly<Vec3>): Vec3 {
    return transformPoint(this.worldFrom, p);
  }

  toWorkspacePose(pose: Pose): Pose {
    return composePose(this.fromWorld, pose);
  }

  toWorldPose(pose: Pose): Pose {
    return composePose(this.worldFrom, pose);
  }

  toWorkspaceHand(hand: HandSample): HandSample {
    const out = new Array<number>(hand.joints.length);
    const j = hand.joints;
    for (let i = 0; i < HAND_JOINTS.length; i++) {
      const o = i * JOINT_STRIDE;
      const local = this.toWorkspacePose({
        p: [j[o] ?? 0, j[o + 1] ?? 0, j[o + 2] ?? 0],
        q: [j[o + 3] ?? 0, j[o + 4] ?? 0, j[o + 5] ?? 0, j[o + 6] ?? 1],
      });
      out[o] = local.p[0];
      out[o + 1] = local.p[1];
      out[o + 2] = local.p[2];
      out[o + 3] = local.q[0];
      out[o + 4] = local.q[1];
      out[o + 5] = local.q[2];
      out[o + 6] = local.q[3];
      out[o + 7] = j[o + 7] ?? 0;
    }
    return { joints: out, pinch: hand.pinch };
  }

  toWorkspaceFrame(worldFrame: TrackedFrame): TrackedFrame {
    return {
      t: worldFrame.t,
      head: this.toWorkspacePose(worldFrame.head),
      left: worldFrame.left && this.toWorkspaceHand(worldFrame.left),
      right: worldFrame.right && this.toWorkspaceHand(worldFrame.right),
    };
  }
}
