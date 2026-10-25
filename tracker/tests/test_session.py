"""TrackerSession: one YOLOE pass per request, jev beside it on its own clock."""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import cv2
import numpy as np
import pytest

from clio_tracker.identify import FrameImage, Query
from clio_tracker.refresh import Refresher
from clio_tracker.session import SessionSettings, TrackerSession
from clio_tracker.track import FrameHeader, Modes, ObjectSet, StreamTracker
from conftest import (
    Clock,
    FakeIdentifier,
    FakeSegmenter,
    ManualExecutor,
    Thing,
    appearance,
    blend,
    frame_image,
    norm_box,
)

A = appearance(1)
B = blend(A, appearance(2), 0.85)
CUP = Query("cup", "A blue ceramic cup on the left of the table", "blue cup")


def at(x: float) -> tuple[float, float, float, float]:
    return (x, 300.0, x + 120.0, 460.0)


@pytest.fixture
def setup(vision):
    clock = Clock()
    jev = FakeIdentifier()
    executor = ManualExecutor()
    session = TrackerSession(vision, jev, executor, SessionSettings(), clock)

    def frame(*things: Thing, queries=(CUP,), dt=1 / 15):
        clock.t += dt
        vision.scenes.append(list(things))
        detections, _ = session.locate(frame_image(), list(queries))
        return detections

    return session, jev, executor, clock, frame


def test_first_frame_asks_jev_and_answers_not_found_meanwhile(setup):
    session, jev, executor, _, frame = setup
    (d,) = frame(Thing(at(100), A))
    assert d == {"id": "cup", "found": False, "track": {"state": "unknown"}}
    assert len(executor.pending) == 1
    executor.run_all()
    assert jev.calls == [[CUP]]


def test_jev_answer_turns_into_tracking_on_later_frames(setup):
    _, jev, executor, _, frame = setup
    jev.answers.append({"cup": (0.93, norm_box(at(100)))})
    frame(Thing(at(100), A), Thing(at(500), B))
    executor.run_all()
    found = [frame(Thing(at(100 + 4 * i), A), Thing(at(500), B))[0] for i in range(1, 4)]
    assert found[-1]["found"] and found[-1]["track"]["state"] == "tracking"
    x1, _, x2, _ = found[-1]["box"]
    assert x1 == pytest.approx(112 / 960, abs=0.01) and x2 == pytest.approx(232 / 960, abs=0.01)
    assert len(found[-1]["outline"]) == 4 and found[-1]["confidence"] >= 0.5
    assert found[-1]["contact"] == pytest.approx([172 / 960, 460 / 720], abs=0.01)


def test_jev_looks_again_once_per_interval_not_per_frame(setup):
    _, jev, executor, clock, frame = setup
    jev.answers.extend([{"cup": (0.9, norm_box(at(100)))}] * 10)
    frame(Thing(at(100), A))
    executor.run_all()
    for _ in range(14):  # just under a second at 15 fps
        frame(Thing(at(100), A))
        executor.run_all()
    assert len(jev.calls) == 1
    frame(Thing(at(100), A), dt=0.1)
    executor.run_all()
    assert len(jev.calls) == 2


def test_no_more_than_max_in_flight(vision):
    clock, jev, executor = Clock(), FakeIdentifier(), ManualExecutor()
    session = TrackerSession(
        vision, jev, executor, SessionSettings(identify_max_in_flight=2), clock
    )
    for _ in range(40):
        clock.t += 0.5
        vision.scenes.append([Thing(at(100), A)])
        session.locate(frame_image(), [CUP])
    assert len(executor.pending) == 2


def test_new_words_for_an_id_start_over_and_drop_old_answers(setup):
    session, jev, executor, _, frame = setup
    jev.answers.append({"cup": (0.9, norm_box(at(100)))})
    frame(Thing(at(100), A))
    mug = Query("cup", "A red mug", "red mug")
    frame(Thing(at(100), A), queries=(mug,))  # re-worded before jev answered
    executor.run_all()
    (d,) = frame(Thing(at(100), A), queries=(mug,))
    (d,) = frame(Thing(at(100), A), queries=(mug,))
    assert not d["found"]


def test_an_identifier_failure_is_logged_once_and_tracking_continues(setup, caplog):
    _, jev, executor, clock, frame = setup
    jev.answers.extend(
        [{"cup": (0.9, norm_box(at(100)))}, RuntimeError("HTTP 529"), RuntimeError("HTTP 529")]
    )
    frame(Thing(at(100), A))
    executor.run_all()
    for _ in range(3):
        frame(Thing(at(100), A))
    with caplog.at_level(logging.WARNING, logger="clio_tracker"):
        for _ in range(2):
            frame(Thing(at(100), A), dt=1.1)
            executor.run_all()
        (d,) = frame(Thing(at(100), A))
    assert d["found"]
    assert sum("HTTP 529" in r.message for r in caplog.records) == 1


