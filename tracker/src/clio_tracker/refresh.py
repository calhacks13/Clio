"""Segmenter calls off the frame thread, one at a time and paced.

SAM 2.1 Small takes about 120 ms a frame on this Mac with the cache cleared (see
`Sam2Segmenter.encode`), and the frame thread must never wait on it. `submit` hands a frame and
a box to the executor and returns at once; `drain`, once per frame, returns what has finished.
At most one call is in flight, and calls start at least `min_interval_s` apart: a segmenter that
is behind only falls further behind when asked more often. A keyframe (jev has just named the
object, so this box is worth cutting out now) ignores the interval and is never refused. While a
call is in flight keyframes wait, one per object (one jev answer may name several), a newer one
for an object replacing its older one in its place; the oldest waiting goes at the first `drain`
with nothing in flight, and no refresh is taken while any waits. A segmenter error is logged once
per outage and its result dropped; the caller goes on with the outline it has.

`submit` and `drain` are for one thread, the frame thread. Only the executor's worker runs the
segmenter.
"""

from __future__ import annotations

import logging
import math
import queue
import threading
import time
from collections import OrderedDict
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
    took_s: float


@dataclass
class _Job:
    key: str
    seq: int
    rgb: np.ndarray
    box: np.ndarray
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
        self._lock = threading.Lock()  # the worker and the frame thread share these two
        self._in_flight = 0
        self._down = False
        self._pending: OrderedDict[str, _Job] = OrderedDict()  # keyframes waiting, by key
        self._last_submit = -math.inf
        self._done: queue.SimpleQueue[Refreshed] = queue.SimpleQueue()

    @property
    def in_flight(self) -> int:
        return self._in_flight

    def submit(
        self, key: str, seq: int, rgb: np.ndarray, box: np.ndarray, keyframe: bool = False
    ) -> bool:
        """Ask for `box` to be cut out of `rgb`. False, and nothing done, when a call is in flight
        or a keyframe waits, or when the last call started under `min_interval_s` ago. A
        keyframe is never refused: it waits behind the keyframes already waiting (replacing one
        for the same key), and the oldest goes now if nothing is in flight."""
        now = self._clock()
        if not keyframe and (
            self._in_flight or self._pending or now - self._last_submit < self.min_interval_s
        ):
            return False
        # The caller reuses its frame buffer and box while the segmenter works.
        job = _Job(key, seq, np.ascontiguousarray(rgb).copy(), np.array(box, np.float32), keyframe)
        if not keyframe:
            self._start(job, now)
            return True
        self._pending[key] = job
        self._next(now)
        return True

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
        """Start the oldest waiting keyframe, if any, when nothing is in flight."""
        if self._pending and not self._in_flight:
            _, job = self._pending.popitem(last=False)
            self._start(job, now)

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
            crop = self.segmenter.mask_in_box(self.segmenter.encode(job.rgb), job.box)
        except Exception as error:
            if self._set_down(True):
                log.warning(f"{self.segmenter.name}: {error!r}. Tracking continues.")
        else:
            if self._set_down(False):
                log.info(f"{self.segmenter.name} answers again")
            took = self._clock() - started
            self._done.put(Refreshed(job.key, job.seq, crop, job.box, job.keyframe, took))
        finally:
            with self._lock:
                self._in_flight -= 1

    def _set_down(self, down: bool) -> bool:
        """Record whether the segmenter is failing; True when that changed."""
        with self._lock:
            changed = self._down != down
            self._down = down
        return changed
