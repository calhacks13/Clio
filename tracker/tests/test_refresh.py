"""The refresher runs segmenter calls off the frame thread, one at a time and paced.

The executor is `ManualExecutor` (work runs only when told to, like a slow SAM call) and the
clock is `Clock`; `FakeSegmenter` fills each box and records what it was asked.
"""

from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest

from clio_tracker.refresh import Refreshed, Refresher
from clio_tracker.segment import SegEncoding
from conftest import Clock, FakeSegmenter, ManualExecutor

BOX = np.array([10, 20, 50, 80], np.float32)


def frame(value: int = 0) -> np.ndarray:
    return np.full((72, 96, 3), value, np.uint8)


def make(min_interval_s: float = 0.15, run_now: bool = False):
    segmenter, executor, clock = FakeSegmenter(), ManualExecutor(run_now=run_now), Clock()
    return Refresher(segmenter, executor, min_interval_s, clock), segmenter, executor, clock


def test_submit_runs_segmenter_and_drain_returns_crop():
    refresher, segmenter, executor, clock = make()
    rgb = frame(7)

    assert refresher.submit("target", 5, rgb, BOX)
    assert refresher.in_flight == 1
    assert refresher.drain() == []  # nothing has run yet
    assert segmenter.calls == []

    rgb[:] = 99  # the caller reuses its frame buffer
    executor.run_all()
    done = refresher.drain()

    assert len(done) == 1
    result = done[0]
    assert isinstance(result, Refreshed)
    assert (result.key, result.seq, result.keyframe) == ("target", 5, False)
    assert np.array_equal(result.box, BOX)
    assert result.took_s >= 0
    assert result.crop is not None
    assert result.crop.origin == (10.0, 20.0)
    assert result.crop.logits.shape == (60, 40)
    assert segmenter.calls == [(96, 72, (10.0, 20.0, 50.0, 80.0))]
    assert refresher.in_flight == 0
    assert refresher.drain() == []  # a result is returned once


def test_submit_copies_the_frame_and_the_box():
    seen: list[int] = []

    class Spy(FakeSegmenter):
        def encode(self, rgb: np.ndarray) -> SegEncoding:
            seen.append(int(rgb[0, 0, 0]))
            return super().encode(rgb)

    executor = ManualExecutor()
    refresher = Refresher(Spy(), executor, clock=Clock())
    rgb, box = frame(7), BOX.copy()
    refresher.submit("a", 1, rgb, box)
    rgb[:] = 99
    box[:] = 0
    executor.run_all()

    assert seen == [7]
    assert np.array_equal(refresher.drain()[0].box, BOX)


def test_took_s_is_the_segmenters_time_by_the_clock():
    class Slow(FakeSegmenter):
        def encode(self, rgb: np.ndarray) -> SegEncoding:
            clock.t += 0.4
            return super().encode(rgb)

    clock, executor = Clock(), ManualExecutor()
    refresher = Refresher(Slow(), executor, clock=clock)
    refresher.submit("a", 1, frame(), BOX)
    executor.run_all()

    assert refresher.drain()[0].took_s == pytest.approx(0.4)


def test_nothing_found_comes_back_as_none_crop():
    class Empty(FakeSegmenter):
        def mask_in_box(self, enc, box):
            return None

    executor = ManualExecutor(run_now=True)
    refresher = Refresher(Empty(), executor, clock=Clock())
    assert refresher.submit("a", 3, frame(), BOX)
    done = refresher.drain()

    assert [(r.key, r.seq, r.crop) for r in done] == [("a", 3, None)]


def test_submit_refuses_while_in_flight():
    refresher, segmenter, executor, clock = make()
    assert refresher.submit("a", 1, frame(), BOX)

    clock.t += 1.0  # long past the interval: only the call in flight is the reason
    assert not refresher.submit("b", 2, frame(), BOX)
    assert len(executor.pending) == 1  # the refusal queued nothing

    executor.run_all()
    refresher.drain()
    assert refresher.in_flight == 0
    assert refresher.submit("b", 2, frame(), BOX)
    executor.run_all()
    assert [r.key for r in refresher.drain()] == ["b"]
    assert len(segmenter.calls) == 2


def test_submit_respects_min_interval():
    refresher, _, executor, clock = make(min_interval_s=0.15)
    assert refresher.submit("a", 1, frame(), BOX)
    executor.run_all()
    refresher.drain()

    clock.t += 0.1
    assert not refresher.submit("b", 2, frame(), BOX)  # any key counts
    assert executor.pending == []

    clock.t += 0.1  # 0.2 s after the first submit
    assert refresher.submit("b", 2, frame(), BOX)


def test_interval_is_measured_from_the_last_submit_not_the_last_finish():
    refresher, _, executor, clock = make(min_interval_s=0.15)
    refresher.submit("a", 1, frame(), BOX)
    clock.t += 0.5  # the call takes a while
    executor.run_all()
    refresher.drain()

    assert refresher.submit("a", 2, frame(), BOX)  # 0.5 s since the submit: due


