"""The live tracking stream (TRACK.md): follow the target on every frame the headset streams.

The messages are the jev finder's: binary frames (a 4-byte big-endian header length, a JSON
header, the JPEG), `target` and `clear` commands, and one `mask` answer per frame. Behind them,
YOLOE and ByteTrack replace EdgeTAM: each frame is one pass through the vision graph and one
ObjectTracker step (tracking.py). A target is jev's box on a frame the page streamed a moment
ago; that frame is kept, so the box becomes the object's visual prompt on the very frame jev
looked at and is matched to the track that was there, as in the HTTP tracker. A target that is
one part of an object (`"part": true`, or a box lying inside what it would be matched to and
covering less than half of it) is followed by part.py instead, never as the whole object.

In objects mode (an `objects` message, for a lesson), the page names several objects in words
instead and gets one `detections` answer per frame. jev places them about once a second, in one
call for all that are due, and each is followed as `POST /locate` with a session follows it
(session.py), in a TrackerSession of the connection's own.

With a segmenter (segment.py), each target's outline is its mask: jev's box is cut out of jev's
frame as a keyframe, and again around the target whenever its tracker doubts the mask it has,
off the frame thread (refresh.py), and a region follower (follow.py) carries the latest mask to
every frame. The stream has one follower, stepped from the first frame, before there is any
target, so the motion since the frame jev looked at is known when its box arrives; each tracker
the stream makes (an object, a part, a part's object made the target again) gets it in turn,
cleared. A refresh asked before jev's newest box arrived, and a keyframe older than that box,
are dropped when they come back: they cut out what jev may since have replaced. jev's keyframe
itself replaces the follower's mask even when a refresh of a newer frame landed while jev
answered. Objects mode has the same, per object, in its TrackerSession.
"""

from __future__ import annotations

import json
import logging
import math
import re
import struct
from collections import Counter, OrderedDict
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from time import perf_counter

import cv2
import numpy as np

from .follow import RegionFollower
from .geometry import iou, normalize_box
from .identify import FrameImage, Query
from .motion import CameraMotion, warp_box
from .part import PartTracker, is_part
from .refresh import Refreshed, Refresher
from .segment import Segmenter
from .session import TrackerSession, outdated
from .tracking import ObjectTracker, Sighting, TrackerParams
from .vision import YoloeVision

log = logging.getLogger("clio_tracker")

HEADER_LENGTH = struct.Struct(">I")
MAX_HEADER_BYTES = 4096
# Frames kept for targets, which refer to a frame streamed a second or so before: 20 s at the
# page's 15 frames a second, about 50 KB each.
FRAMES_KEPT = 300
MAX_OBJECTS = 8  # followed at once in objects mode; the rest of a longer set is ignored
WORD = re.compile(r"\w")


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


@dataclass(frozen=True)
class ObjectSet:
    """Objects mode: the objects to find and follow from now on, in the page's order."""

    objects: list[Query]


Command = TargetBox | ObjectSet | None  # None is `clear`


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


def parse_command(text: str) -> Command:
    """A text message: a target box, a set of objects, or None for `clear`."""
    try:
        message = json.loads(text)
    except json.JSONDecodeError as e:
        raise BadMessage(f"The message is not JSON: {e}") from e
    kind = message.get("type") if isinstance(message, dict) else None
    if kind == "clear":
        return None
    if kind == "objects":
        return _object_set(message.get("objects"))
    if kind != "target":
        raise BadMessage(f"Unknown message type {kind!r}: send target, objects or clear.")
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


def _object_set(objects) -> ObjectSet:
    """The objects of an `objects` message, checked as `POST /locate` checks its objects. An id
    sent twice keeps its first words; past the eighth object the rest is ignored."""
    if not isinstance(objects, list):
        raise BadMessage("objects must be a list of {id, phrase, query}.")
    out: list[Query] = []
    for o in objects:
        if not isinstance(o, dict):
            raise BadMessage("Each object must be {id, phrase, query}.")
        oid, query, phrase = o.get("id"), o.get("query"), o.get("phrase")
        if not isinstance(oid, str) or not 0 < len(oid) <= 200:
            raise BadMessage("Each object needs an id of 1 to 200 characters.")
        query = query.strip() if isinstance(query, str) else ""
        if not WORD.search(query) or len(query) > 1000:
            raise BadMessage(f"{oid}: the query must be words, at most 1000 characters.")
        phrase = phrase.strip() if isinstance(phrase, str) else phrase
        if phrase is not None and (not isinstance(phrase, str) or len(phrase) > 200):
            raise BadMessage(f"{oid}: the phrase must be a string of at most 200 characters.")
        if all(q.id != oid for q in out):
            out.append(Query(oid, query, phrase if phrase and WORD.search(phrase) else None))
    if len(out) > MAX_OBJECTS:
        ignored = ", ".join(q.id for q in out[MAX_OBJECTS:])
        log.warning(
            "Track: %d objects sent, %d followed; ignored %s", len(out), MAX_OBJECTS, ignored
        )
    return ObjectSet(out[:MAX_OBJECTS])


