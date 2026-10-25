"""Each object's measured shape (shapes.json: `ShapesDoc`, packages/protocol/src/derived.ts).

The headset records depth samples inside each tracked outline (observations.ndjson `surface`,
feature "object.surface"): points in W where camera rays met the depth map on the object. One
frame's samples show the side the camera saw; fused over the frames, the shape grows. Each frame's
samples are taken relative to the object's compiled position at that frame (the grid frame nearest
the capture time), so the shape rides with the object and frames taken from different places
agree. Only frames where the object stood still count: a frame whose compiled position is missing
can form no offset, and a frame inside a held span would smear the shape; both are skipped, never
placed at the origin.

The pooled offsets are fused on a voxel grid (`voxel_m`): each voxel becomes the mean of its
samples. Once there are more than MANY_VOXELS voxels, one with fewer than `min_hits` samples is
noise and goes. More than `max_points` points are thinned by a uniform stride. A yaw-aligned box
sums the points up: its x axis is the principal axis of the points' horizontal (x, z) spread, its
y axis is up, and each side spans the 2nd to 98th percentile of the points along its axis. Fewer
than MIN_BOX_POINTS points give no box. Nothing here is interpolated or guessed: a shape says only
where depth was measured.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from .derived_io import DERIVED_SCHEMA_ID, rounded, time_or_none, times
from .episode import Episode
from .objects import ObjectSeries

DEFAULT_VOXEL_M = 0.01
DEFAULT_MIN_HITS = 2
DEFAULT_MAX_POINTS = 2000
# The headset keeps samples within this of the object's measured center (live-objects.ts
# SURFACE_REACH_M); the compiled policy records it for readers.
DEFAULT_REACH_M = 0.3
# Up to this many voxels, every voxel stays: a small shape must not vanish for want of hits.
MANY_VOXELS = 50
MIN_BOX_POINTS = 4
BOX_PERCENTILES = (2.0, 98.0)


def has_depth_samples(episode: Episode) -> bool:
    """Whether any observation carries depth samples (a non-empty `surface`)."""
    return any(_surface_points(obs) is not None for obs in episode.observations)


def object_shapes(
    episode: Episode,
    series: dict[str, ObjectSeries],
    *,
    voxel_m: float = DEFAULT_VOXEL_M,
    min_hits: int = DEFAULT_MIN_HITS,
    max_points: int = DEFAULT_MAX_POINTS,
) -> dict[str, dict[str, Any]]:
    """One CompiledObjectShape per object some `measured` observation sampled, in first-sampled
    order. An object whose every sampled frame was skipped (held, or without a compiled position)
    keeps an empty shape, so a reader can tell it was sampled."""
    if not voxel_m > 0:
        raise ValueError(f"voxel_m must be positive, got {voxel_m!r}")
    if min_hits < 1 or max_points < 1:
        raise ValueError(
            f"min_hits and max_points must be at least 1, got {min_hits}, {max_points}"
        )
    pooled: dict[str, list[np.ndarray]] = {}
    seen_at: dict[str, list[float]] = {}
    for obs in episode.observations:
        if obs.get("status") != "measured" or (points := _surface_points(obs)) is None:
            continue
        s = series.get(obs.get("objectId"))
        observed_t = obs.get("observedT")
        if s is None or not _is_number(observed_t):
            continue
        offsets = pooled.setdefault(s.id, [])
        k = s.nearest_frame(observed_t)
        if k is None or not s.valid[k] or s.held[k]:
            continue
        offsets.append(points - s.position[k])
        seen_at.setdefault(s.id, []).append(float(observed_t))
    return {
        obj_id: _shape(obj_id, offsets, seen_at.get(obj_id, []), voxel_m, min_hits, max_points)
        for obj_id, offsets in pooled.items()
    }


def shapes_doc(
    episode: Episode,
    grid: np.ndarray,
    shapes: dict[str, dict[str, Any]],
    *,
    fps: int,
    voxel_m: float,
    min_hits: int,
    reach_m: float = DEFAULT_REACH_M,
) -> dict[str, Any]:
    """ShapesDoc on the tracks' grid."""
    return {
        "schema": DERIVED_SCHEMA_ID,
        "episodeId": episode.episode_id,
        "frame": "workspace",
        "fps": fps,
        "t": times(grid),
        "kind": "shapes",
        "policy": {"voxelM": voxel_m, "minHits": int(min_hits), "reachM": reach_m},
        "objects": list(shapes.values()),
    }


