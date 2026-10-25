"""What a human body can do, written in the G1's joint coordinates (body.py).

The G1's arm is built like a human one, so each of its joints stands for one anatomical motion.
With every joint at zero the upper arm hangs, the elbow is bent 90 degrees with the forearm
forward, the palm faces the body's middle with the index finger up (a handshake), and the wrist
is straight. For the left arm (the right one mirrors the signs marked in MIRRORED):

    shoulder pitch   - flexion (arm forward and up), + extension (arm back)
    shoulder roll    + abduction (arm out to the side), - adduction (across the body)
    shoulder yaw     + external rotation (forearm swings out), - internal rotation
    elbow            0 is 90 degrees of flexion; + extends (pi/2 is straight), - flexes further
    wrist roll       + pronation (palm turns down), - supination (palm up)
    wrist pitch      + ulnar deviation (little finger side down), - radial deviation
    wrist yaw        + extension (back of the hand up), - flexion (toward the palm)

The ranges are the active ranges of motion of an adult (AAOS and Norkin & White, rounded in),
clipped to the G1's own limits; they replace the G1's, which allow a backward-bent elbow, a wrist
that folds 90 degrees sideways and a shoulder that turns most of a circle. Abduction is limited to
the G1's 129 degrees; the shoulder pitch makes up the rest of an overhead reach. Crossing the body
depends on how far the arm is raised: hanging, it meets the hip after a few degrees; raised
forward it can swing about 45 degrees past the middle (`roll_floor`).

The comfort cost scores how far a posture is from the relaxed working posture, joint by joint in
units of that joint's comfortable spread, so the wrist (small spreads) is kept near neutral before
the shoulder is. It chooses among the postures that put the hand where it was measured.

The hand frame comes from the WebXR joints: the wrist and the index, middle and little finger
knuckles (the proximal phalanx joints) are rigid, so their frame is the palm's whatever the
fingers do. It is given in the G1 palm link's convention: x along the fingers, z toward the index
finger (radial), y = z x x.

The neck model places the neck's pivot from the head pose: the eyes sit 8 cm in front of it and
7.5 cm above it (the usual VR neck model), so a learner looking down has their head pivot where
it was and their eyes lower and further forward.
"""

from __future__ import annotations

import numpy as np

from ..frames import JOINT_INDEX, WRIST, quat_rotate

ARM_JOINTS = (
    "shoulder_pitch",
    "shoulder_roll",
    "shoulder_yaw",
    "elbow",
    "wrist_roll",
    "wrist_pitch",
    "wrist_yaw",
)
# The joints whose sign flips between the left and the right arm.
MIRRORED = np.array([False, True, True, False, True, False, True])

_DEG = np.pi / 180
# Left arm (lower, upper), rad.
ARM_RANGE_LEFT = np.array(
    [
        [-170 * _DEG, 50 * _DEG],  # flexion 170, extension 50
        [-48 * _DEG, 129 * _DEG],  # adduction across the body (see roll_floor), abduction
        [-70 * _DEG, 80 * _DEG],  # internal rotation 70, external 80
        [np.pi / 2 - 145 * _DEG, np.pi / 2 + 3 * _DEG],  # flexion 145, straight (3 degrees)
        [-85 * _DEG, 80 * _DEG],  # supination 85, pronation 80
        [-20 * _DEG, 35 * _DEG],  # radial 20, ulnar 35
        [-80 * _DEG, 70 * _DEG],  # flexion 80, extension 70
    ]
)
# The relaxed working posture: arm a little forward and out, forearm thumb-up and slightly
# turned down, wrist slightly extended and toward the little finger.
ARM_NEUTRAL_LEFT = np.array([-20 * _DEG, 10 * _DEG, 0.0, 0.0, 15 * _DEG, 8 * _DEG, 10 * _DEG])
# How far from neutral each joint goes before it costs one unit (squared).
ARM_SPREAD = np.array([70 * _DEG, 45 * _DEG, 50 * _DEG, 80 * _DEG, 45 * _DEG, 14 * _DEG, 35 * _DEG])
# Hanging at rest: a little in front, clear of the thigh, elbow slightly bent, palm to the leg.
ARM_REST_LEFT = np.array(
    [-6 * _DEG, 8 * _DEG, 0.0, np.pi / 2 - 15 * _DEG, 0.0, 5 * _DEG, -8 * _DEG]
)
# Crossing the body: this much adduction with the arm hanging, this much more raised forward.
ADDUCTION_HANGING = 12 * _DEG
ADDUCTION_RAISED = 48 * _DEG

