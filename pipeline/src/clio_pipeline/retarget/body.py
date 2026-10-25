"""A whole Unitree G1 posed from the headset and the two hands (body-g1.json).

Only three things are measured: the head and the two hands. Everything else is inferred, frame by
frame on the compiled tracks grid, so the result is a plausible G1, not a measured one:

1. Scale. The learner's standing head height (a high percentile of the head's height above the
   local floor) maps to the G1's head height; every measured point is scaled by that ratio about
   the floor point under the learner's median head position, so a reach stays a reach.
2. Facing. The head's forward direction, flattened onto the floor and smoothed, is the body's yaw.
3. Pelvis. Below the head by the G1's pelvis-to-head length, never above the G1's standing height
   and never below a deep crouch, a little behind the head; the waist (yaw, roll, pitch) is then
   solved so the head lands on the scaled headset.
4. Feet. Planted where they were, in the G1's reference stance around the pelvis; a foot steps to
   its stance spot only when it is more than STEP_M away or the body turned more than STEP_YAW_RAD.
   Each leg is solved for its planted ankle, sole flat.
5. Arms. Each palm is solved (position only) onto the scaled hand's palm point. Frames without a
   tracked hand keep the arm's last pose, or its rest pose.
6. Fingers. The Dex3 joints close with the pinch, from open at PINCH_OPEN_M to closed at
   PINCH_CLOSED_M.

The G1 is z-up with x forward; the workspace frame W is y-up. Poses are solved in the local-floor
world frame (meta.space.worldFromWorkspace) and written in W, like every derived file.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..episode import Episode
from ..frames import HANDS, JOINT_INDEX, WRIST, quat_rotate
from ..resample import MAX_FRAME_GAP_MS, Resampled, resample_episode
from .ik import IkSettings, solve_ik
from .kinematics import Chain, matrix_to_quat, quat_to_matrix
from .urdf import Urdf, load_urdf

PROFILE_ID = "unitree-g1-body"
PROFILE_VERSION = 1
ROBOT_TYPE = "unitree_g1"
URDF_PATH = Path(__file__).parent / "robots" / "unitree-g1.urdf"
# The same model the visualizer draws (huggingface.co/buckets/lerobot/robot-urdfs).
URDF_NAME = "g1/g1_body29_hand14.urdf"

STANDING_PERCENTILE = 90  # of the head's height: the learner standing
MIN_STANDING_HEAD_M = 1.2  # a seated learner still maps to a standing G1
PELVIS_BEHIND_HEAD_M = 0.04
CROUCH_PELVIS_M = 0.45  # the lowest pelvis height the legs are asked for
STEP_M = 0.18
STEP_YAW_RAD = np.radians(35)
YAW_SMOOTHING = 0.15  # per frame, at 30 fps
HEIGHT_SMOOTHING = 0.25
PINCH_OPEN_M = 0.08
PINCH_CLOSED_M = 0.02
FINGER_CLOSE = 0.8  # of each finger joint's range toward closed
# The G1's eyes in torso_link: the head mesh tops out about 0.53 m above the pelvis.
EYES_IN_TORSO = np.array([0.06, 0.0, 0.43])
MIDDLE_PROXIMAL = JOINT_INDEX["middle-finger-phalanx-proximal"]

ARM_REST = np.array([0.3, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0])  # shoulder pitch .. wrist yaw
LEG_REST = np.array([-0.3, 0.0, 0.0, 0.6, -0.3, 0.0])

_LEG_IK = IkSettings(mode="full", rot_weight=0.1, max_iterations=40, tol_pos_m=0.01)
_ARM_IK = IkSettings(mode="position_only", max_iterations=40, tol_pos_m=0.02)

_UP = np.array([0.0, 1.0, 0.0])


@dataclass(eq=False)
class G1Model:
    urdf: Urdf
    waist: Chain  # pelvis -> torso_link: waist yaw, roll, pitch
    torso: Chain  # the same chain, by its other name
    legs: tuple[Chain, Chain]  # pelvis -> ankle roll link
    arms: tuple[Chain, Chain]  # torso_link -> palm
    fingers: tuple[tuple[str, ...], tuple[str, ...]]
    finger_closed: tuple[np.ndarray, np.ndarray]
    head_in_pelvis: np.ndarray  # (3,) the eyes at the zero waist
    pelvis_height: float  # standing, soles on the floor
    ankle_height: float  # ankle roll origin above the sole
    stance: tuple[np.ndarray, np.ndarray]  # (3,) ankle in the pelvis frame, standing

    @property
    def head_height(self) -> float:
        return self.pelvis_height + float(self.head_in_pelvis[2])

    @property
    def joint_names(self) -> list[str]:
        names = list(self.legs[0].joint_names) + list(self.legs[1].joint_names)
        names += list(self.waist.joint_names)
        names += list(self.arms[0].joint_names) + list(self.arms[1].joint_names)
        return names + list(self.fingers[0]) + list(self.fingers[1])


def load_g1(path: Path = URDF_PATH) -> G1Model:
    urdf = load_urdf(path)
    waist = Chain(urdf, "pelvis", "torso_link")
    legs = tuple(Chain(urdf, "pelvis", f"{h}_ankle_roll_link") for h in HANDS)
    arms = tuple(Chain(urdf, "torso_link", f"{h}_hand_palm_link") for h in HANDS)
    fingers, closed = [], []
    for h in HANDS:
        joints = [j for j in urdf.joints.values() if j.name.startswith(f"{h}_hand_") and j.actuated]
        fingers.append(tuple(j.name for j in joints))
        # Closed is the end of the range farther from zero; a symmetric joint stays at zero.
        closed.append(
            np.array(
                [
                    0.0
                    if abs(abs(j.lower) - abs(j.upper)) < 1e-6
                    else FINGER_CLOSE * (j.lower if abs(j.lower) > abs(j.upper) else j.upper)
                    for j in joints
                ]
            )
        )
    stance = tuple(leg.points(np.zeros(leg.dof))[-1] for leg in legs)
    ankle_height = 0.035  # ankle roll origin above the sole (the URDF's foot spheres)
    return G1Model(
        urdf=urdf,
        waist=waist,
        torso=waist,
        legs=legs,  # type: ignore[arg-type]
        arms=arms,  # type: ignore[arg-type]
        fingers=tuple(fingers),  # type: ignore[arg-type]
        finger_closed=tuple(closed),  # type: ignore[arg-type]
        head_in_pelvis=waist.tip(np.zeros(waist.dof))[1] + EYES_IN_TORSO,
        pelvis_height=-float(stance[0][2]) + ankle_height,
        ankle_height=ankle_height,
        stance=stance,  # type: ignore[arg-type]
    )


@dataclass(eq=False)
class BodyTrajectory:
    t: np.ndarray  # (M,) ms
    root: np.ndarray  # (M, 7) pelvis pose in W; NaN before the head is first seen
    q: np.ndarray  # (M, J) rad, model.joint_names order
    head_target: np.ndarray  # (M, 3) scaled headset, W
    hand_target: np.ndarray  # (M, 2, 3) scaled palm points, W; NaN where untracked
    hand_residual: np.ndarray  # (M, 2) m; NaN where untracked
    scale: float
    standing_head_m: float


def solve_body(
    episode: Episode, model: G1Model, *, fps: int = 30, resampled: Resampled | None = None
) -> BodyTrajectory:
    r = resampled or resample_episode(episode, fps=fps, max_gap_ms=MAX_FRAME_GAP_MS)
    world_from_w = np.asarray(episode.meta["space"]["worldFromWorkspace"], dtype=np.float64)
    wp, wq = world_from_w[:3], world_from_w[3:7] / np.linalg.norm(world_from_w[3:7])

    def to_world(p: np.ndarray) -> np.ndarray:
        return quat_rotate(wq, p) + wp

    m = len(r.t)
    head_w = to_world(r.head[:, :3])
    head_q = _quat_product(wq, r.head[:, 3:7])
    palm = 0.5 * (r.hands[:, :, WRIST, :3] + r.hands[:, :, MIDDLE_PROXIMAL, :3]).astype(float)
    palm_w = to_world(palm.reshape(-1, 3)).reshape(m, 2, 3)

    valid = ~np.isnan(head_w).any(axis=1)
    standing = (
        max(float(np.percentile(head_w[valid, 1], STANDING_PERCENTILE)), MIN_STANDING_HEAD_M)
        if valid.any()
        else MIN_STANDING_HEAD_M
    )
    scale = model.head_height / standing
    center = np.nanmedian(head_w[valid], axis=0) if valid.any() else np.zeros(3)
    center[1] = 0.0

    def scaled(p: np.ndarray) -> np.ndarray:
        return center + scale * (p - center)

    head_s, palm_s = scaled(head_w), scaled(palm_w)
    joints = model.joint_names
    q = np.full((m, len(joints)), np.nan)
    root_world = np.full((m, 4, 4), np.nan)
    residual = np.full((m, 2), np.nan)

    yaw: float | None = None
    pelvis_z: float | None = None
    feet: list[tuple[np.ndarray, float] | None] = [None, None]  # planted ankle (world) and yaw
    q_leg = [LEG_REST.copy(), LEG_REST.copy()]
    q_arm = [ARM_REST.copy(), ARM_REST * [1, -1, -1, 1, -1, 1, -1]]
    q_waist = np.zeros(model.waist.dof)
    for k in range(m):
        if not valid[k]:
            continue
        forward = quat_rotate(head_q[k], np.array([0.0, 0.0, -1.0]))
        heading = float(np.arctan2(-forward[2], forward[0]))  # angle of forward in x/-z
        yaw = heading if yaw is None else yaw + YAW_SMOOTHING * _wrap(heading - yaw)
        # Robot frame in world: x forward (horizontal), z up (world +y), y left.
        x_axis = np.array([np.cos(yaw), 0.0, -np.sin(yaw)])
        z_axis = _UP
        y_axis = np.cross(z_axis, x_axis)
        R_world_robot = np.stack([x_axis, y_axis, z_axis], axis=1)

        head = head_s[k]
        target_z = np.clip(head[1] - model.head_in_pelvis[2], CROUCH_PELVIS_M, model.pelvis_height)
        pelvis_z = (
            target_z if pelvis_z is None else pelvis_z + HEIGHT_SMOOTHING * (target_z - pelvis_z)
        )
        pelvis = np.array([head[0], pelvis_z, head[2]]) - PELVIS_BEHIND_HEAD_M * x_axis
        T = np.eye(4)
        T[:3, :3], T[:3, 3] = R_world_robot, pelvis
        root_world[k] = T

        def local(p: np.ndarray, R=R_world_robot, origin=pelvis) -> np.ndarray:
            return R.T @ (p - origin)

        q_waist = _lean(model, local(head))

        legs_q = []
        for i in range(2):
            spot = pelvis + R_world_robot @ model.stance[i]
            spot[1] = model.ankle_height
            planted = feet[i]
            if (
                planted is None
                or np.linalg.norm((planted[0] - spot)[[0, 2]]) > STEP_M
                or abs(_wrap(planted[1] - yaw)) > STEP_YAW_RAD
            ):
                planted = (spot, yaw)
                feet[i] = planted
            foot_R = R_world_robot.T @ _yaw_matrix(planted[1])
            sol = solve_ik(model.legs[i], foot_R, local(planted[0]), q_leg[i], _LEG_IK)
            q_leg[i] = sol.q
            legs_q.append(sol.q)

        R_torso, p_torso = model.torso.tip(q_waist)
        arms_q, fingers_q = [], []
        for i in range(2):
            target = palm_s[k, i]
            if not np.isnan(target).any():
                in_torso = R_torso.T @ (local(target) - p_torso)
                sol = solve_ik(model.arms[i], np.eye(3), in_torso, q_arm[i], _ARM_IK)
                q_arm[i] = sol.q
                residual[k, i] = sol.residual_pos
            arms_q.append(q_arm[i])
            pinch = float(r.pinch[k, i])
            closure = (
                0.0
                if np.isnan(pinch)
                else np.clip((PINCH_OPEN_M - pinch) / (PINCH_OPEN_M - PINCH_CLOSED_M), 0.0, 1.0)
            )
            fingers_q.append(closure * model.finger_closed[i])
        q[k] = np.concatenate([*legs_q, q_waist, *arms_q, *fingers_q])

    # Back into W.
    R_w = quat_to_matrix(wq).T
    root = np.full((m, 7), np.nan)
    for k in np.flatnonzero(valid):
        R = R_w @ root_world[k, :3, :3]
        p = R_w @ (root_world[k, :3, 3] - wp)
        root[k] = np.concatenate([p, matrix_to_quat(R)])
    w_head = np.einsum("ij,mj->mi", R_w, head_s - wp)
    w_palm = np.einsum("ij,mj->mi", R_w, palm_s.reshape(-1, 3) - wp)
    return BodyTrajectory(
        t=r.t,
        root=root,
        q=q,
        head_target=w_head,
        hand_target=w_palm.reshape(m, 2, 3),
        hand_residual=residual,
        scale=scale,
        standing_head_m=standing,
    )


def body_doc(body: BodyTrajectory, model: G1Model, episode: Episode, fps: int) -> dict:
    """The JSON-ready `BodyDoc` (clio.derived/1, kind "body"): null for no value, never NaN."""
    has = ~np.isnan(body.root).any(axis=1)
    reached = body.hand_residual[~np.isnan(body.hand_residual)]
    return {
        "schema": "clio.derived/1",
        "episodeId": episode.episode_id,
        "frame": "workspace",
        "fps": fps,
        "t": [_round(x, 2) for x in body.t],
        "kind": "body",
        "profile": {
            "id": PROFILE_ID,
            "version": PROFILE_VERSION,
            "robotType": ROBOT_TYPE,
            "urdf": URDF_NAME,
            "inferred": ["pelvis", "legs", "waist", "fingers"],
        },
        "scale": _round(body.scale, 4),
        "standingHeadM": _round(body.standing_head_m, 3),
        "joints": model.joint_names,
        "root": [_row(body.root[k], 4) if has[k] else None for k in range(len(body.t))],
        "q": [_row(body.q[k], 4) if has[k] else None for k in range(len(body.t))],
        "handResidualM": [
            [None if np.isnan(x) else _round(x, 3) for x in row] for row in body.hand_residual
        ],
        "summary": {
            "frames": int(has.sum()),
            "meanHandResidualM": _round(float(reached.mean()), 4) if len(reached) else None,
        },
    }


def _lean(model: G1Model, head: np.ndarray) -> np.ndarray:
    """Waist (yaw, roll, pitch) that tilts the torso toward the head target (pelvis frame); yaw
    stays zero, as the body already faces where the head does."""
    torso_origin = model.waist.tip(np.zeros(model.waist.dof))[1]
    v = head - torso_origin
    pitch = np.arctan2(v[0] - EYES_IN_TORSO[0], v[2])
    roll = np.arctan2(-v[1], v[2])
    joints = [model.urdf.joints[name] for name in model.waist.joint_names]
    lower = np.array([j.lower for j in joints])
    upper = np.array([j.upper for j in joints])
    return np.clip(np.array([0.0, roll, pitch]), lower, upper)


def _quat_product(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    from ..frames import quat_multiply

    return quat_multiply(np.broadcast_to(a, b.shape), b)


def _yaw_matrix(yaw: float) -> np.ndarray:
    x = np.array([np.cos(yaw), 0.0, -np.sin(yaw)])
    return np.stack([x, np.cross(_UP, x), _UP], axis=1)


def _wrap(a: float) -> float:
    return float((a + np.pi) % (2 * np.pi) - np.pi)


def _round(x: float, digits: int) -> float:
    return round(float(x), digits) + 0.0


def _row(values: np.ndarray, digits: int) -> list[float]:
    return [_round(x, digits) for x in values]
