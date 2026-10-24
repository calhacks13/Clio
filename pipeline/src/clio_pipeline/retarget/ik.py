"""Inverse kinematics by weighted damped least squares on one chain.

Each iteration takes the step

    dq = (J^T W J + lambda^2 I)^-1 J^T W e

where e stacks the position error (m) and the orientation error (rad) the mode asks for, and W
weighs one radian like `rot_weight` meters. The damping adapts: it grows when a step would make
the error larger (the step is retried) and near a singularity, and shrinks again after good steps
(down to a tenth of the configured damping). Joints are clamped to their limits after every step;
a joint that runs into a limit is held there while the others take up the rest of the step.

Orientation modes:

- `full`: match the whole tool orientation.
- `approach_axis`: only align `approach_axis` (a tool-frame axis); rolling about it is free.
- `position_only`: ignore orientation.

The solver never forces a match: it stops at the iteration limit or when progress stalls, and
reports the residual it reached. `converged` means within both tolerances (position only, for
`position_only`). The rotation residual is the angle the mode solves for: the whole rotation for
`full`, the angle between the approach axes for `approach_axis`; `position_only` reports the whole
rotation for information.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np

from .kinematics import Chain, cross3, norm3, rotation_angle, rotation_vector

ORIENTATION_MODES = ("full", "approach_axis", "position_only")

# Per-iteration limits that keep each step inside the region where the linearization holds.
MAX_STEP_POS_M = 0.08  # position error used for one step
MAX_STEP_ROT_RAD = 0.5  # orientation error used for one step
MAX_DQ = 0.35  # largest joint change per iteration (rad, or m for prismatic joints)
# Singularity damping: below this smallest singular value of the weighted Jacobian, add up to
# SINGULAR_DAMPING^2 to lambda^2 (Nakamura and Hanafusa's variable damping).
SINGULAR_SIGMA = 0.02
SINGULAR_DAMPING = 0.03
MAX_DAMPING = 10.0  # beyond this the solver is stuck; stop
STALL_RATIO = 1e-4  # an accepted step that improves the error by less than this is a stall
# Keep going until this fraction of the tolerances, so a warm-started trajectory does not ride the
# tolerance edge from frame to frame (and fall off it).
AIM = 0.2


@dataclass(frozen=True, eq=False)
class IkSettings:
    mode: str = "full"
    rot_weight: float = 0.2  # meters of position error worth one radian of orientation error
    approach_axis: np.ndarray = field(default_factory=lambda: np.array([0.0, 0.0, 1.0]))
    damping: float = 0.02
    max_iterations: int = 60
    tol_pos_m: float = 0.005
    tol_rot_rad: float = 0.05

    def __post_init__(self) -> None:
        if self.mode not in ORIENTATION_MODES:
            raise ValueError(f"orientation mode must be one of {ORIENTATION_MODES}: {self.mode!r}")


@dataclass(frozen=True, eq=False)
class IkSolution:
    q: np.ndarray  # (dof,) within the joint limits
    R: np.ndarray  # (3, 3) tool orientation reached, base frame
    p: np.ndarray  # (3,) tool position reached, base frame
    residual_pos: float  # m
    residual_rot: float  # rad (see the module docstring)
    converged: bool
    iterations: int


def solve_ik(
    chain: Chain,
    target_R: np.ndarray,
    target_p: np.ndarray,
    q0: np.ndarray,
    settings: IkSettings,
) -> IkSolution:
    """Solve from `q0` (warm start)."""
    q = chain.clamp(np.asarray(q0, dtype=np.float64))
    task = _Task(chain, target_R, target_p, settings)
    current = task.evaluate(q)
    lam = settings.damping
    iterations = 0
    stalls = 0
    while iterations < settings.max_iterations and not current.within(AIM):
        iterations += 1
        dq = _step(chain, q, current, lam)
        candidate_q = q + dq
        candidate = task.evaluate(candidate_q)
        if candidate.cost < current.cost:
            gain = (current.cost - candidate.cost) / max(current.cost, 1e-12)
            q, current = candidate_q, candidate
            lam = max(lam * 0.5, settings.damping * 0.1)
            stalls = stalls + 1 if gain < STALL_RATIO else 0
            if stalls >= 2:
                break
        else:
            lam *= 4.0
            if lam > MAX_DAMPING:
                break
    return IkSolution(
        q=q,
        R=current.R,
        p=current.p,
        residual_pos=current.pos_err,
        residual_rot=current.rot_err,
        converged=current.within(1.0),
        iterations=iterations,
    )


def solve_ik_restarts(
    chain: Chain,
    target_R: np.ndarray,
    target_p: np.ndarray,
    seeds: Sequence[np.ndarray],
    settings: IkSettings,
    reference: np.ndarray,
) -> IkSolution:
    """Solve from every seed. Of the solutions within tolerance, keep the one closest to
    `reference` (joint space); if none is, keep the one with the smallest error."""
    best: IkSolution | None = None
    best_key: tuple[float, float] | None = None
    task = _Task(chain, target_R, target_p, settings)
    for seed in seeds:
        solution = solve_ik(chain, target_R, target_p, seed, settings)
        if solution.converged:
            key = (0.0, float(np.sum((solution.q - reference) ** 2)))
        else:
            key = (1.0, task.evaluate(solution.q).cost)
        if best_key is None or key < best_key:
            best, best_key = solution, key
    assert best is not None, "solve_ik_restarts needs at least one seed"
    return best


def restart_seeds(chain: Chain, count: int, seed: int = 0) -> list[np.ndarray]:
    """`count` deterministic configurations spread over the joint limits (+-pi for unlimited
    joints)."""
    lower = np.where(np.isfinite(chain.lower), chain.lower, -np.pi)
    upper = np.where(np.isfinite(chain.upper), chain.upper, np.pi)
    rng = np.random.default_rng(seed)
    return [lower + (upper - lower) * rng.random(chain.dof) for _ in range(count)]


@dataclass(frozen=True, eq=False)
class _Evaluation:
    R: np.ndarray
    p: np.ndarray
    J: np.ndarray  # (k, dof) weighted task Jacobian
    e: np.ndarray  # (k,) weighted task error, clamped for one step
    cost: float  # unclamped weighted squared error
    pos_err: float
    rot_err: float
    tol_pos: float
    tol_rot: float | None  # None when orientation is not part of the task

    def within(self, fraction: float) -> bool:
        """Within `fraction` of both tolerances."""
        return self.pos_err <= fraction * self.tol_pos and (
            self.tol_rot is None or self.rot_err <= fraction * self.tol_rot
        )


class _Task:
    def __init__(self, chain: Chain, target_R, target_p, settings: IkSettings) -> None:
        self.chain = chain
        self.R_t = np.asarray(target_R, dtype=np.float64)
        self.p_t = np.asarray(target_p, dtype=np.float64)
        self.s = settings
        axis = np.asarray(settings.approach_axis, dtype=np.float64)
        self.axis = axis / np.linalg.norm(axis)
        self.axis_t = self.R_t @ self.axis

    def evaluate(self, q: np.ndarray) -> _Evaluation:
        s = self.s
        state = self.chain.forward(q)
        J = self.chain.jacobian(state)
        e_pos = self.p_t - state.p
        pos_err = norm3(e_pos)
        step_pos = e_pos * min(1.0, MAX_STEP_POS_M / pos_err) if pos_err > 0 else e_pos
        w = s.rot_weight

        if s.mode == "full":
            e_rot = rotation_vector(self.R_t @ state.R.T)
            rot_err = norm3(e_rot)
            J_rot, e_rot_task = J[3:], e_rot
        elif s.mode == "approach_axis":
            a = state.R @ self.axis
            cross = cross3(a, self.axis_t)
            sin, cos = norm3(cross), float(a @ self.axis_t)
            rot_err = math.atan2(sin, cos)
            if sin > 1e-9:
                e_rot = cross * (rot_err / sin)
            else:  # aligned, or exactly opposite: turn about any axis normal to a
                e_rot = _normal(a) * rot_err
            b1 = _normal(a)
            basis = np.stack([b1, cross3(a, b1)])  # (2, 3) spans the directions that tilt a
            J_rot, e_rot_task = basis @ J[3:], basis @ e_rot
        else:  # reported, not solved for
            rot_err = rotation_angle(self.R_t @ state.R.T)
            J_rot, e_rot_task = J[:0], np.zeros(0)
        solved_rot = s.mode != "position_only"

        rot_norm = math.sqrt(float(e_rot_task @ e_rot_task))
        if rot_norm > MAX_STEP_ROT_RAD:
            e_rot_task = e_rot_task * (MAX_STEP_ROT_RAD / rot_norm)
        return _Evaluation(
            R=state.R,
            p=state.p,
            J=np.concatenate([J[:3], w * J_rot]),
            e=np.concatenate([step_pos, w * e_rot_task]),
            cost=pos_err**2 + ((w * rot_err) ** 2 if solved_rot else 0.0),
            pos_err=pos_err,
            rot_err=rot_err,
            tol_pos=s.tol_pos_m,
            tol_rot=s.tol_rot_rad if solved_rot else None,
        )


def _step(chain: Chain, q: np.ndarray, ev: _Evaluation, lam: float) -> np.ndarray:
    J, e = ev.J, ev.e
    sigma_min = np.linalg.svd(J, compute_uv=False)[-1]
    lam2 = lam**2
    if sigma_min < SINGULAR_SIGMA:
        lam2 += (1.0 - (sigma_min / SINGULAR_SIGMA) ** 2) * SINGULAR_DAMPING**2
    dq = _dls(J, e, lam2)
    dq = _limit(dq)
    target = q + dq
    hit = (target < chain.lower) | (target > chain.upper)
    if hit.any():
        # Move the joints that hit a limit onto it, and give the rest of the error to the others.
        dq_hit = np.clip(target, chain.lower, chain.upper)[hit] - q[hit]
        free = ~hit
        dq = np.zeros_like(dq)
        dq[hit] = dq_hit
        if free.any():
            dq[free] = _limit(_dls(J[:, free], e - J[:, hit] @ dq_hit, lam2))
    return chain.clamp(q + dq) - q


def _dls(J: np.ndarray, e: np.ndarray, lam2: float) -> np.ndarray:
    A = J.T @ J
    A[np.diag_indices_from(A)] += lam2
    return np.linalg.solve(A, J.T @ e)


def _limit(dq: np.ndarray) -> np.ndarray:
    largest = float(np.max(np.abs(dq))) if len(dq) else 0.0
    return dq * (MAX_DQ / largest) if largest > MAX_DQ else dq


def _normal(a: np.ndarray) -> np.ndarray:
    """A unit vector normal to unit vector a."""
    other = np.array([1.0, 0.0, 0.0]) if abs(a[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    n = cross3(a, other)
    return n / norm3(n)
