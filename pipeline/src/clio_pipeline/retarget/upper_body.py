"""The G1's pelvis, waist and both arms solved together, the hands first (body.py).

The variables are the pelvis's offset from where the trunk estimate put it (3, world), the
pelvis's pitch and roll over the hips, the waist's yaw, roll and pitch and the seven joints of
each arm with a hand to reach (22 at most); the pelvis yaw is given. The solve is prioritized
(Siciliano and Slotine's task-priority scheme, damped): each step first moves the palms onto the
measured palm points as far as the joints can, and only within the motions that leave the palms
where they are does it then also match each palm's orientation, put each elbow on its chosen
swivel (swivel.py), keep the eyes on the measured head and keep the trunk and arms near their
estimates, all by weighted least squares. So a hand that is out of the arm's reach from the
estimated trunk is reached by leaning, turning or shifting the body rather than by giving up on
it, and the head, which the G1 cannot bend away from its torso, gives way before a hand does.

Every variable stays in its range: the human ranges for the arms and waist (human.py), the
G1's hips for the pelvis tilt, and the legs' length for the pelvis's height. A variable that
would leave its range is held at the bound for the rest of the step and the others take up its
share (an active set).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .human import roll_floor
from .kinematics import Chain, cross_rows, rotation_vector
from .swivel import ArmModel, elbow_at

TRUNK = 8  # pelvis dx, dy, dz (world), pelvis pitch, pelvis roll, waist yaw, roll, pitch
ARM = 7
# The pelvis tilt over the hips: back a little, forward to a deep bow; sideways a little.
PELVIS_PITCH = (-0.25, 1.3)
PELVIS_ROLL = (-0.25, 0.25)
PELVIS_SHIFT_M = 0.5  # furthest the pelvis moves from its estimate, horizontally
MAX_STEP_POS_M = 0.08
MAX_STEP_ROT_RAD = 0.5
MAX_DX_RAD = 0.3
MAX_DX_M = 0.06
# A person at full reach leans in before locking the elbow; a straight elbow is also where a
# small change of reach turns it fast. Straighter than this (rad of G1 elbow, 17 degrees of
# flexion) costs `Weights.straight`.
ELBOW_BENT = np.pi / 2 - 0.5
_UP = np.array([0.0, 1.0, 0.0])


@dataclass(frozen=True)
class Weights:
    """Weights of the second-priority tasks, per unit of error (m or rad)."""

    orientation: float = 0.6  # palm orientation, per rad
    elbow: float = 1.5  # elbow on its swivel, per m
    eyes: float = 0.8  # the G1's eyes on the measured head, per m
    pelvis_shift: float = 3.0  # the pelvis away from its estimate, per m
    trunk: tuple[float, ...] = (1.2, 1.5, 0.8, 1.2, 0.8)  # pelvis pitch, roll, waist y, r, p
    posture: float = 0.05  # each arm joint away from the swivel model's, per rad
    straight: float = 8.0  # the elbow straighter than ELBOW_BENT, per rad (the body leans in)


@dataclass(frozen=True, eq=False)
class Targets:
    """One frame's goals, world frame (y up). An arm without a palm target is held at its q."""

    yaw: float  # pelvis yaw
    pelvis: np.ndarray  # (3,) the estimated pelvis
    trunk: np.ndarray  # (5,) estimated pelvis pitch, roll and waist yaw, roll, pitch
    pelvis_z: tuple[float, float]  # the pelvis's height range
    eyes: np.ndarray | None  # (3,)
    tcp: tuple[np.ndarray | None, np.ndarray | None]  # palm points (3,)
    R_tcp: tuple[np.ndarray | None, np.ndarray | None]  # palm frames (3, 3)
    swivel: tuple[float | None, float | None]  # rad (swivel.py)
    wrist: tuple[np.ndarray | None, np.ndarray | None]  # (3,) the wrist the elbow aims from
    q_ref: tuple[np.ndarray, np.ndarray]  # (7,) posture each arm is drawn toward
    weights: Weights = field(default_factory=Weights)


@dataclass(frozen=True, eq=False)
class Result:
    x: np.ndarray  # (22,) the trunk (8) and both arms (7 + 7)
    root: np.ndarray  # (4, 4) pelvis in world
    residual: tuple[float | None, float | None]  # palm point to its target, m
    iterations: int


