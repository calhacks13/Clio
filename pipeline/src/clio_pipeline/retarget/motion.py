"""Cleaning measured motion before a body is posed from it (body.py), offline and zero-phase.

Hand tracking drops out (a hand leaves the cameras' view) and glitches (a frame or two where the
hand jumps away or the skeleton flips). A glitch is a sample faster than a hand moves, or further
from the head than an arm reaches; it and isolated blips of tracking inside a dropout are
removed. The posed body then needs a hand everywhere: across a short dropout the hand moves on
the smooth path a reach takes (Flash and Hogan's minimum jerk, matching the velocity on both
sides); a long dropout is the arm's business (body.py lowers it to rest and raises it back).

Smoothing is a Gaussian over valid samples only (a normalized convolution), run forward and
backward at once, so nothing lags the measurement; rotations are averaged as sign-aligned
quaternions.
"""

from __future__ import annotations

import numpy as np

from .kinematics import matrix_to_quat, quat_to_matrix


def runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[(start, stop)) of each run of True."""
    m = np.concatenate([[False], np.asarray(mask, dtype=bool), [False]])
    edges = np.flatnonzero(np.diff(m.astype(np.int8)))
    return list(zip(edges[::2].tolist(), edges[1::2].tolist(), strict=True))


def min_jerk(tau: np.ndarray) -> np.ndarray:
    """The minimum-jerk profile from 0 to 1 over tau in [0, 1]: zero velocity and acceleration at
    both ends."""
    t = np.clip(tau, 0.0, 1.0)
    return t * t * t * (10.0 + t * (-15.0 + 6.0 * t))


def gaussian_smooth(x: np.ndarray, sigma: float, valid: np.ndarray | None = None) -> np.ndarray:
    """Zero-phase Gaussian smoothing along axis 0 (sigma in samples), over `valid` samples only:
    each run of valid samples is smoothed on its own and invalid samples stay as they were."""
    x = np.asarray(x, dtype=np.float64)
    if valid is None:
        valid = ~np.isnan(x.reshape(len(x), -1)).any(axis=1)
    out = x.copy()
    if sigma <= 0:
        return out
    radius = int(np.ceil(3 * sigma))
    kernel = np.exp(-0.5 * (np.arange(-radius, radius + 1) / sigma) ** 2)
    for a, b in runs(valid):
        seg = x[a:b].reshape(b - a, -1)
        keep = slice(radius, radius + b - a)
        weight = np.convolve(np.ones(b - a), kernel)[keep]
        smoothed = np.stack([np.convolve(c, kernel)[keep] for c in seg.T], axis=1)
        out[a:b] = (smoothed / weight[:, None]).reshape(x[a:b].shape)
    return out


def smooth_rotations(R: np.ndarray, sigma: float, valid: np.ndarray) -> np.ndarray:
    """(M, 3, 3) rotations smoothed like `gaussian_smooth`, as sign-aligned quaternions."""
    out = R.copy()
    for a, b in runs(valid):
        q = matrix_to_quat(R[a:b])
        flips = np.cumsum(np.concatenate([[0], np.sum(q[1:] * q[:-1], axis=1) < 0]))
        q = np.where((flips % 2 == 1)[:, None], -q, q)
        out[a:b] = quat_to_matrix(gaussian_smooth(q, sigma))
    return out


def smooth_rotations_adaptive(
    R: np.ndarray, valid: np.ndarray, *, slow: float, fast: float, fast_turn: float, rate: float
) -> np.ndarray:
    """(M, 3, 3) rotations smoothed with sigma `slow` (samples) while they turn slowly and `fast`
    while they turn at `fast_turn` (rad/s) or more, blended in between: tracking noise on a
    still hand is evened out without blunting a quick turn of the wrist (zero-phase, like
    `smooth_rotations`)."""
    R_slow = smooth_rotations(R, slow, valid)
    R_fast = smooth_rotations(R, fast, valid)
    turn = np.zeros(len(R))
    rel = np.einsum("mji,mjk->mik", R_fast[:-1], R_fast[1:])
    cos = np.clip((np.trace(rel, axis1=1, axis2=2) - 1.0) / 2.0, -1.0, 1.0)
    turn[1:] = np.arccos(cos) * rate
    blend = gaussian_smooth(np.clip(turn / fast_turn, 0.0, 1.0), fast, valid)
    out = R.copy()
    for a, b in runs(valid):
        q0, q1 = matrix_to_quat(R_slow[a:b]), matrix_to_quat(R_fast[a:b])
        q1 = np.where((np.sum(q0 * q1, axis=1) < 0)[:, None], -q1, q1)
        w = blend[a:b, None]
        out[a:b] = quat_to_matrix((1 - w) * q0 + w * q1)
    return out


def lazy_track(x: np.ndarray, weight: np.ndarray, stiffness: float, valid: np.ndarray):
    """(M, D) the path that stays near x (M, D) where `weight` (M,) is high and moves as little
    as it can elsewhere: the minimum of sum w |p - x|^2 + stiffness * sum |p[k+1] - p[k]|^2 over
    each run of valid samples (a tridiagonal solve, zero-phase). Where the weight is 1 it follows
    x with a time constant of about sqrt(stiffness) samples; where it is small it barely moves."""
    x = np.asarray(x, dtype=np.float64)
    out = x.copy()
    for a, b in runs(valid):
        n = b - a
        w = np.asarray(weight[a:b], dtype=np.float64)
        diag = w + 2.0 * stiffness
        diag[0] -= stiffness
        diag[-1] -= stiffness
        if n == 1:
            diag[0] = w[0]
        rhs = w[:, None] * x[a:b]
        # Thomas algorithm: off-diagonals are all -stiffness.
        c = np.zeros(n)
        d = np.zeros_like(rhs)
        c[0] = -stiffness / diag[0]
        d[0] = rhs[0] / diag[0]
        for k in range(1, n):
            denom = diag[k] + stiffness * c[k - 1]
            c[k] = -stiffness / denom
            d[k] = (rhs[k] + stiffness * d[k - 1]) / denom
        for k in range(n - 2, -1, -1):
            d[k] -= c[k] * d[k + 1]
        out[a:b] = d
    return out


def smooth_angle(a: np.ndarray, sigma: float, valid: np.ndarray) -> np.ndarray:
    """Angles (rad) smoothed like `gaussian_smooth` after unwrapping each valid run."""
    out = np.asarray(a, dtype=np.float64).copy()
    for s, e in runs(valid):
        out[s:e] = gaussian_smooth(np.unwrap(out[s:e]), sigma)
    return out


def clean_tracking(
    p: np.ndarray,
    R: np.ndarray,
    tracked: np.ndarray,
    head: np.ndarray,
    forward: np.ndarray,
    *,
    dt: float,
    max_speed: float,
    max_turn: float,
    max_reach: float,
    max_behind: float,
    spike: float,
    min_run: int,
) -> np.ndarray:
    """The frames (M,) of a tracked hand (positions p (M, 3), frames R (M, 3, 3)) worth keeping:
    not a glitch and not an isolated blip. A sample is a glitch when it is further than
    `max_reach` from the head (M, 3); when it is behind the eyes, where the headset's cameras do
    not see (its direction from the head is more than `max_behind` rad from the head's `forward`
    (M, 3)); when it sticks out more than `spike` (m) from the midpoint of the samples on either
    side while they agree; or when reaching it from the last good sample would take more than
    `max_speed` (m/s) or `max_turn` (rad/s). The samples on either side of a glitch go with it
    (resampling blended them with it), and a run of tracking shorter than `min_run` frames
    between dropouts is a blip."""
    present = tracked & ~np.isnan(p).any(axis=1) & ~np.isnan(head).any(axis=1)
    good = present.copy()
    offset = np.nan_to_num(p - head)
    distance = np.linalg.norm(offset, axis=1)
    good &= distance <= max_reach
    ahead = np.sum(offset * forward, axis=1) / np.maximum(distance, 1e-9)
    good &= ahead >= np.cos(max_behind)
    inner = np.flatnonzero(good[1:-1] & good[:-2] & good[2:]) + 1
    if len(inner):
        mid = 0.5 * (p[inner - 1] + p[inner + 1])
        out = np.linalg.norm(p[inner] - mid, axis=1)
        apart = np.linalg.norm(p[inner + 1] - p[inner - 1], axis=1)
        good[inner[(out > spike) & (out > apart)]] = False
    last: int | None = None
    for k in np.flatnonzero(good):
        if last is not None and k - last <= 3:
            span = (k - last) * dt
            jump = float(np.linalg.norm(p[k] - p[last])) / span
            cos = (np.trace(R[last].T @ R[k]) - 1.0) / 2.0
            turn = float(np.arccos(np.clip(cos, -1.0, 1.0))) / span
            if jump > max_speed or turn > max_turn:
                good[k] = False
                continue
        last = k
    # A grid sample next to a glitch was interpolated with it: drop it too.
    glitch = present & ~good
    good[1:] &= ~glitch[:-1]
    good[:-1] &= ~glitch[1:]
    for a, b in runs(good):
        if b - a < min_run:
            good[a:b] = False
    return good


def fill_short_gaps(
    p: np.ndarray, R: np.ndarray, good: np.ndarray, *, max_gap: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Bridge each dropout of at most `max_gap` frames between good samples: the position on a
    cubic that leaves and arrives with the measured velocities, the frame on a minimum-jerk
    slerp. Returns the positions, frames and the frames that now have a value."""
    p, R = p.copy(), R.copy()
    have = good.copy()
    for a, b in runs(~good):
        if a == 0 or b == len(good) or b - a > max_gap:
            continue
        i, j = a - 1, b  # the good samples on both sides
        n = j - i
        v0 = p[i] - p[i - 1] if i > 0 and good[i - 1] else np.zeros(3)
        v1 = p[j + 1] - p[j] if j + 1 < len(good) and good[j + 1] else np.zeros(3)
        u = np.arange(1, n) / n
        h00, h10 = 2 * u**3 - 3 * u**2 + 1, u**3 - 2 * u**2 + u
        h01, h11 = -2 * u**3 + 3 * u**2, u**3 - u**2
        p[a:b] = (
            h00[:, None] * p[i]
            + h10[:, None] * (n * v0)
            + h01[:, None] * p[j]
            + h11[:, None] * (n * v1)
        )
        q0, q1 = matrix_to_quat(R[i]), matrix_to_quat(R[j])
        R[a:b] = quat_to_matrix(_slerp(q0, q1, min_jerk(u)))
        have[a:b] = True
    return p, R, have


def _slerp(q0: np.ndarray, q1: np.ndarray, s: np.ndarray) -> np.ndarray:
    if float(q0 @ q1) < 0:
        q1 = -q1
    cos = float(np.clip(q0 @ q1, -1.0, 1.0))
    angle = np.arccos(cos)
    if angle < 1e-6:
        return np.broadcast_to(q0, (len(s), 4)).copy()
    w0 = np.sin((1 - s) * angle) / np.sin(angle)
    w1 = np.sin(s * angle) / np.sin(angle)
    return w0[:, None] * q0 + w1[:, None] * q1
