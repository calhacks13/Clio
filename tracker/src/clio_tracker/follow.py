"""A mask carried to every frame by its own pixels: the outline that moves with the part.

The segmenter (segment.py) cuts the target out cleanly, but only about once a second: on jev's
frame, and again when asked. In between, a part moves on its own (a door swings, a jaw slides)
as well as with the camera, and an outline that waits for the next answer freezes or lags. So
the latest mask is carried to each frame by the motion of points inside it: the same sparse
Lucas-Kanade flow, forward-backward check and RANSAC as motion.py, seeded inside the warped
mask rather than over the whole frame. A full affine when enough points agree (a door turning
away foreshortens) and it stretches no more than a part can from one frame to the next, else a
similarity, on a frame scaled to 480 pixels wide: about 1 ms a frame, plus about 2 ms to scale
a 1280x960 frame down. While the points can be trusted they are seeded again inside the warped
mask every `redetect_every` frames, and as soon as fewer than twice `min_inliers` are left (a
hand passing in front takes some with it each time), so they don't simply run out.

A glance moves the whole picture 60 to 100 pixels a frame, far beyond what the flow finds on
its own (about 15 on fine texture). So each point's search starts where the camera's motion
(motion.py's, handed to every step) and the part's own motion on the frame before would put it,
as motion.py starts its own from a phase correlation; the flow only finds what is left.

A mask is measured on an older frame (jev's, or the one a refresh was asked on), so the motion
of every frame is logged, also before there is any mask, and a mask that arrives late is
carried by the motions since its own frame (one from before the log is ignored). A mask from
before the current one's frame is ignored too, unless it replaces it: jev's keyframe does, also
when a refresh of a newer frame landed while jev answered. When the
points can't be trusted (too few survive, too few agree, the region is leaving the view) the
follower says so and carries the mask by the camera's motion alone. It seeds no new points
until a new mask arrives, so it never settles on the background a mask has slid onto; the
tracker asks the segmenter for that new mask. A region whose mask holds too few corners to
follow at all (a white door) is `sparse`: unsure only for want of texture, in view, carried by
the camera's motion; the tracker may still draw that mask while it agrees with what YOLOE sees.
"""

from __future__ import annotations

import logging
import math
from collections import deque
from dataclasses import dataclass

import cv2
import numpy as np

from .motion import compose
from .vision import OUTSIDE, MaskCrop

log = logging.getLogger("clio_tracker")

KEEP = 300  # frames of motion remembered, for a mask measured on an older frame
EDGE = 3  # points are seeded at least this many tracked-frame pixels inside the mask's edge
LK = {"winSize": (15, 15), "maxLevel": 3}
IDENTITY = np.array([[1.0, 0, 0], [0, 1.0, 0]])
NO_POINTS = np.empty((0, 1, 2), np.float32)
STRETCH = (0.5, 2.0)  # bounds on each singular value of one frame's affine (its linear part)
SKEW = 1.5  # and on the larger over the smaller: beyond either it is a bad fit, not a part


@dataclass(frozen=True)
class FollowParams:
    max_width: int = 480  # frames wider than this are tracked at this width
    max_corners: int = 120
    min_inliers: int = 8
    affine_inliers: int = 12
    redetect_every: int = 10  # frames between re-seeding points inside the warped mask
    fb_max_px: float = 1.0  # forward-backward error, in tracked-frame pixels
    doubt_ratio: float = 0.5  # inliers / points tracked, below this is doubt
    in_view: float = 0.25  # share of the warped box inside the frame
    crop_side: int = 256


@dataclass
class Followed:
    box: np.ndarray  # frame pixels, bounds of the warped mask
    crop: MaskCrop  # the warped mask
    inliers: int
    ratio: float
    confident: bool
    # Unsure only because the mask held too few corners to follow when last seeded, and in
    # view: carried by the camera's motion alone, with no points that disagreed.
    sparse: bool = False


@dataclass
class _Region:
    crop: MaskCrop  # the reference mask
    corners: np.ndarray  # its mask's bounds as four corners, in reference-crop pixels
    t: np.ndarray  # reference-crop pixels to the last frame's pixels, 2x3
    points: np.ndarray | None = None  # on the last frame, tracked pixels; None: seed first
    age: int = 0  # steps since the points were seeded
    sparse: bool = False  # the last seeding found fewer than `min_inliers` corners