class StreamTracker:
    """One stream's tracking state. `command` and `step` are called one at a time. A segmenter
    comes with the Refresher that calls it off the frame thread."""

    def __init__(
        self,
        vision: YoloeVision,
        params: TrackerParams | None = None,
        segmenter: Segmenter | None = None,
        refresher: Refresher | None = None,
    ):
        if (refresher.segmenter if refresher is not None else None) is not segmenter:
            raise ValueError("Pass a segmenter with a Refresher of it, or neither.")
        self.vision = vision
        self.params = params or TrackerParams()
        self.refresher = refresher  # None without a segmenter, or once its executor has stopped
        # The stream's one follower, handed to each tracker it makes.
        self.follower = RegionFollower(self.params.follow) if refresher is not None else None
        self._keyframe: tuple[int, int] | None = None  # jev's frame, and the newest frame then
        self.label = vision.model
        self.name: str | None = None
        self.object: ObjectTracker | None = None
        self.part: PartTracker | None = None  # while the target is one part of the object
        self.frames: OrderedDict[int, bytes] = OrderedDict()
        self.waiting: TargetBox | None = None  # a target whose frame hasn't arrived
        self.t = 0.0  # the newest frame's capture time (s, page clock)
        self.camera = CameraMotion()  # how the picture moved since the frame before
        # Found answers by what drew the outline (Sighting.source), over the stream's life.
        self.drawn: Counter[str | None] = Counter()
        self._summary = _Summary("Stream")

    def command(self, target: TargetBox | None) -> None:
        """Applies a target (or `clear` as None) before the next frame."""
        if target is None:
            if self.name:
                log.info("Track: clear %s", self.name)
            self.object, self.part, self.name, self.waiting = None, None, None, None
            self._clear_follower()
            return
        if self.object is None or _norm(target.name) != _norm(self.name):
            # Another object was named: follow it from scratch.
            self.object = ObjectTracker("target", target.name, self.params, follower=self.follower)
            self.part = None
            self.name = target.name
            self._clear_follower()
        jpeg = self.frames.get(target.seq)
        if jpeg is None:
            self.waiting = target  # applied to the next frame, as if measured on it
            return
        try:
            rgb = decode_jpeg(jpeg)
        except BadMessage:
            return
        self._identify(target, self.vision.encode(rgb), target.seq, rgb)

    def reset(self) -> None:
        """As on connecting: no target, no frames kept, no camera motion (objects mode ran)."""
        self.command(None)
        self.frames.clear()
        self.camera = CameraMotion()

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
        # The follower's flow is on gray pixels, once a frame, and only with a segmenter.
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY) if self.refresher is not None else None
        if self.object is None:
            if gray is not None:
                # No tracker steps the follower yet: the stream does, so that its log of the
                # picture's motion reaches back to the frame jev's first box is on.
                assert self.follower is not None
                self.follower.step(header.seq, gray, camera, self.t)
            return self._answer(header, None, ms, started)
        segmenting = perf_counter()
        enc = self.vision.encode(rgb)
        if self.waiting is not None:
            self._identify(self.waiting, enc, header.seq, rgb)
            self.waiting = None
        tracker = self.part or self.object
        if gray is None:
            sighting = tracker.step(enc, header.seq, self.t, self.vision, camera)
        else:
            sighting = self._follow(tracker, enc, header.seq, camera, rgb, gray)
        ms["segment"] = _ms(segmenting)
        return self._answer(
            header, sighting, ms, started, (enc.letterbox.width, enc.letterbox.height)
        )

    def _follow(
        self,
        tracker: ObjectTracker | PartTracker,
        enc,
        seq: int,
        camera: np.ndarray | None,
        rgb: np.ndarray,
        gray: np.ndarray,
    ) -> Sighting:
        """A step with the segmenter: the masks it has cut since the last frame first, then the
        step, which carries the latest one to this frame, then a refresh if the tracker doubts
        the mask it has."""
        for r in self._segmenter(Refresher.drain) or []:
            if not outdated(r, self._keyframe):
                tracker.refreshed(r.seq, r.crop, keyframe=r.keyframe)
        sighting = tracker.step(enc, seq, self.t, self.vision, camera, gray=gray)
        box = tracker.refresh_box if tracker.wants_refresh else None
        if box is not None:
            self._segmenter(Refresher.submit, "target", seq, rgb, box)
        return sighting

    def _identify(self, target: TargetBox, enc, seq: int, rgb: np.ndarray) -> None:
        assert self.object is not None
        lb = enc.letterbox
        size = np.array([lb.width, lb.height, lb.width, lb.height], dtype=np.float32)
        box = (np.asarray(target.box, dtype=np.float32) * size).astype(np.float32)
        appearance = self.vision.prompts(enc, box)[0]
        carry = self.camera.since(seq)
        if target.part or self._is_part(seq, box, carry, enc, appearance):
            if self.part is None:
                self.part = PartTracker("target", target.name, self.params, follower=self.follower)
                self._clear_follower()  # it followed the whole object
            change = self.part.identified(seq, self.t, True, box, enc, self.vision, carry)
        else:
            if self.part is not None:
                # The whole object again: what followed the object holding the part goes on.
                if self.part.parent is not None:
                    self.object = self.part.parent
                    self.object.follower = self.follower
                self.part = None
                self._clear_follower()  # it followed the part
            change = self.object.identified(seq, self.t, True, box, appearance, carry)
        log.info("Track: %s on frame %d: %s", self.name or "the target", target.seq, change)
        if self.refresher is not None and change != "stale":
            # jev's box, cut out of jev's frame; the mask reaches the tracker through `drain`
            # on a later frame.
            newest = next(reversed(self.frames))
            if self._segmenter(Refresher.submit, "target", seq, rgb, box, True):
                self._keyframe = (seq, newest)

    def _clear_follower(self) -> None:
        """Another tracker takes the follower over, or none: the mask it carried is not theirs.
        Its log of the picture's motion stays."""
        if self.follower is not None:
            self.follower.clear()

    def _segmenter(self, call: Callable, *args) -> bool | list[Refreshed] | None:
        """`call(refresher, *args)`, unless the Refresher's executor has been shut down (the
        service is stopping): then one warning, and the stream goes on without the segmenter."""
        if self.refresher is None:
            return None
        try:
            return call(self.refresher, *args)
        except RuntimeError as e:
            log.warning(
                "Track: %s takes no more calls (%s); outlines are YOLOE's from now on",
                self.refresher.segmenter.name,
                e,
            )
            self.refresher = None
            return None

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
        source = sighting.source if sighting else None
        if sighting is not None:
            self.drawn[source] += 1
        self._summary.add([state], ms["total"], [source], self.refresher)
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
            "track": sighting.track_id if sighting else None,  # ByteTrack's id
            "ms": {stage: round(value, 1) for stage, value in ms.items()},
            "model": self.label,
        }