class UpperBody:
    def __init__(
        self,
        waist: Chain,
        arms: tuple[Chain, Chain],
        models: tuple[ArmModel, ArmModel],
        tcp: tuple[np.ndarray, np.ndarray],
        eyes_in_torso: np.ndarray,
        waist_range: np.ndarray,
    ) -> None:
        self.waist, self.arms, self.models = waist, arms, models
        self.tcp = tcp
        self.eyes_in_torso = eyes_in_torso
        lower = np.concatenate(
            [
                [-PELVIS_SHIFT_M, -np.inf, -PELVIS_SHIFT_M, PELVIS_PITCH[0], PELVIS_ROLL[0]],
                waist_range[:, 0],
                models[0].limits[:, 0],
                models[1].limits[:, 0],
            ]
        )
        upper = np.concatenate(
            [
                [PELVIS_SHIFT_M, np.inf, PELVIS_SHIFT_M, PELVIS_PITCH[1], PELVIS_ROLL[1]],
                waist_range[:, 1],
                models[0].limits[:, 1],
                models[1].limits[:, 1],
            ]
        )
        self.lower, self.upper = lower, upper

    def root(self, x: np.ndarray, targets: Targets) -> np.ndarray:
        """(4, 4) the pelvis in world for variables x."""
        T = np.eye(4)
        T[:3, :3] = _yaw(targets.yaw) @ _rot_y(x[3]) @ _rot_x(x[4])
        T[:3, 3] = targets.pelvis + x[:3]
        return T

    def solve(self, x0: np.ndarray, targets: Targets, *, iterations: int = 20) -> Result:
        """Solve from x0 (warm start): the pelvis offset, the trunk angles and both arms."""
        x = self._bounded(np.asarray(x0, dtype=np.float64).copy(), targets)
        active = [targets.tcp[i] is not None for i in range(2)]
        free = np.ones(len(x), dtype=bool)
        for i in range(2):
            if not active[i]:
                free[TRUNK + ARM * i : TRUNK + ARM * (i + 1)] = False
        done = 0
        for step in range(1, iterations + 1):
            done = step
            pose = self._pose(x, targets)
            J1, e1, J2, e2 = self._tasks(pose, x, targets, active)
            dx = self._step(x, J1, e1, J2, e2, free, targets)
            if not np.isfinite(dx).all():
                break
            x = x + dx
            if np.max(np.abs(dx)) < 2e-4:
                break
        pose = self._pose(x, targets)
        residual = tuple(
            float(np.linalg.norm(targets.tcp[i] - pose.arms[i].tcp)) if active[i] else None
            for i in range(2)
        )
        return Result(x=x, root=self.root(x, targets), residual=residual, iterations=done)  # type: ignore[arg-type]

    # Kinematics.

    def _pose(self, x: np.ndarray, targets: Targets) -> _Pose:
        Y = _yaw(targets.yaw)
        Ry = _rot_y(x[3])
        R_p = Y @ Ry @ _rot_x(x[4])
        P = targets.pelvis + x[:3]
        w = self.waist.forward(x[5:8])
        R_T, p_T = R_p @ w.R, P + R_p @ w.p
        axes = [Y[:, 1], (Y @ Ry)[:, 0], *(w.axes @ R_p.T)]
        origins = [P, P, *(P + w.origins @ R_p.T)]
        arms = []
        for i in range(2):
            s = self.arms[i].forward(x[TRUNK + ARM * i : TRUNK + ARM * (i + 1)])
            R = R_T @ s.R
            arms.append(
                _ArmPose(
                    axes=s.axes @ R_T.T,
                    origins=p_T + s.origins @ R_T.T,
                    R=R,
                    tcp=p_T + R_T @ s.p + R @ self.tcp[i],
                )
            )
        return _Pose(
            trunk_axes=np.array(axes),
            trunk_origins=np.array(origins),
            R_T=R_T,
            p_T=p_T,
            eyes=p_T + R_T @ self.eyes_in_torso,
            arms=arms,
        )

    def _tasks(self, pose: _Pose, x: np.ndarray, targets: Targets, active: list[bool]):
        n = len(x)
        wt = targets.weights
        rows1, err1, rows2, err2 = [], [], [], []

        def point_jacobian(point: np.ndarray, arm: int | None, upto: int = ARM) -> np.ndarray:
            J = np.zeros((3, n))
            J[:, :3] = np.eye(3)
            J[:, 3:TRUNK] = cross_rows(pose.trunk_axes, point - pose.trunk_origins).T
            if arm is not None:
                a = pose.arms[arm]
                cols = slice(TRUNK + ARM * arm, TRUNK + ARM * arm + upto)
                J[:, cols] = cross_rows(a.axes[:upto], point - a.origins[:upto]).T
            return J

        for i in range(2):
            if not active[i]:
                continue
            a = pose.arms[i]
            tcp_t = targets.tcp[i]
            e = tcp_t - a.tcp
            norm = float(np.linalg.norm(e))
            rows1.append(point_jacobian(a.tcp, i))
            err1.append(e * min(1.0, MAX_STEP_POS_M / norm) if norm > 0 else e)

            R_t = targets.R_tcp[i]
            if R_t is not None:
                J = np.zeros((3, n))
                J[:, 3:TRUNK] = pose.trunk_axes.T
                J[:, TRUNK + ARM * i : TRUNK + ARM * (i + 1)] = a.axes.T
                e_rot = rotation_vector(R_t @ a.R.T)
                angle = float(np.linalg.norm(e_rot))
                if angle > MAX_STEP_ROT_RAD:
                    e_rot *= MAX_STEP_ROT_RAD / angle
                rows2.append(wt.orientation * J)
                err2.append(wt.orientation * e_rot)

            phi = targets.swivel[i]
            if phi is not None and R_t is not None:
                model = self.models[i]
                S = pose.R_T.T @ (a.origins[1] - pose.p_T)
                wrist = targets.wrist[i]
                if wrist is None:
                    wrist = tcp_t + R_t @ model.wrist_in_tcp
                W = pose.R_T.T @ (wrist - pose.p_T)
                E_t = pose.p_T + pose.R_T @ elbow_at(model, S, W, phi)
                elbow = a.origins[3]
                e = E_t - elbow
                norm = float(np.linalg.norm(e))
                if norm > MAX_STEP_POS_M:
                    e *= MAX_STEP_POS_M / norm
                rows2.append(wt.elbow * point_jacobian(elbow, i, upto=3))
                err2.append(wt.elbow * e)

        if targets.eyes is not None:
            rows2.append(wt.eyes * point_jacobian(pose.eyes, None))
            err2.append(wt.eyes * (targets.eyes - pose.eyes))

        # Stay near the estimates: the pelvis's offset toward zero, the trunk toward its estimate,
        # each active arm toward its reference posture.
        cols = list(range(TRUNK))
        weight = [wt.pelvis_shift] * 3 + list(wt.trunk)
        goal = [0.0, 0.0, 0.0, *targets.trunk]
        for i in range(2):
            if active[i]:
                cols += list(range(TRUNK + ARM * i, TRUNK + ARM * (i + 1)))
                weight += [wt.posture] * ARM
                goal += list(targets.q_ref[i])
        for i in range(2):
            col = TRUNK + ARM * i + 3
            if active[i] and x[col] > ELBOW_BENT:
                cols.append(col)
                weight.append(wt.straight)
                goal.append(ELBOW_BENT)
        weight_v = np.array(weight)
        prior = np.zeros((len(cols), n))
        prior[np.arange(len(cols)), cols] = weight_v
        rows2.append(prior)
        err2.append(weight_v * (np.array(goal) - x[cols]))

        J1 = np.concatenate(rows1) if rows1 else np.zeros((0, n))
        e1 = np.concatenate(err1) if err1 else np.zeros(0)
        return J1, e1, np.concatenate(rows2), np.concatenate(err2)

    def _step(self, x, J1, e1, J2, e2, free, targets: Targets) -> np.ndarray:
        lower, upper = self._bounds(x, targets)
        dx = np.zeros_like(x)
        free = free.copy()
        held = np.zeros_like(x)
        for _ in range(4):
            f = free
            r1 = e1 - J1[:, ~f] @ held[~f] if len(e1) else e1
            r2 = e2 - J2[:, ~f] @ held[~f]
            step = _prioritized(J1[:, f], r1, J2[:, f], r2)
            dx = held.copy()
            dx[f] = step
            dx = _limit(dx)
            target = x + dx
            hit = f & ((target < lower - 1e-12) | (target > upper + 1e-12))
            if not hit.any():
                break
            held[hit] = np.clip(target[hit], lower[hit], upper[hit]) - x[hit]
            free = free & ~hit
        return np.clip(x + dx, lower, upper) - x

    def _bounds(self, x: np.ndarray, targets: Targets) -> tuple[np.ndarray, np.ndarray]:
        lower, upper = self.lower.copy(), self.upper.copy()
        lower[1] = targets.pelvis_z[0] - targets.pelvis[1]
        upper[1] = targets.pelvis_z[1] - targets.pelvis[1]
        for i in range(2):
            roll = TRUNK + ARM * i + 1
            floor = float(roll_floor(x[TRUNK + ARM * i], i))
            if i == 0:
                lower[roll] = max(lower[roll], floor)
            else:
                upper[roll] = min(upper[roll], floor)
        return lower, upper

    def _bounded(self, x: np.ndarray, targets: Targets) -> np.ndarray:
        lower, upper = self._bounds(x, targets)
        return np.clip(x, lower, upper)


