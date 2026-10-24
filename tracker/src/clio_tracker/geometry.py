"""Boxes, letterboxing and mask outlines.

Boxes are `[x1, y1, x2, y2]`. Inside the tracker they are in pixels of the camera frame; on the
wire they are normalized to 0..1 of the frame (x right, y down), as in docs/object-finder.md.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

PAD_VALUE = 114  # YOLO's gray letterbox padding
CONTACT_BAND = 0.03


@dataclass(frozen=True)
class Letterbox:
    """How a camera frame was scaled and padded into the square model input."""

    width: int  # the camera frame
    height: int
    size: int  # the square model input
    gain: float
    left: int
    top: int

    def to_input(self, boxes: np.ndarray) -> np.ndarray:
        """Frame pixels to model-input pixels."""
        out = np.asarray(boxes, dtype=np.float32) * self.gain
        out[..., 0::2] += self.left
        out[..., 1::2] += self.top
        return out

    def to_frame(self, boxes: np.ndarray) -> np.ndarray:
        """Model-input pixels to frame pixels, clipped to the frame."""
        out = np.asarray(boxes, dtype=np.float32).copy()
        out[..., 0::2] = (out[..., 0::2] - self.left) / self.gain
        out[..., 1::2] = (out[..., 1::2] - self.top) / self.gain
        out[..., 0::2] = out[..., 0::2].clip(0, self.width)
        out[..., 1::2] = out[..., 1::2].clip(0, self.height)
        return out


def letterbox(rgb: np.ndarray, size: int) -> tuple[np.ndarray, Letterbox]:
    """Fit an HxWx3 frame into size x size without distortion, the way Ultralytics does."""
    h, w = rgb.shape[:2]
    gain = min(size / h, size / w)
    nw, nh = round(w * gain), round(h * gain)
    left = round((size - nw) / 2 - 0.1)
    top = round((size - nh) / 2 - 0.1)
    out = np.full((size, size, 3), PAD_VALUE, dtype=np.uint8)
    interp = cv2.INTER_AREA if gain < 1 else cv2.INTER_LINEAR
    out[top : top + nh, left : left + nw] = cv2.resize(rgb, (nw, nh), interpolation=interp)
    return out, Letterbox(w, h, size, gain, left, top)


def iou(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Pairwise IoU of (N, 4) and (M, 4) boxes: (N, M)."""
    a = np.asarray(a, dtype=np.float32).reshape(-1, 4)
    b = np.asarray(b, dtype=np.float32).reshape(-1, 4)
    x1 = np.maximum(a[:, None, 0], b[None, :, 0])
    y1 = np.maximum(a[:, None, 1], b[None, :, 1])
    x2 = np.minimum(a[:, None, 2], b[None, :, 2])
    y2 = np.minimum(a[:, None, 3], b[None, :, 3])
    inter = (x2 - x1).clip(0) * (y2 - y1).clip(0)
    area_a = (a[:, 2] - a[:, 0]).clip(0) * (a[:, 3] - a[:, 1]).clip(0)
    area_b = (b[:, 2] - b[:, 0]).clip(0) * (b[:, 3] - b[:, 1]).clip(0)
    union = area_a[:, None] + area_b[None, :] - inter
    return np.where(union > 0, inter / np.maximum(union, 1e-9), 0.0)


def nms(boxes: np.ndarray, scores: np.ndarray, threshold: float) -> np.ndarray:
    """Indices of the boxes kept by greedy non-maximum suppression, best first."""
    order = np.argsort(-scores)
    keep: list[int] = []
    while order.size:
        i = int(order[0])
        keep.append(i)
        if order.size == 1:
            break
        overlap = iou(boxes[i], boxes[order[1:]])[0]
        order = order[1:][overlap < threshold]
    return np.asarray(keep, dtype=np.int64)