class ObjectsTracker:
    """Objects mode: the objects of the page's last `objects` message, followed on every frame
    by the connection's own TrackerSession, which asks jev about them as `POST /locate` with a
    session does. `set` and `step` are called one at a time."""

    def __init__(self, session: TrackerSession):
        self.session = session
        self.label = session.vision.model
        self.objects: list[Query] = []
        self._summary = _Summary("Objects")

    def set(self, objects: list[Query]) -> None:
        """Replaces the set. Objects left out are dropped now, along with any jev answer about
        them still on the way; a new phrase for an id starts it over (on the next frame), while
        new query words only change what jev is told about it. An empty set stops tracking and
        jev: frames are still answered, with no detections."""
        ids = [q.id for q in objects]
        self.session.drop(q.id for q in self.objects if q.id not in ids)
        if ids != [q.id for q in self.objects]:
            log.info("Track: objects %s", ", ".join(ids) or "none")
        self.objects = list(objects)

    def step(self, header: FrameHeader, jpeg: bytes) -> dict:
        """Follows every object on one frame and answers with the detections message."""
        started = perf_counter()
        ms: dict[str, float] = {}
        if not self.objects:
            return self._answer(header, [], ms, started)
        try:
            rgb = decode_jpeg(jpeg)
        except BadMessage as e:
            log.warning("Frame %d: %s", header.seq, e)
            unseen = Sighting(False, state="lost")
            return self._answer(header, [_tracked(q.id, unseen) for q in self.objects], ms, started)
        ms["decode"] = _ms(started)
        tracking = perf_counter()
        image = FrameImage(jpeg, "image/jpeg", rgb)
        sightings, size, _ = self.session.follow(image, self.objects)
        ms["track"] = _ms(tracking)
        detections = [_tracked(q.id, s, size) for q, s in zip(self.objects, sightings, strict=True)]
        found = [d["found"] for d in detections]
        sources = [s.source if f else None for s, f in zip(sightings, found, strict=True)]
        return self._answer(header, detections, ms, started, sources)

    def _answer(
        self,
        header: FrameHeader,
        detections: list[dict],
        ms: dict,
        started: float,
        sources: list[str | None] | None = None,
    ) -> dict:
        ms["total"] = _ms(started)
        states = [f"{d['id']} {d['state']}" for d in detections] or ["idle"]
        self._summary.add(states, ms["total"], sources or [], self.session.refresher)
        return {
            "type": "detections",
            "seq": header.seq,
            "t": header.t,
            "model": self.label,
            "ms": {stage: round(value, 1) for stage, value in ms.items()},
            "detections": detections,
        }


