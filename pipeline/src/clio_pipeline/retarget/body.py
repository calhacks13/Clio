"""A whole Unitree G1 posed from the headset and the two hands (body-g1.json).

Only three things are measured: the head and the two hands, each with its orientation. Everything
else is inferred, on the compiled tracks grid, so the result is a plausible G1, not a measured
one. The episode is known in full before it is posed, so every estimate may look ahead and is
smoothed without lag.

1. Scale. The learner's standing head height (a high percentile of the head's height above the
   local floor) maps to the G1's eye height; every measured point is scaled by that ratio about
   the floor point under the learner's median head position. So a taller or shorter learner's
   reach, and where they held things, shrink or grow with them, and the hands keep their places
   relative to the table and the objects. The pose is solved at the G1's size; the document's
   `root` is the pelvis of the G1 drawn back at the learner's size (`1 / scale`), so its head
   and palms land on the measured head and hands.
2. Hands. Tracking glitches (a hand faster than a hand moves, or further than an arm reaches)
   and blips are dropped, dropouts up to SHORT_GAP_S are bridged on a smooth reach (motion.py),
   and the palm frames are smoothed a little. The palm point is halfway from the wrist to the
   middle knuckle; the palm frame comes from the wrist and knuckles (human.py).
3. Trunk. A neck model puts the neck's pivot under the eyes (human.py), where the G1's neck
   goes. The trunk faces between where the head looks and where the hands are, turning less
   than the head (a neck turns too), and the pelvis turns slower still. When the head drops below
   standing, a learner looking down is taken to bend over at the hips and a learner looking ahead
   to crouch; the pelvis then sits behind and below the neck along a trunk that leans that much,
   the lean shared between the hips and the waist, and short sways of the head lean the trunk
   rather than move the pelvis.
4. Elbows. Each arm's swivel is chosen for the whole episode at once (swivel.py): the elbow
   a person would use for that hand, smoothly.
5. Upper body. Pelvis, waist and arms are solved together each frame (upper_body.py), the palm
   points first: the palm orientations, the elbows, the head and staying near the trunk estimate
   come second. A hand the arm cannot reach from the estimated trunk is reached by leaning,
   turning or shifting the body. Every joint stays in a human range (human.py).
6. Arms without a hand. Across a longer dropout the arm lowers to hang at the side on a
   minimum-jerk path and comes back up to meet the hand where it reappears, in time for it.
7. Legs. Feet stay planted in the G1's stance around the pelvis; a foot steps to its stance spot
   when it is more than STEP_M away or the body turned more than STEP_YAW_RAD. Each leg is solved
   for its ankle, sole flat.
8. Fingers. The Dex3 joints close with the pinch, from open at PINCH_OPEN_M to closed at
   PINCH_CLOSED_M, and relax half closed without a hand.

The G1 is z-up with x forward; the workspace frame W is y-up. Poses are solved in the local-floor
world frame (meta.space.worldFromWorkspace) and written in W, like every derived file.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..episode import Episode
from ..frames import HANDS, quat_rotate
from ..resample import MAX_FRAME_GAP_MS, Resampled, resample_episode
from .human import (
    ARM_REST_LEFT,
    LEG_MIRRORED,
    LEG_RANGE_LEFT,
    WAIST_RANGE,
    arm_range,
    neck_pivot,
    palm_frame,
    sided,
)
from .ik import IkSettings, solve_ik
from .kinematics import Chain, matrix_to_quat, quat_to_matrix
from .motion import (
    clean_tracking,
    fill_short_gaps,
    gaussian_smooth,
    min_jerk,
    runs,
    smooth_angle,
    smooth_rotations,
    smooth_rotations_adaptive,
)
from .swivel import SWIVEL_STEPS, ArmModel, choose_swivel, swivel_costs
from .upper_body import TRUNK, Targets, UpperBody, Weights
from .urdf import Urdf, load_urdf

PROFILE_ID = "unitree-g1-body"
PROFILE_VERSION = 2
ROBOT_TYPE = "unitree_g1"
URDF_PATH = Path(__file__).parent / "robots" / "unitree-g1.urdf"
# The same model the visualizer draws (huggingface.co/buckets/lerobot/robot-urdfs).
URDF_NAME = "g1/g1_body29_hand14.urdf"

STANDING_PERCENTILE = 90  # of the head's height: the learner standing
MIN_STANDING_HEAD_M = 1.2  # a seated learner still maps to a standing G1
ADULT_EYE_HEIGHT_M = 1.62  # the neck model's adult
CROUCH_PELVIS_M = 0.38  # the lowest pelvis height the legs are asked for
STEP_M = 0.18
STEP_YAW_RAD = np.radians(35)
PINCH_OPEN_M = 0.08
PINCH_CLOSED_M = 0.02
FINGER_CLOSE = 0.8  # of each finger joint's range toward closed
FINGER_RELAXED = 0.3  # closure of a hand that is not tracked
# The G1's eyes in torso_link: the head mesh tops out about 0.53 m above the pelvis.
EYES_IN_TORSO = np.array([0.06, 0.0, 0.43])
# The palm point (halfway from the wrist to the knuckles) in each palm link frame.
TCP_IN_PALM = np.array([0.045, 0.0, 0.0])
# Standing: knees and hips slightly bent, as a person stands (and off the straight-leg
# singularity).
LEG_STANDING = np.array([-0.12, 0.0, 0.0, 0.26, -0.14, 0.0])

# Hand tracking (learner's meters and seconds).
HAND_MAX_SPEED = 6.0  # m/s: faster is a glitch
HAND_MAX_TURN = 30.0  # rad/s
HAND_REACH = 1.0  # m from the eyes: further is a glitch
HAND_BEHIND_RAD = np.radians(100)  # from where the head looks: the cameras do not see further
HAND_SPIKE_M = 0.04  # out of line with the samples on either side
MIN_RUN_S = 0.1  # a shorter run of tracking inside a dropout is a blip
SHORT_GAP_S = 0.35  # bridged on a smooth reach; longer, the arm goes to rest
PALM_SMOOTHING_S = (0.12, 0.03)  # sigma, palm frames turning slowly and fast
PALM_FAST_TURN = 4.0  # rad/s: turning this fast gets the light smoothing
# The G1's wrist sits 13 cm behind its palm point (a person's 4), so the palm frame's noise moves
# it; the elbow aims from it smoothed this much (sigma).
WRIST_SMOOTHING_S = 0.08
HEAD_SMOOTHING_S = 0.03  # sigma, the eyes
REST_MOVE_S = 0.7  # lowering the arm to rest, and raising it back

# Trunk.
TRUNK_YAW_SMOOTHING_S = 0.25
PELVIS_YAW_SMOOTHING_S = 0.6
NECK_TURN_RAD = 1.0  # the most the head turns from the trunk
WAIST_TURN_RAD = 0.6  # the most the trunk turns from the pelvis
HANDS_PULL = 0.6  # how much the hands' direction turns the trunk, against the head's 1
LOOK_DOWN_BEND = (0.15, 0.6)  # rad of looking down: from here the drop is a bend, fully here
MAX_LEAN_RAD = 1.2
LEAN_SMOOTHING_S = 0.2
PELVIS_SMOOTHING_S = 0.35
WAIST_SHARE = (0.4, 0.5)  # of the trunk's lean forward and sideways taken by the waist
# The front of the body in the torso frame: a palm closer in than BODY_FRONT, within the body's
# width and height, would be inside it.
BODY_FRONT = 0.13
BODY_HALF_WIDTH = 0.13
BODY_Z = (-0.3, 0.32)
CLEAR_SPREAD_S = 0.25  # the trunk starts leaning back this long before the hand needs it
CLEAR_SMOOTHING_S = 0.15

ORIENTATION_FIT = 8.0  # a best swivel cost above this: the palm orientation fits no elbow well
DEFAULT_WEIGHTS = Weights()

_LEG_IK = IkSettings(mode="full", rot_weight=0.1, max_iterations=40, tol_pos_m=0.005)

_UP = np.array([0.0, 1.0, 0.0])


@dataclass(eq=False)
class G1Model:
    urdf: Urdf
    waist: Chain  # pelvis -> torso_link: waist yaw, roll, pitch
    torso: Chain  # the same chain, by its other name
    legs: tuple[Chain, Chain]  # pelvis -> ankle roll link
    arms: tuple[Chain, Chain]  # torso_link -> palm
    arm_models: tuple[ArmModel, ArmModel]
    upper_body: UpperBody
    fingers: tuple[tuple[str, ...], tuple[str, ...]]
    finger_closed: tuple[np.ndarray, np.ndarray]
    head_in_pelvis: np.ndarray  # (3,) the eyes at the zero waist
    neck_in_torso: np.ndarray  # (3,) where the learner's neck pivot goes
    pelvis_height: float  # standing, soles on the floor
    ankle_height: float  # ankle roll origin above the sole
    stance: tuple[np.ndarray, np.ndarray]  # (3,) ankle in the pelvis frame, standing
    arm_rest: tuple[np.ndarray, np.ndarray]

    @property
    def head_height(self) -> float:
        return self.pelvis_height + float(self.head_in_pelvis[2])

    @property
    def neck_size(self) -> float:
        """The learner's neck model in G1 meters (scaled like everything else)."""
        return self.head_height / ADULT_EYE_HEIGHT_M

    @property
    def joint_names(self) -> list[str]:
        names = list(self.legs[0].joint_names) + list(self.legs[1].joint_names)
        names += list(self.waist.joint_names)
        names += list(self.arms[0].joint_names) + list(self.arms[1].joint_names)
        return names + list(self.fingers[0]) + list(self.fingers[1])