def asked_at(jev, executor, clock, frame, frames: int) -> list[float]:
    """Streams frames of the cup, jev's calls run at once: when each call went out."""
    times: list[float] = []
    for _ in range(frames):
        frame(Thing(at(100), A))
        executor.run_all()
        times.extend([clock.t] * (len(jev.calls) - len(times)))
    return times


def gaps(times: list[float]) -> list[float]:
    return [b - a for a, b in zip(times[:-1], times[1:], strict=True)]


def test_a_failing_identifier_is_asked_less_often_not_on_every_frame(setup, caplog):
    _, jev, executor, clock, frame = setup
    jev.answers.extend([RuntimeError("HTTP 429")] * 50)  # fails at once, every time
    with caplog.at_level(logging.INFO, logger="clio_tracker"):
        times = asked_at(jev, executor, clock, frame, 20 * 15)  # 20 s at 15 fps, never placed
    # The interval after the first failure, then twice as long each time (plus the frame that
    # notices the failure).
    assert gaps(times) == pytest.approx([1, 2, 4, 8], abs=0.15)
    assert sum("HTTP 429" in r.message for r in caplog.records) == 1


def test_the_wait_while_the_identifier_fails_is_capped(vision):
    clock, jev, executor = Clock(), FakeIdentifier(), ManualExecutor()
    settings = SessionSettings(identify_backoff_max_s=3.0)
    session = TrackerSession(vision, jev, executor, settings, clock)
    jev.answers.extend([RuntimeError("HTTP 503")] * 50)

    def frame(*things: Thing):
        clock.t += 1 / 25
        vision.scenes.append(list(things))
        session.locate(frame_image(), [CUP])

    times = asked_at(jev, executor, clock, frame, 16 * 25)  # 16 s at 25 fps
    assert gaps(times) == pytest.approx([1, 2, 3, 3, 3, 3], abs=0.1)


def test_the_first_answer_after_failures_ends_the_wait(setup, caplog):
    _, jev, executor, clock, frame = setup
    down, placed = RuntimeError("HTTP 429"), {"cup": (0.9, norm_box(at(100)))}
    jev.answers.extend([down] * 3 + [placed, down] + [placed] * 3)
    with caplog.at_level(logging.INFO, logger="clio_tracker"):
        times = asked_at(jev, executor, clock, frame, 10 * 15)
        (d,) = frame(Thing(at(100), A))
    # Three failures, the answer that places the cup, its next look a plain interval later, and
    # when that one fails, the interval again: the wait started over.
    assert gaps(times) == pytest.approx([1, 2, 4, 1, 1], abs=0.15)
    assert d["found"]
    told = [r.message for r in caplog.records if "429" in r.message or "answers again" in r.message]
    assert len(told) == 4  # each outage once, as it starts and as it ends
    assert "answers again, after 3 failed" in told[1] and "after 1 failed" in told[3]


def test_objects_nobody_asks_about_are_forgotten(setup):
    session, _, _, _, frame = setup
    frame(Thing(at(100), A))
    other = Query("jug", "A white plastic jug", "jug")
    frame(Thing(at(100), A), queries=(other,), dt=11)
    assert set(session._objects) == {"jug"}


def test_follow_answers_sightings_in_order_and_the_frame_size(setup, vision):
    session, jev, executor, clock, frame = setup
    jug = Query("jug", "A white plastic jug", "white jug")
    jev.answers.append({"cup": (0.9, norm_box(at(100))), "jug": (0.9, norm_box(at(500)))})
    frame(Thing(at(100), A), Thing(at(500), B), queries=(CUP, jug))
    executor.run_all()
    assert jev.calls == [[CUP, jug]]  # one call for both
    clock.t += 1 / 15
    vision.scenes.append([Thing(at(100), A), Thing(at(500), B)])
    (cup, other), size, _ = session.follow(frame_image(), [CUP, jug])
    assert size == (960, 720)
    assert cup.found and cup.box[0] == pytest.approx(100, abs=1)
    assert other.found and other.box[0] == pytest.approx(500, abs=1)


def test_dropped_objects_go_at_once_and_jevs_late_answer_is_ignored(setup):
    session, jev, executor, _, frame = setup
    jev.answers.append({"cup": (0.9, norm_box(at(100)))})
    frame(Thing(at(100), A))
    session.drop(["cup"])
    assert session._objects == {}
    executor.run_all()  # answers about the dropped cup
    (d,) = frame(Thing(at(100), A))
    assert d["track"]["state"] == "unknown"  # the cup again, from scratch
    assert len(executor.pending) == 1  # and asked about at once


