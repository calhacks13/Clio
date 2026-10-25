"""The keyframes an object's model is made from, where the object is in each, and the crops cut
from them (SceneModel `crops`, `crop-<id>-<n>.jpg`).

A keyframe is a candidate when the object has a valid compiled position at its capture time (the
nearest grid frame, at most a frame away) and is not held there: a hand around it would be drawn
into the model. Its box in the image:

    observation  a measured observation of the object whose camera frame was captured within
                 OBSERVATION_MATCH_MS of the keyframe: the tracker's own box on the same frame.
    projection   otherwise the corners of its measured box (fit.py: the shape box, else the
                 extent, else the radius) at its compiled position, through the keyframe's pose.

A box must lie mostly inside the image, be at least MIN_SHORT_SIDE_PX on its short side, and the
object must be more than MIN_DEPTH_M in front of the camera. Candidates are scored by how big and
how centered the box is, how sharp the crop is (the variance of its Laplacian, on a crop scaled
to a fixed size so near and far views compare), and the tracker's score (a projection, which
only says where the object should be, scores lower). The best is taken first, then the next best
whose camera looks from a different direction (MIN_VIEW_ANGLE_DEG apart from every one taken), up
to MAX_VIEWS. Each crop keeps a CROP_MARGIN around its box.
"""

from __future__ import annotations

import math
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from ..keyframes import Keyframe
from .fit import Measured, box_corners

OBSERVATION_MATCH_MS = 40.0
MIN_DEPTH_M = 0.1
MIN_SHORT_SIDE_PX = 32
MIN_INSIDE = 0.7  # of a projected box's area
CROP_MARGIN = 0.15
MAX_VIEWS = 3
MIN_VIEW_ANGLE_DEG = 30.0
SHORTLIST = 12  # best candidates by geometry whose images are decoded for sharpness
MAX_CROP_PX = 1024
SHARPNESS_PX = 128
JPEG_QUALITY = 90
_EDGE = 0.005  # a box this close to the image border may be cut off by it


@dataclass
class View:
    keyframe: Keyframe
    frame: int  # grid index nearest the keyframe's capture
    position: np.ndarray  # (3,) the object's compiled position there, W
    box: np.ndarray  # (4,) normalized [x0, y0, x1, y1], inside the image
    source: str  # "observation" | "projection"
    observation_score: float | None
    outline: np.ndarray | None  # (K, 2) normalized, from the observation
    depth: float  # m in front of the camera
    toward_camera: np.ndarray  # (3,) unit, from the object to the camera, W
    score: float = 0.0
    crop: Image.Image | None = None  # the saved crop: the box with its margin
    crop_rect: tuple[int, int, int, int] | None = None  # pixels of the keyframe image it covers
    image_size: tuple[int, int] = (0, 0)  # of the decoded keyframe image

    def box_in_crop(self, box: np.ndarray | None = None) -> np.ndarray:
        """Normalized image coordinates (pairs, or a 4-box) in the crop's pixels."""
        assert self.crop is not None and self.crop_rect is not None
        x0, y0, x1, y1 = self.crop_rect
        width, height = self.image_size
        values = np.asarray(self.box if box is None else box, dtype=np.float64).reshape(-1, 2)
        sx, sy = self.crop.width / (x1 - x0), self.crop.height / (y1 - y0)
        return np.stack(
            [(values[:, 0] * width - x0) * sx, (values[:, 1] * height - y0) * sy], axis=1
        )


class Images:
    """Keyframe images, decoded once and kept for a few objects."""

    def __init__(self, keep: int = 16) -> None:
        self._keep = keep
        self._cache: OrderedDict[Path, Image.Image | None] = OrderedDict()

    def get(self, keyframe: Keyframe) -> Image.Image | None:
        path = keyframe.path
        if path is None:
            return None
        if path in self._cache:
            self._cache.move_to_end(path)
            return self._cache[path]
        try:
            with Image.open(path) as image:
                decoded: Image.Image | None = image.convert("RGB")
        except (OSError, ValueError):
            decoded = None
        self._cache[path] = decoded
        if len(self._cache) > self._keep:
            self._cache.popitem(last=False)
        return decoded


