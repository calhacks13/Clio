"""Each object's metric size, estimated from what the finders saw (`CompiledObjectTrack.extent`,
packages/protocol/src/derived.ts).

A finder's box is in normalized image coordinates. The camera model (meta.camera) turns its width
and height into angles, and the object's compiled depth, how far ahead of the camera its tracked
position is when the frame was captured, turns those into meters:

    width = (x1 - x0) * W / fx * z        height = (y1 - y0) * H / fy * z

with W, H the size of the frame the box was drawn on (the observation's `frame`, else the
intrinsics' size). The camera pose is the head pose at the capture time (the recorded frames
around it, interpolated) composed with the camera's mount (`headFromCamera`), mirroring the
headset's pixelRay (apps/headset/src/domain/world/camera-model.ts): the camera frame has x right,
y up and looks along -z.

Nothing is invented. Only observations that saw the object (status `measured`) with a box, taken
while the object has a compiled position and the camera has it in front, count; the medians of
at least three give an extent, else there is none. Without a camera model no object has one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from .episode import Episode
from .frames import quat_multiply, quat_rotate
from .objects import ObjectSeries
from .resample import MAX_FRAME_GAP_MS

MIN_SAMPLES = 3
EXTENT_DECIMALS = 3  # mm

_CAMERA_FORWARD = np.array([0.0, 0.0, -1.0])


@dataclass(frozen=True)
class CameraModel:
    width: float
    height: float
    fx: float
    fy: float
    camera_in_head: (
        np.ndarray
    )  # (7,) [px, py, pz, qx, qy, qz, qw]: the camera pose in the head frame


def object_extents(
    episode: Episode, series: dict[str, ObjectSeries]
) -> dict[str, dict[str, Any] | None]:
    """{object id: {"width", "height", "samples"} or None}, keyed like `series`."""
    camera = camera_model(episode.meta)
    sizes: dict[str, list[tuple[float, float]]] = {obj_id: [] for obj_id in series}
    if camera is not None:
        for obs in episode.observations:
            size = _measured_size(episode, series, camera, obs)
            if size is not None:
                sizes[obs["objectId"]].append(size)
    return {obj_id: _extent(measured) for obj_id, measured in sizes.items()}


def camera_model(meta: dict[str, Any]) -> CameraModel | None:
    """meta.camera as a CameraModel, or None when the episode records no (readable) camera."""
    camera = meta.get("camera")
    if not isinstance(camera, dict):
        return None
    try:
        intrinsics = camera["intrinsics"]
        model = CameraModel(
            width=float(intrinsics["width"]),
            height=float(intrinsics["height"]),
            fx=float(intrinsics["fx"]),
            fy=float(intrinsics["fy"]),
            camera_in_head=np.asarray(camera["headFromCamera"], dtype=np.float64).reshape(7),
        )
    except (KeyError, TypeError, ValueError):
        return None
    if (
        min(model.width, model.height, model.fx, model.fy) <= 0
        or np.isnan(model.camera_in_head).any()
    ):
        return None
    return model


def head_pose_at(
    episode: Episode, t: float, *, max_gap_ms: float | None = MAX_FRAME_GAP_MS
) -> np.ndarray | None:
    """The head pose (7,) at `t`: the recorded frames around it blended (position linearly, the
    quaternion by normalized lerp along the short arc), the nearest frame outside the recording.
    None without frames, or between two frames further apart than `max_gap_ms`: the compiled
    tracks leave the head null there too (resample.py)."""
    times = episode.t
    if len(times) == 0:
        return None
    if t <= times[0]:
        return episode.head[0].copy()
    if t >= times[-1]:
        return episode.head[-1].copy()
    j = int(np.searchsorted(times, t, side="left"))  # times[j - 1] < t <= times[j]
    if t == times[j]:
        return episode.head[j].copy()
    i = j - 1
    span = times[j] - times[i]
    if max_gap_ms is not None and span > max_gap_ms:
        return None
    alpha = (t - times[i]) / span
    a, b = episode.head[i], episode.head[j]
    position = a[:3] * (1.0 - alpha) + b[:3] * alpha
    qb = -b[3:7] if np.dot(a[3:7], b[3:7]) < 0 else b[3:7]
    rotation = a[3:7] * (1.0 - alpha) + qb * alpha
    return np.concatenate([position, rotation / np.linalg.norm(rotation)])


def compose_pose(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """The pose (7,) of `b` given in frame `a`, in a's parent frame: p = a_p + a_q (b_p),
    q = a_q (x) b_q."""
    position = a[:3] + quat_rotate(a[3:7], b[:3])
    rotation = quat_multiply(a[3:7], b[3:7])
    return np.concatenate([position, rotation / np.linalg.norm(rotation)])


def _measured_size(
    episode: Episode,
    series: dict[str, ObjectSeries],
    camera: CameraModel,
    obs: dict[str, Any],
) -> tuple[float, float] | None:
    """(width, height) in meters of one measured box, or None when it cannot be measured."""
    s = series.get(obs.get("objectId"))
    box, observed_t = obs.get("box"), obs.get("observedT")
    if (
        s is None
        or obs.get("status") != "measured"
        or not _is_box(box)
        or not _is_number(observed_t)
    ):
        return None
    k = s.nearest_frame(observed_t)
    if k is None or not s.valid[k]:
        return None
    head = head_pose_at(episode, observed_t)
    if head is None:
        return None
    pose = compose_pose(head, camera.camera_in_head)
    depth = float(np.dot(s.position[k] - pose[:3], quat_rotate(pose[3:7], _CAMERA_FORWARD)))
    if depth <= 0:
        return None
    width_px, height_px = _frame_size(obs, camera)
    width = (box[2] - box[0]) * width_px / camera.fx * depth
    height = (box[3] - box[1]) * height_px / camera.fy * depth
    return (width, height) if width > 0 and height > 0 else None


def _frame_size(obs: dict[str, Any], camera: CameraModel) -> tuple[float, float]:
    frame = obs.get("frame")
    if isinstance(frame, dict):
        width, height = frame.get("width"), frame.get("height")
        if _is_number(width) and _is_number(height) and width > 0 and height > 0:
            return float(width), float(height)
    return camera.width, camera.height


def _extent(sizes: list[tuple[float, float]]) -> dict[str, Any] | None:
    if len(sizes) < MIN_SAMPLES:
        return None
    width, height = (
        round(float(np.median(v)), EXTENT_DECIMALS) + 0.0 for v in zip(*sizes, strict=True)
    )
    if width <= 0 or height <= 0:  # smaller than a millimeter: not a size worth claiming
        return None
    return {"width": width, "height": height, "samples": len(sizes)}


def _is_box(value: Any) -> bool:
    return isinstance(value, list) and len(value) == 4 and all(_is_number(v) for v in value)


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and np.isfinite(value)
