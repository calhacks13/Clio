"""Every object's estimates on one fixed-rate grid (`ObjectSeries`, docs/data-pipeline.md).

Any object source (layout, pinch, marker, detector, a future tracker) compiles into the same
series, so retargeting, export and the visualizer need not know which one produced the data.
Nothing is invented: a grid time gets a value only from a measurement at or before it.

For grid time g, the governing sample is the newest estimate measured at or before g (estimates
are ordered by `sample_t`: observedT where recorded, else the line's time; ties keep file order).

- No governing sample (before the object was first seen) or one without the position-valid bit:
  no position.
- Otherwise, if the next estimate is also position-valid and at most `max_interpolate_gap_ms`
  later, the position is interpolated between the two (orientations too, when both have one);
  else the governing position holds until the next estimate.
- `interpolated` marks values bridged across a gap longer than `stale_ms`, where measurements
  are missing. Resampling dense estimates is not flagged.
- `tracked`: the governing estimate has the position-tracked bit and is at most `stale_ms` old.
- `confidence` only for marker and detector estimates (the headset's other values are fixed,
  not measured), and only where there is a position.
- `held_by` comes from the object's held spans (held.py).

Arrays hold NaN where their mask says there is no value; compiled files turn those into null.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .episode import (
    MEASURED_SOURCES,
    ORIENTATION_VALID,
    POSITION_TRACKED,
    POSITION_VALID,
    Episode,
    ObjectTrack,
)
from .held import HeldSpan, held_spans
from .resample import EXACT_MS, uniform_times

DEFAULT_MAX_INTERPOLATE_GAP_MS = 250.0
DEFAULT_STALE_MS = 100.0


@dataclass
class ObjectSeries:
    id: str
    label: str
    kind: str | None  # plan object kind (item, tool, container, point, region); None if unplanned
    radius: float | None
    hidden: bool
    part_of: str | None  # the declared object this one is a component of (plan `partOf`), if any
    t: np.ndarray  # (M,) grid times, ms
    position: np.ndarray  # (M, 3) workspace frame; NaN where not `valid`
    orientation: np.ndarray  # (M, 4) [x, y, z, w]; NaN where unknown
    valid: np.ndarray  # (M,) bool: there is a usable position
    tracked: np.ndarray  # (M,) bool: measured no longer than stale_ms ago
    interpolated: np.ndarray  # (M,) bool: bridged between measurements across a gap
    confidence: np.ndarray  # (M,) measured confidence; NaN where none
    source: list[str | None]  # the governing estimate's source; None before the first
    held: np.ndarray  # (M,) bool: inside a held span, whether or not its hand is known
    held_by: list[str | None]  # left | right while a known hand holds it
    held_spans: list[HeldSpan]

    def __len__(self) -> int:
        return len(self.t)

    @property
    def orientation_valid(self) -> np.ndarray:
        return ~np.isnan(self.orientation).any(axis=1)

    @property
    def valid_fraction(self) -> float:
        return float(self.valid.mean()) if len(self.t) else 0.0

    @property
    def tracked_fraction(self) -> float:
        return float(self.tracked.mean()) if len(self.t) else 0.0


def grid_times(episode: Episode, fps: float) -> np.ndarray:
    """The grid `resample_episode` uses at `fps`."""
    return uniform_times(episode.t, fps)


def object_series(
    episode: Episode,
    grid_t: np.ndarray,
    *,
    max_interpolate_gap_ms: float = DEFAULT_MAX_INTERPOLATE_GAP_MS,
    stale_ms: float = DEFAULT_STALE_MS,
) -> dict[str, ObjectSeries]:
    """One series per object the episode has estimates for, in `episode.objects` order."""
    grid = np.asarray(grid_t, dtype=np.float64)
    spans = held_spans(episode)
    plan = {o["id"]: o for o in (episode.plan or {}).get("objects", [])}
    placed = {o["id"] for o in episode.meta.get("objects", [])}
    out: dict[str, ObjectSeries] = {}
    for obj_id, track in episode.objects.items():
        spec = plan.get(obj_id, {})
        own = [span for span in spans if span.object_id == obj_id]
        label = track.label if track.label != obj_id else spec.get("label", obj_id)
        radius = track.radius if track.radius is not None else spec.get("radius")
        out[obj_id] = ObjectSeries(
            id=obj_id,
            label=label,
            kind=spec.get("kind"),
            radius=float(radius) if radius is not None else None,
            hidden=bool(spec.get("hidden", False)),
            part_of=spec.get("partOf"),
            t=grid,
            held_spans=own,
            held=_held(own, grid),
            held_by=_held_by(own, grid),
            **_sample(track, grid, obj_id in placed, max_interpolate_gap_ms, stale_ms),
        )
    return out


def _sample(track: ObjectTrack, grid: np.ndarray, placed: bool, max_gap: float, stale: float):
    keep = np.ones(len(track.t), dtype=bool)
    if placed:
        # An estimate measured before the recording started (observedT < 0) is newer than the
        # meta.objects placement (the registry takes no observation older than its estimate),
        # so the placement, sorted after it at t = 0, would hide it: drop the placement.
        later = (track.flags[1:] & POSITION_VALID).astype(bool) & (track.sample_t[1:] < 0)
        keep[0] = not later.any()
    order = np.flatnonzero(keep)[np.argsort(track.sample_t[keep], kind="stable")]
    st = track.sample_t[order]
    flags = track.flags[order].astype(np.int64)
    pos, quat, conf = track.position[order], track.orientation[order], track.confidence[order]
    sources = [track.source[i] for i in order]
    m, n = len(grid), len(st)
    if n == 0:
        return _empty(m)

    k = np.searchsorted(st, grid, side="right") - 1
    seen = k >= 0
    k = np.maximum(k, 0)
    nxt = np.minimum(k + 1, n - 1)
    pos_valid = (flags & POSITION_VALID) != 0
    ori_valid = (flags & ORIENTATION_VALID) != 0
    measured = np.array([s in MEASURED_SOURCES for s in sources], dtype=bool)

    valid = seen & pos_valid[k]
    offset = grid - st[k]
    gap = st[nxt] - st[k]  # > offset whenever there is a next estimate
    blend = valid & (k + 1 < n) & pos_valid[nxt] & (gap <= max_gap) & (offset > EXACT_MS)
    alpha = np.where(blend, offset / np.where(blend, gap, 1.0), 0.0)[:, None]

    position = np.where(blend[:, None], pos[k] * (1.0 - alpha) + pos[nxt] * alpha, pos[k])
    position[~valid] = np.nan
    orientation = _nlerp(quat[k], quat[nxt], alpha, blend & ori_valid[nxt])
    orientation[~(seen & ori_valid[k])] = np.nan
    confidence = np.where(valid & measured[k], conf[k], np.nan)
    return {
        "position": position,
        "orientation": orientation,
        "valid": valid,
        "tracked": valid & ((flags[k] & POSITION_TRACKED) != 0) & (offset <= stale),
        "interpolated": blend & (gap > stale),
        "confidence": confidence,
        "source": [
            sources[i] if s else None for i, s in zip(k.tolist(), seen.tolist(), strict=True)
        ],
    }


def _empty(m: int) -> dict:
    none = np.zeros(m, dtype=bool)
    return {
        "position": np.full((m, 3), np.nan),
        "orientation": np.full((m, 4), np.nan),
        "valid": none,
        "tracked": none.copy(),
        "interpolated": none.copy(),
        "confidence": np.full(m, np.nan),
        "source": [None] * m,
    }


def _nlerp(a: np.ndarray, b: np.ndarray, alpha: np.ndarray, blend: np.ndarray) -> np.ndarray:
    """Normalized lerp along the short arc where `blend`, else `a`."""
    b = np.where(np.sum(a * b, axis=-1, keepdims=True) < 0, -b, b)
    with np.errstate(invalid="ignore", divide="ignore"):
        mixed = a * (1.0 - alpha) + b * alpha
        mixed /= np.linalg.norm(mixed, axis=-1, keepdims=True)
    return np.where(blend[:, None], mixed, a)


def _held(spans: list[HeldSpan], grid: np.ndarray) -> np.ndarray:
    """Whether some span holds the object at each grid time."""
    held = np.zeros(len(grid), dtype=bool)
    for span in spans:
        end = np.inf if span.end_t is None else span.end_t
        held |= (grid >= span.start_t) & (grid < end)
    return held


def _held_by(spans: list[HeldSpan], grid: np.ndarray) -> list[str | None]:
    """The hand of the span holding the object at each grid time; the newest span wins."""
    held: list[str | None] = [None] * len(grid)
    for span in spans:  # by start time
        end = np.inf if span.end_t is None else span.end_t
        for i in np.flatnonzero((grid >= span.start_t) & (grid < end)):
            held[i] = span.hand
    return held
