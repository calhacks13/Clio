"""Keyframes: the passthrough camera stills an episode recorded (`scene.keyframe` events, feature
"scene.keyframes"), each with the camera's pose in W and the intrinsics of the stored image.

The camera frame follows WebXR (and OpenGL, and Nerfstudio's transforms.json): x right, y up,
looking down -z. Image pixels have x right and y down, so a camera-frame point (X, Y, Z) with Z < 0
lands at u = cx + fx * X / -Z, v = cy - fy * Y / -Z, the inverse of the headset's `pixelRay`
(apps/headset/src/domain/world/camera-model.ts).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .episode import Episode
from .glb import quat_matrix

KEYFRAME_EVENT = "scene.keyframe"


@dataclass(frozen=True)
class Keyframe:
    index: int  # 0-based, in capture order
    media: str  # file name in the episode's media/
    path: Path | None  # the image; None when it never arrived
    t: float  # the event's t (ms)
    captured_t: float  # when the camera frame was captured (ms, an observation's observedT clock)
    pose: np.ndarray  # (7,) camera pose in W: [px, py, pz, qx, qy, qz, qw]
    width: int
    height: int
    fx: float
    fy: float
    cx: float
    cy: float

    def world_from_camera(self) -> np.ndarray:
        """4x4 camera-to-W matrix (WebXR camera axes): what Nerfstudio calls transform_matrix."""
        m = np.eye(4)
        m[:3, :3] = quat_matrix(self.pose[3:7])
        m[:3, 3] = self.pose[:3]
        return m

    def camera_from_world(self) -> np.ndarray:
        r = quat_matrix(self.pose[3:7])
        m = np.eye(4)
        m[:3, :3] = r.T
        m[:3, 3] = -r.T @ self.pose[:3]
        return m

    def to_camera(self, points_w: np.ndarray) -> np.ndarray:
        """(N, 3) points in W to the camera frame."""
        m = self.camera_from_world()
        p = np.asarray(points_w, dtype=np.float64).reshape(-1, 3)
        return p @ m[:3, :3].T + m[:3, 3]

    def project(self, points_w: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Pixel coordinates (N, 2) and depth in front of the camera (N,), meters. Points with
        depth <= 0 are behind the camera and their pixels are NaN."""
        c = self.to_camera(points_w)
        depth = -c[:, 2]
        with np.errstate(divide="ignore", invalid="ignore"):
            u = self.cx + self.fx * c[:, 0] / depth
            v = self.cy - self.fy * c[:, 1] / depth
        uv = np.stack([u, v], axis=1)
        uv[depth <= 0] = np.nan
        return uv, depth

    def in_image(self, uv: np.ndarray, margin: float = 0.0) -> np.ndarray:
        """Which pixel coordinates fall inside the image, `margin` pixels from its edges."""
        u, v = uv[:, 0], uv[:, 1]
        with np.errstate(invalid="ignore"):
            return (
                (u >= margin)
                & (u <= self.width - 1 - margin)
                & (v >= margin)
                & (v <= self.height - 1 - margin)
            )


def load_keyframes(episode: Episode, *, include_missing: bool = False) -> list[Keyframe]:
    """The episode's keyframes in capture order. A keyframe whose image is not in media/ (its
    upload was dropped) is left out unless `include_missing`; a malformed event is skipped."""
    frames: list[Keyframe] = []
    for event in episode.events_of(KEYFRAME_EVENT):
        try:
            pose = np.asarray(event["pose"], dtype=np.float64)
            k = event["intrinsics"]
            width, height = int(event["width"]), int(event["height"])
            fx, fy, cx, cy = (float(k[name]) for name in ("fx", "fy", "cx", "cy"))
            media = str(event["media"])
            t, captured = float(event["t"]), float(event["capturedT"])
        except (KeyError, TypeError, ValueError):
            continue
        if pose.shape != (7,) or not np.isfinite(pose).all() or width <= 0 or height <= 0:
            continue
        path = episode.media.get(media)
        if path is None and not include_missing:
            continue
        frames.append(Keyframe(0, media, path, t, captured, pose, width, height, fx, fy, cx, cy))
    frames.sort(key=lambda f: f.captured_t)
    return [
        Keyframe(
            i, f.media, f.path, f.t, f.captured_t, f.pose, f.width, f.height, f.fx, f.fy, f.cx, f.cy
        )
        for i, f in enumerate(frames)
    ]