def _tracked(object_id: str, s: Sighting, size: tuple[int, int] | None = None) -> dict:
    """One object's entry in a detections message: the mask message's fields, for each object."""
    found = s.found and s.box is not None and size is not None
    shape = s.shape if found else None
    return {
        "id": object_id,
        "found": found,
        # tracking, coasting (drawn at its predicted place), lost (also when jev says it is not
        # in view), or unknown (jev hasn't placed it yet)
        "state": "lost" if s.state == "absent" else s.state,
        "box": normalize_box(s.box, *size) if found and size else None,
        "outline": shape.outline if shape else None,
        "point": shape.point if shape else None,
        "contact": shape.contact if shape else None,
        "score": round(s.confidence, 3) if found else None,
        "track": s.track_id if found else None,
    }


class Modes:
    """A /track connection's mode (TRACK.md): one target until the page sends `objects`, then
    objects until it sends a `target`. Switching either way drops what the other mode followed.
    The objects' TrackerSession is made on the first `objects` and kept for the connection, so
    a jev call still on the way counts against the one in flight if objects come back."""

    def __init__(self, target: StreamTracker, session: Callable[[], TrackerSession]):
        self.target = target
        self.label = target.label
        self.objects: ObjectsTracker | None = None
        self.in_objects_mode = False
        self._session = session

    def command(self, command: Command) -> None:
        """Applies a message before the next frame."""
        if isinstance(command, ObjectSet):
            if not self.in_objects_mode:
                self.target.reset()
                self.in_objects_mode = True
            if self.objects is None:
                self.objects = ObjectsTracker(self._session())
            self.objects.set(command.objects)
        elif self.in_objects_mode:
            assert self.objects is not None
            self.objects.set([])  # `clear`, which stays in objects mode, or a target
            if command is not None:
                self.in_objects_mode = False
                self.target.command(command)
        else:
            self.target.command(command)

    def step(self, header: FrameHeader, jpeg: bytes) -> dict:
        if self.in_objects_mode:
            assert self.objects is not None
            return self.objects.step(header, jpeg)
        return self.target.step(header, jpeg)


class _Summary:
    """Every few seconds, a log line: frames answered, how often each state was answered and the
    mean time in the tracker, so a slow or lossy stream shows in the log, not only on the
    headset. With a segmenter it adds the share of found answers whose outline the follower drew
    (`follower N%`) and what the segmenter did since the last line (`segmenter: K calls, M ms, E
    empty`: boxes cut, their mean time, and how many held nothing), so a mask that is rarely
    drawn shows too."""

    def __init__(self, what: str):
        self.what = what
        self._states: dict[str, int] = {}
        self._frames = 0
        self._ms = 0.0
        self._found = 0  # found answers, and those the follower drew
        self._followed = 0
        self._start = perf_counter()

    def add(
        self,
        states: Iterable[str],
        total_ms: float,
        sources: Iterable[str | None] = (),
        refresher: Refresher | None = None,
    ) -> None:
        """One frame: each answer's state, the frame's time, and what drew each found answer's
        outline (None for an answer not found). `refresher` is the segmenter's, if any."""
        for state in states:
            self._states[state] = self._states.get(state, 0) + 1
        for source in sources:
            self._found += source is not None
            self._followed += source == "follower"
        self._frames += 1
        self._ms += total_ms
        elapsed = perf_counter() - self._start
        if elapsed < 3:
            return
        counts = ", ".join(f"{k} {v}" for k, v in sorted(self._states.items()))
        line = "%s: %.1f frames/s, %.1f ms each (%s)"
        args: list = [self.what, self._frames / elapsed, self._ms / self._frames, counts]
        if refresher is not None:
            calls, mean_s, empty = refresher.tally()
            line += "; follower %.0f%%, segmenter: %d calls, %.0f ms, %d empty"
            args += [100 * self._followed / max(self._found, 1), calls, 1000 * mean_s, empty]
        log.info(line, *args)
        self._states.clear()
        self._frames = 0
        self._ms = 0.0
        self._found = self._followed = 0
        self._start = perf_counter()


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
