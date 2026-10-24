"""Hand joint layout (mirrors packages/protocol/src/hand.ts) and coordinate-frame conversions.

Episodes are recorded in the workspace frame W (WebXR convention: right-handed, +y up, +z toward
the user, table at z < 0). Robotics tools expect z-up, so exports convert to a robot base frame at
the workspace origin, facing the table (docs/data-format.md):

    x_robot = -z_W   (forward, away from the user)
    y_robot = -x_W   (left)
    z_robot = +y_W   (up)

Quaternions are [x, y, z, w] everywhere.
"""

from __future__ import annotations

import numpy as np
from numpy.typing import ArrayLike

# WebXR hand joints, in the order the WebXR Hand Input spec iterates them. Never reorder.
HAND_JOINTS: tuple[str, ...] = (
    "wrist",
    "thumb-metacarpal",
    "thumb-phalanx-proximal",
    "thumb-phalanx-distal",
    "thumb-tip",
    "index-finger-metacarpal",
    "index-finger-phalanx-proximal",
    "index-finger-phalanx-intermediate",
    "index-finger-phalanx-distal",
    "index-finger-tip",
    "middle-finger-metacarpal",
    "middle-finger-phalanx-proximal",
    "middle-finger-phalanx-intermediate",
    "middle-finger-phalanx-distal",
    "middle-finger-tip",
    "ring-finger-metacarpal",
    "ring-finger-phalanx-proximal",
    "ring-finger-phalanx-intermediate",
    "ring-finger-phalanx-distal",
    "ring-finger-tip",
    "pinky-finger-metacarpal",
    "pinky-finger-phalanx-proximal",
    "pinky-finger-phalanx-intermediate",
    "pinky-finger-phalanx-distal",
    "pinky-finger-tip",
)
# Values stored per joint, in order.
JOINT_FIELDS: tuple[str, ...] = ("px", "py", "pz", "qx", "qy", "qz", "qw", "radius")
JOINT_STRIDE = len(JOINT_FIELDS)
NUM_JOINTS = len(HAND_JOINTS)
HANDS: tuple[str, str] = ("left", "right")  # index 0 = left, 1 = right
JOINT_INDEX: dict[str, int] = {name: i for i, name in enumerate(HAND_JOINTS)}

WRIST = JOINT_INDEX["wrist"]
THUMB_TIP = JOINT_INDEX["thumb-tip"]
INDEX_TIP = JOINT_INDEX["index-finger-tip"]
PINKY_TIP = JOINT_INDEX["pinky-finger-tip"]

# The skeleton as one chain per finger, wrist -> metacarpal -> ... -> tip (WebXR joint order).
FINGER_CHAINS: tuple[tuple[int, ...], ...] = tuple(
    (WRIST, *(JOINT_INDEX[name] for name in HAND_JOINTS if name.startswith(finger)))
    for finger in ("thumb-", "index-", "middle-", "ring-", "pinky-")
)

# Workspace -> robot frame: p_robot = R @ p_W, and q_robot = Q (x) q_W.
R_ROBOT_FROM_WORKSPACE = np.array([[0.0, 0.0, -1.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
Q_ROBOT_FROM_WORKSPACE = np.array([0.5, -0.5, -0.5, 0.5])  # 120 deg about (1, -1, -1)


def quat_multiply(a: ArrayLike, b: ArrayLike) -> np.ndarray:
    """Hamilton product a (x) b of [x, y, z, w] quaternions (broadcasts over leading dims)."""
    a, b = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    ax, ay, az, aw = np.moveaxis(a, -1, 0)
    bx, by, bz, bw = np.moveaxis(b, -1, 0)
    return np.stack(
        [
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz,
        ],
        axis=-1,
    )


def quat_rotate(q: ArrayLike, v: ArrayLike) -> np.ndarray:
    """Rotate vector(s) v by unit quaternion(s) q."""
    q, v = np.asarray(q, dtype=np.float64), np.asarray(v, dtype=np.float64)
    u, w = q[..., :3], q[..., 3:]
    t = 2.0 * np.cross(u, v)
    return v + w * t + np.cross(u, t)


def workspace_to_robot_position(p: ArrayLike) -> np.ndarray:
    """Positions (..., 3) in W -> robot frame. NaN stays NaN."""
    p = np.asarray(p, dtype=np.float64)
    return np.stack([-p[..., 2], -p[..., 0], p[..., 1]], axis=-1)


def workspace_to_robot_quaternion(q: ArrayLike) -> np.ndarray:
    """Orientations (..., 4) in W -> robot frame. The joint's local axes are unchanged; only the
    frame they are expressed in changes. NaN stays NaN."""
    return quat_multiply(Q_ROBOT_FROM_WORKSPACE, q)


def workspace_to_robot_pose(pose: ArrayLike) -> np.ndarray:
    """Pose7 (..., 7) [px, py, pz, qx, qy, qz, qw] in W -> robot frame."""
    pose = np.asarray(pose, dtype=np.float64)
    return np.concatenate(
        [workspace_to_robot_position(pose[..., :3]), workspace_to_robot_quaternion(pose[..., 3:7])],
        axis=-1,
    )


def make_quaternions_continuous(q: ArrayLike) -> np.ndarray:
    """Flip signs along axis 0 so consecutive quaternions lie in the same hemisphere (q and -q are
    the same rotation; learning code prefers no jumps). NaN rows are skipped."""
    out = np.array(q, dtype=np.float64, copy=True)
    ref = np.full(out.shape[1:], np.nan)
    for i in range(out.shape[0]):
        valid = ~np.isnan(out[i]).any(axis=-1)
        with np.errstate(invalid="ignore"):
            flip = valid & (np.sum(out[i] * ref, axis=-1) < 0)
        out[i][flip] *= -1.0
        ref[valid] = out[i][valid]
    return out
