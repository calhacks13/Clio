"""Forward kinematics and the geometric Jacobian of one URDF chain, from a base link to a tip link.

Fixed joints are folded into constant transforms, so a solver step only walks the moving joints.
A mimic joint on the chain follows its leader, which must be on the same chain. Poses are a
rotation matrix R and a position p in the base link frame. Quaternions are [x, y, z, w].
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from numpy.typing import ArrayLike

from .urdf import Urdf, UrdfError

_I3 = np.eye(3)
_ZERO3 = np.zeros(3)
_NEXT, _PREV = [1, 2, 0], [2, 0, 1]  # cyclic index shifts for row-wise cross products


@dataclass(frozen=True, eq=False)
class _Segment:
    """One moving joint: the constant transform from the previous moving joint's child frame (or
    the base) to this joint's frame, then motion along or about `axis`."""

    pre_R: np.ndarray | None  # None when it is the identity
    pre_p: np.ndarray
    axis: np.ndarray
    skew: np.ndarray  # K = [axis]x, so R(theta) = I + sin K + (1 - cos) K @ K
    skew2: np.ndarray
    prismatic: bool
    var: int  # index into q of the joint that drives it
    multiplier: float
    offset: float

    def value(self, q: np.ndarray) -> float:
        return self.multiplier * float(q[self.var]) + self.offset

    def motion(self, value: float) -> np.ndarray:
        """The rotation about `axis` by `value` (revolute joints)."""
        return _I3 + math.sin(value) * self.skew + (1.0 - math.cos(value)) * self.skew2


@dataclass(frozen=True, eq=False)
class ChainState:
    """Forward kinematics at one configuration, in the base link frame."""

    R: np.ndarray  # (3, 3) tip orientation
    p: np.ndarray  # (3,) tip position
    origins: np.ndarray  # (S, 3) each moving joint's origin
    axes: np.ndarray  # (S, 3) each moving joint's axis


class Chain:
    """The joints from `base_link` to `tip_link`. `q` holds the actuated joints, in chain order."""

    def __init__(self, urdf: Urdf, base_link: str, tip_link: str) -> None:
        joints = urdf.chain(base_link, tip_link)
        self.base_link = base_link
        self.tip_link = tip_link
        actuated = [j for j in joints if j.actuated]
        if not actuated:
            raise UrdfError(f"no actuated joints between {base_link!r} and {tip_link!r}")
        index = {j.name: k for k, j in enumerate(actuated)}
        self.joint_names: tuple[str, ...] = tuple(j.name for j in actuated)
        self.lower = np.array([j.lower for j in actuated])
        self.upper = np.array([j.upper for j in actuated])

        segments: list[_Segment] = []
        # Drawing order: ("fixed", k, p) is a point at p in the frame after k moving joints;
        # ("moving", k) is moving joint k's child frame origin.
        self._points: list[tuple] = []
        acc_R, acc_p = np.eye(3), np.zeros(3)
        for joint in joints:
            acc_p = acc_p + acc_R @ joint.origin[:3, 3]
            acc_R = acc_R @ joint.origin[:3, :3]
            if not joint.moves:
                self._points.append(("fixed", len(segments), acc_p.copy()))
                continue
            if joint.mimic is None:
                var, multiplier, offset = index[joint.name], 1.0, 0.0
            elif joint.mimic.joint in index:
                var = index[joint.mimic.joint]
                multiplier, offset = joint.mimic.multiplier, joint.mimic.offset
            else:
                raise UrdfError(
                    f"joint {joint.name!r} mimics {joint.mimic.joint!r}, which is not on the "
                    f"chain from {base_link!r} to {tip_link!r}"
                )
            a = joint.axis
            skew = np.array([[0.0, -a[2], a[1]], [a[2], 0.0, -a[0]], [-a[1], a[0], 0.0]])
            segments.append(
                _Segment(
                    pre_R=None if np.allclose(acc_R, _I3, rtol=0.0, atol=1e-15) else acc_R,
                    pre_p=acc_p,
                    axis=a,
                    skew=skew,
                    skew2=skew @ skew,
                    prismatic=joint.type == "prismatic",
                    var=var,
                    multiplier=multiplier,
                    offset=offset,
                )
            )
            self._points.append(("moving", len(segments) - 1))
            acc_R, acc_p = np.eye(3), np.zeros(3)
        self._segments = segments
        self._post_R, self._post_p = acc_R, acc_p
        # Jacobian columns per moving joint -> per actuated joint (mimics add to their leader).
        self._mix = np.zeros((len(segments), len(actuated)))
        for s, seg in enumerate(segments):
            self._mix[s, seg.var] = seg.multiplier
        self._identity_mix = len(segments) == len(actuated) and np.array_equal(
            self._mix, np.eye(len(actuated))
        )
        self._prismatic = np.array([seg.prismatic for seg in segments])

    @property
    def dof(self) -> int:
        return len(self.joint_names)

    def clamp(self, q: np.ndarray) -> np.ndarray:
        return np.clip(q, self.lower, self.upper)

    def forward(self, q: ArrayLike) -> ChainState:
        q = np.asarray(q, dtype=np.float64)
        R, p = _I3, _ZERO3
        n = len(self._segments)
        origins, axes = np.empty((n, 3)), np.empty((n, 3))
        for s, seg in enumerate(self._segments):
            p = p + R @ seg.pre_p
            if seg.pre_R is not None:
                R = R @ seg.pre_R
            a = R @ seg.axis
            origins[s], axes[s] = p, a
            if seg.prismatic:
                p = p + a * seg.value(q)
            else:
                R = R @ seg.motion(seg.value(q))
        return ChainState(R=R @ self._post_R, p=p + R @ self._post_p, origins=origins, axes=axes)

    def tip(self, q: ArrayLike) -> tuple[np.ndarray, np.ndarray]:
        state = self.forward(q)
        return state.R, state.p

    def jacobian(self, state: ChainState) -> np.ndarray:
        """(6, dof) geometric Jacobian at the tip, base frame: rows are linear velocity, then
        angular velocity. Revolute: [w x (p_tip - p_i); w]; prismatic: [w; 0]."""
        linear = cross_rows(state.axes, state.p - state.origins)
        angular = state.axes.copy()
        linear[self._prismatic] = state.axes[self._prismatic]
        angular[self._prismatic] = 0.0
        full = np.concatenate([linear, angular], axis=1).T  # (6, S)
        return full if self._identity_mix else full @ self._mix

    def points(self, q: ArrayLike) -> np.ndarray:
        """(P, 3) the base origin, then every joint origin along the chain (fixed ones too), in the
        base frame; the last point is the tip link's origin. For drawing the arm."""
        q = np.asarray(q, dtype=np.float64)
        frames = [(_I3, _ZERO3)]  # frame after k moving joints
        R, p = _I3, _ZERO3
        for seg in self._segments:
            p = p + R @ seg.pre_p
            if seg.pre_R is not None:
                R = R @ seg.pre_R
            if seg.prismatic:
                p = p + (R @ seg.axis) * seg.value(q)
            else:
                R = R @ seg.motion(seg.value(q))
            frames.append((R, p))
        out = [np.zeros(3)]
        for entry in self._points:
            if entry[0] == "fixed":
                frame_R, frame_p = frames[entry[1]]
                out.append(frame_p + frame_R @ entry[2])
            else:
                out.append(frames[entry[1] + 1][1])
        return np.array(out)