def load_g1(path: Path = URDF_PATH) -> G1Model:
    urdf = load_urdf(path)
    waist = Chain(urdf, "pelvis", "torso_link")
    _restrict(waist, WAIST_RANGE)
    legs = tuple(Chain(urdf, "pelvis", f"{h}_ankle_roll_link") for h in HANDS)
    for side, leg in enumerate(legs):
        _restrict(leg, sided(LEG_RANGE_LEFT, side, LEG_MIRRORED))
    arms = tuple(Chain(urdf, "torso_link", f"{h}_hand_palm_link") for h in HANDS)
    models = []
    for side, arm in enumerate(arms):
        limits = arm_range(side, arm.lower, arm.upper)
        _restrict(arm, limits)
        models.append(ArmModel.of(arm, side, TCP_IN_PALM, limits, urdf))
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
    stance = tuple(
        leg.points(sided(LEG_STANDING, side, LEG_MIRRORED))[-1] for side, leg in enumerate(legs)
    )
    ankle_height = 0.035  # ankle roll origin above the sole (the URDF's foot spheres)
    head_in_pelvis = waist.tip(np.zeros(waist.dof))[1] + EYES_IN_TORSO
    # The neck pivot sits where the neck model puts it behind and below the G1's eyes.
    neck_size = (-float(stance[0][2]) + ankle_height + float(head_in_pelvis[2])) / (
        ADULT_EYE_HEIGHT_M
    )
    neck_in_torso = EYES_IN_TORSO - neck_size * np.array([0.0805, 0.0, 0.075])
    upper = UpperBody(
        waist,
        arms,  # type: ignore[arg-type]
        tuple(models),  # type: ignore[arg-type]
        (TCP_IN_PALM, TCP_IN_PALM),
        EYES_IN_TORSO,
        waist_range=np.stack([waist.lower, waist.upper], axis=1),
    )
    return G1Model(
        urdf=urdf,
        waist=waist,
        torso=waist,
        legs=legs,  # type: ignore[arg-type]
        arms=arms,  # type: ignore[arg-type]
        arm_models=tuple(models),  # type: ignore[arg-type]
        upper_body=upper,
        fingers=tuple(fingers),  # type: ignore[arg-type]
        finger_closed=tuple(closed),  # type: ignore[arg-type]
        head_in_pelvis=head_in_pelvis,
        neck_in_torso=neck_in_torso,
        pelvis_height=-float(stance[0][2]) + ankle_height,
        ankle_height=ankle_height,
        stance=stance,  # type: ignore[arg-type]
        arm_rest=(sided(ARM_REST_LEFT, 0), sided(ARM_REST_LEFT, 1)),
    )


