"""How the camera moved between two frames, from the pixels: a similarity transform.

The headset's camera turns with the wearer's head, so most of what moves in the frame moves
together. Knowing that motion lets the tracker carry every track, every coasting outline and
the smoothed output along with the picture (ByteTrack's Kalman filter alone assumes a steady
velocity, which a glance breaks), and lets jev's box, measured a second or two ago, be moved
to where its object is now. BoT-SORT calls this global motion compensation; this is its
sparse-optical-flow method, with a forward-backward check and a phase-correlation guess for
fast glances, on a frame scaled to 240 pixels wide: about 1.5 ms.
"""

from __future__ import annotations

from collections import deque

import cv2
import numpy as np

MAX_WIDTH = 240  # frames are scaled down to at most this width first


class CameraMotion:
    """Feed every frame in order; `update` answers the motion since the frame before, and
    `since` the motion from an earlier frame (the last `keep` are remembered) to the newest."""

    def __init__(self, max_corners: int = 160, min_inliers: int = 12, keep: int = 300):
        self.max_corners = max_corners
        self.min_inliers = min_inliers
        self._prev: np.ndarray | None = None
        self._points: np.ndarray | None = None
        self._scale = 1.0
        self._log: deque[tuple[int, np.ndarray | None]] = deque(maxlen=keep)

    def reset(self) -> None:
        self._prev = self._points = None

    def since(self, seq: int) -> np.ndarray:
        """How the picture moved from frame `seq` to the newest frame. Steps that couldn't be
        measured, and frames from before the log, count as no motion."""
        total = np.array([[1.0, 0, 0], [0, 1.0, 0]])
        for s, m in self._log:
            if s > seq and m is not None:
                total = compose(m, total)
        return total

    def update(self, rgb: np.ndarray | None, seq: int | None = None) -> np.ndarray | None:
        """The 2x3 transform taking the last frame's pixels to this one's (frame `seq`), or None
        when it can't be told (the first frame, too little texture, or a frame of another
        size)."""
        m = self._measure(rgb)
        if seq is not None:
            self._log.append((seq, m))
        return m

    def _measure(self, rgb: np.ndarray | None) -> np.ndarray | None:
        if rgb is None:
            self.reset()
            return None
        h, w = rgb.shape[:2]
        scale = min(1.0, MAX_WIDTH / w)
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY) if rgb.ndim == 3 else rgb
        if scale < 1:
            gray = cv2.resize(
                gray, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA
            )
        prev, points = self._prev, self._points
        same_size = prev is not None and prev.shape == gray.shape and scale == self._scale
        self._prev, self._scale = gray, scale
        self._points = cv2.goodFeaturesToTrack(
            gray, self.max_corners, qualityLevel=0.01, minDistance=7, blockSize=5
        )
        if not same_size or points is None or len(points) < self.min_inliers:
            return None
        # A quick glance moves the picture 100 px a frame or more, beyond what optical flow
        # finds on its own: phase correlation of the two frames gives it a starting guess.
        shift, sure = _shift(prev, gray)
        # When the flow fails (a blurred glance), the phase correlation alone, if it is clear.
        fallback = (
            np.array([[1.0, 0, shift[0] / scale], [0, 1.0, shift[1] / scale]]) if sure else None
        )
        guess = (points + shift.astype(np.float32)).astype(np.float32)
        lk = {"winSize": (15, 15), "maxLevel": 3}
        moved, ok, _ = cv2.calcOpticalFlowPyrLK(
            prev, gray, points, guess, flags=cv2.OPTFLOW_USE_INITIAL_FLOW, **lk
        )
        back, ok_back, _ = cv2.calcOpticalFlowPyrLK(gray, prev, moved, None, **lk)
        good = (ok.ravel() == 1) & (ok_back.ravel() == 1)
        good &= np.linalg.norm((back - points).reshape(-1, 2), axis=1) < 0.7
        if good.sum() < self.min_inliers:
            return fallback
        m, inliers = cv2.estimateAffinePartial2D(
            points[good], moved[good], method=cv2.RANSAC, ransacReprojThreshold=1.0
        )
        if m is None or inliers is None or inliers.sum() < self.min_inliers:
            return fallback
        m = m.astype(np.float64)
        m[:, 2] /= scale  # back to frame pixels (the linear part is the same at any scale)
        return m


def _shift(prev: np.ndarray, gray: np.ndarray) -> tuple[np.ndarray, bool]:
    """The translation from `prev` to `gray` by phase correlation at half their size, and
    whether its peak is clear enough to use on its own (zero when it isn't clear at all)."""
    a = cv2.resize(prev, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA).astype(np.float32)
    b = cv2.resize(gray, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA).astype(np.float32)
    window = cv2.createHanningWindow(a.shape[::-1], cv2.CV_32F)
    (dx, dy), response = cv2.phaseCorrelate(a, b, window)
    if response < 0.05:
        return np.zeros(2), False
    return np.array([dx, dy]) * 2, response >= 0.15


def compose(later: np.ndarray, earlier: np.ndarray) -> np.ndarray:
    """`earlier` then `later`, both 2x3."""
    a = np.vstack([later, [0, 0, 1]])
    b = np.vstack([earlier, [0, 0, 1]])
    return (a @ b)[:2]


def warp_box(box: np.ndarray, m: np.ndarray | None) -> np.ndarray:
    """An axis-aligned box carried by a similarity transform (rotation is small frame to frame:
    the box keeps its centre's path and scales with the transform)."""
    b = np.asarray(box, dtype=np.float32)
    if m is None:
        return b.copy()
    s = float(np.sqrt(abs(np.linalg.det(m[:, :2]))))
    c = m[:, :2] @ np.array([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]) + m[:, 2]
    hw, hh = s * (b[2] - b[0]) / 2, s * (b[3] - b[1]) / 2
    return np.array([c[0] - hw, c[1] - hh, c[0] + hw, c[1] + hh], dtype=np.float32)


def warp_point(p, m: np.ndarray | None) -> np.ndarray:
    p = np.asarray(p, dtype=np.float64)
    return p.copy() if m is None else m[:, :2] @ p + m[:, 2]


def scale_of(m: np.ndarray | None) -> float:
    return 1.0 if m is None else float(np.sqrt(abs(np.linalg.det(m[:, :2]))))