def test_keyframe_ignores_the_interval():
    refresher, _, executor, clock = make(min_interval_s=0.15)
    refresher.submit("a", 1, frame(), BOX)
    executor.run_all()
    refresher.drain()

    clock.t += 0.01
    assert not refresher.submit("a", 2, frame(), BOX)
    assert refresher.submit("a", 2, frame(), BOX, keyframe=True)
    assert len(executor.pending) == 1


def test_keyframe_waits_then_goes():
    refresher, segmenter, executor, clock = make()
    assert refresher.submit("a", 1, frame(), BOX)

    kf_box = np.array([30, 30, 60, 60], np.float32)
    assert refresher.submit("target", 2, frame(), kf_box, keyframe=True)  # kept as pending
    assert refresher.in_flight == 1
    assert len(executor.pending) == 1  # only the first call is queued

    assert refresher.drain() == []  # the first call has not finished: pending still waits
    assert len(executor.pending) == 1

    executor.run_all()
    first = refresher.drain()  # returns the first result, then submits the pending keyframe
    assert [(r.key, r.keyframe) for r in first] == [("a", False)]
    assert refresher.in_flight == 1
    assert len(executor.pending) == 1

    executor.run_all()
    second = refresher.drain()
    assert [(r.key, r.seq, r.keyframe) for r in second] == [("target", 2, True)]
    assert np.array_equal(second[0].box, kf_box)
    assert refresher.in_flight == 0
    assert [call[2] for call in segmenter.calls] == [tuple(BOX), tuple(kf_box)]
    assert refresher.drain() == []  # and nothing is left pending


def test_newer_keyframe_replaces_the_pending_one():
    refresher, segmenter, executor, _ = make()
    refresher.submit("a", 1, frame(), BOX)
    assert refresher.submit("t", 2, frame(), BOX + 1, keyframe=True)
    assert refresher.submit("t", 3, frame(), BOX + 2, keyframe=True)

    executor.run_all()
    refresher.drain()
    executor.run_all()
    done = refresher.drain()

    assert [(r.seq, r.keyframe) for r in done] == [(3, True)]
    assert len(segmenter.calls) == 2  # seq 2 never ran


def test_non_keyframe_does_not_jump_a_pending_keyframe():
    refresher, _, executor, clock = make()
    refresher.submit("a", 1, frame(), BOX)
    refresher.submit("t", 2, frame(), BOX, keyframe=True)
    executor.run_all()  # the first call is done, but drain has not yet started the keyframe
    clock.t += 1.0

    assert not refresher.submit("a", 3, frame(), BOX)
    refresher.drain()
    executor.run_all()
    assert [r.seq for r in refresher.drain()] == [2]


def test_keyframes_for_other_keys_all_wait_and_go_oldest_first():
    refresher, segmenter, executor, _ = make()
    refresher.submit("a", 1, frame(), BOX)
    for i, key in enumerate("xyz"):  # one jev answer about three objects
        assert refresher.submit(key, 2, frame(), BOX + i, keyframe=True)

    done = []
    for _ in range(4):
        executor.run_all()
        done += refresher.drain()

    assert [(r.key, r.keyframe) for r in done] == [
        ("a", False),
        ("x", True),
        ("y", True),
        ("z", True),
    ]
    assert [call[2] for call in segmenter.calls] == [tuple(BOX + i) for i in (0, 0, 1, 2)]


def test_a_newer_keyframe_replaces_its_keys_pending_one_in_its_place():
    refresher, segmenter, executor, _ = make()
    refresher.submit("a", 1, frame(), BOX)
    refresher.submit("x", 2, frame(), BOX, keyframe=True)
    refresher.submit("y", 3, frame(), BOX, keyframe=True)
    refresher.submit("x", 4, frame(), BOX, keyframe=True)  # x's newer view

    done = []
    for _ in range(4):
        executor.run_all()
        done += refresher.drain()

    assert [(r.key, r.seq) for r in done] == [("a", 1), ("x", 4), ("y", 3)]
    assert len(segmenter.calls) == 3  # x on frame 2 never ran


def test_non_keyframe_is_refused_while_any_keyframe_waits():
    refresher, _, executor, clock = make()
    refresher.submit("a", 1, frame(), BOX)
    refresher.submit("x", 2, frame(), BOX, keyframe=True)
    refresher.submit("y", 2, frame(), BOX, keyframe=True)
    executor.run_all()
    refresher.drain()  # x goes
    executor.run_all()  # x is done, y still waits
    clock.t += 1.0

    assert not refresher.submit("a", 3, frame(), BOX)
    refresher.drain()  # y goes
    executor.run_all()
    refresher.drain()
    clock.t += 1.0
    assert refresher.submit("a", 4, frame(), BOX)


