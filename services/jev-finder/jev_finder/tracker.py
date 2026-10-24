"""The live tracking stream (TRACK.md): segment the current target on every frame.

jev boxes the target about once a second. A target is matched against the mask tracked on the
frame jev measured: the same object is corrected with jev's box, a different one starts over from
it. Between jev's answers the segmenter's track session follows the object: EdgeTAM with its
video memory (edgetam.py), or any still-image segmenter through `BoxChain`, which prompts each
frame with the previous mask's box, padded, and the deepest point inside that mask. A mask that
vanishes, collapses or jumps is reported lost until the next target.
"""

from __future__ import annotations

import io
import json
import logging
import math
import struct
from collections import deque
from dataclasses import dataclass
from time import perf_counter
from typing import Protocol

import numpy as np
from PIL import Image, UnidentifiedImageError

from .outline import Shape, mask_shape

log = logging.getLogger("jev_finder")

HEADER_LENGTH = struct.Struct(">I")
MAX_HEADER_BYTES = 4096
# Frames are 640x480; anything larger is shrunk to SAM's own 1024 px input size first.
MAX_SIDE = 1024
# Masks are traced at about this width: a 640x480 mask takes 10 to 20 ms, a 320x240 one a
# quarter of that, and the outline is simplified to a few pixels anyway.
TRACE_WIDTH = 320

# A target box overlapping the tracked box this much is the same object (TRACK.md).
SAME_OBJECT_IOU = 0.3
# Each tracking prompt is the previous mask's box grown by this share of its size on each side.
PAD_SHARE = 0.1
# Tracked boxes kept for matching jev's answers, which refer to frames about a second old.
HISTORY = 256
# A mask is lost when its area falls below MIN_AREA_RATIO or rises above MAX_AREA_RATIO times
# the previous one, when its box overlaps the previous box less than MIN_STEP_IOU, or when it is
# a speck. A seed from jev is checked against jev's box instead: at least MIN_SEED_INSIDE of
# the mask's box must lie inside it (a small part of a large box is fine, a mask elsewhere isn't).
MIN_AREA_RATIO = 0.25
MAX_AREA_RATIO = 4.0
MIN_STEP_IOU = 0.2
MIN_SEED_INSIDE = 0.5
MIN_AREA_SHARE = 0.0005


class BadMessage(ValueError):
    """A stream message that doesn't follow TRACK.md. It is logged and skipped."""


class StillSegmenter(Protocol):
    def segment(
        self, image: Image.Image, box: list[float], point: list[float] | None = None
    ) -> tuple[np.ndarray, float]: ...


class TrackSession(Protocol):
    """How a segmenter follows one object through a stream. Each call segments one frame and
    returns its HxW bool mask (empty when the object isn't there) and a score in 0..1. Boxes
    and points are in 0..1 of the frame."""

    def start(self, image: Image.Image, box: list[float]) -> tuple[np.ndarray, float]:
        """A new object, in `box` on this frame: forget the previous one."""
        ...

    def correct(self, image: Image.Image, box: list[float]) -> tuple[np.ndarray, float]:
        """The same object, which jev boxed in `box` on this frame."""
        ...

    def follow(
        self, image: Image.Image, box: list[float], point: list[float]
    ) -> tuple[np.ndarray, float]:
        """The next frame; `box` and `point` are the previous mask's box and deepest point."""
        ...

    def reset(self) -> None:
        """The object is gone; free whatever the session keeps about it."""
        ...


class BoxChain:
    """A track session for a still-image segmenter: jev's box alone on a seed frame, then the
    previous mask's box padded by 10% and its deepest point on each following frame."""

    def __init__(self, segmenter: StillSegmenter):
        self.segmenter = segmenter

    def start(self, image: Image.Image, box: list[float]) -> tuple[np.ndarray, float]:
        return self.segmenter.segment(image, box)

    def correct(self, image: Image.Image, box: list[float]) -> tuple[np.ndarray, float]:
        return self.segmenter.segment(image, box)

    def follow(
        self, image: Image.Image, box: list[float], point: list[float]
    ) -> tuple[np.ndarray, float]:
        return self.segmenter.segment(image, pad_box(box), point)

    def reset(self) -> None:
        pass


@dataclass(frozen=True)
class FrameHeader:
    seq: int
    t: float
    width: int
    height: int


@dataclass(frozen=True)
class TargetBox:
    seq: int
    box: list[float]
    name: str | None