@dataclass(eq=False)
class BodyTrajectory:
    t: np.ndarray  # (M,) ms
    root: np.ndarray  # (M, 7) pelvis pose in W, the G1 at the learner's size; NaN without a head
    q: np.ndarray  # (M, J) rad, model.joint_names order
    head_target: np.ndarray  # (M, 3) the measured eyes, W
    hand_target: np.ndarray  # (M, 2, 3) the measured palm points, W; NaN where untracked
    hand_residual: np.ndarray  # (M, 2) m at the learner's size; NaN where untracked
    scale: float
    standing_head_m: float


@dataclass(eq=False)
class _Hands:
    """Both hands in the scaled world: palm points and frames, and which frames have them."""

    p: np.ndarray  # (M, 2, 3)
    R: np.ndarray  # (M, 2, 3, 3)
    wrist: np.ndarray  # (M, 2, 3) the G1 wrist the palm frame implies, smoothed (the elbow's aim)
    measured: np.ndarray  # (M, 2) a kept measurement
    target: np.ndarray  # (M, 2) measured or bridged: the arm reaches for it


@dataclass(eq=False)
class _Trunk:
    """Per frame: pelvis yaw, the pelvis estimate (world) and pelvis pitch, roll, waist yaw,
    roll, pitch."""

    yaw: np.ndarray  # (M,)
    pelvis: np.ndarray  # (M, 3)
    angles: np.ndarray  # (M, 5)


