"""One client's tracking state: its objects, its frame count and its jev calls in flight.

Every locate request is one frame. The frame goes through YOLOE once, each requested object's
tracker steps on it, and the answer goes back right away. jev runs beside that, in a thread:
an object is sent along with the frame when its interval has passed (or straight away when the
tracker has nothing to follow, or doubts it is still on the same object). After a failed call
nothing is sent for the interval, then twice as long after each further failure, up to
identify_backoff_max_s, until jev answers again. The frame's SAVPE maps are kept until jev
answers, so its box becomes a prompt on the very frame jev looked at, then is matched to the
track that was there, several frames ago.

`POST /locate` with a session id shares one of these per id (Sessions); a /track connection in
objects mode (TRACK.md) has one of its own and steps it on every frame it streams.

With a segmenter (segment.py), each object's outline is its mask. The frame jev looks at is
kept whole too, so jev's box is cut out of that very frame as a keyframe when the answer comes;
between answers a tracker that doubts the mask it has asks for its object to be cut out of the
newest frame again, one object at a time and the objects in turn. Each object's region follower
(follow.py), made with its tracker and kept as long as it, carries the latest mask to every
frame. The segmenter runs off the frame thread (refresh.py), and a mask is applied on the first
frame after it is ready.
A refresh asked before jev's newest box for the object arrived, and a keyframe older than that
box, are dropped when they come back: they cut out what jev may since have replaced. jev's
keyframe itself replaces the follower's mask even when a refresh of a newer frame landed while
jev answered.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from collections.abc import Callable, Iterable
from concurrent.futures import Executor
from dataclasses import dataclass, field

import cv2
import numpy as np

from .follow import RegionFollower
from .geometry import normalize_box
from .identify import FrameImage, Identification, Identifier, Query
from .motion import CameraMotion
from .refresh import Refreshed, Refresher
from .segment import Segmenter
from .tracking import ObjectTracker, Sighting, TrackerParams
from .vision import Encoding, YoloeVision

log = logging.getLogger("clio_tracker")


@dataclass(frozen=True)
class SessionSettings:
    identify_interval_s: float = 1.0  # how often jev looks again at each object
    # jev's client never overlaps billed calls; another identifier may allow more.
    identify_max_in_flight: int = 1
    identify_backoff_max_s: float = 16.0  # the longest wait for the next call while jev fails
    present_threshold: float = 0.5  # jev's Noul probability that counts as "in view"
    forget_after_s: float = 10.0  # an object nobody asks about is dropped after this
    tracker: TrackerParams = field(default_factory=TrackerParams)


@dataclass
class _Ask:
    seq: int
    started: float
    generations: dict[str, int]
    answers: list[Identification] | None = None
    error: BaseException | None = None


@dataclass
class FrameTimings:
    encode_ms: float
    track_ms: float


class TrackerSession:
    """A segmenter comes with the Refresher that calls it off the frame thread."""

    def __init__(
        self,
        vision: YoloeVision,
        identifier: Identifier,
        executor: Executor,
        settings: SessionSettings | None = None,
        clock: Callable[[], float] = time.monotonic,
        segmenter: Segmenter | None = None,
        refresher: Refresher | None = None,
    ):
        if (refresher.segmenter if refresher is not None else None) is not segmenter:
            raise ValueError("Pass a segmenter with a Refresher of it, or neither.")
        self.vision = vision
        self.identifier = identifier
        self.settings = settings or SessionSettings()
        self.refresher = refresher  # None without a segmenter, or once its executor has stopped
        self._executor = executor
        self._clock = clock
        self._lock = threading.Lock()
        self._seq = 0
        self._generation = 0
        self._objects: dict[str, ObjectTracker] = {}
        self._generations: dict[str, int] = {}
        self._asked: dict[str, float] = {}
        self._last_ask: dict[str, float] = {}
        self._in_flight: dict[str, int] = {}
        self._frames: dict[int, tuple[Encoding, np.ndarray]] = {}  # frames jev is looking at
        self._keyframes: dict[str, tuple[int, int]] = {}  # jev's frame, and the newest then
        self._refreshed_last: str | None = None  # the object the last refresh was for
        self._done: queue.SimpleQueue[_Ask] = queue.SimpleQueue()
        self._failures = 0  # failed calls since jev last answered
        self._wait_s = 0.0  # and the wait they set before the next call
        self._retry_at = -np.inf
        self._camera = CameraMotion()

    @property
    def in_flight(self) -> int:
        return len(self._frames)

    def locate(self, image: FrameImage, queries: list[Query]) -> tuple[list[dict], FrameTimings]:
        sightings, size, timings = self.follow(image, queries)
        detections = [_detection(q.id, s, size) for q, s in zip(queries, sightings, strict=True)]
        return detections, timings

    def follow(
        self, image: FrameImage, queries: list[Query]
    ) -> tuple[list[Sighting], tuple[int, int], FrameTimings]:
        """One frame: a YOLOE pass, a step of each object's tracker, and jev asked about the
        objects that are due. Answers each object's sighting, in order, and the frame's size."""
        with self._lock:
            started = self._clock()
            enc = self.vision.encode(image.rgb)
            encoded = self._clock()
            self._seq += 1
            seq = self._seq
            self._apply_answers(encoded, seq)
            trackers = [self._tracker_for(q, encoded) for q in queries]
            camera = self._camera.update(image.rgb, seq)
            if self.refresher is None:
                sightings = [tr.step(enc, seq, encoded, self.vision, camera) for tr in trackers]
            else:
                sightings = self._follow(image.rgb, enc, seq, encoded, camera, queries, trackers)
            self._ask(image, enc, seq, encoded, queries, trackers)
            self._forget(encoded)
            done = self._clock()
        size = (enc.letterbox.width, enc.letterbox.height)
        return (
            sightings,
            size,
            FrameTimings(round((encoded - started) * 1000, 1), round((done - encoded) * 1000, 1)),
        )

    def _follow(
        self,
        rgb: np.ndarray,
        enc: Encoding,
        seq: int,
        now: float,
        camera: np.ndarray | None,
        queries: list[Query],
        trackers: list[ObjectTracker],
    ) -> list[Sighting]:
        """The steps with the segmenter: the masks it has cut since the last frame first, then
        each tracker's step, which carries its object's latest mask to this frame, then a
        refresh for one object whose tracker doubts the mask it has: the objects take turns,
        from the one after the object that had the last refresh, so one the segmenter keeps
        finding nothing in doesn't hold the others up."""
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        for r in self._segmenter(Refresher.drain) or []:
            tr = self._objects.get(r.key)
            if tr is not None and not outdated(r, self._keyframes.get(r.key)):
                tr.refreshed(r.seq, r.crop, keyframe=r.keyframe)
        sightings = [tr.step(enc, seq, now, self.vision, camera, gray) for tr in trackers]
        pairs = list(zip(queries, trackers, strict=True))
        turn = next((i + 1 for i, (q, _) in enumerate(pairs) if q.id == self._refreshed_last), 0)
        for q, tr in pairs[turn:] + pairs[:turn]:
            box = tr.refresh_box if tr.wants_refresh else None
            if box is None:
                continue
            if self._segmenter(Refresher.submit, q.id, seq, rgb, box):
                self._refreshed_last = q.id
            break  # taken or not, the Refresher takes no other refresh on this frame
        return sightings

    def _segmenter(self, call: Callable, *args) -> bool | list[Refreshed] | None:
        """`call(refresher, *args)`, unless the Refresher's executor has been shut down (the
        service is stopping): then one warning, and the session goes on without the segmenter."""
        if self.refresher is None:
            return None
        try:
            return call(self.refresher, *args)
        except RuntimeError as e:
            log.warning(
                f"{self.refresher.segmenter.name} takes no more calls ({e}); outlines are "
                "YOLOE's from now on"
            )
            self.refresher = None
            return None

    def drop(self, ids: Iterable[str]) -> None:
        """Stops following these objects now (objects mode left them out of its set). A jev
        answer about them that is still on the way is ignored, as for re-worded objects."""
        with self._lock:
            for oid in ids:
                self._drop(oid)

    # --- objects ---------------------------------------------------------------------------

    def _tracker_for(self, q: Query, now: float) -> ObjectTracker:
        tr = self._objects.get(q.id)
        if tr is None or _norm(tr.phrase) != _norm(q.phrase):
            # New words for the id (e.g. a new primary object): a different target.
            if tr is not None:
                log.info(f"{q.id}: now {q.phrase!r} (was {tr.phrase!r}), starting over")
            params = self.settings.tracker
            # A follower of its own: jev's frames for this object all come after this one.
            follower = None if self.refresher is None else RegionFollower(params.follow)
            tr = ObjectTracker(q.id, q.phrase, params, follower=follower)
            self._objects[q.id] = tr
            self._generation += 1
            self._generations[q.id] = self._generation
            self._last_ask.pop(q.id, None)
        self._asked[q.id] = now
        return tr

    def _forget(self, now: float) -> None:
        for oid in [o for o, t in self._asked.items() if now - t > self.settings.forget_after_s]:
            self._drop(oid)

    def _drop(self, oid: str) -> None:
        self._objects.pop(oid, None)
        self._generations.pop(oid, None)
        self._asked.pop(oid, None)
        self._last_ask.pop(oid, None)
        self._keyframes.pop(oid, None)

    # --- jev -------------------------------------------------------------------------------

    def _ask(
        self,
        image: FrameImage,
        enc: Encoding,
        seq: int,
        now: float,
        queries: list[Query],
        trackers: list[ObjectTracker],
    ) -> None:
        s = self.settings
        if self.in_flight >= s.identify_max_in_flight or now < self._retry_at:
            return
        due = [
            q
            for q, tr in zip(queries, trackers, strict=True)
            if (tr.wants_jev_now and self._in_flight.get(q.id, 0) == 0)
            or now - self._last_ask.get(q.id, -np.inf) >= s.identify_interval_s
        ]
        if not due:
            return
        ask = _Ask(seq, now, {q.id: self._generations[q.id] for q in due})
        for q in due:
            self._last_ask[q.id] = now
            self._in_flight[q.id] = self._in_flight.get(q.id, 0) + 1
        self._frames[seq] = (enc, image.rgb)

        def work() -> None:
            try:
                ask.answers = self.identifier.identify(image, due)
            except BaseException as error:  # noqa: BLE001 - reported on the next frame
                ask.error = error
            self._done.put(ask)

        self._executor.submit(work)

    def _apply_answers(self, now: float, newest: int) -> None:
        """jev's answers that have come since the last frame; `newest` is this frame's seq."""
        while True:
            try:
                ask = self._done.get_nowait()
            except queue.Empty:
                return
            frame = self._frames.pop(ask.seq, None)
            for oid in ask.generations:
                self._in_flight[oid] = max(0, self._in_flight.get(oid, 0) - 1)
            took = now - ask.started
            if ask.error is not None or ask.answers is None or frame is None:
                self._failed(ask.error, now)
                continue
            if self._failures:
                log.info(f"{self.identifier.name} answers again, after {self._failures} failed")
            self._failures, self._retry_at = 0, -np.inf
            for answer in ask.answers:
                self._apply(answer, ask, frame, now, took, newest)

    def _failed(self, error: BaseException | None, now: float) -> None:
        """Tracking goes on, and nothing is sent until a wait has passed: a fast failure (an
        HTTP 429, jev's client busy with another caller, no network) would otherwise send an
        object that is new or lost again on the very next frame. The wait is the interval, then
        doubles with each failure in a row."""
        s = self.settings
        self._failures += 1
        longest = max(s.identify_backoff_max_s, s.identify_interval_s)
        first = self._failures == 1
        self._wait_s = s.identify_interval_s if first else min(self._wait_s * 2, longest)
        self._retry_at = now + self._wait_s
        if first:
            log.warning(
                f"{self.identifier.name}: {error}. Tracking continues; asking again in "
                f"{self._wait_s:g} s, then less often until it answers."
            )

    def _apply(
        self,
        answer: Identification,
        ask: _Ask,
        frame: tuple[Encoding, np.ndarray],
        now: float,
        took: float,
        newest: int,
    ) -> None:
        enc, rgb = frame
        tr = self._objects.get(answer.id)
        if tr is None or self._generations.get(answer.id) != ask.generations.get(answer.id):
            return  # the object was dropped or re-worded since
        present = answer.present >= self.settings.present_threshold and answer.box is not None
        box = appearance = None
        if present:
            lb = enc.letterbox
            size = np.array([lb.width, lb.height, lb.width, lb.height], dtype=np.float32)
            box = np.asarray(answer.box, dtype=np.float32) * size
            appearance = self.vision.prompts(enc, box)[0]
        change = tr.identified(ask.seq, now, present, box, appearance, self._camera.since(ask.seq))
        if present and change != "stale" and self.refresher is not None:
            # jev's box, cut out of jev's frame; the mask reaches the tracker through `drain` on
            # a later frame.
            if self._segmenter(Refresher.submit, answer.id, ask.seq, rgb, box, True):
                self._keyframes[answer.id] = (ask.seq, newest)
        seen = (
            f"in view ({answer.present:.2f})" if present else f"not in view ({answer.present:.2f})"
        )
        log.info(
            f"{answer.id}: {self.identifier.name} says {seen} on frame {ask.seq}, "
            f"{took:.1f} s later: {change}"
        )