def test_new_query_words_keep_the_tracker_and_reach_jev(setup):
    session, jev, executor, clock, frame = setup
    jev.answers.extend([{"cup": (0.9, norm_box(at(100)))}] * 3)
    frame(Thing(at(100), A))
    executor.run_all()
    (before,) = frame(Thing(at(100), A))
    tracker = session._objects["cup"]
    reworded = Query("cup", "The blue cup the learner fills first", "blue cup")
    (after,) = frame(Thing(at(100), A), queries=(reworded,), dt=1.1)
    executor.run_all()
    assert session._objects["cup"] is tracker and after["track"] == before["track"]
    assert jev.calls[-1] == [reworded]


# --- the segmenter -----------------------------------------------------------------------------

JEV = (90.0, 290.0, 230.0, 470.0)  # jev's box around the cup at(100), a little loose: the fake mask


def texture() -> np.ndarray:
    """A 960 x 720 RGB frame of smooth noise, for the follower's flow (frame_image is flat)."""
    noise = np.random.default_rng(7).integers(0, 256, (90, 120)).astype(np.uint8)
    gray = cv2.resize(noise, (960, 720), interpolation=cv2.INTER_CUBIC)
    return np.ascontiguousarray(np.repeat(gray[..., None], 3, axis=2))


def bounds(outline: list[list[float]]) -> list[float]:
    xs, ys = zip(*outline, strict=True)
    return [min(xs), min(ys), max(xs), max(ys)]


@pytest.fixture
def segmented(vision, segmenter):
    """A session with the fake segmenter, whose calls (like jev's) run only when told to."""
    clock, jev, executor, segmenting = Clock(), FakeIdentifier(), ManualExecutor(), ManualExecutor()
    refresher = Refresher(segmenter, segmenting, clock=clock)
    session = TrackerSession(
        vision, jev, executor, SessionSettings(), clock, segmenter=segmenter, refresher=refresher
    )
    image = FrameImage(b"jpeg", "image/jpeg", texture())

    def frame(*things: Thing) -> dict:
        clock.t += 1 / 15
        vision.scenes.append(list(things))
        (d,) = session.locate(image, [CUP])[0]
        return d

    return SimpleNamespace(
        session=session,
        jev=jev,
        executor=executor,
        segmenting=segmenting,
        refresher=refresher,
        segmenter=segmenter,
        frame=frame,
    )


def test_the_frame_jev_looks_at_is_kept_whole_only_for_a_segmenter(setup, segmented):
    session, _, _, _, frame = setup
    frame(Thing(at(100), A))
    ((enc, rgb),) = session._frames.values()  # jev is looking at it
    assert rgb is None and enc is not None  # its YOLOE pass is all an answer needs
    segmented.frame(Thing(at(100), A))
    ((_, rgb),) = segmented.session._frames.values()
    assert rgb is not None and rgb.shape == (720, 960, 3)  # for jev's keyframe


def test_session_keyframe_after_jev_answer(segmented):
    s = segmented
    s.jev.answers.append({"cup": (0.93, norm_box(JEV))})
    assert not s.frame(Thing(at(100), A))["found"]
    s.executor.run_all()  # jev answers about frame 1
    s.frame(Thing(at(100), A))  # the answer applies, and jev's box goes to the segmenter
    assert s.refresher.in_flight == 1 and len(s.segmenting.pending) == 1
    s.segmenting.run_all()
    ((width, height, box),) = s.segmenter.calls
    assert (width, height) == (960, 720) and box == pytest.approx(JEV)
    for _ in range(10):
        d = s.frame(Thing(at(100), A))
    assert s.session._objects["cup"].follower.reference_seq == 1  # the mask of jev's frame
    assert d["found"] and d["track"]["state"] == "tracking"
    # The fake mask fills jev's box; FakeVision outlines the cup's own box, 10 pixels inside it.
    assert d["box"] == pytest.approx(list(norm_box(JEV)), abs=2 / 960)
    assert bounds(d["outline"]) == pytest.approx(list(norm_box(JEV)), abs=2 / 960)
    assert len(s.segmenter.calls) == 1  # the follower is sure of itself: no refresh asked