# Legs, left (the right mirrors hip roll and yaw): hip pitch, roll, yaw, knee, ankle pitch, roll.
LEG_RANGE_LEFT = np.array(
    [
        [-120 * _DEG, 25 * _DEG],  # hip flexion 120, extension 25
        [-20 * _DEG, 40 * _DEG],  # hip adduction 20, abduction 40
        [-35 * _DEG, 40 * _DEG],  # internal 35, external 40 (the leg's own yaw)
        [0.0, 140 * _DEG],  # knee: straight to 140 of flexion
        [-50 * _DEG, 25 * _DEG],  # plantar flexion 50, dorsiflexion 25 (within the G1's)
        [-15 * _DEG, 15 * _DEG],
    ]
)
LEG_MIRRORED = np.array([False, True, True, False, False, True])
# Trunk: waist yaw (turn), roll (side bend), pitch (+ bends forward).
WAIST_RANGE = np.array([[-45 * _DEG, 45 * _DEG], [-25 * _DEG, 25 * _DEG], [-20 * _DEG, 30 * _DEG]])

# Neck model, head frame (WebXR: x right, y up, -z forward): the eyes from the neck's pivot.
EYES_FROM_NECK = np.array([0.0, 0.075, -0.0805])

MIDDLE_KNUCKLE = JOINT_INDEX["middle-finger-phalanx-proximal"]
INDEX_KNUCKLE = JOINT_INDEX["index-finger-phalanx-proximal"]
PINKY_KNUCKLE = JOINT_INDEX["pinky-finger-phalanx-proximal"]


def sided(left: np.ndarray, side: int, mirrored: np.ndarray = MIRRORED) -> np.ndarray:
    """Left-arm values for `side` (0 left, 1 right): the mirrored joints change sign."""
    values = np.array(left, dtype=np.float64)
    if side == 0:
        return values
    sign = np.where(mirrored, -1.0, 1.0)
    if values.ndim == 2:  # ranges: a mirrored (lower, upper) becomes (-upper, -lower)
        out = values * sign[:, None]
        out[mirrored] = out[mirrored][:, ::-1]
        return out
    return values * sign


def arm_range(side: int, robot_lower: np.ndarray, robot_upper: np.ndarray) -> np.ndarray:
    """(7, 2) the human range of `side`'s arm joints within the robot's limits."""
    human = sided(ARM_RANGE_LEFT, side)
    return np.stack([np.maximum(human[:, 0], robot_lower), np.minimum(human[:, 1], robot_upper)], 1)


def roll_floor(pitch: np.ndarray, side: int) -> np.ndarray:
    """The most adduction (left: the lowest roll; right: the highest) the arm has at `pitch`: a
    few degrees hanging, ADDUCTION_RAISED once it is raised forward 90 degrees."""
    raised = np.clip(-np.asarray(pitch) / (np.pi / 2), 0.0, 1.0)
    floor = -(ADDUCTION_HANGING + (ADDUCTION_RAISED - ADDUCTION_HANGING) * raised)
    return floor if side == 0 else -floor


def comfort_cost(q: np.ndarray, side: int) -> np.ndarray:
    """(...,) how far each arm posture (..., 7) is from the relaxed one, in squared spreads."""
    z = (np.asarray(q) - sided(ARM_NEUTRAL_LEFT, side)) / ARM_SPREAD
    return np.sum(z * z, axis=-1)


def range_excess(q: np.ndarray, side: int, limits: np.ndarray) -> np.ndarray:
    """(..., 7) how far (rad) each joint is outside `limits`, the cross-body floor included."""
    q = np.asarray(q)
    excess = np.maximum(limits[:, 0] - q, 0.0) + np.maximum(q - limits[:, 1], 0.0)
    floor = roll_floor(q[..., 0], side)
    roll = q[..., 1]
    over = np.maximum(floor - roll, 0.0) if side == 0 else np.maximum(roll - floor, 0.0)
    excess[..., 1] = np.maximum(excess[..., 1], over)
    return excess


def palm_frame(joints: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """From WebXR hand joints (..., 25, >=3): the palm point (..., 3), halfway from the wrist to
    the middle knuckle, and the palm frame (..., 3, 3) in the G1 palm link's convention (columns:
    x along the fingers, y = z x x, z toward the index finger). NaN where the hand is missing."""
    p = np.asarray(joints, dtype=np.float64)[..., :3]
    wrist, middle = p[..., WRIST, :], p[..., MIDDLE_KNUCKLE, :]
    radial = p[..., INDEX_KNUCKLE, :] - p[..., PINKY_KNUCKLE, :]
    x = _unit(middle - wrist)
    z = _unit(radial - np.sum(radial * x, axis=-1, keepdims=True) * x)
    y = np.cross(z, x)
    return 0.5 * (wrist + middle), np.stack([x, y, z], axis=-1)


def neck_pivot(eyes: np.ndarray, head_q: np.ndarray, size: float = 1.0) -> np.ndarray:
    """(M, 3) the neck's pivot under the eyes (M, 3) of heads (M, 4), for a person `size` times
    the neck model's (1 is an adult)."""
    return eyes - size * quat_rotate(head_q, np.broadcast_to(EYES_FROM_NECK, eyes.shape))


def _unit(v: np.ndarray) -> np.ndarray:
    with np.errstate(invalid="ignore", divide="ignore"):
        return v / np.linalg.norm(v, axis=-1, keepdims=True)