def solve_body(
    episode: Episode, model: G1Model, *, fps: int = 30, resampled: Resampled | None = None
) -> BodyTrajectory:
    r = resampled or resample_episode(episode, fps=fps, max_gap_ms=MAX_FRAME_GAP_MS)
    world_from_w = np.asarray(episode.meta["space"]["worldFromWorkspace"], dtype=np.float64)
    wp, wq = world_from_w[:3], world_from_w[3:7] / np.linalg.norm(world_from_w[3:7])
    R_world_w = quat_to_matrix(wq)
    m = len(r.t)
    rate = float(r.fps)

    def to_world(p: np.ndarray) -> np.ndarray:
        return quat_rotate(wq, p) + wp

    head_w = to_world(r.head[:, :3])
    head_q = _quat_product(wq, r.head[:, 3:7])
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

    def unscaled(p: np.ndarray) -> np.ndarray:
        return center + (p - center) / scale

    eyes = scaled(gaussian_smooth(head_w, HEAD_SMOOTHING_S * rate, valid))
    head_q = _smooth_quats(head_q, 2.0, valid)
    wrist_in_tcp = [arm.wrist_in_tcp for arm in model.arm_models]
    hands = _clean_hands(
        r, to_world, R_world_w, scaled, eyes, head_q, valid, scale, rate, wrist_in_tcp
    )
    trunk = _estimate_trunk(model, eyes, head_q, hands, valid, rate)
    swivel, q_ref, fit = _choose_elbows(model, hands, trunk)

    joints = model.joint_names
    q = np.full((m, len(joints)), np.nan)
    root_world = np.full((m, 4, 4), np.nan)
    residual = np.full((m, 2), np.nan)
    upper = model.upper_body
    x = np.concatenate([np.zeros(3), trunk.angles[0], *model.arm_rest])
    arm_q = np.full((m, 2, 7), np.nan)
    for k in np.flatnonzero(valid):
        for i in range(2):
            if hands.target[k, i] and (k == 0 or not hands.target[k - 1, i]):
                x[TRUNK + 7 * i : TRUNK + 7 * (i + 1)] = q_ref[k, i]  # a hand back: start there
        targets = Targets(
            yaw=float(trunk.yaw[k]),
            pelvis=trunk.pelvis[k],
            trunk=trunk.angles[k],
            pelvis_z=(CROUCH_PELVIS_M, model.pelvis_height),
            eyes=eyes[k],
            tcp=tuple(hands.p[k, i] if hands.target[k, i] else None for i in range(2)),  # type: ignore[arg-type]
            R_tcp=tuple(hands.R[k, i] if hands.target[k, i] else None for i in range(2)),  # type: ignore[arg-type]
            swivel=tuple(  # type: ignore[arg-type]
                float(swivel[k, i]) if hands.target[k, i] else None for i in range(2)
            ),
            wrist=tuple(hands.wrist[k, i] if hands.target[k, i] else None for i in range(2)),  # type: ignore[arg-type]
            q_ref=(q_ref[k, 0], q_ref[k, 1]),
            weights=_weights(fit[k]),
        )
        back = any(hands.target[k, i] and (k == 0 or not hands.target[k - 1, i]) for i in range(2))
        sol = upper.solve(x, targets, iterations=60 if back else 20)
        x = sol.x
        root_world[k] = sol.root
        for i in range(2):
            if hands.target[k, i]:
                arm_q[k, i] = x[TRUNK + 7 * i : TRUNK + 7 * (i + 1)]
            if hands.measured[k, i] and sol.residual[i] is not None:
                residual[k, i] = sol.residual[i] / scale
        q[k, 12:15] = x[5:8]
    for i in range(2):
        arm_q[:, i] = _rest_through_gaps(arm_q[:, i], hands.target[:, i], valid, model, i, rate)

    legs_q = _legs(model, root_world, valid)
    fingers = _fingers(model, r.pinch, hands.measured, valid, rate)
    for k in np.flatnonzero(valid):
        q[k] = np.concatenate([legs_q[k, 0], legs_q[k, 1], q[k, 12:15], *arm_q[k], fingers[k]])

    # Back into W, the G1 drawn at the learner's size.
    R_w = R_world_w.T
    root = np.full((m, 7), np.nan)
    for k in np.flatnonzero(valid):
        R = R_w @ root_world[k, :3, :3]
        p = R_w @ (unscaled(root_world[k, :3, 3]) - wp)
        root[k] = np.concatenate([p, matrix_to_quat(R)])
    w_head = np.einsum("ij,mj->mi", R_w, unscaled(eyes) - wp)
    palm = np.where(hands.measured[..., None], hands.p, np.nan)
    w_palm = np.einsum("ij,mj->mi", R_w, unscaled(palm.reshape(-1, 3)) - wp)
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
            "inferred": ["pelvis", "legs", "waist", "elbows", "fingers"],
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