def parse_frame(data: bytes) -> tuple[FrameHeader, bytes]:
    """A binary frame message: 4-byte big-endian header length, JSON header, JPEG bytes."""
    if len(data) < HEADER_LENGTH.size:
        raise BadMessage("The frame is shorter than its header length.")
    (length,) = HEADER_LENGTH.unpack_from(data)
    if not 0 < length <= MAX_HEADER_BYTES or HEADER_LENGTH.size + length >= len(data):
        raise BadMessage(f"The frame header length {length} doesn't fit the message.")
    end = HEADER_LENGTH.size + length
    try:
        header = json.loads(data[HEADER_LENGTH.size : end].decode())
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise BadMessage(f"The frame header is not JSON: {e}") from e
    if not isinstance(header, dict) or header.get("type") != "frame":
        raise BadMessage("The frame header's type is not frame.")
    seq, t = header.get("seq"), header.get("t")
    width, height = header.get("width"), header.get("height")
    if not _is_int(seq) or not _is_number(t) or not _is_int(width) or not _is_int(height):
        raise BadMessage("The frame header needs an integer seq, width, height and a number t.")
    return FrameHeader(seq, t, width, height), data[end:]


def parse_command(text: str) -> TargetBox | None:
    """A text message: a target box, or None for `clear`."""
    try:
        message = json.loads(text)
    except json.JSONDecodeError as e:
        raise BadMessage(f"The message is not JSON: {e}") from e
    kind = message.get("type") if isinstance(message, dict) else None
    if kind == "clear":
        return None
    if kind != "target":
        raise BadMessage(f"Unknown message type {kind!r}: send target or clear.")
    seq, box, name = message.get("seq"), message.get("box"), message.get("name")
    if not _is_int(seq):
        raise BadMessage("The target needs the integer seq of the frame jev measured.")
    if not (isinstance(box, list) and len(box) == 4 and all(_is_number(v) for v in box)):
        raise BadMessage("The target box must be [left, top, right, bottom].")
    x0, y0, x1, y1 = (float(v) for v in box)
    if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
        raise BadMessage("The target box must be in 0..1 with left < right and top < bottom.")
    if name is not None and not isinstance(name, str):
        raise BadMessage("The target name must be a string.")
    return TargetBox(seq, [x0, y0, x1, y1], name)


def box_inside(a: list[float], b: list[float]) -> float:
    """The share of box `a`'s area that lies inside box `b`."""
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0
    return w * h / ((a[2] - a[0]) * (a[3] - a[1]))


def box_iou(a: list[float], b: list[float]) -> float:
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0
    overlap = w * h
    return overlap / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - overlap)


def pad_box(box: list[float], share: float = PAD_SHARE) -> list[float]:
    """The box grown by `share` of its width and height on each side, clamped to the frame."""
    x0, y0, x1, y1 = box
    dx, dy = (x1 - x0) * share, (y1 - y0) * share
    return [max(0.0, x0 - dx), max(0.0, y0 - dy), min(1.0, x1 + dx), min(1.0, y1 + dy)]


def carry_box(box: list[float], then: list[float], now: list[float]) -> list[float]:
    """`box`, measured on the frame where the tracked box was `then`, moved and scaled the way
    the tracked box has moved since (it is `now`). jev answers about a second late; this keeps
    its correction without undoing the motion since."""
    sx = (now[2] - now[0]) / (then[2] - then[0])
    sy = (now[3] - now[1]) / (then[3] - then[1])
    cx, cy = (then[0] + then[2]) / 2, (then[1] + then[3]) / 2
    nx, ny = (now[0] + now[2]) / 2, (now[1] + now[3]) / 2
    x0, y0, x1, y1 = box
    carried = [
        max(0.0, nx + (x0 - cx) * sx),
        max(0.0, ny + (y0 - cy) * sy),
        min(1.0, nx + (x1 - cx) * sx),
        min(1.0, ny + (y1 - cy) * sy),
    ]
    if carried[0] >= carried[2] or carried[1] >= carried[3]:
        return list(box)
    return carried


@dataclass
class Tracked:
    box: list[float]
    point: list[float]
    area: float
    """Share of the frame."""