def test_a_keyframe_when_idle_goes_after_those_already_waiting():
    refresher, segmenter, executor, _ = make()
    refresher.submit("a", 1, frame(), BOX)
    refresher.submit("x", 2, frame(), BOX + 1, keyframe=True)
    executor.run_all()  # nothing in flight now, but x waits for the next drain

    assert refresher.submit("y", 3, frame(), BOX + 2, keyframe=True)
    assert refresher.in_flight == 1  # x went at once, y waits behind it
    done = refresher.drain()
    for _ in range(2):
        executor.run_all()
        done += refresher.drain()

    assert [r.key for r in done] == ["a", "x", "y"]
    assert [call[2] for call in segmenter.calls] == [tuple(BOX + i) for i in (0, 1, 2)]


def test_keyframe_when_idle_goes_at_once():
    refresher, segmenter, executor, _ = make()
    assert refresher.submit("t", 1, frame(), BOX, keyframe=True)
    executor.run_all()
    assert [r.keyframe for r in refresher.drain()] == [True]
    assert len(segmenter.calls) == 1


def test_pending_keyframe_counts_for_the_interval_once_it_goes():
    refresher, _, executor, clock = make(min_interval_s=0.15)
    refresher.submit("a", 1, frame(), BOX)
    refresher.submit("t", 2, frame(), BOX, keyframe=True)
    clock.t += 1.0
    executor.run_all()
    refresher.drain()  # the keyframe goes now
    executor.run_all()
    refresher.drain()

    clock.t += 0.1
    assert not refresher.submit("a", 3, frame(), BOX)  # 0.1 s after the keyframe went


def test_segmenter_error_is_dropped_and_logged(caplog):
    class Broken(FakeSegmenter):
        fail = True

        def encode(self, rgb: np.ndarray) -> SegEncoding:
            if self.fail:
                raise RuntimeError("MPS out of memory")
            return super().encode(rgb)

    segmenter, executor, clock = Broken(), ManualExecutor(), Clock()
    refresher = Refresher(segmenter, executor, clock=clock)

    with caplog.at_level(logging.INFO, logger="clio_tracker"):
        refresher.submit("a", 1, frame(), BOX)
        executor.run_all()
        assert refresher.drain() == []
        assert refresher.in_flight == 0
        assert [r.levelno for r in caplog.records] == [logging.WARNING]
        assert "MPS out of memory" in caplog.text
        assert segmenter.name in caplog.text

        # still down: dropped again, not logged again
        clock.t += 1.0
        assert refresher.submit("a", 2, frame(), BOX)
        executor.run_all()
        assert refresher.drain() == []
        assert len(caplog.records) == 1

        # back: the result is delivered and the recovery is logged once
        segmenter.fail = False
        clock.t += 1.0
        assert refresher.submit("a", 3, frame(), BOX)
        executor.run_all()
        assert [r.seq for r in refresher.drain()] == [3]
        assert [r.levelno for r in caplog.records] == [logging.WARNING, logging.INFO]


def test_error_in_mask_in_box_frees_the_slot_too():
    class Broken(FakeSegmenter):
        def mask_in_box(self, enc, box):
            raise ValueError("bad box")

    executor = ManualExecutor(run_now=True)
    refresher = Refresher(Broken(), executor, clock=Clock())
    assert refresher.submit("a", 1, frame(), BOX)
    assert refresher.drain() == []
    assert refresher.in_flight == 0


def test_executor_that_refuses_the_work_leaves_nothing_in_flight():
    class Refusing(ManualExecutor):
        refuse = True

        def submit(self, fn, *args, **kwargs):
            if self.refuse:
                raise RuntimeError("cannot schedule new futures after shutdown")
            return super().submit(fn, *args, **kwargs)

    segmenter, executor = FakeSegmenter(), Refusing(run_now=True)
    refresher = Refresher(segmenter, executor, clock=Clock())

    with pytest.raises(RuntimeError, match="after shutdown"):
        refresher.submit("a", 1, frame(), BOX)
    assert refresher.in_flight == 0

    executor.refuse = False  # no time passes: the refused call did not start the interval
    assert refresher.submit("a", 2, frame(), BOX)
    assert [r.seq for r in refresher.drain()] == [2]
    assert refresher.in_flight == 0


def test_real_thread_runs_the_call_while_the_frame_thread_is_refused():
    started, release = threading.Event(), threading.Event()

    class Blocking(FakeSegmenter):
        def encode(self, rgb: np.ndarray) -> SegEncoding:
            started.set()
            assert release.wait(5), "the test never released the encoder"
            return super().encode(rgb)

    clock = Clock()
    executor = ThreadPoolExecutor(max_workers=1)
    refresher = Refresher(Blocking(), executor, clock=clock)
    try:
        assert refresher.submit("a", 1, frame(), BOX)
        assert started.wait(5)
        clock.t += 1.0  # past the interval: only the call in flight is the reason

        assert not refresher.submit("a", 2, frame(), BOX)
        assert refresher.in_flight == 1
        assert refresher.drain() == []
    finally:
        release.set()
        executor.shutdown(wait=True)

    done = refresher.drain()
    assert [(r.key, r.seq) for r in done] == [("a", 1)]
    assert refresher.in_flight == 0
