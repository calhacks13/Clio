"""Retarget an episode's hands onto the profile's robot arms, one grid frame at a time.

The grid is the compiled tracks grid (`resample_episode(episode, fps).t`). For each arm, the
driving hand's tool target is built in W (the hand point with the wrist orientation, the tcp
offset and tool alignment, then the workspace scale), moved into the arm's base frame and solved
by damped least squares, warm-started from the previous frame. The first frame of every run of
targets (the start, and after the hand was untracked) tries several seeds and keeps the solution
closest to the last one before the gap (or the rest pose). When the warm start misses, the seeds
are tried again (at most every RETRY_EVERY frames), and a configuration that does reach the
target replaces it: the jump stays visible in q. Frames without a tracked hand get no target: NaN
joints and `reachable` False. That includes grid times inside a gap between recorded frames longer
than MAX_FRAME_GAP_MS, where the hands are not interpolated. Everything returned is in W.

The robot trajectory is derived, not measured: it is what this profile's robot would have to do to
follow the hand, with the residual it could not remove.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..episode import Episode
from ..frames import (
    HANDS,
    INDEX_TIP,
    JOINT_INDEX,
    THUMB_TIP,
    WRIST,
    make_quaternions_continuous,
    quat_multiply,
    quat_rotate,
)
from ..resample import MAX_FRAME_GAP_MS, Resampled, resample_episode
from .ik import restart_seeds, solve_ik, solve_ik_restarts
from .kinematics import matrix_to_quat, quat_to_matrix
from .profile import ArmProfile, RetargetProfile

DERIVED_SCHEMA_ID = "clio.derived/1"
GRASP_FEATURE = "object.grasp"
RESTART_SEEDS = 8  # random seeds tried, besides the reference and the rest pose
RETRY_EVERY = 10  # frames between restart attempts while the warm start keeps failing
MIDDLE_PROXIMAL = JOINT_INDEX["middle-finger-phalanx-proximal"]


@dataclass(eq=False)
class ArmTrajectory:
    """One arm on the grid (M frames). NaN where the driving hand gave no target."""

    hand: str
    joints: tuple[str, ...]  # actuated URDF joints, the order of q
    base_in_workspace: np.ndarray  # (7,) W
    q: np.ndarray  # (M, J) rad, or m for prismatic joints
    gripper: np.ndarray  # (M,) 0 open .. 1 closed; NaN where the hand is untracked
    target: np.ndarray  # (M, 7) tool target, W
    achieved: np.ndarray  # (M, 7) tool pose the solution reaches, W
    residual_pos: np.ndarray  # (M,) m
    residual_rot: np.ndarray  # (M,) rad (see clio_pipeline.retarget.ik)
    reachable: np.ndarray  # (M,) bool: solved within the profile tolerances
    links: np.ndarray  # (M, P, 3) joint origins from the base to the tool, W

    @property
    def has_target(self) -> np.ndarray:
        return ~np.isnan(self.q).any(axis=1)


@dataclass(frozen=True)
class RetargetSummary:
    reachable_fraction: float  # of the arm frames that had a target
    target_fraction: float  # of all arm frames
    mean_residual_pos: float | None  # m, over the arm frames that had a target


@dataclass(eq=False)
class Retargeted:
    profile: RetargetProfile
    fps: int
    t: np.ndarray  # (M,) the compiled tracks grid, ms
    arms: list[ArmTrajectory]

    def __len__(self) -> int:
        return len(self.t)

    @property
    def summary(self) -> RetargetSummary:
        frames = len(self.t) * len(self.arms)
        targets = sum(int(arm.has_target.sum()) for arm in self.arms)
        reachable = sum(int(arm.reachable.sum()) for arm in self.arms)
        residuals = np.concatenate([arm.residual_pos[arm.has_target] for arm in self.arms])
        return RetargetSummary(
            reachable_fraction=reachable / targets if targets else 0.0,
            target_fraction=targets / frames if frames else 0.0,
            mean_residual_pos=float(residuals.mean()) if len(residuals) else None,
        )


def retarget_episode(
    episode: Episode,
    profile: RetargetProfile,
    *,
    fps: int = 30,
    resampled: Resampled | None = None,
) -> Retargeted:
    """Solve every grid frame for every arm of `profile`. Pass `resampled` (from
    `resample_episode(episode, fps, max_gap_ms=MAX_FRAME_GAP_MS)`) to reuse a resampling already
    done; its hand masks decide which frames get a target."""
    if fps <= 0 or int(fps) != fps:
        raise ValueError(f"fps must be a positive integer, got {fps}")
    if resampled is None:
        resampled = resample_episode(episode, fps=fps, max_gap_ms=MAX_FRAME_GAP_MS)
    r = resampled
    if r.fps != float(fps):
        raise ValueError(f"resampled at {r.fps} fps, asked for {fps}")
    holding = _holding(episode, r.t)
    arms = []
    for arm in profile.arms:
        h = HANDS.index(arm.hand)
        target = tool_targets(r.hands[:, h], profile)
        target[~r.tracked[:, h]] = np.nan
        gripper = _gripper(r.pinch[:, h], holding[:, h], profile)
        arms.append(_solve_arm(arm, profile, target, gripper))
    return Retargeted(profile=profile, fps=int(fps), t=r.t, arms=arms)


def tool_targets(hand: np.ndarray, profile: RetargetProfile) -> np.ndarray:
    """(M, 7) tool targets in W from one hand's resampled joints (M, 25, 8): the profile's hand
    point with the wrist orientation, offset by `wristToTcp` (wrist axes), turned by `toolAlign`,
    then scaled about the workspace pivot. NaN where the hand is NaN."""
    joints = hand.astype(np.float64)
    if profile.tcp_target == "wrist":
        point = joints[:, WRIST, :3]
    elif profile.tcp_target == "pinch_point":
        point = 0.5 * (joints[:, THUMB_TIP, :3] + joints[:, INDEX_TIP, :3])
    else:  # palm
        point = 0.5 * (joints[:, WRIST, :3] + joints[:, MIDDLE_PROXIMAL, :3])
    wrist_q = joints[:, WRIST, 3:7]
    with np.errstate(invalid="ignore", divide="ignore"):
        wrist_q = wrist_q / np.linalg.norm(wrist_q, axis=-1, keepdims=True)
    offset = profile.wrist_to_tcp
    position = point + quat_rotate(wrist_q, offset[:3])
    orientation = quat_multiply(quat_multiply(wrist_q, offset[3:]), profile.tool_align)
    pivot = profile.workspace_pivot
    position = pivot + profile.workspace_scale * (position - pivot)
    return np.concatenate([position, orientation], axis=-1)


def gripper_closure(pinch: np.ndarray, profile: RetargetProfile) -> np.ndarray:
    """0 (open) at `pinchOpenM` to 1 (closed) at `pinchClosedM`, clamped; NaN stays NaN."""
    span = profile.pinch_open_m - profile.pinch_closed_m
    with np.errstate(invalid="ignore"):
        return np.clip((profile.pinch_open_m - pinch.astype(np.float64)) / span, 0.0, 1.0)


def _gripper(pinch: np.ndarray, holding: np.ndarray, profile: RetargetProfile) -> np.ndarray:
    gripper = gripper_closure(pinch, profile)
    gripper[holding & ~np.isnan(gripper)] = 1.0
    return gripper


def _holding(episode: Episode, t: np.ndarray) -> np.ndarray:
    """(M, 2) whether each hand holds an object at each time, from object.grasped and
    object.released events. All False for episodes that do not record grasps."""
    out = np.zeros((len(t), 2), dtype=bool)
    if GRASP_FEATURE not in (episode.meta.get("features") or []):
        return out
    held: list[set[str]] = [set(), set()]
    changes: list[list[tuple[float, bool]]] = [[], []]
    for event in episode.events_of("object.grasped", "object.released"):
        h = HANDS.index(event["hand"])
        if event["type"] == "object.grasped":
            held[h].add(event["objectId"])
        else:
            held[h].discard(event["objectId"])
        changes[h].append((float(event["t"]), bool(held[h])))
    for h in range(2):
        if not changes[h]:
            continue
        times = np.array([c[0] for c in changes[h]])
        state = np.array([c[1] for c in changes[h]])
        idx = np.searchsorted(times, t, side="right") - 1
        out[:, h] = (idx >= 0) & state[np.maximum(idx, 0)]
    return out


def _solve_arm(
    arm: ArmProfile, profile: RetargetProfile, target: np.ndarray, gripper: np.ndarray
) -> ArmTrajectory:
    chain, settings = arm.chain, profile.ik
    m, dof = len(target), chain.dof
    base = arm.base_in_workspace
    base_R, base_p = quat_to_matrix(base[3:]), base[:3]
    has = ~np.isnan(target).any(axis=1)
    # Targets in the base frame: p_B = R^T (p_W - p_b), R_B = R^T R_W. (einsum, not @: Apple's
    # BLAS raises spurious floating point warnings for large matmuls.)
    target_p = np.einsum("ji,mj->mi", base_R, target[:, :3] - base_p)
    target_R = np.einsum("ji,mjk->mik", base_R, quat_to_matrix(target[:, 3:]))

    q = np.full((m, dof), np.nan)
    achieved_R = np.full((m, 3, 3), np.nan)
    achieved_p = np.full((m, 3), np.nan)
    residual_pos = np.full(m, np.nan)
    residual_rot = np.full(m, np.nan)
    reachable = np.zeros(m, dtype=bool)
    links = np.full((m, len(chain.points(arm.rest_pose)), 3), np.nan)
    seeds = restart_seeds(chain, RESTART_SEEDS)
    last: np.ndarray | None = None  # the latest solution, across gaps
    last_retry = -RETRY_EVERY
    for k in np.flatnonzero(has):
        if k > 0 and has[k - 1] and last is not None:
            solution = solve_ik(chain, target_R[k], target_p[k], last, settings)
            if not solution.converged and k - last_retry >= RETRY_EVERY:
                # The warm start can be caught against a joint limit or in a poor configuration.
                last_retry = k
                retry = solve_ik_restarts(
                    chain, target_R[k], target_p[k], [arm.rest_pose, *seeds], settings, last
                )
                if retry.converged:
                    solution = retry
        else:
            reference = arm.rest_pose if last is None else last
            candidates = [reference, *([] if last is None else [arm.rest_pose]), *seeds]
            solution = solve_ik_restarts(
                chain, target_R[k], target_p[k], candidates, settings, reference
            )
        last = solution.q
        q[k] = solution.q
        achieved_R[k] = base_R @ solution.R
        achieved_p[k] = base_R @ solution.p + base_p
        residual_pos[k] = solution.residual_pos
        residual_rot[k] = solution.residual_rot
        reachable[k] = solution.converged
        links[k] = chain.points(solution.q) @ base_R.T + base_p

    achieved_q = np.full((m, 4), np.nan)
    if has.any():
        achieved_q[has] = matrix_to_quat(achieved_R[has])
    target_out = target.copy()
    target_out[:, 3:] = make_quaternions_continuous(target[:, 3:])
    return ArmTrajectory(
        hand=arm.hand,
        joints=chain.joint_names,
        base_in_workspace=base,
        q=q,
        gripper=gripper,
        target=target_out,
        achieved=np.concatenate([achieved_p, make_quaternions_continuous(achieved_q)], axis=1),
        residual_pos=residual_pos,
        residual_rot=residual_rot,
        reachable=reachable,
        links=links,
    )


def retarget_doc(result: Retargeted, episode: Episode) -> dict:
    """The JSON-ready `RetargetDoc` (clio.derived/1, packages/protocol/src/derived.ts): null for
    no value, never NaN. Joint values are rounded to 5 decimals, positions, quaternions,
    residuals and the gripper to 4, times to 2."""
    profile = result.profile
    summary = result.summary
    return {
        "schema": DERIVED_SCHEMA_ID,
        "episodeId": episode.episode_id,
        "frame": "workspace",
        "fps": result.fps,
        "t": [_round(x, 2) for x in result.t],
        "kind": "retarget",
        "profile": {
            "id": profile.id,
            "version": profile.version,
            "robot": profile.name,
            "robotType": profile.robot_type,
            "urdfSha256": profile.urdf_sha256,
            "example": profile.example,
            "orientationMode": profile.ik.mode,
            "tolPosM": profile.ik.tol_pos_m,
            "tolRotRad": profile.ik.tol_rot_rad,
        },
        "arms": [_arm_doc(arm) for arm in result.arms],
        "summary": {
            "reachableFraction": _round(summary.reachable_fraction, 4),
            "targetFraction": _round(summary.target_fraction, 4),
            "meanResidualPosM": None
            if summary.mean_residual_pos is None
            else _round(summary.mean_residual_pos, 5),
        },
    }


def _arm_doc(arm: ArmTrajectory) -> dict:
    return {
        "hand": arm.hand,
        "joints": list(arm.joints),
        "q": _rows(arm.q, 5),
        "gripper": _values(arm.gripper, 4),
        "target": _rows(arm.target, 4),
        "achieved": _rows(arm.achieved, 4),
        "residualPosM": _values(arm.residual_pos, 4),
        "residualRotRad": _values(arm.residual_rot, 4),
        "reachable": [bool(x) for x in arm.reachable],
        "links": [
            None if np.isnan(points).any() else [[_round(c, 4) for c in p] for p in points]
            for points in arm.links
        ],
        "baseInWorkspace": [_round(c, 4) for c in arm.base_in_workspace],
    }


def _round(x: float, digits: int) -> float:
    return round(float(x), digits) + 0.0  # + 0.0 turns -0.0 into 0.0


def _values(values: np.ndarray, digits: int) -> list[float | None]:
    return [None if np.isnan(x) else _round(x, digits) for x in values]


def _rows(rows: np.ndarray, digits: int) -> list[list[float] | None]:
    return [None if np.isnan(row).any() else [_round(x, digits) for x in row] for row in rows]