def _clean_hands(
    r, to_world, R_world_w, scaled, eyes, head_q, valid, scale: float, rate: float, wrist_in_tcp
) -> _Hands:
    m = len(r.t)
    forward = quat_rotate(np.nan_to_num(head_q) + [0, 0, 0, 1e-9], np.array([0.0, 0.0, -1.0]))
    p = np.full((m, 2, 3), np.nan)
    R = np.tile(np.eye(3), (m, 2, 1, 1))
    measured = np.zeros((m, 2), dtype=bool)
    target = np.zeros((m, 2), dtype=bool)
    wrist = np.full((m, 2, 3), np.nan)
    for i in range(2):
        point, frame = palm_frame(r.hands[:, i])
        point = scaled(to_world(point))
        frame = np.einsum("ij,mjk->mik", R_world_w, np.nan_to_num(frame))
        tracked = r.tracked[:, i] & valid & ~np.isnan(point).any(axis=1)
        good = clean_tracking(
            point,
            frame,
            tracked,
            eyes,
            forward,
            dt=1.0 / rate,
            max_speed=HAND_MAX_SPEED * scale,
            max_turn=HAND_MAX_TURN,
            max_reach=HAND_REACH * scale,
            max_behind=HAND_BEHIND_RAD,
            spike=HAND_SPIKE_M * scale,
            min_run=max(1, round(MIN_RUN_S * rate)),
        )
        frame = smooth_rotations_adaptive(
            frame,
            good,
            slow=PALM_SMOOTHING_S[0] * rate,
            fast=PALM_SMOOTHING_S[1] * rate,
            fast_turn=PALM_FAST_TURN,
            rate=rate,
        )
        point, frame, have = fill_short_gaps(
            point, frame, good, max_gap=max(1, round(SHORT_GAP_S * rate))
        )
        have &= valid
        p[:, i], R[:, i] = point, frame
        measured[:, i], target[:, i] = good, have
        implied = point + np.einsum("mij,j->mi", frame, wrist_in_tcp[i])
        wrist[:, i] = gaussian_smooth(implied, WRIST_SMOOTHING_S * rate, have)
    return _Hands(p=p, R=R, wrist=wrist, measured=measured, target=target)