class Tracker:
    """One stream's tracking state. `command` and `step` are called one at a time."""

    def __init__(self, session: TrackSession, label: str):
        self.session = session
        self.label = label
        self.name: str | None = None
        self.seed: list[float] | None = None
        """jev's box, used as the prompt on the next frame."""
        self.same = False
        """Whether the seed is the object already tracked (a correction) or a new one."""
        self.tracked: Tracked | None = None
        self.history: deque[tuple[int, list[float]]] = deque(maxlen=HISTORY)

    def command(self, target: TargetBox | None) -> None:
        """Applies a target (or `clear` as None) before the next frame."""
        if target is None:
            self._drop()
            return
        matched = self._nearest(target.seq)
        self.same = bool(
            self.tracked and matched and box_iou(target.box, matched[1]) >= SAME_OBJECT_IOU
        )
        if self.same:
            self.seed = carry_box(target.box, matched[1], self.tracked.box)
        else:
            self.seed = target.box
            self.history.clear()
        self.name = target.name

    def step(self, header: FrameHeader, jpeg: bytes) -> dict:
        """Segments the target on one frame and answers with its mask message."""
        started = perf_counter()
        ms: dict[str, float] = {}
        seed = self.seed
        previous = self.tracked if seed is None else None
        if seed is None and previous is None:
            return self._answer(header, None, 0.0, ms, started)

        try:
            image = decode_jpeg(jpeg)
        except BadMessage as e:
            log.warning("Frame %d: %s", header.seq, e)
            return self._answer(header, None, 0.0, ms, started)
        ms["decode"] = _ms(started)

        segmenting = perf_counter()
        if previous is not None:
            mask, score = self.session.follow(image, previous.box, previous.point)
        elif self.same:
            mask, score = self.session.correct(image, seed)
        else:
            mask, score = self.session.start(image, seed)
        ms["segment"] = _ms(segmenting)
        shape, area, problem = self._check(mask, seed, previous, ms)
        if problem and self.same:
            # jev's box matched the tracked box, but the track can't follow it there (it had
            # drifted onto something else): start over from jev's box on this frame.
            log.info("Frame %d: restarting %s (%s)", header.seq, self.name or "the target", problem)
            self.same = False
            segmenting = perf_counter()
            mask, score = self.session.start(image, seed)
            ms["segment"] += _ms(segmenting)
            shape, area, problem = self._check(mask, seed, previous, ms)
        if problem:
            log.info("Frame %d: lost %s (%s)", header.seq, self.name or "the target", problem)
            self._drop()
            return self._answer(header, None, score, ms, started)
        self.seed = None
        self.same = False
        self.tracked = Tracked(shape.box, shape.point, area)
        self.history.append((header.seq, shape.box))
        return self._answer(header, shape, score, ms, started)

    def _check(
        self, mask: np.ndarray, seed: list[float] | None, previous: Tracked | None, ms: dict
    ) -> tuple[Shape | None, float, str | None]:
        """The mask's shape, its share of the frame, and why it isn't the target (or None)."""
        outlining = perf_counter()
        mask = shrink_mask(mask)
        shape = mask_shape(mask)
        ms["outline"] = ms.get("outline", 0.0) + _ms(outlining)
        area = shape.area / mask.size if shape else 0.0
        return shape, area, _problem(shape, area, seed, previous)

    def _nearest(self, seq: int) -> tuple[int, list[float]] | None:
        return min(self.history, key=lambda entry: abs(entry[0] - seq), default=None)

    def _drop(self) -> None:
        self.name = None
        self.seed = None
        self.same = False
        self.tracked = None
        self.history.clear()
        self.session.reset()

    def _answer(self, header: FrameHeader, shape, score: float, ms: dict, started) -> dict:
        ms["total"] = _ms(started)
        return {
            "type": "mask",
            "seq": header.seq,
            "t": header.t,
            "found": shape is not None,
            "name": self.name,
            "outline": shape.outline if shape else None,
            "box": shape.box if shape else None,
            "point": shape.point if shape else None,
            "contact": shape.contact if shape else None,
            "score": round(score, 3) if shape else None,
            "ms": {stage: round(value, 1) for stage, value in ms.items()},
            "model": self.label,
        }


def decode_jpeg(jpeg: bytes) -> Image.Image:
    try:
        image = Image.open(io.BytesIO(jpeg))
        if image.format != "JPEG":
            raise BadMessage(f"The frame is {image.format}, not JPEG.")
        image.draft("RGB", (MAX_SIDE, MAX_SIDE))  # JPEG can decode at 1/2, 1/4 or 1/8 size
        image = image.convert("RGB")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as e:
        raise BadMessage("The frame is not a readable JPEG.") from e
    if max(image.size) > MAX_SIDE:
        image.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.BILINEAR)
    return image


def shrink_mask(mask: np.ndarray, width: int = TRACE_WIDTH) -> np.ndarray:
    """The mask pooled by a whole factor to about `width` pixels wide (majority vote)."""
    factor = mask.shape[1] // width
    if factor < 2:
        return mask
    h, w = mask.shape[0] // factor * factor, mask.shape[1] // factor * factor
    blocks = mask[:h, :w].reshape(h // factor, factor, w // factor, factor)
    return blocks.mean(axis=(1, 3)) >= 0.5


def _problem(shape, area: float, seed: list[float] | None, previous: Tracked | None) -> str | None:
    """Why the new mask is not the tracked object, or None when it plausibly is."""
    if shape is None or area < MIN_AREA_SHARE:
        return "the mask is empty"
    if previous is None:
        if box_inside(shape.box, seed) < MIN_SEED_INSIDE:
            return "the mask is outside jev's box"
        return None
    if area < MIN_AREA_RATIO * previous.area:
        return f"the mask shrank to {area / previous.area:.0%}"
    if area > MAX_AREA_RATIO * previous.area:
        return f"the mask grew to {area / previous.area:.0%}"
    if box_iou(shape.box, previous.box) < MIN_STEP_IOU:
        return "the mask jumped"
    return None


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def _ms(since: float) -> float:
    return (perf_counter() - since) * 1000