class RegionFollower:
    """One region's mask, carried from frame to frame. Call `step` for every frame in order,
    with or without a mask, and `set_reference` whenever the segmenter answers."""

    def __init__(self, params: FollowParams | None = None):
        self.params = params or FollowParams()
        self._log: deque[tuple[int, np.ndarray]] = deque(maxlen=KEEP)  # (seq, last frame to it)
        self._prev: np.ndarray | None = None  # the last frame, at tracking size
        self._size: tuple[int, int] | None = None  # the last frame's (height, width)
        self._scale = 1.0  # tracked-frame pixels per frame pixel
        self._seq: int | None = None  # the newest accepted mask's frame
        self._pending: tuple[int, MaskCrop] | None = None
        self._region: _Region | None = None
        self._own: np.ndarray | None = None  # the part's motion beyond the camera's, last step

    @property
    def active(self) -> bool:
        return self._seq is not None

    @property
    def reference_seq(self) -> int | None:
        return self._seq

    def set_reference(self, seq: int, crop: MaskCrop, replace: bool = False) -> None:
        """A mask measured on frame `seq`. It takes over on the next step, carried by the motion
        logged since `seq`. A mask from before the current one's frame is ignored unless it is
        to `replace` it (jev's keyframe, which wins over a refresh that landed after jev's
        frame). Ignored always: a mask with nothing inside, and one from before the oldest frame
        logged, which can't be carried to now."""
        older = self._seq is not None and seq < self._seq
        if (older and not replace) or not (crop.logits > 0).any():
            return
        oldest = self._log[0][0] if self._log else seq
        if seq < oldest:
            log.debug("Follower: frame %d's mask is older than the log (%d on)", seq, oldest)
            return
        self._seq, self._pending = seq, (seq, crop)

    def clear(self) -> None:
        """Forget the region and its mask. The motion log stays, so a new mask measured on an
        older frame is still carried to now."""
        self._seq = self._pending = self._region = self._own = None

    def step(
        self, seq: int, gray: np.ndarray, camera: np.ndarray | None, t: float
    ) -> Followed | None:
        """Frame `seq` (the full frame, 8-bit gray) and the camera's motion from the frame before
        (None when unknown). The region on this frame, or None while there is no mask. (`t` is
        not used: motion is measured frame to frame.) The follower keeps its own copies of both,
        so the caller may reuse its arrays."""
        if self._size is not None and gray.shape[:2] != self._size:
            self.clear()  # another frame size: nothing measured on the old one carries over,
            self._log.clear()  # a pending mask included
            self._prev = None
        prev, small = self._prev, self._shrink(gray)
        self._prev, self._size = small, gray.shape[:2]
        fresh = self._adopt(seq) if self._pending is not None else False
        fallback = IDENTITY if camera is None else np.array(camera, dtype=np.float64, copy=True)
        region = self._region
        if region is None:
            self._log.append((seq, fallback))
            return None
        p = self.params
        measured = not fresh and prev is not None
        estimate, inliers, ratio, points = None, 0, 0.0, NO_POINTS
        if measured:
            guess = fallback if self._own is None else compose(self._own, fallback)
            estimate, inliers, ratio, points = self._measure(region, prev, small, guess)
        confident = (
            estimate is not None
            and inliers >= p.min_inliers
            and ratio >= p.doubt_ratio
            and self._in_view(_bounds(compose(estimate, region.t), region.corners)) >= p.in_view
        )
        m = estimate if confident else fallback
        if not fresh:  # a mask from this very frame is already where it belongs
            region.t = compose(m, region.t)
        self._log.append((seq, m))
        if confident:
            region.age += 1
            if region.age >= p.redetect_every or len(points) < 2 * p.min_inliers:
                region.points, region.age = None, 0  # seeded on this frame, at the next step
            else:
                region.points = points
            self._own = compose(estimate, cv2.invertAffineTransform(fallback))
        elif measured:
            region.points = NO_POINTS  # in doubt: no new points until a new mask
            self._own = None
        box = _bounds(region.t, region.corners)
        sparse = not confident and region.sparse and self._in_view(box) >= p.in_view
        return self._followed(region, inliers, ratio, confident, sparse)

    def _shrink(self, gray: np.ndarray) -> np.ndarray:
        """`gray` at tracking size, as an array of the follower's own: the scaled-down frame is a
        new one already, a frame no wider than `max_width` is copied."""
        h, w = gray.shape[:2]
        self._scale = min(1.0, self.params.max_width / w)
        if self._scale == 1.0:
            return gray.copy()
        size = (round(w * self._scale), round(h * self._scale))
        return cv2.resize(gray, size, interpolation=cv2.INTER_AREA)

    def _adopt(self, seq: int) -> bool:
        """Follow the pending mask from now on, carried to the last frame by the motion logged
        since its own. True when it is from this frame, so there is nothing to carry."""
        ref_seq, crop = self._pending
        self._pending = None
        carried = IDENTITY
        for s, m in self._log:
            if s > ref_seq:
                carried = compose(m, carried)
        placed = np.array([[crop.scale, 0, crop.origin[0]], [0, crop.scale, crop.origin[1]]])
        self._region = _Region(crop, _corners(crop.logits), compose(carried, placed))
        return ref_seq >= seq

    def _measure(
        self, region: _Region, prev: np.ndarray, gray: np.ndarray, guess: np.ndarray
    ) -> tuple[np.ndarray | None, int, float, np.ndarray]:
        """The region's motion from `prev` to `gray` in frame pixels, the number of RANSAC
        inliers, their share of the points tracked, and where the inliers are now. The flow
        starts from `guess` (frame pixels) both ways, so the check back still has to find what
        the guess missed on its own."""
        p = self.params
        points = region.points
        if points is None:
            points = self._seed(region, prev)
            region.sparse = len(points) < p.min_inliers
        if len(points) < p.min_inliers:
            return None, 0, 0.0, NO_POINTS
        ahead = guess.copy()
        ahead[:, 2] *= self._scale  # to tracked pixels (the linear part is the same at any scale)
        lk = {"flags": cv2.OPTFLOW_USE_INITIAL_FLOW, **LK}
        moved, ok, _ = cv2.calcOpticalFlowPyrLK(prev, gray, points, _carry(points, ahead), **lk)
        behind = _carry(moved, cv2.invertAffineTransform(ahead))
        back, ok_back, _ = cv2.calcOpticalFlowPyrLK(gray, prev, moved, behind, **lk)
        good = (ok.ravel() == 1) & (ok_back.ravel() == 1)
        good &= np.linalg.norm((back - points).reshape(-1, 2), axis=1) < p.fb_max_px
        m, keep, _ = _fit(points[good], moved[good], p)
        if m is None:
            return None, 0, 0.0, NO_POINTS
        m[:, 2] /= self._scale  # back to frame pixels (the linear part is the same at any scale)
        inliers = int(keep.sum())
        return m, inliers, inliers / len(points), moved[good][keep]

    def _seed(self, region: _Region, gray: np.ndarray) -> np.ndarray:
        """Corners inside the region's mask on `gray`, the frame `region.t` is for. They keep
        EDGE pixels from the mask's edge, so a corner is the region's own texture and not its
        outline against whatever is behind it."""
        h, w = gray.shape
        logits = _paint(region.crop, region.t, (0.0, 0.0), 1.0 / self._scale, (w, h))
        inside = cv2.erode((logits > 0).astype(np.uint8), np.ones((2 * EDGE + 1,) * 2, np.uint8))
        p = self.params
        found = cv2.goodFeaturesToTrack(gray, p.max_corners, 0.01, 5, mask=inside)
        return NO_POINTS if found is None else found

    def _in_view(self, box: np.ndarray) -> float:
        """The share of `box` inside the frame."""
        h, w = self._size
        across = max(0.0, min(box[2], w) - max(box[0], 0))
        down = max(0.0, min(box[3], h) - max(box[1], 0))
        return across * down / max(float((box[2] - box[0]) * (box[3] - box[1])), 1e-9)

    def _followed(
        self, region: _Region, inliers: int, ratio: float, confident: bool, sparse: bool
    ) -> Followed:
        """The reference mask warped onto a crop over its bounds on the last frame, the crop's
        longer side at most `crop_side` pixels (and no finer than the frame's)."""
        box = _bounds(region.t, region.corners)
        w, h = float(box[2] - box[0]), float(box[3] - box[1])
        scale = max(1.0, max(w, h) / self.params.crop_side)
        size = (max(1, math.ceil(w / scale - 1e-6)), max(1, math.ceil(h / scale - 1e-6)))
        origin = (float(box[0]), float(box[1]))
        logits = _paint(region.crop, region.t, origin, scale, size)
        crop = MaskCrop(logits, origin, scale)
        return Followed(box, crop, inliers, ratio, confident, sparse)