def _estimate_trunk(model: G1Model, eyes, head_q, hands: _Hands, valid, rate: float) -> _Trunk:
    """The trunk estimate, step 3 of the module docstring."""
    m = len(eyes)
    neck = neck_pivot(np.nan_to_num(eyes), np.nan_to_num(head_q) + [0, 0, 0, 1e-9], model.neck_size)
    forward = quat_rotate(np.nan_to_num(head_q) + [0, 0, 0, 1e-9], np.array([0.0, 0.0, -1.0]))
    head_yaw = np.arctan2(-forward[:, 2], forward[:, 0])
    look_down = -np.arcsin(np.clip(forward[:, 1], -1.0, 1.0))

    # Face between the head and the hands.
    face = np.stack([np.cos(head_yaw), -np.sin(head_yaw)], axis=1)  # world (x, z) of forward
    for i in range(2):
        d = (hands.p[:, i] - neck)[:, [0, 2]]
        dist = np.linalg.norm(d, axis=1)
        unit = d / np.maximum(dist, 1e-9)[:, None]
        ahead = np.sum(unit * face, axis=1) > 0
        pull = 0.5 * HANDS_PULL * np.clip(dist / 0.15, 0.0, 1.0)
        w = np.where(hands.measured[:, i] & ahead, pull, 0.0)
        face = face + w[:, None] * np.nan_to_num(unit)
    trunk_yaw = smooth_angle(
        np.arctan2(-face[:, 1], face[:, 0]), TRUNK_YAW_SMOOTHING_S * rate, valid
    )
    trunk_yaw = head_yaw + np.clip(_wrap_array(trunk_yaw - head_yaw), -NECK_TURN_RAD, NECK_TURN_RAD)
    trunk_yaw = smooth_angle(trunk_yaw, 2.0, valid)
    pelvis_yaw = smooth_angle(trunk_yaw, PELVIS_YAW_SMOOTHING_S * rate, valid)
    waist_yaw = np.clip(_wrap_array(trunk_yaw - pelvis_yaw), -WAIST_TURN_RAD, WAIST_TURN_RAD)

    # Bend or crouch: how far the neck is below standing, and whether the learner looks down.
    trunk_len = _trunk_length(model)
    R_t, p_t = model.waist.tip(np.zeros(3))
    standing_neck = model.pelvis_height + float((p_t + R_t @ model.neck_in_torso)[2])
    drop = np.clip(standing_neck - neck[:, 1], 0.0, None)
    lo, hi = LOOK_DOWN_BEND
    bend = np.clip((look_down - lo) / (hi - lo), 0.0, 1.0)
    lean = bend * np.arccos(np.clip(1.0 - drop / trunk_len, np.cos(MAX_LEAN_RAD), 1.0))
    lean = gaussian_smooth(lean, LEAN_SMOOTHING_S * rate, valid)
    fwd = np.stack([np.cos(trunk_yaw), np.zeros(m), -np.sin(trunk_yaw)], axis=1)
    pelvis_h = neck - trunk_len * np.sin(lean)[:, None] * fwd
    pelvis_h = gaussian_smooth(pelvis_h, PELVIS_SMOOTHING_S * rate, valid)

    angles, pelvis = _place_trunk(model, neck, pelvis_h, pelvis_yaw, waist_yaw, lean, valid)

    # The body is behind the hands: where a measured palm would be inside the torso, the pelvis
    # moves back (the trunk leaning over the hands) from a little before to a little after.
    need = np.zeros(m)
    for k in np.flatnonzero(valid & hands.measured.any(axis=1)):
        R_T, p_T = _torso(model, pelvis_yaw[k], angles[k], pelvis[k])
        for i in np.flatnonzero(hands.measured[k]):
            x, y, z = R_T.T @ (hands.p[k, i] - p_T)
            if abs(y) < BODY_HALF_WIDTH and BODY_Z[0] < z < BODY_Z[1] and -0.05 < x < BODY_FRONT:
                need[k] = max(need[k], BODY_FRONT - x)
    if need.any():
        reach = max(1, round(CLEAR_SPREAD_S * rate))
        held = np.array([need[max(0, k - reach) : k + reach + 1].max() for k in range(m)])
        back = gaussian_smooth(held, CLEAR_SMOOTHING_S * rate, valid)
        pelvis_h = pelvis_h - back[:, None] * fwd
        angles, pelvis = _place_trunk(model, neck, pelvis_h, pelvis_yaw, waist_yaw, lean, valid)
    return _Trunk(yaw=pelvis_yaw, pelvis=pelvis, angles=angles)


def _place_trunk(model: G1Model, neck, pelvis_h, pelvis_yaw, waist_yaw, lean, valid):
    """The trunk angles (M, 5) and the pelvis (M, 3) that lean from the pelvis estimate `pelvis_h`
    (horizontally; the height follows from the lean) to the neck, the G1's neck on the
    learner's."""
    m = len(neck)
    trunk_len = _trunk_length(model)
    angles = np.zeros((m, 5))
    pelvis = np.full((m, 3), np.nan)
    for k in np.flatnonzero(valid):
        Y = _yaw_matrix(float(pelvis_yaw[k]))
        height = neck[k, 1] - trunk_len * np.cos(lean[k])
        height = float(np.clip(height, CROUCH_PELVIS_M, model.pelvis_height))
        v = Y.T @ (neck[k] - np.array([pelvis_h[k, 0], height, pelvis_h[k, 2]]))
        pitch = np.arctan2(v[0], v[2])
        roll = np.arctan2(-v[1], v[2])
        waist_pitch = np.clip(WAIST_SHARE[0] * pitch, *WAIST_RANGE[2])
        waist_roll = np.clip(WAIST_SHARE[1] * roll, *WAIST_RANGE[1])
        angles[k] = [pitch - waist_pitch, roll - waist_roll, waist_yaw[k], waist_roll, waist_pitch]
        R_p = Y @ _rot_y(angles[k, 0]) @ _rot_x(angles[k, 1])
        R_t, p_t = model.waist.tip(angles[k, 2:])
        pelvis[k] = neck[k] - R_p @ (p_t + R_t @ model.neck_in_torso)
        pelvis[k, 1] = np.clip(pelvis[k, 1], CROUCH_PELVIS_M, model.pelvis_height)
    return angles, pelvis


