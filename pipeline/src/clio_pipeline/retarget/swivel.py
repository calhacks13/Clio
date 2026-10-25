"""Where the elbow goes: the one thing about an arm the hand does not decide (body.py).

With the shoulder fixed and the hand's position and orientation measured, a 7-joint arm has one
freedom left: the elbow can swing around the line from the shoulder to the wrist (its swivel).
A position-only solve leaves that freedom, and the wrist's two, to wherever the iterations
happen to drift, which is how the arm ended up flailing. A person picks the swivel without
thinking, and predictably: the wrist stays near neutral (its ranges are small, so the hand's
orientation all but sets the forearm's roll and the elbow with it), the elbow hangs as low as
that allows (holding it up costs effort), joints stay inside their ranges, and the elbow never
passes through the torso. And the elbow moves smoothly: it does not jump to another solution
because that one became slightly better.

So, per arm, each frame's swivel is scored on a grid of SWIVEL_STEPS candidates with a simple
model of the G1 arm (spherical shoulder, hinge elbow, spherical wrist, from the URDF's lengths):
for each candidate the model's joint angles follow in closed form (shoulder Y-X-Z and wrist
X-Y-Z Euler angles about the G1's own axes), and the score is the human comfort cost plus
penalties for leaving the human ranges (human.py), for the elbow's height above its lowest
possible and for the elbow inside the torso. The path through the grid that minimizes the
scores plus a cost on every change between frames is found by dynamic programming (Viterbi),
over each run of frames with a hand, then smoothed. body.py's solver follows the chosen elbow
and starts from the model's joint angles.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .human import comfort_cost, range_excess
from .kinematics import Chain
from .motion import runs, smooth_angle

SWIVEL_STEPS = 48  # 7.5 degrees apart
LIMIT_WEIGHT = 1000.0  # per rad^2 outside the human range: 0.1 rad costs 10
GRAVITY_WEIGHT = 1.5  # the elbow at its highest instead of its lowest
TORSO_WEIGHT = 2000.0  # per m^2 of the elbow inside the torso
CHANGE_WEIGHT = 80.0  # per rad^2 of swivel change between frames
# Per frame, a candidate costs at most this much more than the frame's best (smoothly): where no
# elbow fits the measured hand (an occluded hand, a misread orientation), the candidates' large
# differences say little, and must not make the elbow jump.
COST_SPREAD = 12.0
# And a frame whose best candidate costs more than FIT (its hand fits no elbow well) counts for
# FIT / best of a frame, down to a tenth.
FIT = 8.0
SWIVEL_SMOOTHING = 1.5  # frames (sigma) after the grid search
# The torso, in its own frame, that the elbow keeps out of: half depth and half width.
TORSO_HALF = np.array([0.10, 0.11])
TORSO_Z = (-0.25, 0.30)
# The swivel is measured from this direction (torso frame, down and a little back), projected
# off the shoulder-wrist line; positive swings the elbow out for either arm.
SWIVEL_REFERENCE = np.array([-0.4, 0.0, -1.0]) / np.hypot(0.4, 1.0)


@dataclass(frozen=True, eq=False)
class ArmModel:
    side: int  # 0 left, 1 right
    shoulder: np.ndarray  # (3,) the shoulder (roll joint origin), torso frame, arm at zero
    upper: float  # shoulder to elbow, m
    fore: float  # elbow to wrist (the wrist pitch joint), m
    wrist_in_tcp: np.ndarray  # (3,) the wrist from the palm point, palm frame, wrist straight
    pitch_origin: np.ndarray  # (3, 3) the shoulder pitch joint's fixed rotation
    roll_offset: float  # the roll joint's fixed rotation about x (undoes the pitch frame's tilt)
    elbow_offset: float  # the model's elbow angle with the G1's at zero (the links' offsets)
    limits: np.ndarray  # (7, 2) the human ranges

    @classmethod
    def of(cls, chain: Chain, side: int, tcp: np.ndarray, limits: np.ndarray, urdf) -> ArmModel:
        state = chain.forward(np.zeros(chain.dof))
        origins = state.origins
        pitch, roll = (urdf.joints[name] for name in chain.joint_names[:2])
        r = roll.origin[:3, :3]
        u = _unit(origins[3] - origins[1])
        f = _unit(origins[5] - origins[3])
        along = float(f @ u)
        return cls(
            side=side,
            shoulder=origins[1],
            upper=float(np.linalg.norm(origins[3] - origins[1])),
            fore=float(np.linalg.norm(origins[5] - origins[3])),
            wrist_in_tcp=origins[5] - (state.p + state.R @ tcp),
            pitch_origin=pitch.origin[:3, :3],
            roll_offset=float(np.arctan2(r[2, 1], r[1, 1])),
            elbow_offset=float(np.arctan2(along, np.linalg.norm(f - along * u))),
            limits=limits,
        )


def elbow_circle(model: ArmModel, S: np.ndarray, W: np.ndarray):
    """The circle the elbow can be on, for shoulders S and wrists W (..., 3) in the torso frame:
    its center, radius and the two directions phi = 0 and phi = 90 degrees point along."""
    L1, L2 = model.upper, model.fore
    v = W - S
    d = np.linalg.norm(v, axis=-1, keepdims=True)
    n = v / np.maximum(d, 1e-9)
    d = np.clip(d, abs(L1 - L2) + 1e-4, L1 + L2 - 1e-4)
    a = (L1 * L1 - L2 * L2 + d * d) / (2 * d)
    rho = np.sqrt(np.maximum(L1 * L1 - a * a, 0.0))
    ref = SWIVEL_REFERENCE - np.sum(SWIVEL_REFERENCE * n, axis=-1, keepdims=True) * n
    u0 = ref / np.maximum(np.linalg.norm(ref, axis=-1, keepdims=True), 1e-9)
    u90 = np.cross(n, u0) * (1.0 if model.side == 0 else -1.0)
    return S + a * n, rho, u0, u90


def elbow_at(model: ArmModel, S, W, phi) -> np.ndarray:
    """The elbow at swivel phi (...,) for shoulders S and wrists W (..., 3)."""
    center, rho, u0, u90 = elbow_circle(model, S, W)
    phi = np.asarray(phi)[..., None]
    return center + rho * (np.cos(phi) * u0 + np.sin(phi) * u90)


def model_joints(model: ArmModel, S, E, W, R_tcp) -> np.ndarray:
    """(..., 7) the model arm's joint angles with the shoulder at S, the elbow at E, the wrist at
    W (..., 3) and the palm frame R_tcp (..., 3, 3), all in the torso frame."""
    u = _unit(E - S)
    f = _unit(W - E)
    sin_e = np.sum(f * u, axis=-1)
    f_perp = f - sin_e[..., None] * u
    perp = np.linalg.norm(f_perp, axis=-1)
    # A straight arm has no elbow plane; take the one away from the elbow's offset instead.
    away = (S + W) / 2 - E
    away = away - np.sum(away * u, axis=-1, keepdims=True) * u
    x_l = np.where((perp > 1e-3)[..., None], f_perp, away)
    x_l = _unit(x_l)
    z_l = -u
    R_u = np.stack([x_l, np.cross(z_l, x_l), z_l], axis=-1)
    Rp = np.einsum("ji,...jk->...ik", model.pitch_origin, R_u)  # Y(p) X(roll - offset) Z(yaw)
    b = np.arcsin(np.clip(-Rp[..., 1, 2], -1.0, 1.0))
    yaw = np.arctan2(Rp[..., 1, 0], Rp[..., 1, 1])
    pitch = np.arctan2(Rp[..., 0, 2], Rp[..., 2, 2])
    bend = np.arctan2(sin_e, perp)
    elbow = bend - model.elbow_offset
    c, s = np.cos(bend), np.sin(bend)
    zero, one = np.zeros_like(c), np.ones_like(c)
    R_e = np.stack(
        [np.stack([c, zero, s], -1), np.stack([zero, one, zero], -1), np.stack([-s, zero, c], -1)],
        -2,
    )
    R_f = R_u @ R_e
    M = np.einsum("...ji,...jk->...ik", R_f, R_tcp)  # X(roll) Y(pitch) Z(yaw)
    w_pitch = np.arcsin(np.clip(M[..., 0, 2], -1.0, 1.0))
    w_yaw = np.arctan2(-M[..., 0, 1], M[..., 0, 0])
    w_roll = np.arctan2(-M[..., 1, 2], M[..., 2, 2])
    q = np.stack([pitch, b - model.roll_offset, yaw, elbow, w_roll, w_pitch, w_yaw], axis=-1)
    # The other shoulder solution: pitch and yaw half a turn on, roll mirrored about 90 degrees.
    alt = q.copy()
    alt[..., 0] = _wrap(pitch + np.pi)
    alt[..., 1] = _wrap(np.pi - b) - model.roll_offset
    alt[..., 2] = _wrap(yaw + np.pi)
    better = _score(model, alt, E) < _score(model, q, E)
    return np.where(better[..., None], alt, q)


def swivel_costs(model: ArmModel, S, W, R_tcp, phis: np.ndarray):
    """For shoulders S, wrists W (M, 3) and palm frames R_tcp (M, 3, 3), torso frame: the score
    of each candidate swivel (M, K) and the model joints there (M, K, 7)."""
    center, rho, u0, u90 = elbow_circle(model, S, W)
    E = center[:, None] + rho[:, None] * (
        np.cos(phis)[None, :, None] * u0[:, None] + np.sin(phis)[None, :, None] * u90[:, None]
    )
    K = len(phis)
    q = model_joints(
        model,
        np.repeat(S[:, None], K, 1),
        E,
        np.repeat(W[:, None], K, 1),
        np.repeat(R_tcp[:, None], K, 1),
    )
    cost = _score(model, q, E)
    # How high the elbow is above the lowest it could be, as a fraction of the circle's height.
    lowest = center[:, None, 2] - rho[:, None, 0] * np.hypot(u0[:, None, 2], u90[:, None, 2])
    height = 2 * rho[:, None, 0] * np.hypot(u0[:, None, 2], u90[:, None, 2]) + 1e-3
    cost += GRAVITY_WEIGHT * (E[..., 2] - lowest) / height
    return cost, q


def choose_swivel(cost: np.ndarray, valid: np.ndarray, phis: np.ndarray) -> np.ndarray:
    """(M,) the swivel per frame (NaN where not valid): the path through each run of valid frames
    that minimizes the per-frame costs (M, K) plus CHANGE_WEIGHT * change^2, smoothed. Each
    frame's costs count relative to its best candidate, weighed by how well that fits (FIT) and
    capped near COST_SPREAD."""
    K = len(phis)
    best = cost.min(axis=1, keepdims=True)
    trust = np.clip(FIT / np.maximum(best, 1e-9), 0.1, 1.0)
    cost = COST_SPREAD * np.tanh(trust * (cost - best) / COST_SPREAD)
    step = np.abs(_wrap(phis[:, None] - phis[None, :]))
    transition = CHANGE_WEIGHT * step * step  # (from, to)
    out = np.full(len(cost), np.nan)
    for a, b in runs(valid):
        total = cost[a].copy()
        back = np.zeros((b - a, K), dtype=np.int64)
        for k in range(a + 1, b):
            options = total[:, None] + transition
            back[k - a] = np.argmin(options, axis=0)
            total = options[back[k - a], np.arange(K)] + cost[k]
        path = np.empty(b - a, dtype=np.int64)
        path[-1] = int(np.argmin(total))
        for k in range(b - a - 1, 0, -1):
            path[k - 1] = back[k, path[k]]
        out[a:b] = phis[path]
    return _wrap(smooth_angle(out, SWIVEL_SMOOTHING, valid))


def _score(model: ArmModel, q: np.ndarray, E: np.ndarray) -> np.ndarray:
    excess = range_excess(q, model.side, model.limits)
    cost = comfort_cost(q, model.side) + LIMIT_WEIGHT * np.sum(excess * excess, axis=-1)
    # The elbow inside the torso: by how much it would have to move out sideways.
    lateral = E[..., 1] if model.side == 0 else -E[..., 1]
    inside = (
        (np.abs(E[..., 0]) < TORSO_HALF[0]) & (E[..., 2] > TORSO_Z[0]) & (E[..., 2] < TORSO_Z[1])
    )
    depth = np.where(inside, np.maximum(TORSO_HALF[1] - lateral, 0.0), 0.0)
    return cost + TORSO_WEIGHT * depth * depth


def _unit(v: np.ndarray) -> np.ndarray:
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-12)


def _wrap(a):
    return (np.asarray(a) + np.pi) % (2 * np.pi) - np.pi