def _estimate(
    points: np.ndarray, moved: np.ndarray, params: FollowParams | None = None
) -> tuple[np.ndarray | None, int, str]:
    """The motion taking `points` to `moved` (N points, in any one unit), how many points agree
    on it and which it is: "affine", "similarity" or "none" (and no motion), as `_fit` chooses."""
    m, keep, kind = _fit(points, moved, params or FollowParams())
    return m, int(keep.sum()), kind


def _fit(
    a: np.ndarray, b: np.ndarray, p: FollowParams
) -> tuple[np.ndarray | None, np.ndarray, str]:
    """A full affine when `affine_inliers` points agree on one that stretches as a part can
    (`_plausible`), else a similarity, on the same points, when `min_inliers` agree on one;
    None when neither. With the inlier mask and which it is."""
    for estimate, need, kind in (
        (cv2.estimateAffine2D, p.affine_inliers, "affine"),
        (cv2.estimateAffinePartial2D, p.min_inliers, "similarity"),
    ):
        if len(a) < need:
            continue
        m, keep = estimate(a, b, method=cv2.RANSAC, ransacReprojThreshold=2.0)
        if m is None or keep is None or keep.sum() < need:
            continue
        if kind == "affine" and not _plausible(m):
            continue
        return m.astype(np.float64), keep.ravel() == 1, kind
    return None, np.zeros(len(a), dtype=bool), "none"