def _trunk_length(model: G1Model) -> float:
    """Pelvis to the neck pivot, waist straight."""
    R_t, p_t = model.waist.tip(np.zeros(3))
    return float(np.linalg.norm(p_t + R_t @ model.neck_in_torso))


def _torso(model: G1Model, yaw: float, angles: np.ndarray, pelvis: np.ndarray):
    """The torso link's rotation and origin in world for one frame's trunk."""
    R_p = _yaw_matrix(float(yaw)) @ _rot_y(angles[0]) @ _rot_x(angles[1])
    R_t, p_t = model.waist.tip(angles[2:])
    return R_p @ R_t, pelvis + R_p @ p_t


def _choose_elbows(model: G1Model, hands: _Hands, trunk: _Trunk):
    """Per frame and arm, the swivel and the model's joint angles there (step 4)."""
    m = len(trunk.yaw)
    phis = np.linspace(-np.pi, np.pi, SWIVEL_STEPS, endpoint=False)
    swivel = np.full((m, 2), np.nan)
    fit = np.zeros((m, 2))
    q_ref = np.tile(np.stack(model.arm_rest), (m, 1, 1))
    # The torso of the trunk estimate, to see each hand from it.
    R_T = np.full((m, 3, 3), np.nan)
    p_T = np.full((m, 3), np.nan)
    for k in np.flatnonzero(hands.target.any(axis=1)):
        R_T[k], p_T[k] = _torso(model, trunk.yaw[k], trunk.angles[k], trunk.pelvis[k])
    for i in range(2):
        arm = model.arm_models[i]
        frames = np.flatnonzero(hands.target[:, i])
        if len(frames) == 0:
            continue
        Rt = R_T[frames]
        R_tcp = np.einsum("mji,mjk->mik", Rt, hands.R[frames, i])
        W = np.einsum("mji,mj->mi", Rt, hands.wrist[frames, i] - p_T[frames])
        S = np.broadcast_to(arm.shoulder, W.shape)
        cost, q_all = swivel_costs(arm, S, W, R_tcp, phis)
        full = np.zeros((m, len(phis)))
        full[frames] = cost
        chosen = choose_swivel(full, hands.target[:, i], phis)
        swivel[:, i] = chosen
        # The model's joints at the chosen swivel: the nearest candidate's.
        index = np.round((chosen[frames] + np.pi) / (2 * np.pi) * len(phis)).astype(int) % len(phis)
        q_ref[frames, i] = q_all[np.arange(len(frames)), index]
        fit[frames, i] = cost.min(axis=1)
    return swivel, q_ref, fit


def _weights(fit: np.ndarray) -> Weights:
    """The solve's weights for one frame: a palm orientation no human elbow fits well (its best
    swivel cost, `fit`, per arm) is trusted less, down to a quarter."""
    trust = np.clip(ORIENTATION_FIT / np.maximum(fit, 1e-9), 0.25, 1.0)
    return Weights(orientation=DEFAULT_WEIGHTS.orientation * float(np.min(trust)))


def _rest_through_gaps(q, have, valid, model: G1Model, side: int, rate: float) -> np.ndarray:
    """Fill an arm's joints (M, 7) where it has no hand (step 6)."""
    q = q.copy()
    rest = model.arm_rest[side]
    move = REST_MOVE_S * rate
    for a, b in runs(valid & ~have):
        before = q[a - 1] if a > 0 and have[a - 1] else None
        after = q[b] if b < len(q) and have[b] else None
        n = b - a
        k = np.arange(n) + 1.0
        if before is None and after is None:
            q[a:b] = rest
        elif after is None:
            q[a:b] = before + (rest - before) * min_jerk(k / move)[:, None]
        elif before is None:
            q[a:b] = rest + (after - rest) * min_jerk((k - (n + 1 - move)) / move)[:, None]
        elif n + 1 >= 2 * move:
            down = before + (rest - before) * min_jerk(k / move)[:, None]
            up = rest + (after - rest) * min_jerk((k - (n + 1 - move)) / move)[:, None]
            q[a:b] = np.where((k <= move)[:, None], down, up)
        else:
            # Too short to reach rest: dip toward it on the way from one hand to the next.
            depth = np.clip((n + 1) / (2 * move), 0.0, 1.0)
            via = (before + after) / 2 + depth * (rest - (before + after) / 2)
            half = (n + 1) / 2
            down = before + (via - before) * min_jerk(k / half)[:, None]
            up = via + (after - via) * min_jerk((k - half) / half)[:, None]
            q[a:b] = np.where((k <= half)[:, None], down, up)
    return q