def fuse_offsets(
    offsets: np.ndarray, *, voxel_m: float, min_hits: int, max_points: int
) -> np.ndarray:
    """(K, 3) voxel means of the (N, 3) offsets, ordered by voxel; see the module docstring."""
    offsets = np.asarray(offsets, dtype=np.float64).reshape(-1, 3)
    if len(offsets) == 0:
        return offsets
    keys = np.floor(offsets / voxel_m).astype(np.int64)
    voxels, inverse, hits = np.unique(keys, axis=0, return_inverse=True, return_counts=True)
    sums = np.zeros((len(voxels), 3))
    np.add.at(sums, inverse.reshape(-1), offsets)
    means = sums / hits[:, None]
    if len(voxels) > MANY_VOXELS:
        means = means[hits >= min_hits]
    if len(means) > max_points:
        means = means[np.round(np.linspace(0, len(means) - 1, max_points)).astype(np.int64)]
    return means


def yaw_box(points: np.ndarray) -> dict[str, Any] | None:
    """The yaw-aligned box around (K, 3) points: {"center", "rotation", "size"} as arrays, with
    the center an offset in W axes, the rotation a quaternion about +y and the size along the
    box's own axes. None with fewer than MIN_BOX_POINTS points."""
    points = np.asarray(points, dtype=np.float64).reshape(-1, 3)
    if len(points) < MIN_BOX_POINTS:
        return None
    yaw = _principal_yaw(points[:, [0, 2]])
    c, s = math.cos(yaw), math.sin(yaw)
    axes = np.array([[c, 0.0, -s], [0.0, 1.0, 0.0], [s, 0.0, c]])  # rows: the box's x, y, z in W
    low, high = np.percentile(points @ axes.T, BOX_PERCENTILES, axis=0)
    return {
        "center": axes.T @ ((low + high) / 2.0),
        "rotation": np.array([0.0, math.sin(yaw / 2.0), 0.0, math.cos(yaw / 2.0)]),
        "size": high - low,
    }


def _principal_yaw(xz: np.ndarray) -> float:
    """The rotation about +y taking [1, 0, 0] to the principal axis of the (K, 2) horizontal
    coordinates, in (-pi/2, pi/2]: the axis is taken pointing toward +x (toward +z when it has no
    x part), so one spread gives one yaw."""
    _, vectors = np.linalg.eigh(np.cov(xz, rowvar=False))
    ax, az = vectors[:, -1]  # the eigenvector of the largest eigenvalue
    if ax < 0 or (ax == 0 and az < 0):
        ax, az = -ax, -az
    return math.atan2(-az, ax)  # R_y(yaw) [1, 0, 0] = [cos yaw, 0, -sin yaw]


def _shape(
    obj_id: str,
    offsets: list[np.ndarray],
    seen_at: list[float],
    voxel_m: float,
    min_hits: int,
    max_points: int,
) -> dict[str, Any]:
    pooled = np.concatenate(offsets) if offsets else np.zeros((0, 3))
    points = fuse_offsets(pooled, voxel_m=voxel_m, min_hits=min_hits, max_points=max_points)
    box = yaw_box(points)
    return {
        "id": obj_id,
        "points": rounded(points),
        "box": None
        if box is None
        else {
            "center": rounded(box["center"]),
            "rotation": rounded(box["rotation"]),
            "size": rounded(box["size"]),
        },
        "samples": int(len(pooled)),
        "frames": len(seen_at),
        "firstT": time_or_none(min(seen_at)) if seen_at else None,
        "lastT": time_or_none(max(seen_at)) if seen_at else None,
    }


def _surface_points(obs: dict[str, Any]) -> np.ndarray | None:
    """The observation's finite depth samples as (N, 3), or None when it carries none."""
    surface = obs.get("surface")
    if not isinstance(surface, list) or not surface:
        return None
    try:
        points = np.asarray(surface, dtype=np.float64)
    except (TypeError, ValueError):
        return None
    if points.ndim != 2 or points.shape[1] != 3:
        return None
    points = points[np.isfinite(points).all(axis=1)]
    return points if len(points) else None


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)