def valid_box(box: np.ndarray | None, min_size: float = 1.0) -> bool:
    """Finite, ordered, and at least min_size wide and high."""
    if box is None:
        return False
    b = np.asarray(box, dtype=np.float64)
    return bool(
        b.shape == (4,)
        and np.all(np.isfinite(b))
        and b[2] - b[0] >= min_size
        and b[3] - b[1] >= min_size
    )


def touches_edge(box: np.ndarray, width: int, height: int, margin: float = 0.02) -> bool:
    """The box reaches within `margin` (a fraction of the frame) of any frame edge."""
    mx, my = width * margin, height * margin
    return bool(box[0] <= mx or box[1] <= my or box[2] >= width - mx or box[3] >= height - my)


def normalize_box(box: np.ndarray, width: int, height: int) -> list[float]:
    return [
        _unit(box[0] / width),
        _unit(box[1] / height),
        _unit(box[2] / width),
        _unit(box[3] / height),
    ]


def _unit(v: float) -> float:
    return round(float(min(1.0, max(0.0, v))), 4)


@dataclass(frozen=True)
class Shape:
    """A mask turned into what Clio draws and lifts: one outer contour and two points."""

    outline: list[list[float]] | None  # normalized [x, y] points, not closed
    point: list[float]  # normalized; the mask's pole of inaccessibility, else the box center
    # The middle of the mask's lowest edge, where the object most likely rests on a surface
    # (TRACK.md); None without a mask.
    contact: list[float] | None = None


def mask_shape(
    mask: np.ndarray,
    origin: tuple[float, float],
    scale: float,
    width: int,
    height: int,
    box: np.ndarray,
    max_points: int = 64,
) -> Shape:
    """Outline and point of a boolean mask whose pixel (0, 0) sits at `origin` in frame pixels.

    `scale` is frame pixels per mask pixel. Only the largest connected piece is kept, because a
    Clio outline is one closed polygon.
    """
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    center = [_unit(cx / width), _unit(cy / height)]
    m = mask.astype(np.uint8)
    if m.sum() < 4:
        return Shape(None, center)
    contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return Shape(None, center)
    contour = max(contours, key=cv2.contourArea)
    if cv2.contourArea(contour) < 4:
        return Shape(None, center)
    eps = 0.004 * cv2.arcLength(contour, closed=True)
    poly = cv2.approxPolyDP(contour, eps, closed=True).reshape(-1, 2)
    while len(poly) > max_points:
        eps *= 1.5
        poly = cv2.approxPolyDP(contour, eps, closed=True).reshape(-1, 2)
    if len(poly) < 3:
        return Shape(None, center)

    # The point deepest inside the largest piece: a better place to lift into 3D than the box
    # center, which can fall outside an L-shaped or hollow object.
    piece = np.zeros_like(m)
    cv2.drawContours(piece, [contour], -1, 1, thickness=cv2.FILLED)
    depth = cv2.distanceTransform(piece, cv2.DIST_L2, 3)
    py, px = np.unravel_index(int(np.argmax(depth)), depth.shape)

    # The contact point, as the jev finder defined it: the middle of the piece's bottom 3% of
    # rows (at least one), on the bottom pixel edge, so one stray pixel doesn't decide it.
    rows = np.flatnonzero(piece.any(axis=1))
    bottom = int(rows[-1])
    band = max(1, round(CONTACT_BAND * (bottom - int(rows[0]) + 1)))
    cols = np.nonzero(piece[bottom - band + 1 : bottom + 1])[1]
    cx_px, cy_px = (cols.min() + cols.max() + 1) / 2, bottom + 1

    ox, oy = origin
    outline = [
        [_unit((ox + (x + 0.5) * scale) / width), _unit((oy + (y + 0.5) * scale) / height)]
        for x, y in poly.tolist()
    ]
    point = [_unit((ox + (px + 0.5) * scale) / width), _unit((oy + (py + 0.5) * scale) / height)]
    contact = [_unit((ox + cx_px * scale) / width), _unit((oy + cy_px * scale) / height)]
    return Shape(outline, point, contact)