def outdated(r: Refreshed, keyframe: tuple[int, int] | None) -> bool:
    """Whether a segmenter answer about an object is from before its last keyframe, given as
    (jev's frame, the newest frame when the keyframe was asked for). A refresh asked on a frame
    up to then cut out what the tracker held before jev's answer, which may since have moved it
    to another object; being of a newer frame than jev's, it would make the follower ignore
    jev's mask. An older keyframe is jev's previous view, replaced."""
    if keyframe is None:
        return False
    jev_seq, asked_on = keyframe
    return r.seq < jev_seq if r.keyframe else r.seq <= asked_on


def _detection(object_id: str, s: Sighting, size: tuple[int, int]) -> dict:
    """A Sighting in Clio's finder contract (docs/object-finder.md), plus what the contract has
    no field for: the track's state and the contact point (TRACK.md)."""
    if not s.found or s.box is None:
        return {"id": object_id, "found": False, "track": {"state": s.state}}
    detection: dict = {
        "id": object_id,
        "found": True,
        "box": normalize_box(s.box, *size),
        "confidence": s.confidence,
        "track": {"state": s.state, "id": s.track_id},
    }
    if s.shape is not None:
        detection["point"] = s.shape.point
        if s.shape.outline:
            detection["outline"] = s.shape.outline
        if s.shape.contact:
            detection["contact"] = s.shape.contact
    return detection


def _norm(phrase: str | None) -> str:
    return " ".join((phrase or "").lower().split())


class Sessions:
    """Tracking state per client. A request without a session id shares the default one."""

    def __init__(
        self,
        factory: Callable[[], TrackerSession],
        idle_s: float = 120.0,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._factory = factory
        self._idle_s = idle_s
        self._clock = clock
        self._sessions: dict[str, tuple[TrackerSession, float]] = {}
        self._lock = threading.Lock()

    def get(self, key: str | None) -> TrackerSession:
        key = key or "default"
        with self._lock:
            now = self._clock()
            for k in [k for k, (_, t) in self._sessions.items() if now - t > self._idle_s]:
                del self._sessions[k]
            session = self._sessions[key][0] if key in self._sessions else self._factory()
            self._sessions[key] = (session, now)
            return session

    def new(self) -> TrackerSession:
        """A session of its own, kept outside the map: a /track connection's, in objects mode."""
        return self._factory()

    def __len__(self) -> int:
        return len(self._sessions)

    def reset(self) -> None:
        with self._lock:
            self._sessions.clear()