class Observations:
    """Each object's measured observations with a box, by the time their frame was captured."""

    def __init__(self, observations: list[dict[str, Any]]) -> None:
        by_object: dict[str, list[dict[str, Any]]] = {}
        for obs in observations:
            if obs.get("status") == "measured" and _box(obs.get("box")) is not None:
                t = obs.get("observedT")
                if _is_number(t):
                    by_object.setdefault(str(obs.get("objectId")), []).append(obs)
        self._lines = {k: sorted(v, key=lambda o: o["observedT"]) for k, v in by_object.items()}
        self._times = {
            k: np.array([o["observedT"] for o in v], dtype=np.float64)
            for k, v in self._lines.items()
        }

    def nearest(self, obj_id: str, t: float, within_ms: float) -> dict[str, Any] | None:
        times = self._times.get(obj_id)
        if times is None or len(times) == 0:
            return None
        k = int(np.argmin(np.abs(times - t)))
        return self._lines[obj_id][k] if abs(times[k] - t) <= within_ms else None


def select_views(
    obj: dict[str, Any],
    grid_t: np.ndarray,
    measured: Measured,
    keyframes: list[Keyframe],
    observations: Observations,
    images: Images,
    *,
    max_views: int = MAX_VIEWS,
) -> list[View]:
    """The object's best views, best first, each with its crop cut (not yet saved)."""
    candidates = [
        view
        for kf in keyframes
        if (view := candidate(obj, grid_t, measured, kf, observations)) is not None
    ]
    candidates.sort(key=lambda v: v.score, reverse=True)
    scored: list[View] = []
    for view in candidates[:SHORTLIST]:
        image = images.get(view.keyframe)
        if image is None:
            continue
        view.image_size = image.size
        view.score = _score(view, sharpness=sharpness(_cut(image, view.box, 0.0)))
        view.crop_rect = _margin_rect(image.size, view.box)
        crop = image.crop(view.crop_rect)
        if max(crop.size) > MAX_CROP_PX:
            crop.thumbnail((MAX_CROP_PX, MAX_CROP_PX))
        view.crop = crop
        scored.append(view)
    scored.sort(key=lambda v: v.score, reverse=True)
    picked: list[View] = []
    apart = math.cos(math.radians(MIN_VIEW_ANGLE_DEG))
    for view in scored:
        if all(float(view.toward_camera @ p.toward_camera) < apart for p in picked):
            picked.append(view)
        if len(picked) == max_views:
            break
    return picked


def candidate(
    obj: dict[str, Any],
    grid_t: np.ndarray,
    measured: Measured,
    kf: Keyframe,
    observations: Observations,
) -> View | None:
    """The object as `kf` saw it, or None when the keyframe cannot be used (see the module
    docstring). Its score leaves sharpness out: that needs the image."""
    if kf.path is None or len(grid_t) == 0:
        return None
    k = int(np.argmin(np.abs(grid_t - kf.captured_t)))
    step = float(np.median(np.diff(grid_t))) if len(grid_t) > 1 else 50.0
    position = obj["position"][k]
    if abs(grid_t[k] - kf.captured_t) > step or position is None or obj["held"][k]:
        return None
    position = np.asarray(position, dtype=np.float64)
    _, depth = kf.project(position[None])
    if not depth[0] > MIN_DEPTH_M:
        return None
    toward = kf.pose[:3] - position
    toward = toward / np.linalg.norm(toward)
    size = np.array([kf.width, kf.height, kf.width, kf.height], dtype=np.float64)
    obs = observations.nearest(obj["id"], kf.captured_t, OBSERVATION_MATCH_MS)
    if obs is not None:
        box, source = _box(obs["box"]), "observation"
        assert box is not None
        score = obs.get("score")
        obs_score = float(score) if _is_number(score) else None
        outline = _outline(obs.get("outline"))
    else:
        uv, corner_depth = kf.project(box_corners(position, measured, toward))
        if not (corner_depth > MIN_DEPTH_M).all():
            return None
        px = np.array([*uv.min(axis=0), *uv.max(axis=0)])
        clipped = np.clip(px, 0.0, size)
        area = (px[2] - px[0]) * (px[3] - px[1])
        inside = (clipped[2] - clipped[0]) * (clipped[3] - clipped[1])
        if area <= 0 or inside / area < MIN_INSIDE:
            return None
        box, source, obs_score, outline = clipped / size, "projection", None, None
    if min((box[2] - box[0]) * kf.width, (box[3] - box[1]) * kf.height) < MIN_SHORT_SIDE_PX:
        return None
    view = View(kf, k, position, box, source, obs_score, outline, float(depth[0]), toward)
    view.score = _score(view, sharpness=0.5)
    return view