def cross3(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Cross product of two 3-vectors (np.cross is slow for one pair)."""
    a0, a1, a2 = a
    b0, b1, b2 = b
    return np.array([a1 * b2 - a2 * b1, a2 * b0 - a0 * b2, a0 * b1 - a1 * b0])


def cross_rows(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Row-wise cross products of (n, 3) arrays."""
    return a[:, _NEXT] * b[:, _PREV] - a[:, _PREV] * b[:, _NEXT]


def norm3(v: np.ndarray) -> float:
    return math.sqrt(float(v @ v))


def quat_to_matrix(q: ArrayLike) -> np.ndarray:
    """(..., 4) [x, y, z, w] -> (..., 3, 3). Normalizes first; NaN stays NaN."""
    q = np.asarray(q, dtype=np.float64)
    with np.errstate(invalid="ignore", divide="ignore"):
        q = q / np.linalg.norm(q, axis=-1, keepdims=True)
    x, y, z, w = np.moveaxis(q, -1, 0)
    return np.stack(
        [
            np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], -1),
            np.stack([2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], -1),
            np.stack([2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)], -1),
        ],
        axis=-2,
    )


def matrix_to_quat(R: ArrayLike) -> np.ndarray:
    """(..., 3, 3) rotation matrices -> (..., 4) [x, y, z, w] with w >= 0."""
    R = np.asarray(R, dtype=np.float64)
    m = R.reshape(-1, 3, 3)
    out = np.array([_quat_of(r.tolist()) for r in m]).reshape(-1, 4)
    return out.reshape(R.shape[:-2] + (4,))


def rotation_angle(R: ArrayLike) -> float:
    """Angle (rad) of one rotation matrix, in [0, pi]."""
    x, y, z, w = _quat_of(np.asarray(R, dtype=np.float64).tolist())
    return 2.0 * math.atan2(math.sqrt(x * x + y * y + z * z), w)


def rotation_vector(R: ArrayLike) -> np.ndarray:
    """Axis * angle of one rotation matrix (the log map), robust near 0 and pi."""
    x, y, z, w = _quat_of(np.asarray(R, dtype=np.float64).tolist())
    s = math.sqrt(x * x + y * y + z * z)
    scale = 2.0 if s < 1e-12 else 2.0 * math.atan2(s, w) / s
    return np.array([x * scale, y * scale, z * scale])


def _quat_of(r: list[list[float]]) -> tuple[float, float, float, float]:
    """Shepperd's method on one matrix (nested lists), normalized, w >= 0."""
    t = r[0][0] + r[1][1] + r[2][2]
    if t >= r[0][0] and t >= r[1][1] and t >= r[2][2]:
        s = 2.0 * math.sqrt(max(1.0 + t, 0.0))
        q = ((r[2][1] - r[1][2]) / s, (r[0][2] - r[2][0]) / s, (r[1][0] - r[0][1]) / s, s / 4)
    elif r[0][0] >= r[1][1] and r[0][0] >= r[2][2]:
        s = 2.0 * math.sqrt(max(1.0 + r[0][0] - r[1][1] - r[2][2], 0.0))
        q = (s / 4, (r[0][1] + r[1][0]) / s, (r[0][2] + r[2][0]) / s, (r[2][1] - r[1][2]) / s)
    elif r[1][1] >= r[2][2]:
        s = 2.0 * math.sqrt(max(1.0 + r[1][1] - r[0][0] - r[2][2], 0.0))
        q = ((r[0][1] + r[1][0]) / s, s / 4, (r[1][2] + r[2][1]) / s, (r[0][2] - r[2][0]) / s)
    else:
        s = 2.0 * math.sqrt(max(1.0 + r[2][2] - r[0][0] - r[1][1], 0.0))
        q = ((r[0][2] + r[2][0]) / s, (r[1][2] + r[2][1]) / s, s / 4, (r[1][0] - r[0][1]) / s)
    n = math.sqrt(sum(c * c for c in q))
    sign = 1.0 / n if q[3] >= 0 else -1.0 / n
    return (q[0] * sign, q[1] * sign, q[2] * sign, q[3] * sign)
