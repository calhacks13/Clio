"""The live tracking stream (TRACK.md): follow the target on every frame the headset streams.

The messages are the jev finder's: binary frames (a 4-byte big-endian header length, a JSON
header, the JPEG), `target` and `clear` commands, and one `mask` answer per frame. Behind them,
YOLOE and ByteTrack replace EdgeTAM: each frame is one pass through the vision graph and one
ObjectTracker step (tracking.py). A target is jev's box on a frame the page streamed a moment
ago; that frame is kept, so the box becomes the object's visual prompt on the very frame jev
looked at and is matched to the track that was there, as in the HTTP tracker. A target that is
one part of an object (`"part": true`, or a box lying inside what it would be matched to and
covering less than half of it) is followed by part.py instead, never as the whole object.
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

from .geometry import iou, normalize_box
from .motion import CameraMotion, warp_box
from .part import PartTracker, is_part
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
    part: bool = False  # the box is one part of the object (a label, a button), not all of it


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
    part = message.get("part")
    if part is not None and not isinstance(part, bool):
        raise BadMessage("The target's part must be true or false.")
    return TargetBox(seq, [x0, y0, x1, y1], name, bool(part))


class StreamTracker:
    """One stream's tracking state. `command` and `step` are called one at a time."""

    def __init__(self, vision: YoloeVision, params: TrackerParams | None = None):
        self.vision = vision
        self.params = params or TrackerParams()
        self.label = vision.model
        self.name: str | None = None
        self.object: ObjectTracker | None = None
        self.part: PartTracker | None = None  # while the target is one part of the object
        self.frames: OrderedDict[int, bytes] = OrderedDict()
        self.waiting: TargetBox | None = None  # a target whose frame hasn't arrived
        self.t = 0.0  # the newest frame's capture time (s, page clock)
        self.camera = CameraMotion()  # how the picture moved since the frame before
        # Every few seconds: frames answered, by state, and the mean tracker time, so a slow or
        # lossy stream shows in the log rather than only on the headset.
        self._states: dict[str, int] = {}
        self._window_ms = 0.0
        self._window_start = perf_counter()

    def command(self, target: TargetBox | None) -> None:
        """Applies a target (or `clear` as None) before the next frame."""
        if target is None:
            if self.name:
                log.info("Track: clear %s", self.name)
            self.object, self.part, self.name, self.waiting = None, None, None, None
            return
        if self.object is None or _norm(target.name) != _norm(self.name):
            # Another object was named: follow it from scratch.
            self.object = ObjectTracker("target", target.name, self.params)
            self.part = None
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
        try:
            rgb = decode_jpeg(jpeg)
        except BadMessage as e:
            log.warning("Frame %d: %s", header.seq, e)
            self.camera.update(None, header.seq)
            return self._answer(header, None, ms, started)
        # Measured on every frame, also before there is a target: the first target is jev's box
        # on a frame from a second or two ago, carried to now by this.
        camera = self.camera.update(rgb, header.seq)
        ms["decode"] = _ms(started)
        if self.object is None:
            return self._answer(header, None, ms, started)
        segmenting = perf_counter()
        enc = self.vision.encode(rgb)
        if self.waiting is not None:
            self._identify(self.waiting, enc, header.seq)
            self.waiting = None
        follower = self.part or self.object
        sighting = follower.step(enc, header.seq, self.t, self.vision, camera)
        ms["segment"] = _ms(segmenting)
        return self._answer(
            header, sighting, ms, started, (enc.letterbox.width, enc.letterbox.height)
        )

    def _identify(self, target: TargetBox, enc, seq: int) -> None:
        assert self.object is not None
        lb = enc.letterbox
        size = np.array([lb.width, lb.height, lb.width, lb.height], dtype=np.float32)
        box = (np.asarray(target.box, dtype=np.float32) * size).astype(np.float32)
        appearance = self.vision.prompts(enc, box)[0]
        carry = self.camera.since(seq)
        if target.part or self._is_part(seq, box, carry, enc, appearance):
            if self.part is None:
                self.part = PartTracker("target", target.name, self.params)
            change = self.part.identified(seq, self.t, True, box, enc, self.vision, carry)
        else:
            if self.part is not None:
                # The whole object again: what followed the object holding the part goes on.
                if self.part.parent is not None:
                    self.object = self.part.parent
                self.part = None
            change = self.object.identified(seq, self.t, True, box, appearance, carry)
        log.info("Track: %s on frame %d: %s", self.name or "the target", target.seq, change)

    def _is_part(self, seq: int, box: np.ndarray, carry, enc, appearance: np.ndarray) -> bool:
        """A box not flagged as a part is one when it would land on something it is a part of."""
        if self.part is not None:
            parent = self.part.parent
            held_by = parent.box_on(seq) if parent is not None else None
            if held_by is not None:
                return is_part(box, held_by, self.params)
            # Nothing holds the part we follow: the same part again, where it is now.
            now = self.part.box
            if now is not None and float(iou(warp_box(box, carry), now)[0, 0]) >= 0.3:
                return True
        assert self.object is not None
        return self.object.container(seq, box, carry, enc, self.vision, appearance) is not None

    def _summarize(self, state: str, total_ms: float) -> None:
        self._states[state] = self._states.get(state, 0) + 1
        self._window_ms += total_ms
        elapsed = perf_counter() - self._window_start
        if elapsed < 3:
            return
        frames = sum(self._states.values())
        counts = ", ".join(f"{k} {v}" for k, v in sorted(self._states.items()))
        log.info(
            "Stream: %.1f frames/s, %.1f ms each (%s)",
            frames / elapsed,
            self._window_ms / frames,
            counts,
        )
        self._states.clear()
        self._window_ms = 0.0
        self._window_start = perf_counter()

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
        self._summarize(state, ms["total"])
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
    # cvtColor, not bgr[..., ::-1] copied: the same pixels, 0.05 ms against 0.8 ms at 640x480.
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


def _norm(name: str | None) -> str:
    return " ".join((name or "").lower().split())


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def _ms(since: float) -> float:
    return (perf_counter() - since) * 1000
