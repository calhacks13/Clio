"""Steady what the tracker answers, frame to frame, without making it late.

YOLOE's box and mask for the same object wobble by a few pixels from frame to frame, and its
outline can grow or lose a piece for a frame. Drawn as is, the outline shimmers. This module
filters what is returned (the box, the outline and its two points), never what is tracked:

- **The box** goes through a One Euro filter (Casiez et al., 2012): strong smoothing while the
  box is still, little while it moves, so it doesn't trail a moving object. The filter runs
  in the scene's frame of reference: the camera's own motion (motion.py) is applied to the
  filtered box first and is never smoothed, so turning the head adds no lag.
- **The outline** is blended in the box's own coordinates: each frame's mask, resampled to a
  grid over its box, is mixed with the previous blend. Moving and scaling with the box, the
  shape keeps up while one-frame glitches (a missing piece, a speck) don't show; a change that
  lasts two frames does.
- **The point and contact** are the blended mask's, eased the same way in box coordinates.

A box that jumps (it overlaps the last one, carried by the camera, by less than `jump_iou`)
starts over, so a new object is never morphed into from the last one.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np

from .geometry import Shape, iou, mask_shape
from .motion import warp_box
from .vision import MaskCrop


@dataclass(frozen=True)
class SmoothParams:
    min_cutoff: float = 1.5  # Hz: the One Euro cutoff when the box is still (lower: steadier)
    beta: float = 4.0  # the cutoff rises by this many Hz per box-size per second of motion
    d_cutoff: float = 1.5  # Hz: how the box's speed itself is smoothed
    mask_keep: float = 0.55  # share of the blended mask kept each frame: a glitch shows only
    # when the new frame alone outweighs it, i.e. it lasts two frames
    point_keep: float = 0.5  # the same for `point` and `contact`, in box coordinates
    jump_iou: float = 0.3  # a box overlapping the last one less than this starts over
    max_gap_s: float = 0.5  # nothing to smooth from after this long without an answer
    grid: int = 96  # the blended mask's longer side, in cells


@dataclass
class _State:
    t: float
    box: np.ndarray  # the filtered box, frame pixels
    raw: np.ndarray  # the last measured box
    speed: np.ndarray  # filtered rate of change of (cx, cy, w, h), box sizes per second
    mask: np.ndarray | None  # blended mask, 0..1, on a grid over the box
    point: np.ndarray | None  # in box coordinates (0..1)
    contact: np.ndarray | None


class Stabilizer:
    """One followed object's smoothing. Call `moved` once per frame, then `sighted` or
    `coasting`; `reset` when the object changes."""

    def __init__(self, params: SmoothParams | None = None):
        self.params = params or SmoothParams()
        self._s: _State | None = None

    def reset(self) -> None:
        self._s = None

    @property
    def velocity(self) -> np.ndarray:
        """How fast the box moves on its own (the camera's motion taken out), as filtered for the
        cutoff: the rate of change of (cx, cy, w, h) in box sizes a second. 0 before any box."""
        return np.zeros(4) if self._s is None else self._s.speed.copy()

    @property
    def speed(self) -> float:
        """`velocity`'s length: the centre and the size together."""
        return float(np.linalg.norm(self.velocity))

    def moved(self, camera: np.ndarray | None) -> None:
        """The camera moved by this 2x3 transform since the last frame: carry everything along."""
        if self._s is None or camera is None:
            return
        self._s.box = warp_box(self._s.box, camera)
        self._s.raw = warp_box(self._s.raw, camera)

    def sighted(
        self,
        t: float,
        box: np.ndarray,
        crop: MaskCrop | None,
        size: tuple[int, int],
        fallback: Shape | None = None,
    ) -> tuple[np.ndarray, Shape | None]:
        """This frame's measured box and mask: the box and shape to show."""
        box = np.asarray(box, dtype=np.float32)
        cells = _sample(crop, box, self._grid(box)) if crop is not None else None
        s = self._s
        p = self.params
        if (
            s is None
            or t - s.t > p.max_gap_s
            or t <= s.t
            or float(iou(s.raw, box)[0, 0]) < p.jump_iou
        ):
            self._s = s = _State(t, box.copy(), box.copy(), np.zeros(4), cells, None, None)
        else:
            s.box = self._filter(s, box, t - s.t)
            s.raw, s.t = box.copy(), t
            if cells is not None:
                if s.mask is None:
                    s.mask = cells
                else:
                    old = cv2.resize(s.mask, cells.shape[::-1], interpolation=cv2.INTER_LINEAR)
                    s.mask = p.mask_keep * old + (1 - p.mask_keep) * cells
        if s.mask is None:
            return s.box.copy(), fallback
        return s.box.copy(), self._shape(s, size)

    def coasting(
        self, t: float, box: np.ndarray, size: tuple[int, int]
    ) -> tuple[np.ndarray, Shape | None]:
        """No sighting on this frame; `box` is where the object is predicted to be."""
        s = self._s
        box = np.asarray(box, dtype=np.float32)
        if s is None:
            return box.copy(), None
        if t > s.t:
            s.box = self._filter(s, box, t - s.t)
            s.raw, s.t = box.copy(), t
        return s.box.copy(), self._shape(s, size) if s.mask is not None else None

    # --- internals -------------------------------------------------------------------------

    def _grid(self, box: np.ndarray) -> tuple[int, int]:
        """(rows, cols) of a grid over `box` with square cells and `grid` cells on its long side."""
        w, h = max(float(box[2] - box[0]), 1.0), max(float(box[3] - box[1]), 1.0)
        n = self.params.grid
        return (max(2, round(n * h / max(w, h))), max(2, round(n * w / max(w, h))))

    def _filter(self, s: _State, box: np.ndarray, dt: float) -> np.ndarray:
        """One Euro on (cx, cy, w, h), relative to the box's size."""
        p = self.params
        prev, meas = _cxcywh(s.box), _cxcywh(box)
        size = max(math.sqrt(max(prev[2] * prev[3], 1.0)), 1.0)
        rate = (meas - prev) / size / dt
        a_d = _alpha(p.d_cutoff, dt)
        s.speed = a_d * rate + (1 - a_d) * s.speed
        cutoff = p.min_cutoff + p.beta * np.abs(s.speed)
        a = np.array([_alpha(c, dt) for c in cutoff])
        out = prev + a * (meas - prev)
        out[2:] = np.maximum(out[2:], 1.0)
        return _xyxy(out)

    def _shape(self, s: _State, size: tuple[int, int]) -> Shape | None:
        assert s.mask is not None
        p = self.params
        rows, cols = s.mask.shape
        b = s.box
        bw, bh = max(float(b[2] - b[0]), 1e-3), max(float(b[3] - b[1]), 1e-3)
        shape = mask_shape(
            s.mask > 0.5, (float(b[0]), float(b[1])), (bw / cols, bh / rows), *size, b
        )
        if shape.outline is None:
            return shape
        w, h = size
        ridge = _ridge_point(s.mask > 0.5)
        if ridge is not None:
            point = np.array([(ridge[0] + 0.5) / cols, (ridge[1] + 0.5) / rows])
        else:
            point = np.array([(shape.point[0] * w - b[0]) / bw, (shape.point[1] * h - b[1]) / bh])
        s.point = point if s.point is None else p.point_keep * s.point + (1 - p.point_keep) * point
        out_point = _from_box(s.point, b, size)
        out_contact = None
        if shape.contact is not None:
            c = np.array([(shape.contact[0] * w - b[0]) / bw, (shape.contact[1] * h - b[1]) / bh])
            s.contact = (
                c if s.contact is None else p.point_keep * s.contact + (1 - p.point_keep) * c
            )
            out_contact = _from_box(s.contact, b, size)
        return Shape(shape.outline, out_point, out_contact)


def _ridge_point(mask: np.ndarray, near: float = 0.85) -> tuple[float, float] | None:
    """A steadier `point`: the middle of where the largest piece is deepest (within `near` of
    its deepest), rather than the single deepest pixel, which hops along the ridge of a long
    shape from frame to frame. Mask pixels (x, y); None for an empty mask."""
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    if n <= 1:
        return None
    piece = (labels == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)
    depth = cv2.distanceTransform(piece, cv2.DIST_L2, 3)
    ys, xs = np.nonzero(depth >= near * float(depth.max()))
    cx, cy = float(xs.mean()), float(ys.mean())
    if depth[int(round(cy)), int(round(cx))] > 0:
        return cx, cy
    k = int(np.argmin((xs - cx) ** 2 + (ys - cy) ** 2))  # a bent ridge: its nearest point
    return float(xs[k]), float(ys[k])


def _sample(crop: MaskCrop, box: np.ndarray, grid: tuple[int, int]) -> np.ndarray:
    """The crop's mask as 0..1 on a rows x cols grid spanning `box` (cell centres)."""
    rows, cols = grid
    bw, bh = float(box[2] - box[0]), float(box[3] - box[1])
    # crop pixel = (frame - origin) / scale - 0.5, frame = box0 + (cell + 0.5) * size / n
    sx, sy = bw / cols / crop.scale, bh / rows / crop.scale
    tx = (float(box[0]) - crop.origin[0]) / crop.scale + 0.5 * sx - 0.5
    ty = (float(box[1]) - crop.origin[1]) / crop.scale + 0.5 * sy - 0.5
    m = np.array([[sx, 0, tx], [0, sy, ty]], dtype=np.float64)
    prob = 1.0 / (1.0 + np.exp(-np.clip(crop.logits, -30, 30)))
    return cv2.warpAffine(
        prob.astype(np.float32),
        m,
        (cols, rows),
        flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0.0,
    )


def _alpha(cutoff: float, dt: float) -> float:
    tau = 1.0 / (2 * math.pi * max(cutoff, 1e-6))
    return 1.0 / (1.0 + tau / max(dt, 1e-6))


def _cxcywh(b: np.ndarray) -> np.ndarray:
    return np.array([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, b[2] - b[0], b[3] - b[1]], np.float64)


def _xyxy(c: np.ndarray) -> np.ndarray:
    return np.array(
        [c[0] - c[2] / 2, c[1] - c[3] / 2, c[0] + c[2] / 2, c[1] + c[3] / 2], dtype=np.float32
    )


def _from_box(rel: np.ndarray, box: np.ndarray, size: tuple[int, int]) -> list[float]:
    w, h = size
    x = (box[0] + rel[0] * (box[2] - box[0])) / w
    y = (box[1] + rel[1] * (box[3] - box[1])) / h
    return [round(float(min(1.0, max(0.0, x))), 4), round(float(min(1.0, max(0.0, y))), 4)]
