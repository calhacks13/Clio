import { type HandJoint, type HandPoint, type HandSample, jointOffset } from '@clio/protocol';
import { distance, midpoint, type Pose, type Vec3 } from '../../core/math';

// Derived hand features, computed from the flat 25-joint sample. Positions are in whatever frame
// the sample is in.

export function jointPosition(hand: HandSample, joint: HandJoint): Vec3 {
  const o = jointOffset(joint);
  const j = hand.joints;
  return [j[o] ?? 0, j[o + 1] ?? 0, j[o + 2] ?? 0];
}

export function jointPose(hand: HandSample, joint: HandJoint): Pose {
  const o = jointOffset(joint);
  const j = hand.joints;
  return {
    p: [j[o] ?? 0, j[o + 1] ?? 0, j[o + 2] ?? 0],
    q: [j[o + 3] ?? 0, j[o + 4] ?? 0, j[o + 5] ?? 0, j[o + 6] ?? 1],
  };
}

export const wristPose = (hand: HandSample): Pose => jointPose(hand, 'wrist');

/** Thumb-tip to index-tip distance (m): the pinch aperture and gripper proxy. */
export function pinchDistance(hand: HandSample): number {
  return distance(jointPosition(hand, 'thumb-tip'), jointPosition(hand, 'index-finger-tip'));
}

export function pinchPoint(hand: HandSample): Vec3 {
  return midpoint(jointPosition(hand, 'thumb-tip'), jointPosition(hand, 'index-finger-tip'));
}

export function palmPoint(hand: HandSample): Vec3 {
  return midpoint(
    jointPosition(hand, 'wrist'),
    jointPosition(hand, 'middle-finger-phalanx-proximal'),
  );
}

export function handPoint(hand: HandSample, point: HandPoint): Vec3 {
  switch (point) {
    case 'pinch':
      return pinchPoint(hand);
    case 'index_tip':
      return jointPosition(hand, 'index-finger-tip');
    case 'thumb_tip':
      return jointPosition(hand, 'thumb-tip');
    case 'palm':
      return palmPoint(hand);
    case 'wrist':
      return jointPosition(hand, 'wrist');
  }
}

/** Mean fingertip-to-palm distance (m). Small values mean a closed fist or power grasp. */
export function gripClosure(hand: HandSample): number {
  const palm = palmPoint(hand);
  const tips: HandJoint[] = ['index-finger-tip', 'middle-finger-tip', 'ring-finger-tip'];
  return tips.reduce((sum, tip) => sum + distance(jointPosition(hand, tip), palm), 0) / tips.length;
}
