"""One client's tracking state: its objects, its frame count and its jev calls in flight.

Every locate request is one frame. The frame goes through YOLOE once, each requested object's
tracker steps on it, and the answer goes back right away. jev runs beside that, in a thread:
an object is sent along with the frame when its interval has passed (or straight away when the
tracker has nothing to follow, or doubts it is still on the same object). The frame's SAVPE
maps are kept until jev answers, so its box becomes a prompt on the very frame jev looked at,
then is matched to the track that was there, several frames ago.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from collections.abc import Callable
from concurrent.futures import Executor
from dataclasses import dataclass, field

import numpy as np

from .geometry import normalize_box
from .identify import FrameImage, Identification, Identifier, Query
from .tracking import ObjectTracker, Sighting, TrackerParams
from .vision import Encoding, YoloeVision

log = logging.getLogger("clio_tracker")


@dataclass(frozen=True)
class SessionSettings:
    identify_interval_s: float = 1.0  # how often jev looks again at each object
    # jev's client never overlaps billed calls; another identifier may allow more.
    identify_max_in_flight: int = 1
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
    def __init__(
        self,
        vision: YoloeVision,
        identifier: Identifier,
        executor: Executor,
        settings: SessionSettings | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.vision = vision
        self.identifier = identifier
        self.settings = settings or SessionSettings()
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
        self._frames: dict[int, Encoding] = {}  # frames jev is looking at
        self._done: queue.SimpleQueue[_Ask] = queue.SimpleQueue()
        self._identifier_down = False

    @property
    def in_flight(self) -> int:
        return len(self._frames)

    def locate(self, image: FrameImage, queries: list[Query]) -> tuple[list[dict], FrameTimings]:
        with self._lock:
            started = self._clock()
            enc = self.vision.encode(image.rgb)
            encoded = self._clock()
            self._seq += 1
            seq = self._seq
            self._apply_answers(encoded)
            trackers = [self._tracker_for(q, encoded) for q in queries]
            sightings = [tr.step(enc, seq, encoded, self.vision) for tr in trackers]
            self._ask(image, enc, seq, encoded, queries, trackers)
            self._forget(encoded)
            done = self._clock()
        detections = [_detection(q.id, s, enc) for q, s in zip(queries, sightings, strict=True)]
        return detections, FrameTimings(
            round((encoded - started) * 1000, 1), round((done - encoded) * 1000, 1)
        )

    # --- objects ---------------------------------------------------------------------------

    def _tracker_for(self, q: Query, now: float) -> ObjectTracker:
        tr = self._objects.get(q.id)
        if tr is None or _norm(tr.phrase) != _norm(q.phrase):
            # New words for the id (e.g. a new primary object): a different target.
            if tr is not None:
                log.info(f"{q.id}: now {q.phrase!r} (was {tr.phrase!r}), starting over")
            tr = ObjectTracker(q.id, q.phrase, self.settings.tracker)
            self._objects[q.id] = tr
            self._generation += 1
            self._generations[q.id] = self._generation
            self._last_ask.pop(q.id, None)
        self._asked[q.id] = now
        return tr

    def _forget(self, now: float) -> None:
        for oid in [o for o, t in self._asked.items() if now - t > self.settings.forget_after_s]:
            self._objects.pop(oid, None)
            self._generations.pop(oid, None)
            self._asked.pop(oid, None)
            self._last_ask.pop(oid, None)

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
        if self.in_flight >= s.identify_max_in_flight:
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
        self._frames[seq] = enc

        def work() -> None:
            try:
                ask.answers = self.identifier.identify(image, due)
            except BaseException as error:  # noqa: BLE001 - reported on the next frame
                ask.error = error
            self._done.put(ask)

        self._executor.submit(work)

    def _apply_answers(self, now: float) -> None:
        while True:
            try:
                ask = self._done.get_nowait()
            except queue.Empty:
                return
            enc = self._frames.pop(ask.seq, None)
            for oid in ask.generations:
                self._in_flight[oid] = max(0, self._in_flight.get(oid, 0) - 1)
            took = now - ask.started
            if ask.error is not None or ask.answers is None or enc is None:
                if not self._identifier_down:
                    log.warning(f"{self.identifier.name}: {ask.error}. Tracking continues.")
                self._identifier_down = True
                continue
            if self._identifier_down:
                log.info(f"{self.identifier.name} answers again")
            self._identifier_down = False
            for answer in ask.answers:
                self._apply(answer, ask, enc, now, took)

    def _apply(
        self, answer: Identification, ask: _Ask, enc: Encoding, now: float, took: float
    ) -> None:
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
        change = tr.identified(ask.seq, now, present, box, appearance)
        seen = (
            f"in view ({answer.present:.2f})" if present else f"not in view ({answer.present:.2f})"
        )
        log.info(
            f"{answer.id}: {self.identifier.name} says {seen} on frame {ask.seq}, "
            f"{took:.1f} s later: {change}"
        )


def _detection(object_id: str, s: Sighting, enc: Encoding) -> dict:
    """A Sighting in Clio's finder contract (docs/object-finder.md), plus the track's state."""
    if not s.found or s.box is None:
        return {"id": object_id, "found": False, "track": {"state": s.state}}
    lb = enc.letterbox
    detection: dict = {
        "id": object_id,
        "found": True,
        "box": normalize_box(s.box, lb.width, lb.height),
        "confidence": s.confidence,
        "track": {"state": s.state, "id": s.track_id},
    }
    if s.shape is not None:
        detection["point"] = s.shape.point
        if s.shape.outline:
            detection["outline"] = s.shape.outline
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

    def __len__(self) -> int:
        return len(self._sessions)

    def reset(self) -> None:
        with self._lock:
            self._sessions.clear()