@dataclass(frozen=True, eq=False)
class _ArmPose:
    axes: np.ndarray  # (7, 3) world
    origins: np.ndarray  # (7, 3) world
    R: np.ndarray  # palm link orientation, world
    tcp: np.ndarray  # palm point, world


@dataclass(frozen=True, eq=False)
class _Pose:
    trunk_axes: np.ndarray  # (5, 3) pelvis pitch, roll, waist yaw, roll, pitch
    trunk_origins: np.ndarray  # (5, 3)
    R_T: np.ndarray
    p_T: np.ndarray
    eyes: np.ndarray
    arms: list[_ArmPose]


def _prioritized(J1, e1, J2, e2, damping1: float = 1e-3, damping2: float = 1e-2) -> np.ndarray:
    # Apple's Accelerate BLAS raises spurious floating point flags on some small products; the
    # results are finite (solve() checks), so the flags are not turned into warnings here.
    with np.errstate(divide="ignore", over="ignore", invalid="ignore"):
        return _prioritized_step(J1, e1, J2, e2, damping1, damping2)


def _prioritized_step(J1, e1, J2, e2, damping1: float, damping2: float) -> np.ndarray:
    n = J2.shape[1]
    if len(e1):
        sigma = np.linalg.svd(J1, compute_uv=False)
        lam2 = damping1**2 + (0.0 if sigma[-1] > 0.05 else (0.05 - sigma[-1]) ** 2)
        A = J1 @ J1.T + lam2 * np.eye(len(e1))
        J1_pinv = J1.T @ np.linalg.inv(A)
        dq1 = J1_pinv @ e1
        N1 = np.eye(n) - J1_pinv @ J1
    else:
        dq1, N1 = np.zeros(n), np.eye(n)
    J2N = J2 @ N1
    H = J2N.T @ J2N
    H[np.diag_indices_from(H)] += damping2**2
    z = np.linalg.solve(H, J2N.T @ (e2 - J2 @ dq1))
    return dq1 + N1 @ z


def _limit(dx: np.ndarray) -> np.ndarray:
    scale = 1.0
    shift = float(np.max(np.abs(dx[:3])))
    if shift > MAX_DX_M:
        scale = MAX_DX_M / shift
    turn = float(np.max(np.abs(dx[3:])))
    if turn * scale > MAX_DX_RAD:
        scale = MAX_DX_RAD / turn
    return dx * scale


def _yaw(yaw: float) -> np.ndarray:
    """The robot's axes (x forward, y left, z up) in world (y up) at body yaw `yaw`."""
    x = np.array([np.cos(yaw), 0.0, -np.sin(yaw)])
    return np.stack([x, np.cross(_UP, x), _UP], axis=1)


def _rot_x(a: float) -> np.ndarray:
    c, s = np.cos(a), np.sin(a)
    return np.array([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]])


def _rot_y(a: float) -> np.ndarray:
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])