def _score(view: View, *, sharpness: float) -> float:
    kf, box = view.keyframe, view.box
    short = min((box[2] - box[0]) * kf.width, (box[3] - box[1]) * kf.height)
    size = min(1.0, short / (0.35 * min(kf.width, kf.height)))
    off = math.hypot((box[0] + box[2]) / 2 - 0.5, (box[1] + box[3]) / 2 - 0.5)
    centered = max(0.0, 1.0 - off / math.hypot(0.5, 0.5))
    if view.source == "observation":
        trust = (
            min(1.0, max(0.0, view.observation_score))
            if view.observation_score is not None
            else 0.6
        )
    else:
        trust = 0.3
    score = 0.35 * size + 0.15 * centered + 0.3 * sharpness + 0.2 * trust
    if view.source == "observation" and (min(box[:2]) < _EDGE or max(box[2:]) > 1 - _EDGE):
        score *= 0.75  # it may run out of the frame
    return score


def sharpness(crop: Image.Image) -> float:
    """0..1 from the variance of the Laplacian of the crop's gray levels, at a fixed scale."""
    gray = crop.convert("L")
    scale = SHARPNESS_PX / max(1, min(gray.size))
    gray = gray.resize(
        (max(3, round(gray.width * scale)), max(3, round(gray.height * scale))),
        Image.Resampling.BILINEAR,
    )
    variance = laplacian_variance(np.asarray(gray, dtype=np.float64))
    return variance / (variance + 100.0)


def laplacian_variance(gray: np.ndarray) -> float:
    g = np.asarray(gray, dtype=np.float64)
    if g.shape[0] < 3 or g.shape[1] < 3:
        return 0.0
    lap = g[1:-1, :-2] + g[1:-1, 2:] + g[:-2, 1:-1] + g[2:, 1:-1] - 4.0 * g[1:-1, 1:-1]
    return float(lap.var())


def _cut(image: Image.Image, box: np.ndarray, margin: float) -> Image.Image:
    return image.crop(_margin_rect(image.size, box, margin))


def _margin_rect(
    image_size: tuple[int, int], box: np.ndarray, margin: float = CROP_MARGIN
) -> tuple[int, int, int, int]:
    width, height = image_size
    x0, y0, x1, y1 = box
    dx, dy = (x1 - x0) * margin, (y1 - y0) * margin
    rect = (
        max(0, math.floor((x0 - dx) * width)),
        max(0, math.floor((y0 - dy) * height)),
        min(width, math.ceil((x1 + dx) * width)),
        min(height, math.ceil((y1 + dy) * height)),
    )
    return (rect[0], rect[1], max(rect[2], rect[0] + 1), max(rect[3], rect[1] + 1))


def save_crops(views: list[View], out_dir: Path, stem: str) -> list[dict[str, Any]]:
    """Write crop-<stem>-<n>.jpg (n from 1, best first); SceneCrop dicts for scene.json."""
    crops = []
    for n, view in enumerate(views, start=1):
        if view.crop is None:
            continue
        name = f"crop-{stem}-{n}.jpg"
        view.crop.save(out_dir / name, "JPEG", quality=JPEG_QUALITY)
        crops.append(
            {
                "file": name,
                "keyframe": view.keyframe.media,
                "box": [round(float(v), 4) + 0.0 for v in np.clip(view.box, 0.0, 1.0)],
                "from": view.source,
            }
        )
    return crops


def _box(value: Any) -> np.ndarray | None:
    if not isinstance(value, list | tuple) or len(value) != 4 or not all(map(_is_number, value)):
        return None
    box = np.clip(np.asarray(value, dtype=np.float64), 0.0, 1.0)
    return box if box[2] > box[0] and box[3] > box[1] else None


def _outline(value: Any) -> np.ndarray | None:
    if not isinstance(value, list) or len(value) < 3:
        return None
    try:
        points = np.asarray(value, dtype=np.float64)
    except (TypeError, ValueError):
        return None
    if points.ndim != 2 or points.shape[1] != 2 or not np.isfinite(points).all():
        return None
    return np.clip(points, 0.0, 1.0)


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)