def test_objects_mode_outline_comes_from_the_segmenter(vision, segmenter):
    jev, executor, clock = FakeIdentifier(), ManualExecutor(run_now=True), Clock()
    segmenting = ManualExecutor()

    def session() -> TrackerSession:
        refresher = Refresher(segmenter, segmenting, clock=clock)
        settings = SessionSettings()
        return TrackerSession(
            vision, jev, executor, settings, clock, segmenter=segmenter, refresher=refresher
        )

    modes = Modes(StreamTracker(vision), session)
    ok, jpeg = cv2.imencode(".jpg", texture())  # gray, so BGR or RGB alike
    assert ok

    def play(seq: int) -> list[dict]:
        clock.t += 1 / 15
        vision.scenes.append([Thing(at(100), A)])
        return modes.step(FrameHeader(seq, 1000.0 + 66 * seq, 960, 720), jpeg.tobytes())[
            "detections"
        ]

    jev.answers.append({"cup": (0.9, norm_box(JEV))})
    modes.command(ObjectSet([CUP]))
    play(0)  # jev is asked, and answers at once
    play(1)  # the answer applies: jev's box goes to the segmenter
    assert len(segmenting.pending) == 1
    segmenting.run_all()
    for seq in range(2, 12):
        (cup,) = play(seq)
    assert cup["found"] and cup["state"] == "tracking"
    assert bounds(cup["outline"]) == pytest.approx(list(norm_box(JEV)), abs=2 / 960)
    assert cup["box"] == pytest.approx(list(norm_box(JEV)), abs=2 / 960)


def test_the_session_carries_on_without_the_segmenter_once_its_executor_is_shut_down(
    vision, segmenter, caplog
):
    stopped = ThreadPoolExecutor(max_workers=1)
    stopped.shutdown()
    clock, executor = Clock(), ManualExecutor(run_now=True)
    jevs = [FakeIdentifier(), FakeIdentifier()]
    sessions = [
        TrackerSession(
            vision,
            jevs[0],
            executor,
            SessionSettings(),
            clock,
            segmenter=segmenter,
            refresher=Refresher(segmenter, stopped),
        ),
        TrackerSession(vision, jevs[1], executor, SessionSettings(), clock),
    ]
    image = FrameImage(b"jpeg", "image/jpeg", texture())
    answers: list[list[dict]] = [[], []]
    with caplog.at_level(logging.WARNING, logger="clio_tracker"):
        for _ in range(6):
            clock.t += 1 / 15
            for jev, session, out in zip(jevs, sessions, answers, strict=True):
                jev.answers.append({"cup": (0.9, norm_box(at(100)))})
                vision.scenes.append([Thing(at(100), A)])
                out.extend(session.locate(image, [CUP])[0])
    assert answers[0] == answers[1] and answers[0][-1]["found"]
    assert sessions[0].refresher is None
    assert sum("fake-segmenter" in r.message for r in caplog.records) == 1


THREE = {"a": at(100), "b": at(400), "c": at(700)}


def several(vision, segmenter, ids: str):
    """A session over things a, b and c (those in `ids` asked about), jev answering at once and
    the segmenter's calls run after every frame."""
    clock, jev, executor = Clock(), FakeIdentifier(), ManualExecutor(run_now=True)
    segmenting = ManualExecutor()
    refresher = Refresher(segmenter, segmenting, clock=clock)
    session = TrackerSession(
        vision, jev, executor, SessionSettings(), clock, segmenter=segmenter, refresher=refresher
    )
    queries = [Query(k, f"thing {k}", f"thing {k}") for k in ids]
    things = [Thing(box, appearance(10 + i)) for i, box in enumerate(THREE.values())]
    image = FrameImage(b"jpeg", "image/jpeg", texture())

    def frame() -> None:
        clock.t += 1 / 15
        vision.scenes.append(list(things))
        session.locate(image, queries)
        segmenting.run_all()

    jev.answers.append({k: (0.9, norm_box(THREE[k])) for k in ids})
    return session, frame


def test_three_objects_placed_by_one_jev_answer_each_get_a_keyframe(vision, segmenter):
    encodes = []
    encode = segmenter.encode
    segmenter.encode = lambda rgb: encodes.append(1) or encode(rgb)
    session, frame = several(vision, segmenter, "abc")
    for _ in range(6):
        frame()
    assert [call[2][0] for call in segmenter.calls] == pytest.approx([100, 400, 700])
    assert len(encodes) == 1  # one job: jev's frame encoded once for the three boxes
    assert [session._objects[k].follower.reference_seq for k in "abc"] == [1, 1, 1]


def test_an_object_the_segmenter_keeps_failing_on_does_not_starve_another(vision, segmenter):
    misses = {100.0: 1000, 400.0: 1}  # nothing in a's box, ever; nothing in b's the first time

    def picky(enc, box):
        crop = FakeSegmenter.mask_in_box(segmenter, enc, box)
        x0 = float(box[0])
        if misses.get(x0, 0):
            misses[x0] -= 1
            return None
        return crop

    segmenter.mask_in_box = picky
    session, frame = several(vision, segmenter, "ab")
    for _ in range(14):  # under a second: jev is asked once
        frame()
    asked = [call[2][0] for call in segmenter.calls]
    assert asked[:2] == pytest.approx([100, 400])  # the two keyframes, both empty
    assert asked.count(400.0) == 2  # then b's turn came, between a's
    assert session._objects["b"].follower.active and not session._objects["a"].follower.active
