"""The live tracking stream (TRACK.md): follow the target on every frame the headset streams.

The messages are the jev finder's: binary frames (a 4-byte big-endian header length, a JSON
header, the JPEG), `target` and `clear` commands, and one `mask` answer per frame. Behind them,
YOLOE and ByteTrack replace EdgeTAM: each frame is one pass through the vision graph and one
ObjectTracker step (tracking.py). A target is jev's box on a frame the page streamed a moment
ago; that frame is kept, so the box becomes the object's visual prompt on the very frame jev
looked at and is matched to the track that was there, as in the HTTP tracker.
"""

from __future__ import annotations

import json
import logging
import math
import struct
from collections import OrderedDict
from dataclasses import dataclass
from time import perf_counter

import cv2
import numpy as np

from .geometry import normalize_box
from .tracking import ObjectTracker, Sighting, TrackerParams
from .vision import YoloeVision

log = logging.getLogger("clio_tracker")

HEADER_LENGTH = struct.Struct(">I")
MAX_HEADER_BYTES = 4096
# Frames kept for targets, which refer to a frame streamed a second or so before: 20 s at the
# page's 15 frames a second, about 50 KB each.
FRAMES_KEPT = 300


class BadMessage(ValueError):
    """A stream message that doesn't follow TRACK.md. It is logged and skipped."""


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


class StreamTracker:
    """One stream's tracking state. `command` and `step` are called one at a time."""

    def __init__(self, vision: YoloeVision, params: TrackerParams | None = None):
        self.vision = vision
        self.params = params or TrackerParams()
        self.label = vision.model
        self.name: str | None = None
        self.object: ObjectTracker | None = None
        self.frames: OrderedDict[int, bytes] = OrderedDict()
        self.waiting: TargetBox | None = None  # a target whose frame hasn't arrived
        self.t = 0.0  # the newest frame's capture time (s, page clock)

    def command(self, target: TargetBox | None) -> None:
        """Applies a target (or `clear` as None) before the next frame."""
        if target is None:
            if self.name:
                log.info("Track: clear %s", self.name)
            self.object, self.name, self.waiting = None, None, None
            return
        if self.object is None or _norm(target.name) != _norm(self.name):
            # Another object was named: follow it from scratch.
            self.object = ObjectTracker("target", target.name, self.params)
            self.name = target.name
        jpeg = self.frames.get(target.seq)
        if jpeg is None:
            self.waiting = target  # applied to the next frame, as if measured on it
            return
        try:
            rgb = decode_jpeg(jpeg)
        except BadMessage:
            return
        self._identify(target, self.vision.encode(rgb), target.seq)

    def step(self, header: FrameHeader, jpeg: bytes) -> dict:
        """Follows the target on one frame and answers with its mask message."""
        started = perf_counter()
        ms: dict[str, float] = {}
        self._keep(header.seq, jpeg)
        self.t = header.t / 1000
        if self.object is None:
            return self._answer(header, None, ms, started)
        try:
            rgb = decode_jpeg(jpeg)
        except BadMessage as e:
            log.warning("Frame %d: %s", header.seq, e)
            return self._answer(header, None, ms, started)
        ms["decode"] = _ms(started)
        segmenting = perf_counter()
        enc = self.vision.encode(rgb)
        if self.waiting is not None:
            self._identify(self.waiting, enc, header.seq)
            self.waiting = None
        sighting = self.object.step(enc, header.seq, self.t, self.vision)
        ms["segment"] = _ms(segmenting)
        return self._answer(
            header, sighting, ms, started, (enc.letterbox.width, enc.letterbox.height)
        )

    def _identify(self, target: TargetBox, enc, seq: int) -> None:
        assert self.object is not None
        lb = enc.letterbox
        box = np.asarray(target.box, dtype=np.float32) * [lb.width, lb.height, lb.width, lb.height]
        appearance = self.vision.prompts(enc, box)[0]
        change = self.object.identified(seq, self.t, True, box.astype(np.float32), appearance)
        log.info("Track: %s on frame %d: %s", self.name or "the target", target.seq, change)

    def _keep(self, seq: int, jpeg: bytes) -> None:
        self.frames[seq] = jpeg
        while len(self.frames) > FRAMES_KEPT:
            self.frames.popitem(last=False)

    def _answer(
        self,
        header: FrameHeader,
        sighting: Sighting | None,
        ms: dict,
        started: float,
        size: tuple[int, int] | None = None,
    ) -> dict:
        ms["total"] = _ms(started)
        state = sighting.state if sighting else "idle"
        if sighting is None or not sighting.found or sighting.box is None or size is None:
            sighting = None
        shape = sighting.shape if sighting else None
        return {
            "type": "mask",
            "seq": header.seq,
            "t": header.t,
            "found": sighting is not None,
            "name": self.name if sighting else None,
            "outline": shape.outline if shape else None,
            "box": normalize_box(sighting.box, *size) if sighting and size else None,
            "point": shape.point if shape else None,
            "contact": shape.contact if shape else None,
            "score": round(sighting.confidence, 3) if sighting else None,
            # tracking, coasting (drawn at its predicted place), lost, unknown, or idle (no target)
            "state": state,
            "ms": {stage: round(value, 1) for stage, value in ms.items()},
            "model": self.label,
        }


def decode_jpeg(jpeg: bytes) -> np.ndarray:
    """RGB pixels of a JPEG frame."""
    if jpeg[:3] != b"\xff\xd8\xff":
        raise BadMessage("The frame is not a JPEG.")
    bgr = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
    if bgr is None or bgr.size == 0:
        raise BadMessage("The frame is not a readable JPEG.")
    return np.ascontiguousarray(bgr[..., ::-1])


def _norm(name: str | None) -> str:
    return " ".join((name or "").lower().split())


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def _ms(since: float) -> float:
    return (perf_counter() - since) * 1000