def _plausible(m: np.ndarray) -> bool:
    """Whether the 2x3 `m` stretches no more than a part can from one frame to the next: each
    singular value of its linear part within STRETCH, the larger at most SKEW times the
    smaller. (Nearly collinear points leave an affine free to stretch across them.)"""
    big, small = np.linalg.svd(m[:, :2], compute_uv=False)
    return STRETCH[0] <= small and big <= STRETCH[1] and big <= SKEW * small


def _corners(logits: np.ndarray) -> np.ndarray:
    """The bounds of `logits > 0` as four corners, in crop pixels (pixel i spans i to i + 1)."""
    ys, xs = np.nonzero(logits > 0)
    x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    return np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], dtype=np.float64)


def _carry(points: np.ndarray, m: np.ndarray) -> np.ndarray:
    """(N, 1, 2) points moved by the 2x3 transform `m`, as float32 for the flow."""
    return (points @ m[:, :2].T.astype(np.float32) + m[:, 2].astype(np.float32)).astype(np.float32)


def _bounds(t: np.ndarray, corners: np.ndarray) -> np.ndarray:
    """The axis-aligned box around `corners` carried by `t`, in frame pixels."""
    moved = corners @ t[:, :2].T + t[:, 2]
    return np.concatenate([moved.min(axis=0), moved.max(axis=0)]).astype(np.float32)


def _paint(
    crop: MaskCrop,
    t: np.ndarray,
    origin: tuple[float, float],
    scale: float,
    size: tuple[int, int],
) -> np.ndarray:
    """`crop`'s logits carried by `t` (crop pixels to frame pixels) onto a `size` (cols, rows)
    grid whose pixel (0, 0) is at `origin` in frame pixels and whose pixels are `scale` frame
    pixels, as MaskCrop counts them. Outside the crop is OUTSIDE."""
    centre = np.array([[1.0, 0, 0.5], [0, 1.0, 0.5]])  # pixel index to its centre's position
    grid = np.array(
        [[1 / scale, 0, -origin[0] / scale - 0.5], [0, 1 / scale, -origin[1] / scale - 0.5]]
    )
    m = compose(grid, compose(t, centre))
    return cv2.warpAffine(
        crop.logits,
        m,
        size,
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=OUTSIDE,
    )
