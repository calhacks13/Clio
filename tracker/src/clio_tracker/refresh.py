"""Segmenter calls off the frame thread, one at a time and paced.

SAM 2.1 takes 120 ms to 2 s per frame, so the stream thread never calls it. `submit` hands a
frame and a box to the executor and returns at once; `drain`, once per frame, returns what has
finished. At most one call is in flight, and calls start at least `min_interval_s` apart: a
segmenter that is behind only falls further behind when asked more often. A keyframe (jev has
just named the object, so this box is worth cutting out now) ignores the interval; if a call is
in flight it waits as `pending` and goes at the next `drain` after that call, a newer keyframe
replacing an older one. A segmenter error is logged once per outage and its result dropped; the
caller goes on with the outline it has.

`submit` and `drain` are for one thread, the frame thread. Only the executor's worker runs the
segmenter.
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
        self._pending: _Job | None = None
        self._last_submit = -math.inf
        self._done: queue.SimpleQueue[Refreshed] = queue.SimpleQueue()

    @property
    def in_flight(self) -> int:
        return self._in_flight

    def submit(
        self, key: str, seq: int, rgb: np.ndarray, box: np.ndarray, keyframe: bool = False
    ) -> bool:
        """Ask for `box` to be cut out of `rgb`. False, and nothing done, when a call is in flight
        or another waits as pending, or when the last call started under `min_interval_s` ago;
        a keyframe is never refused: it goes now, or waits for the call in flight."""
        now = self._clock()
        if not keyframe and (
            self._in_flight
            or self._pending is not None
            or now - self._last_submit < self.min_interval_s
        ):
            return False
        # The caller reuses its frame buffer and box while the segmenter works.
        job = _Job(key, seq, np.ascontiguousarray(rgb).copy(), np.array(box, np.float32), keyframe)
        if self._in_flight:
            self._pending = job
        else:
            self._pending = None
            self._start(job, now)
        return True

    def drain(self) -> list[Refreshed]:
        """What has finished since the last drain, oldest first. Then the pending keyframe goes,
        if nothing is in flight any more."""
        finished = []
        while True:
            try:
                finished.append(self._done.get_nowait())
            except queue.Empty:
                break
        if self._pending is not None and not self._in_flight:
            job, self._pending = self._pending, None
            self._start(job, self._clock())
        return finished

    def _start(self, job: _Job, now: float) -> None:
        with self._lock:
            self._in_flight += 1
        self._last_submit = now
        self._executor.submit(self._work, job)

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
