"""TrackerSession: one YOLOE pass per request, jev beside it on its own clock."""

from __future__ import annotations

import logging

import pytest

from clio_tracker.identify import Query
from clio_tracker.session import SessionSettings, TrackerSession
from conftest import (
    Clock,
    FakeIdentifier,
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


def test_objects_nobody_asks_about_are_forgotten(setup):
    session, _, _, _, frame = setup
    frame(Thing(at(100), A))
    other = Query("jug", "A white plastic jug", "jug")
    frame(Thing(at(100), A), queries=(other,), dt=11)
    assert set(session._objects) == {"jug"}
