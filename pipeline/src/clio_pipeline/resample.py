"""Resample an episode's variable-rate XR frames (72-120 Hz) onto a fixed-rate grid."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

from .episode import Episode
from .segments import FrameLabels, frame_labels

# Grid times within this many ms of a source frame count as hitting it exactly.
EXACT_MS = 1e-6
# Compiled tracks and retargeting never interpolate the head or hands across recorded frames
# further apart than this (a lost batch, or the XR loop paused while the headset was off).
MAX_FRAME_GAP_MS = 100.0


@dataclass
class Resampled:
    fps: float
    t: np.ndarray  # (M,) ms since episode start, uniform: t[0] + k * 1000 / fps
    head: np.ndarray  # (M, 7); NaN where not `head_valid`
    hands: np.ndarray  # (M, 2, 25, 8) float32; NaN where the hand is missing
    pinch: np.ndarray  # (M, 2) float32; NaN where the hand is missing
    tracked: np.ndarray  # (M, 2) bool
    source_index: np.ndarray  # (M,) the source frame at or just before each grid time
    segment: np.ndarray  # (M,) labels of the source frame `source_index` (nearest previous)
    step_index: np.ndarray
    task: np.ndarray
    action_verb: np.ndarray
    head_valid: np.ndarray  # (M,) bool: False inside a frame gap longer than `max_gap_ms`
    max_gap_ms: float | None  # the longest gap between source frames interpolated; None: any

    def __len__(self) -> int:
        return len(self.t)


def uniform_times(t: np.ndarray, fps: float) -> np.ndarray:
    """t[0], t[0] + 1000/fps, ... up to and including t[-1] (ms)."""
    if fps <= 0:
        raise ValueError(f"fps must be positive, got {fps}")
    if len(t) == 0:
        return np.zeros(0)
    count = int(np.floor((t[-1] - t[0]) * fps / 1000.0 + 1e-9)) + 1
    return t[0] + np.arange(count) * (1000.0 / fps)


def resample_episode(
    episode: Episode,
    fps: float = 30.0,
    labels: FrameLabels | None = None,
    *,
    max_gap_ms: float | None = None,
) -> Resampled:
    """Positions and radii are interpolated linearly and quaternions by normalized lerp along the
    short arc. A hand counts as missing at a grid time if it is missing in either neighboring
    source frame. Discrete labels (task, step) come from the nearest previous source frame.

    With `max_gap_ms`, a grid time between two source frames further apart than that is not
    interpolated: both hands are missing there and the head is not valid (NaN). Without it,
    every gap is bridged (the human_hands LeRobot export)."""
    grid = uniform_times(episode.t, fps)
    if labels is None:
        labels = frame_labels(episode)
    i, j, alpha, blend = _neighbors(episode.t, grid)
    head_valid = np.ones(len(grid), dtype=bool)
    if max_gap_ms is not None:
        head_valid = ~(blend & (episode.t[j] - episode.t[i] > max_gap_ms))

    head = np.concatenate(
        [
            _lerp(episode.head[:, :3], i, j, alpha, blend),
            _nlerp(episode.head[:, 3:7], i, j, alpha, blend),
        ],
        axis=-1,
    )
    head[~head_valid] = np.nan
    tracked = episode.tracked[i] & (episode.tracked[j] | ~blend[:, None]) & head_valid[:, None]
    hands = np.concatenate(
        [
            _lerp(episode.hands[..., :3], i, j, alpha, blend),
            _nlerp(episode.hands[..., 3:7], i, j, alpha, blend),
            _lerp(episode.hands[..., 7:8], i, j, alpha, blend),
        ],
        axis=-1,
    ).astype(np.float32)
    pinch = _lerp(episode.pinch, i, j, alpha, blend).astype(np.float32)
    hands[~tracked] = np.nan
    pinch[~tracked] = np.nan
    return Resampled(
        fps=float(fps),
        t=grid,
        head=head,
        hands=hands,
        pinch=pinch,
        tracked=tracked,
        source_index=i,
        segment=labels.segment[i],
        step_index=labels.step_index[i],
        task=labels.task[i],
        action_verb=labels.action_verb[i],
        head_valid=head_valid,
        max_gap_ms=None if max_gap_ms is None else float(max_gap_ms),
    )


def resample_objects(episode: Episode, t: np.ndarray, object_ids: Sequence[str]) -> np.ndarray:
    """(M, K, 3) positions of `object_ids` at times `t`: the latest estimate at or before each
    time, or the first estimate for times before an object was first seen. NaN for ids the
    episode never mentions."""
    out = np.full((len(t), len(object_ids), 3), np.nan)
    for k, obj_id in enumerate(object_ids):
        track = episode.objects.get(obj_id)
        if track is None or len(track.t) == 0:
            continue
        idx = np.maximum(np.searchsorted(track.t, t, side="right") - 1, 0)
        out[:, k] = track.position[idx]
    return out


def _neighbors(t_src: np.ndarray, grid: np.ndarray):
    """For each grid time: source frame i at or before it, j = i + 1, the blend weight of j, and
    whether j takes part at all (False for exact hits on frame i and for the last frame)."""
    n = len(t_src)
    if n == 0:
        empty = np.zeros(0, dtype=np.int64)
        return empty, empty, np.zeros(0), np.zeros(0, dtype=bool)
    i = np.clip(np.searchsorted(t_src, grid + EXACT_MS, side="right") - 1, 0, n - 1)
    j = np.minimum(i + 1, n - 1)
    span = t_src[j] - t_src[i]
    offset = grid - t_src[i]
    blend = (span > 0) & (offset > EXACT_MS)
    alpha = np.where(blend, np.clip(offset / np.where(span > 0, span, 1.0), 0.0, 1.0), 0.0)
    return i, j, alpha, blend


def _expand(w: np.ndarray, like: np.ndarray) -> np.ndarray:
    return w.reshape(w.shape + (1,) * (like.ndim - 1))


def _lerp(values: np.ndarray, i, j, alpha, blend) -> np.ndarray:
    a, b = values[i].astype(np.float64), values[j].astype(np.float64)
    w = _expand(alpha, a)
    return np.where(_expand(blend, a), a * (1.0 - w) + b * w, a)


def _nlerp(q: np.ndarray, i, j, alpha, blend) -> np.ndarray:
    a, b = q[i].astype(np.float64), q[j].astype(np.float64)
    b = np.where(np.sum(a * b, axis=-1, keepdims=True) < 0, -b, b)  # short arc
    w = _expand(alpha, a)
    mixed = a * (1.0 - w) + b * w
    with np.errstate(invalid="ignore", divide="ignore"):
        mixed /= np.linalg.norm(mixed, axis=-1, keepdims=True)
    return np.where(_expand(blend, a), mixed, a)
