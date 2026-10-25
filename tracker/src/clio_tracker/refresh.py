"""Segmenter calls off the frame thread, one at a time and paced.

SAM 2.1 Small takes about 120 ms a frame on this Mac with the cache cleared (see
`Sam2Segmenter.encode`), and the frame thread must never wait on it. `submit` hands a frame and
a box to the executor and returns at once; `drain`, once per frame, returns what has finished.
At most one job is in flight, and jobs start at least `min_interval_s` apart: a segmenter that
is behind only falls further behind when asked more often. A keyframe (jev has just named the
object, so this box is worth cutting out now) ignores the interval and is never refused. The
keyframes of one jev answer are one job (`submit_keyframes`): the frame is encoded once and each
object's box cut out of it, one `Refreshed` per object. While a job is in flight keyframe jobs
wait, one per frame; a newer keyframe for an object takes its box out of the job it waited in
(a job left with no box is dropped) and waits in its place, and boxes for a frame that already
has a job join that job. The oldest waiting job goes at the first `drain` with nothing in
flight, and no refresh is taken while any waits. A segmenter error is logged once per outage and
the job's remaining results dropped; the caller goes on with the outline it has. `tally` says
how many boxes were cut since it was last asked, how long they took and how many held nothing,
for the stream's log line.

`submit`, `submit_keyframes`, `drain` and `tally` are for one thread, the frame thread. Only the
executor's worker runs the segmenter.
"""

from __future__ import annotations

import logging
import math
import queue
import threading
import time
from collections.abc import Callable
from concurrent.futures import Executor
from dataclasses import dataclass

import numpy as np

from .segment import Segmenter
from .vision import MaskCrop

log = logging.getLogger("clio_tracker")


@dataclass(frozen=True)
class Refreshed:
    key: str  # the object's id, or "target" on the stream
    seq: int  # the frame the box was cut out of
    crop: MaskCrop | None  # None when the segmenter found nothing in the box
    box: np.ndarray  # the prompt box, in frame pixels
    keyframe: bool
    took_s: float  # from the job's start to this box's mask, the frame's encoding included


@dataclass
class _Job:
    seq: int
    rgb: np.ndarray
    boxes: dict[str, np.ndarray]  # by key, cut out in this order
    keyframe: bool


class Refresher:
    def __init__(
        self,
        segmenter: Segmenter,
        executor: Executor,
        min_interval_s: float = 0.15,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.segmenter = segmenter
        self.min_interval_s = min_interval_s
        self._executor = executor
        self._clock = clock
        self._lock = threading.Lock()  # the worker and the frame thread share these
        self._in_flight = 0
        self._down = False
        self._counts = [0, 0.0, 0]  # since the last tally: boxes cut, their seconds, empty ones
        self._pending: list[_Job] = []  # keyframe jobs waiting, oldest first, one per frame
        self._last_submit = -math.inf
        self._done: queue.SimpleQueue[Refreshed] = queue.SimpleQueue()

    @property
    def in_flight(self) -> int:
        return self._in_flight

    def submit(
        self, key: str, seq: int, rgb: np.ndarray, box: np.ndarray, keyframe: bool = False
    ) -> bool:
        """Ask for `box` to be cut out of `rgb`. False, and nothing done, when a job is in flight
        or a keyframe job waits, or when the last job started under `min_interval_s` ago. A
        keyframe is `submit_keyframes` with this one box."""
        if keyframe:
            return self.submit_keyframes(seq, rgb, {key: box})
        now = self._clock()
        if self._in_flight or self._pending or now - self._last_submit < self.min_interval_s:
            return False
        self._start(_Job(seq, _copy(rgb), {key: np.array(box, np.float32)}, False), now)
        return True

    def submit_keyframes(self, seq: int, rgb: np.ndarray, boxes: dict[str, np.ndarray]) -> bool:
        """jev's boxes on frame `seq`, by key, cut out of `rgb` as one job: the frame is encoded
        once. Never refused (True): the job waits behind those already waiting, taking each of
        its keys out of the job it waited in, or joins the job of the same frame; the oldest
        goes now if nothing is in flight."""
        if boxes:
            # The caller reuses its frame buffer and boxes while the segmenter works.
            copies = {k: np.array(b, np.float32) for k, b in boxes.items()}
            self._wait(_Job(seq, _copy(rgb), copies, True))
        self._next(self._clock())
        return True

    def _wait(self, job: _Job) -> None:
        """Queue a keyframe job (see the module docstring)."""
        same = next((j for j in self._pending if j.seq == job.seq), None)
        place = None  # where a job its keys were taken out of waited
        for i, waiting in enumerate(self._pending):
            if waiting is same:
                continue
            taken = [k for k in job.boxes if k in waiting.boxes]
            for k in taken:
                del waiting.boxes[k]
            if taken and place is None:
                place = i + (1 if waiting.boxes else 0)
        if same is not None:
            same.rgb = job.rgb
            same.boxes.update(job.boxes)
        else:
            self._pending.insert(len(self._pending) if place is None else place, job)
        self._pending = [j for j in self._pending if j.boxes]

    def tally(self) -> tuple[int, float, int]:
        """Boxes cut since the last tally, their mean `took_s` (0 when none) and how many the
        segmenter found nothing in; counting starts again."""
        with self._lock:
            (calls, seconds, empty), self._counts = self._counts, [0, 0.0, 0]
        return calls, seconds / calls if calls else 0.0, empty

    def drain(self) -> list[Refreshed]:
        """What has finished since the last drain, oldest first. Then the oldest waiting
        keyframe goes, if nothing is in flight any more."""
        finished = []
        while True:
            try:
                finished.append(self._done.get_nowait())
            except queue.Empty:
                break
        self._next(self._clock())
        return finished

    def _next(self, now: float) -> None:
        """Start the oldest waiting keyframe job, if any, when nothing is in flight."""
        if self._pending and not self._in_flight:
            self._start(self._pending.pop(0), now)

    def _start(self, job: _Job, now: float) -> None:
        with self._lock:
            self._in_flight += 1
        try:
            self._executor.submit(self._work, job)
        except BaseException:
            with self._lock:  # the work will never run, so nothing will count it out
                self._in_flight -= 1
            raise
        self._last_submit = now

    def _work(self, job: _Job) -> None:
        started = self._clock()
        try:
            enc = self.segmenter.encode(job.rgb)
            for key, box in job.boxes.items():
                crop = self.segmenter.mask_in_box(enc, box)
                took = self._clock() - started
                with self._lock:
                    self._counts[0] += 1
                    self._counts[1] += took
                    self._counts[2] += crop is None
                self._done.put(Refreshed(key, job.seq, crop, box, job.keyframe, took))
        except Exception as error:
            if self._set_down(True):
                log.warning(f"{self.segmenter.name}: {error!r}. Tracking continues.")
        else:
            if self._set_down(False):
                log.info(f"{self.segmenter.name} answers again")
        finally:
            with self._lock:
                self._in_flight -= 1

    def _set_down(self, down: bool) -> bool:
        """Record whether the segmenter is failing; True when that changed."""
        with self._lock:
            changed = self._down != down
            self._down = down
        return changed


def _copy(rgb: np.ndarray) -> np.ndarray:
    return np.ascontiguousarray(rgb).copy()