def _legs(model: G1Model, root_world: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """(M, 2, 6) leg joints: planted feet, stepping when the body moved or turned (step 7)."""
    m = len(root_world)
    out = np.zeros((m, 2, 6))
    feet: list[tuple[np.ndarray, float] | None] = [None, None]
    q_leg = [sided(LEG_STANDING, side, LEG_MIRRORED) for side in range(2)]
    for k in np.flatnonzero(valid):
        T = root_world[k]
        pelvis, R_root = T[:3, 3], T[:3, :3]
        yaw = float(np.arctan2(-R_root[2, 0], R_root[0, 0]))
        Y = _yaw_matrix(yaw)
        for i in range(2):
            spot = pelvis + Y @ model.stance[i]
            spot[1] = model.ankle_height
            planted = feet[i]
            if (
                planted is None
                or np.linalg.norm((planted[0] - spot)[[0, 2]]) > STEP_M
                or abs(_wrap(planted[1] - yaw)) > STEP_YAW_RAD
            ):
                planted = (spot, yaw)
                feet[i] = planted
            foot_R = R_root.T @ _yaw_matrix(planted[1])
            sol = solve_ik(
                model.legs[i], foot_R, R_root.T @ (planted[0] - pelvis), q_leg[i], _LEG_IK
            )
            q_leg[i] = sol.q
            out[k, i] = sol.q
    return out


def _fingers(model: G1Model, pinch, measured, valid, rate: float) -> np.ndarray:
    """(M, 2 * fingers) Dex3 joints from the pinch, relaxed without a hand (step 8)."""
    out = []
    for i in range(2):
        closure = np.clip(
            (PINCH_OPEN_M - pinch[:, i].astype(float)) / (PINCH_OPEN_M - PINCH_CLOSED_M), 0.0, 1.0
        )
        closure = np.where(measured[:, i] & ~np.isnan(closure), closure, FINGER_RELAXED)
        closure = gaussian_smooth(closure, 0.05 * rate, valid)
        out.append(closure[:, None] * model.finger_closed[i])
    return np.concatenate(out, axis=1)


def _restrict(chain: Chain, limits: np.ndarray) -> None:
    """Narrow a chain's joint limits to `limits` (dof, 2), within its own."""
    chain.lower = np.maximum(chain.lower, limits[:, 0])
    chain.upper = np.minimum(chain.upper, limits[:, 1])


def _smooth_quats(q: np.ndarray, sigma: float, valid: np.ndarray) -> np.ndarray:
    out = q.copy()
    if valid.any():
        R = quat_to_matrix(np.where(valid[:, None], q, [0.0, 0.0, 0.0, 1.0]))
        out[valid] = matrix_to_quat(smooth_rotations(R, sigma, valid)[valid])
    return out


def _quat_product(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    from ..frames import quat_multiply

    return quat_multiply(np.broadcast_to(a, b.shape), b)


def _yaw_matrix(yaw: float) -> np.ndarray:
    x = np.array([np.cos(yaw), 0.0, -np.sin(yaw)])
    return np.stack([x, np.cross(_UP, x), _UP], axis=1)


def _rot_x(a: float) -> np.ndarray:
    c, s = np.cos(a), np.sin(a)
    return np.array([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]])


def _rot_y(a: float) -> np.ndarray:
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


def _wrap(a: float) -> float:
    return float((a + np.pi) % (2 * np.pi) - np.pi)


def _wrap_array(a: np.ndarray) -> np.ndarray:
    return (a + np.pi) % (2 * np.pi) - np.pi


def _round(x: float, digits: int) -> float:
    return round(float(x), digits) + 0.0


def _row(values: np.ndarray, digits: int) -> list[float]:
    return [_round(x, digits) for x in values]
