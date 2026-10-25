"""The /track stream (TRACK.md): messages, tracking a named target, objects mode, and the
WebSocket itself."""

from __future__ import annotations

import json
import logging
import socket
import struct
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import cv2
import numpy as np
import pytest
import uvicorn
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from clio_tracker.finder import Finder
from clio_tracker.identify import JevIdentifier, Query
from clio_tracker.refresh import Refresher
from clio_tracker.server import create_app
from clio_tracker.session import Sessions, SessionSettings, TrackerSession
from clio_tracker.track import (
    MAX_OBJECTS,
    Anchor,
    BadMessage,
    FrameHeader,
    Modes,
    ObjectSet,
    StreamTracker,
    TargetBox,
    _tracked,
    parse_command,
    parse_frame,
)
from clio_tracker.tracking import Sighting, TrackerParams
from conftest import (
    Clock,
    FakeIdentifier,
    ManualExecutor,
    Thing,
    appearance,
    blend,
    norm_box,
    scene_jpeg,
)

A = appearance(1)
B = blend(A, appearance(2), 0.85)  # a look-alike
C = appearance(3)  # something else
CUP = (100.0, 300.0, 220.0, 460.0)
OTHER = (600.0, 280.0, 720.0, 440.0)
JUG = OTHER


def frame(seq: int, scene: int = 1) -> bytes:
    header = json.dumps(
        {"type": "frame", "seq": seq, "t": 1000.0 + 66 * seq, "width": 960, "height": 720}
    ).encode()
    return struct.pack(">I", len(header)) + header + scene_jpeg(scene)


def target(seq: int, box=CUP, name: str = "blue cup") -> str:
    x0, y0, x1, y1 = box
    return json.dumps(
        {
            "type": "target",
            "seq": seq,
            "box": [x0 / 960, y0 / 720, x1 / 960, y1 / 720],
            "name": name,
        }
    )


@pytest.fixture
def world(vision):
    vision.world[1] = [Thing(CUP, A), Thing(OTHER, B)]
    vision.world[2] = [Thing((110.0, 300.0, 230.0, 460.0), A), Thing(OTHER, B)]
    return vision


# --- messages ----------------------------------------------------------------------------------


def test_frames_and_commands_parse():
    header, jpeg = parse_frame(frame(7))
    assert header == FrameHeader(7, 1462.0, 960, 720) and jpeg == scene_jpeg(1)
    assert parse_command('{"type": "clear"}') is None
    t = parse_command(target(3))
    assert isinstance(t, TargetBox) and t.seq == 3 and t.name == "blue cup"


@pytest.mark.parametrize(
    "data",
    [
        b"\x00\x00",
        struct.pack(">I", 9999) + b"{}",
        struct.pack(">I", 2) + b"{}" + b"jpeg",
        struct.pack(">I", 15) + b'{"type":"text"}' + b"jpeg",
    ],
)
def test_bad_frames_are_refused(data):
    with pytest.raises(BadMessage):
        parse_frame(data)


@pytest.mark.parametrize(
    "text",
    [
        "not json",
        '{"type": "dance"}',
        '{"type": "target", "seq": 1.5, "box": [0, 0, 1, 1]}',
        '{"type": "target", "seq": 1, "box": [0.5, 0, 0.4, 1]}',
        '{"type": "target", "seq": 1, "box": [0, 0, 1, 1], "name": 7}',
    ],
)
def test_bad_commands_are_refused(text):
    with pytest.raises(BadMessage):
        parse_command(text)


def objects(*items: dict) -> str:
    return json.dumps({"type": "objects", "objects": list(items)})


CUP_WORDS = {"id": "cup", "phrase": "blue cup", "query": "A blue ceramic cup on the left"}
JUG_WORDS = {"id": "jug", "phrase": "white jug", "query": "A white plastic jug on the right"}
CUP_Q = Query("cup", "A blue ceramic cup on the left", "blue cup")
JUG_Q = Query("jug", "A white plastic jug on the right", "white jug")


def test_objects_parse_in_order_first_words_win_and_at_most_eight():
    assert parse_command(objects(CUP_WORDS, JUG_WORDS)) == ObjectSet([CUP_Q, JUG_Q])
    assert parse_command(objects()) == ObjectSet([])
    again = {**CUP_WORDS, "phrase": "red mug"}
    assert parse_command(objects(CUP_WORDS, again)).objects == [CUP_Q]
    plain = parse_command(objects({"id": "cup", "query": "  A cup  ", "phrase": " "}))
    assert plain.objects == [Query("cup", "A cup", None)]
    many = [{"id": f"o{i}", "phrase": "cup", "query": "A cup"} for i in range(MAX_OBJECTS + 3)]
    assert [q.id for q in parse_command(objects(*many)).objects] == [f"o{i}" for i in range(8)]


@pytest.mark.parametrize(
    "text",
    [
        '{"type": "objects"}',
        '{"type": "objects", "objects": {"id": "cup"}}',
        '{"type": "objects", "objects": ["cup"]}',
        '{"type": "objects", "objects": [{"query": "A cup"}]}',
        '{"type": "objects", "objects": [{"id": "", "query": "A cup"}]}',
        '{"type": "objects", "objects": [{"id": "cup", "query": " ... "}]}',
        '{"type": "objects", "objects": [{"id": "cup", "query": "A cup", "phrase": 3}]}',
    ],
)
def test_bad_objects_are_refused(text):
    with pytest.raises(BadMessage):
        parse_command(text)


def anchor(seq: int, box=CUP, oid: str = "cup", **extra) -> str:
    """An anchor on the frame `frame(seq)` streams (its capture time), `box` in frame pixels."""
    x0, y0, x1, y1 = box
    return json.dumps(
        {
            "type": "anchor",
            "id": oid,
            "t": 1000.0 + 66 * seq,
            "box": [x0 / 960, y0 / 720, x1 / 960, y1 / 720],
            "source": "er",
            **extra,
        }
    )


def test_anchors_parse_with_er_as_the_source_and_words_trimmed():
    a = parse_command(anchor(3, query="  The blue cup on the left, half full  "))
    assert a == Anchor("cup", 1198.0, norm_box(CUP), "er", "The blue cup on the left, half full")
    bare = json.loads(anchor(3))
    del bare["source"]
    assert parse_command(json.dumps(bare)) == Anchor("cup", 1198.0, norm_box(CUP), "er", None)


@pytest.mark.parametrize(
    "fields",
    [
        {"id": ""},
        {"id": 7},
        {"t": None},
        {"t": "now"},
        {"box": [0.5, 0.2, 0.4, 0.6]},
        {"box": [0.1, 0.2, 0.3]},
        {"box": [0.1, 0.2, 1.3, 0.6]},
        {"source": "jev"},
        {"query": " ... "},
        {"query": 3},
        {"query": "x" * 1001},
    ],
)
def test_bad_anchors_are_refused(fields):
    with pytest.raises(BadMessage):
        parse_command(json.dumps({**json.loads(anchor(3)), **fields}))


# --- tracking ----------------------------------------------------------------------------------


def step(tracker: StreamTracker, seq: int, scene: int = 1) -> dict:
    return tracker.step(*parse_frame(frame(seq, scene)))


def test_no_target_answers_not_found(world):
    answer = step(StreamTracker(world), 0)
    assert answer["type"] == "mask" and answer["found"] is False and answer["state"] == "idle"
    assert answer["outline"] is None and answer["name"] is None and answer["model"] == "fake-yoloe"
    assert answer["track"] is None


def test_a_target_on_an_earlier_frame_is_followed_from_the_next(world):
    tracker = StreamTracker(world)
    step(tracker, 0)
    tracker.command(parse_command(target(0)))
    answer = step(tracker, 1, scene=2)
    assert answer["found"] and answer["name"] == "blue cup" and answer["state"] == "tracking"
    assert answer["box"] == pytest.approx([110 / 960, 300 / 720, 230 / 960, 460 / 720], abs=1e-3)
    assert answer["contact"] == pytest.approx([170 / 960, 460 / 720], abs=1e-3)
    assert answer["seq"] == 1 and answer["t"] == 1066.0
    assert set(answer["ms"]) >= {"segment", "total"}
    assert isinstance(answer["track"], int)


def test_the_target_holds_against_a_look_alike_and_jev_can_move_it(world):
    tracker = StreamTracker(world)
    step(tracker, 0)
    tracker.command(parse_command(target(0)))
    for seq in range(1, 6):
        assert step(tracker, seq)["box"][0] == pytest.approx(100 / 960, abs=1e-3)
    tracker.command(parse_command(target(5, OTHER)))  # jev says it is the other one
    assert step(tracker, 6)["box"][0] == pytest.approx(600 / 960, abs=1e-3)


def test_a_target_before_its_frame_applies_to_the_next_frame(world):
    tracker = StreamTracker(world)
    tracker.command(parse_command(target(41)))
    answer = step(tracker, 0)
    assert answer["found"] and answer["box"][0] == pytest.approx(100 / 960, abs=1e-3)


def test_clear_and_another_name_start_over(world):
    tracker = StreamTracker(world)
    step(tracker, 0)
    tracker.command(parse_command(target(0)))
    assert step(tracker, 1)["found"]
    tracker.command(None)
    cleared = step(tracker, 2)
    assert cleared["found"] is False and cleared["name"] is None and cleared["state"] == "idle"
    tracker.command(parse_command(target(2, OTHER, name="white jug")))
    answer = step(tracker, 3)
    assert answer["name"] == "white jug" and answer["box"][0] == pytest.approx(600 / 960, 1e-3)


def test_frames_kept_for_targets_are_bounded(world):
    from clio_tracker.track import FRAMES_KEPT

    tracker = StreamTracker(world)
    for seq in range(FRAMES_KEPT + 20):
        tracker._keep(seq, b"x")
    assert len(tracker.frames) == FRAMES_KEPT and min(tracker.frames) == 20


# --- objects mode ------------------------------------------------------------------------------

MOVED_CUP = (110.0, 300.0, 230.0, 460.0)


@pytest.fixture
def lesson(vision):
    """A connection's Modes over a room with a cup and a jug (scene 3; scene 4: the cup moved;
    scene 5: the cup gone), the jev stand-in answering at once, and every session it makes."""
    vision.world[3] = [Thing(CUP, A), Thing(JUG, C)]
    vision.world[4] = [Thing(MOVED_CUP, A), Thing(JUG, C)]
    vision.world[5] = [Thing(JUG, C)]
    jev, executor, clock = FakeIdentifier(), ManualExecutor(run_now=True), Clock()
    made: list[TrackerSession] = []

    def session() -> TrackerSession:
        made.append(TrackerSession(vision, jev, executor, SessionSettings(), clock))
        return made[-1]

    encodes = []
    encode = vision.encode
    vision.encode = lambda rgb=None, scene=None: encodes.append(1) or encode(rgb, scene)
    return SimpleNamespace(
        modes=Modes(StreamTracker(vision), session),
        jev=jev,
        executor=executor,
        clock=clock,
        made=made,
        encodes=encodes,
    )


def play(lesson, seq: int, scene: int = 3, dt: float = 1 / 15) -> dict:
    lesson.clock.t += dt
    return lesson.modes.step(*parse_frame(frame(seq, scene)))


def both_placed() -> dict:
    return {"cup": (0.9, norm_box(CUP)), "jug": (0.9, norm_box(JUG))}


def test_objects_are_placed_by_one_jev_call_and_followed_on_every_frame(lesson):
    lesson.jev.answers.append(both_placed())
    lesson.modes.command(parse_command(objects(CUP_WORDS, JUG_WORDS)))
    first = play(lesson, 0)
    assert {k: first[k] for k in ("type", "seq", "t", "model")} == {
        "type": "detections",
        "seq": 0,
        "t": 1000.0,
        "model": "fake-yoloe",
    }
    assert first["detections"] == [
        _tracked("cup", Sighting(False)),
        _tracked("jug", Sighting(False)),
    ]
    assert lesson.jev.calls == [[CUP_Q, JUG_Q]]  # both in one call
    answer = play(lesson, 1, scene=4)
    cup, jug = answer["detections"]
    assert [cup["id"], jug["id"]] == ["cup", "jug"]
    assert cup["found"] and cup["state"] == "tracking" and isinstance(cup["track"], int)
    assert cup["box"] == pytest.approx(list(norm_box(MOVED_CUP)), abs=1e-3)
    assert cup["contact"] == pytest.approx([170 / 960, 460 / 720], abs=1e-3)
    assert cup["point"] == pytest.approx([170 / 960, 380 / 720], abs=1e-3)
    assert len(cup["outline"]) == 4 and cup["score"] >= 0.5
    assert jug["found"] and jug["box"] == pytest.approx(list(norm_box(JUG)), abs=1e-3)
    assert isinstance(jug["track"], int)
    assert set(answer["ms"]) == {"decode", "track", "total"}
    assert len(lesson.jev.calls) == 1


def test_not_found_entries_have_no_geometry_and_absent_reads_as_lost():
    assert _tracked("cup", Sighting(False, state="absent")) == {
        "id": "cup",
        "found": False,
        "state": "lost",
        "box": None,
        "outline": None,
        "point": None,
        "contact": None,
        "score": None,
        "track": None,
        "source": None,
    }
    assert _tracked("cup", Sighting(False, state="lost", track_id=4))["track"] is None


def test_jev_looks_again_about_once_a_second_at_every_due_object_together(lesson):
    lesson.jev.answers.extend([both_placed()] * 5)
    lesson.modes.command(parse_command(objects(CUP_WORDS, JUG_WORDS)))
    for seq in range(15):  # just under a second at 15 fps
        play(lesson, seq)
    assert len(lesson.jev.calls) == 1
    play(lesson, 15, dt=0.1)
    assert lesson.jev.calls == [[CUP_Q, JUG_Q]] * 2


def test_one_jev_call_in_flight_for_any_number_of_objects(lesson):
    lesson.executor.run_now = False  # jev takes its time
    lesson.modes.command(parse_command(objects(CUP_WORDS, JUG_WORDS)))
    for seq in range(40):
        play(lesson, seq, dt=0.2)
    assert len(lesson.executor.pending) == 1


def test_an_empty_set_answers_every_frame_without_yoloe_or_jev(lesson):
    lesson.modes.command(parse_command(objects()))
    for seq in range(20):
        answer = play(lesson, seq, dt=0.5)
    assert answer["type"] == "detections" and answer["seq"] == 19
    assert answer["detections"] == [] and set(answer["ms"]) == {"total"}
    assert lesson.jev.calls == [] and lesson.encodes == []


def test_an_empty_set_stops_tracking_and_jev(lesson):
    lesson.jev.answers.append(both_placed())
    lesson.modes.command(parse_command(objects(CUP_WORDS, JUG_WORDS)))
    play(lesson, 0)
    assert play(lesson, 1)["detections"][0]["found"]
    lesson.modes.command(parse_command(objects()))
    encoded = len(lesson.encodes)
    for seq in range(2, 20):
        answer = play(lesson, seq, dt=0.5)
    assert answer["detections"] == []
    assert len(lesson.jev.calls) == 1 and len(lesson.encodes) == encoded
    assert lesson.made[0]._objects == {}


def test_new_query_words_keep_the_track_and_a_new_phrase_starts_over(lesson):
    lesson.jev.answers.extend([{"cup": (0.9, norm_box(CUP))}] * 5)
    lesson.modes.command(parse_command(objects(CUP_WORDS)))
    play(lesson, 0)
    (before,) = play(lesson, 1)["detections"]
    reworded = {**CUP_WORDS, "query": "The blue cup the learner fills first"}
    lesson.modes.command(parse_command(objects(reworded)))
    (after,) = play(lesson, 2)["detections"]
    assert after["state"] == "tracking" and after["track"] == before["track"]
    play(lesson, 3, dt=1.1)
    assert lesson.jev.calls[-1] == [Query("cup", reworded["query"], "blue cup")]

    calls = len(lesson.jev.calls)
    mug = {**CUP_WORDS, "phrase": "red mug"}
    lesson.modes.command(parse_command(objects(mug)))
    (restarted,) = play(lesson, 4)["detections"]
    assert restarted["state"] == "unknown" and not restarted["found"]
    assert len(lesson.jev.calls) == calls + 1  # asked at once, as for a new object
    assert lesson.jev.calls[-1] == [Query("cup", CUP_WORDS["query"], "red mug")]


def test_an_object_left_out_is_dropped_with_jevs_answer_about_it(lesson):
    lesson.executor.run_now = False
    lesson.jev.answers.append(both_placed())
    lesson.modes.command(parse_command(objects(CUP_WORDS, JUG_WORDS)))
    play(lesson, 0)
    lesson.modes.command(parse_command(objects(JUG_WORDS)))
    lesson.executor.run_all()  # jev answers about both, after the cup was left out
    (jug,) = play(lesson, 1)["detections"]
    assert jug["id"] == "jug" and jug["found"]
    assert set(lesson.made[0]._objects) == {"jug"}
    lesson.modes.command(parse_command(objects(CUP_WORDS, JUG_WORDS)))
    cup, jug = play(lesson, 2)["detections"]
    assert cup["state"] == "unknown" and jug["found"]


def test_clear_drops_every_object_and_stays_in_objects_mode(lesson):
    lesson.jev.answers.append(both_placed())
    lesson.modes.command(parse_command(objects(CUP_WORDS, JUG_WORDS)))
    play(lesson, 0)
    lesson.modes.command(parse_command('{"type": "clear"}'))
    answer = play(lesson, 1)
    assert answer["type"] == "detections" and answer["detections"] == []
    assert lesson.made[0]._objects == {}


def test_a_connection_without_objects_never_makes_a_session(lesson):
    play(lesson, 0, scene=1)
    lesson.modes.command(parse_command(target(0)))
    lesson.modes.command(None)
    for seq in range(1, 20):
        assert play(lesson, seq, scene=3, dt=0.5)["type"] == "mask"
    assert lesson.made == [] and lesson.jev.calls == []


def test_switching_modes_either_way_drops_what_the_other_followed(lesson):
    modes = lesson.modes
    play(lesson, 0)
    modes.command(parse_command(target(0)))
    assert play(lesson, 1)["found"]

    lesson.jev.answers.append(both_placed())
    modes.command(parse_command(objects(CUP_WORDS, JUG_WORDS)))
    assert modes.target.object is None and not modes.target.frames  # the target is gone
    assert [d["id"] for d in play(lesson, 2)["detections"]] == ["cup", "jug"]
    assert play(lesson, 3)["detections"][1]["found"]

    modes.command(parse_command(target(3, JUG, name="white jug")))
    answer = play(lesson, 4)
    assert answer["type"] == "mask" and answer["name"] == "white jug" and answer["found"]
    assert answer["box"][0] == pytest.approx(600 / 960, abs=1e-3)
    assert lesson.made[0]._objects == {}  # the objects are gone
    for seq in range(5, 20):
        play(lesson, seq, dt=0.5)
    assert len(lesson.jev.calls) == 1

    modes.command(parse_command(objects(JUG_WORDS)))
    assert modes.target.object is None
    (jug,) = play(lesson, 20)["detections"]
    assert jug["id"] == "jug" and jug["state"] == "unknown"
    assert len(lesson.made) == 1 and len(lesson.jev.calls) == 2  # the connection's one session


# --- anchors -----------------------------------------------------------------------------------


@pytest.fixture
def lookalikes(lesson, vision):
    """The lesson's room with two cups that look alike (scene 10 + i, i up to 9): cup A stays
    at CUP, cup B starts at OTHER and slides 40 px left a frame, so ByteTrack follows both."""
    for i in range(10):
        vision.world[10 + i] = [Thing(CUP, A), Thing(b_on(i), B)]
    return lesson


def b_on(seq: int) -> tuple[float, float, float, float]:
    """Cup B on frame `seq` of the lookalikes (it stops at the last scene)."""
    return moved(OTHER, -40 * min(seq, 9))


def slide(lesson, seq: int, dt: float = 1 / 15) -> dict:
    """The cup's entry on frame `seq` of the lookalikes."""
    (cup,) = play(lesson, seq, scene=10 + min(seq, 9), dt=dt)["detections"]
    return cup


def on_a_then_er_says_b(lesson, *jev: dict) -> dict:
    """jev places the cup on A; on frame 4, ER's anchor (boxed on frame 1) says it is B. jev's
    later answers are `jev`, in order. The cup's entry on frame 4."""
    lesson.jev.answers.extend([{"cup": (0.9, norm_box(CUP))}, *jev])
    lesson.modes.command(parse_command(objects(CUP_WORDS)))
    for seq in range(4):
        cup = slide(lesson, seq)
    assert cup["source"] == "jev" and cup["box"] == pytest.approx(list(norm_box(CUP)), abs=1e-3)
    lesson.modes.command(parse_command(anchor(1, b_on(1))))
    return slide(lesson, 4)


def test_an_anchor_places_the_object_on_the_frame_it_was_boxed_on(lookalikes):
    encoded = len(lookalikes.encodes)
    cup = on_a_then_er_says_b(lookalikes)
    # Frame 1 was encoded again: the anchor's box is matched to the track that was there then,
    # cup B's, which has slid its own width since (on this frame the box would miss it).
    assert len(lookalikes.encodes) == encoded + 4 + 2
    assert cup["found"] and cup["state"] == "tracking" and cup["source"] == "er"
    assert cup["box"] == pytest.approx(list(norm_box(b_on(4))), abs=1e-3)


def test_a_disagreeing_jev_answer_is_ignored_while_the_anchor_holds_and_applies_after(
    lookalikes, caplog
):
    a = {"cup": (0.9, norm_box(CUP))}
    with caplog.at_level(logging.INFO, logger="clio_tracker"):
        on_a_then_er_says_b(lookalikes, a, a)
        slide(lookalikes, 5, dt=1.0)  # jev looks again: cup A
        held = slide(lookalikes, 6)
    assert len(lookalikes.jev.calls) == 2
    # Still on B (the box trails it a little after the 1 s gap: it is smoothed).
    assert held["source"] == "er" and held["box"][0] == pytest.approx(b_on(6)[0] / 960, abs=0.02)
    assert any("ignored, anchored 1.1 s ago" in r.message for r in caplog.records)
    slide(lookalikes, 7, dt=5.0)  # 6 s after the anchor: jev's cup A again
    after = slide(lookalikes, 8)
    assert len(lookalikes.jev.calls) == 3
    assert after["source"] == "jev" and after["box"][0] == pytest.approx(CUP[0] / 960, abs=0.02)


def test_an_agreeing_jev_answer_keeps_the_anchors_box_while_it_holds(lookalikes, caplog):
    b = {"cup": (0.9, norm_box(b_on(5)))}  # jev's box on frame 5: cup B
    anchored = on_a_then_er_says_b(lookalikes, b)
    slide(lookalikes, 5, dt=1.0)
    with caplog.at_level(logging.INFO, logger="clio_tracker"):
        agreed = slide(lookalikes, 6)
    assert len(lookalikes.jev.calls) == 2
    # Still ER's placement on the same track: jev's box, which takes in neighbors, is not applied.
    assert agreed["source"] == "er" and agreed["track"] == anchored["track"]
    assert agreed["box"][0] == pytest.approx(b_on(6)[0] / 960, abs=0.02)
    assert any("its box kept" in r.getMessage() for r in caplog.records)


def test_jev_saying_absent_does_not_lose_an_anchored_object_while_it_holds(lookalikes, caplog):
    absent = {"cup": (0.1, None)}
    anchored = on_a_then_er_says_b(lookalikes, absent, absent)
    cup = lookalikes.made[0]._objects["cup"]
    with caplog.at_level(logging.INFO, logger="clio_tracker"):
        slide(lookalikes, 5, dt=1.0)
        held = slide(lookalikes, 6)
        assert not cup.absent and cup.target_id == anchored["track"]
        assert held["found"] and held["state"] == "tracking" and held["source"] == "er"
        slide(lookalikes, 7, dt=5.0)
        later = slide(lookalikes, 8)
    told = [r.getMessage() for r in caplog.records if "not in view" in r.getMessage()]
    assert told[0].endswith("ignored, anchored 1.1 s ago") and told[1].endswith(": absent")
    # After the hold jev's word is taken (B, still in plain view, is found again by appearance).
    assert cup.absent and later["source"] == "er"  # who last placed it


def test_an_anchors_words_are_what_jev_is_told_next_and_the_track_goes_on(lesson):
    lesson.jev.answers.extend([{"cup": (0.9, norm_box(CUP))}] * 3)
    lesson.modes.command(parse_command(objects(CUP_WORDS)))
    play(lesson, 0)
    (before,) = play(lesson, 1)["detections"]
    words = "The blue ceramic cup at the front left, half full of water"
    lesson.modes.command(parse_command(anchor(1, query=words)))
    (after,) = play(lesson, 2)["detections"]
    assert after["source"] == "er" and after["track"] == before["track"]
    play(lesson, 3, dt=1.1)
    assert lesson.jev.calls[-1] == [Query("cup", words, "blue cup")]  # the phrase stays
    (later,) = play(lesson, 4)["detections"]
    # jev agrees, within the anchor's 6 s: the anchor's placement stands, on the same track.
    assert later["source"] == "er" and later["track"] == before["track"]


def test_an_object_jev_has_not_placed_is_placed_from_its_anchor_at_once(lesson):
    lesson.executor.run_now = False  # jev has not answered
    lesson.modes.command(parse_command(objects(CUP_WORDS, JUG_WORDS)))
    for seq in range(3):
        cup, jug = play(lesson, seq)["detections"]
    assert cup["state"] == "unknown" and cup["source"] is None
    lesson.modes.command(parse_command(anchor(1)))
    cup, jug = play(lesson, 3)["detections"]
    assert cup["found"] and cup["state"] == "tracking" and cup["source"] == "er"
    assert cup["box"] == pytest.approx(list(norm_box(CUP)), abs=1e-3)
    assert jug["state"] == "unknown" and jug["source"] is None


def test_an_anchor_on_a_frame_not_streamed_yet_is_placed_on_the_next_frame(lookalikes):
    lookalikes.executor.run_now = False
    lookalikes.modes.command(parse_command(objects(CUP_WORDS)))
    for seq in range(3):
        slide(lookalikes, seq)
    lookalikes.modes.command(parse_command(anchor(3, b_on(3))))  # frame 3 comes next
    encoded = len(lookalikes.encodes)
    cup = slide(lookalikes, 3)
    assert len(lookalikes.encodes) == encoded + 1  # this frame is the anchor's
    assert cup["found"] and cup["source"] == "er"
    assert cup["box"] == pytest.approx(list(norm_box(b_on(3))), abs=1e-3)


def test_an_anchor_for_an_unknown_object_or_in_target_mode_is_logged_and_skipped(lesson, caplog):
    with caplog.at_level(logging.WARNING, logger="clio_tracker"):
        play(lesson, 0, scene=1)
        lesson.modes.command(parse_command(anchor(0)))  # target mode
        assert play(lesson, 1, scene=1)["type"] == "mask" and lesson.made == []
        lesson.modes.command(parse_command(objects(CUP_WORDS)))
        play(lesson, 2)
        lesson.modes.command(parse_command(anchor(2, JUG, oid="jug")))
        (cup,) = play(lesson, 3)["detections"]
    assert cup["id"] == "cup" and cup["source"] is None  # jev says absent; nothing placed it
    assert lesson.made[0]._anchored == {}
    told = [r.getMessage() for r in caplog.records]
    assert "Track: an anchor for cup in target mode; skipped" in told
    assert "Track: an anchor for jug, which is not followed; skipped" in told


# --- the segmenter -----------------------------------------------------------------------------

# Smooth noise, wider than a frame: what the follower's and the camera's flow need to find (the
# flat gray of scene_jpeg has nothing to follow).
NOISE = cv2.resize(
    np.random.default_rng(7).integers(0, 256, (92, 147)).astype(np.uint8),
    (1176, 736),
    interpolation=cv2.INTER_CUBIC,
)
JEV_CUP = (90.0, 290.0, 230.0, 470.0)  # jev's box around the cup, a little loose: the fake mask
JEV_OTHER = (590.0, 270.0, 730.0, 450.0)


def textured(shift: int = 0) -> np.ndarray:
    """A 960 x 720 RGB frame of the noise, its picture moved `shift` (0 to 200) pixels right."""
    gray = NOISE[:720, 200 - shift : 1160 - shift]
    return np.ascontiguousarray(np.repeat(gray[..., None], 3, axis=2))


def textured_frame(seq: int, shift: int = 0) -> bytes:
    header = json.dumps(
        {"type": "frame", "seq": seq, "t": 1000.0 + 66 * seq, "width": 960, "height": 720}
    ).encode()
    ok, jpeg = cv2.imencode(".jpg", cv2.cvtColor(textured(shift), cv2.COLOR_RGB2BGR))
    assert ok
    return struct.pack(">I", len(header)) + header + jpeg.tobytes()


def moved(box, dx: float) -> tuple[float, float, float, float]:
    return (box[0] + dx, box[1], box[2] + dx, box[3])


def bounds(outline: list[list[float]]) -> list[float]:
    xs, ys = zip(*outline, strict=True)
    return [min(xs), min(ys), max(xs), max(ys)]


def without_ms(answer: dict) -> dict:
    return {k: v for k, v in answer.items() if k != "ms"}


@pytest.fixture
def segmented(vision, segmenter):
    """A stream with the fake segmenter behind a Refresher whose calls run only when told to.
    FakeVision takes its scenes in order, one per encode: each test lays them out."""
    executor, clock = ManualExecutor(), Clock()
    refresher = Refresher(segmenter, executor, clock=clock)
    tracker = StreamTracker(vision, segmenter=segmenter, refresher=refresher)
    return SimpleNamespace(
        tracker=tracker,
        refresher=refresher,
        segmenter=segmenter,
        executor=executor,
        clock=clock,
        vision=vision,
    )


def seg_step(s, seq: int, shift: int = 0) -> dict:
    s.clock.t += 1 / 15
    return s.tracker.step(*parse_frame(textured_frame(seq, shift)))


def test_stream_submits_keyframe_on_target_and_applies_refresh(segmented):
    s = segmented
    s.vision.scenes.extend([[Thing(CUP, A), Thing(OTHER, C)]] * 2)
    seg_step(s, 0)
    s.tracker.command(parse_command(target(0, JEV_CUP)))
    assert s.refresher.in_flight == 1 and len(s.executor.pending) == 1  # jev's box, a keyframe
    s.executor.run_all()
    ((width, height, box),) = s.segmenter.calls
    assert (width, height) == (960, 720) and box == pytest.approx(JEV_CUP)
    answer = seg_step(s, 1)
    assert s.tracker.follower.reference_seq == 0  # the mask of jev's frame
    assert answer["found"] and answer["state"] == "tracking"
    # The fake mask fills jev's box; FakeVision outlines the cup's own box, 10 pixels inside it.
    assert bounds(answer["outline"]) == pytest.approx(list(norm_box(JEV_CUP)), abs=2 / 960)
    assert answer["box"] == pytest.approx(list(norm_box(JEV_CUP)), abs=1e-3)
    assert s.tracker.drawn == {"follower": 1}  # found answers, by what drew the outline


def test_the_summary_line_says_how_often_the_follower_drew_and_what_the_segmenter_did(
    monkeypatch, caplog, segmenter
):
    import clio_tracker.track as track

    now = [0.0]
    monkeypatch.setattr(track, "perf_counter", lambda: now[0])
    clock = Clock()

    class Slow(type(segmenter)):
        def mask_in_box(self, enc, box):
            clock.t += 0.14
            return None if box[0] == 0 else super().mask_in_box(enc, box)

    refresher = Refresher(Slow(), ManualExecutor(run_now=True), clock=clock)
    refresher.submit_keyframes(1, textured(), {"a": np.array(CUP), "b": np.array([0, 0, 9, 9])})
    refresher.drain()
    with_segmenter, plain = track._Summary("Stream"), track._Summary("Stream")
    with caplog.at_level(logging.INFO, logger="clio_tracker"):
        for source in ("follower", "follower", "yoloe", None, "follower"):
            with_segmenter.add(["tracking"], 20.0, [source], refresher)
            plain.add(["tracking"], 20.0, [source])
        now[0] = 3.5
        with_segmenter.add(["tracking"], 20.0, [None], refresher)
        plain.add(["tracking"], 20.0, [None])
        now[0] = 7.0
        with_segmenter.add(["lost"], 20.0, [None], refresher)
    lines = [r.getMessage() for r in caplog.records]
    assert lines[0].endswith("(tracking 6); follower 75%, segmenter: 2 calls, 210 ms, 1 empty")
    assert lines[1].endswith("(tracking 6)")  # without a segmenter, as before
    assert lines[2].endswith("(lost 1); follower 0%, segmenter: 0 calls, 0 ms, 0 empty")


def test_stream_answers_while_refresh_pending(segmented, vision):
    s = segmented
    plain = StreamTracker(vision)
    vision.scenes.extend([[Thing(CUP, A), Thing(OTHER, C)]] * 20)
    for tracker in (s.tracker, plain):
        tracker.step(*parse_frame(textured_frame(0)))
        tracker.command(parse_command(target(0, JEV_CUP)))
    for seq in range(1, 9):  # the segmenter never answers
        answer = seg_step(s, seq)
        assert without_ms(answer) == without_ms(plain.step(*parse_frame(textured_frame(seq))))
        assert answer["found"] and len(answer["outline"]) == 4
    assert s.refresher.in_flight == 1 and len(s.executor.pending) == 1  # no second call
    assert s.segmenter.calls == []


class GrayCount:
    """track.py's cv2, counting conversions to gray."""

    def __init__(self) -> None:
        self.count = 0

    def __getattr__(self, name: str):
        return getattr(cv2, name)

    def cvtColor(self, src, code):  # noqa: N802 - cv2's name
        self.count += code == cv2.COLOR_RGB2GRAY
        return cv2.cvtColor(src, code)


def test_stream_without_segmenter_unchanged(world, monkeypatch):
    import clio_tracker.track as track

    grays = GrayCount()
    monkeypatch.setattr(track, "cv2", grays)
    old = StreamTracker(world)
    new = StreamTracker(world, TrackerParams(), segmenter=None, refresher=None)
    answers = []
    for tracker in (old, new):
        step(tracker, 0)
        tracker.command(parse_command(target(0)))
        run = [step(tracker, seq, scene=1 + seq % 2) for seq in range(1, 6)]
        tracker.command(parse_command(target(5, OTHER)))
        run += [step(tracker, seq) for seq in range(6, 9)]
        answers.append([without_ms(a) for a in run])
    assert answers[0] == answers[1]
    assert grays.count == 0 and new.follower is None and new.refresher is None


def test_the_streams_follower_carries_a_keyframe_from_20_frames_back(segmented):
    s = segmented
    for seq in range(21):  # no target yet; the picture pans 4 pixels right a frame
        seg_step(s, seq, shift=4 * seq)
    s.vision.scenes.extend(
        [
            [Thing(CUP, A), Thing(OTHER, C)],  # frame 0, which jev looked at
            [Thing(moved(CUP, 84), A), Thing(moved(OTHER, 84), C)],  # frame 21
        ]
    )
    s.tracker.command(parse_command(target(0, JEV_CUP)))
    assert s.tracker.object.follower is s.tracker.follower
    s.executor.run_all()
    answer = seg_step(s, 21, shift=84)
    assert s.tracker.follower.reference_seq == 0
    assert answer["found"] and answer["state"] == "tracking"
    # jev's mask from 1.4 s ago, carried by the motion the follower logged since.
    expected = list(norm_box(moved(JEV_CUP, 84)))
    assert bounds(answer["outline"]) == pytest.approx(expected, abs=3 / 960)


def test_clear_drops_the_followers_mask(segmented):
    s = segmented
    s.vision.scenes.extend([[Thing(CUP, A), Thing(OTHER, C)]] * 2)
    seg_step(s, 0)
    s.tracker.command(parse_command(target(0, JEV_CUP)))
    s.executor.run_all()
    seg_step(s, 1)
    assert s.tracker.follower.active
    s.tracker.command(None)
    assert not s.tracker.follower.active  # what it carried was the cleared target's
    assert seg_step(s, 2)["state"] == "idle"


FRIDGE = (100.0, 300.0, 300.0, 500.0)
DOOR = (120.0, 320.0, 170.0, 370.0)  # one part of it


def part_target(seq: int, box, part: bool = True) -> str:
    x0, y0, x1, y1 = box
    return json.dumps(
        {
            "type": "target",
            "seq": seq,
            "box": [x0 / 960, y0 / 720, x1 / 960, y1 / 720],
            "name": "door of the fridge",
            "part": part,
        }
    )


def follow_the_door(s) -> dict:
    """A part target on frame 0, its keyframe cut, and five frames followed."""
    s.vision.scenes.extend([[Thing(FRIDGE, A)]] * 20)
    seg_step(s, 0)
    s.tracker.command(parse_command(part_target(0, DOOR)))
    s.executor.run_all()
    for seq in range(1, 6):
        answer = seg_step(s, seq)
    return answer


def test_a_part_target_gets_the_streams_follower_and_its_keyframe_outlines_the_part(segmented):
    s = segmented
    answer = follow_the_door(s)
    part = s.tracker.part
    assert part is not None and part.follower is s.tracker.follower
    assert part.parent is not None and part.parent.follower is None  # the whole has none
    ((_, _, box),) = s.segmenter.calls
    assert box == pytest.approx(DOOR)
    assert s.tracker.follower.reference_seq == 0
    assert answer["found"] and answer["state"] == "tracking"
    assert bounds(answer["outline"]) == pytest.approx(list(norm_box(DOOR)), abs=2 / 960)


def test_a_part_target_after_the_whole_takes_the_follower_cleared(segmented):
    """jev names one part of the object the stream follows: the part's tracker gets the
    stream's follower cleared, so the whole's mask never stands for the part, not even before
    the part's keyframe is cut."""
    s = segmented
    s.vision.scenes.extend([[Thing(FRIDGE, A)]] * 20)
    seg_step(s, 0)
    s.tracker.command(parse_command(part_target(0, FRIDGE, part=False)))  # the whole fridge
    s.executor.run_all()
    for seq in range(1, 4):
        seg_step(s, seq)
    assert s.tracker.part is None and s.tracker.follower.reference_seq == 0  # the fridge's mask
    s.tracker.command(parse_command(part_target(3, DOOR)))  # now its door
    assert s.tracker.part is not None and s.tracker.part.follower is s.tracker.follower
    assert not s.tracker.follower.active
    answer = seg_step(s, 4)  # the door's keyframe is still being cut
    assert answer["box"] == pytest.approx(list(norm_box(DOOR)), abs=1e-3)
    s.executor.run_all()
    for seq in range(5, 10):
        answer = seg_step(s, seq)
    assert s.tracker.follower.reference_seq == 3
    assert bounds(answer["outline"]) == pytest.approx(list(norm_box(DOOR)), abs=2 / 960)


BIG_DOOR = (120.0, 320.0, 220.0, 420.0)  # a part of the fridge 100 px across


def test_jevs_keyframe_wins_over_a_refresh_that_landed_after_jevs_frame(segmented):
    """A part followed confidently; a refresh cut around a box 40 px off lands on frame 6 and
    the follower follows that, sure of itself. jev's answer about frame 5 then confirms the part
    where it really is: its keyframe, from the older frame, takes over, and the outline follows
    jev's box from the next frame on."""
    s = segmented
    s.vision.scenes.extend([[Thing(FRIDGE, A)]] * 20)
    seg_step(s, 0)
    s.tracker.command(parse_command(part_target(0, BIG_DOOR)))
    s.executor.run_all()
    for seq in range(1, 7):
        seg_step(s, seq)
    s.clock.t += 1
    assert s.refresher.submit("target", 6, textured(), np.array(moved(BIG_DOOR, 40)))
    s.executor.run_all()
    seg_step(s, 7)
    assert s.tracker.follower.reference_seq == 6
    np.testing.assert_allclose(s.tracker.part.box, moved(BIG_DOOR, 40), atol=1)
    s.tracker.command(parse_command(part_target(5, BIG_DOOR)))
    np.testing.assert_allclose(s.tracker.part.box, moved(BIG_DOOR, 40), atol=1)  # sure: it stands
    s.executor.run_all()
    for seq in range(8, 13):
        answer = seg_step(s, seq)
    assert s.tracker.follower.reference_seq == 5
    assert answer["state"] == "tracking"
    assert bounds(answer["outline"]) == pytest.approx(list(norm_box(BIG_DOOR)), abs=2 / 960)
    np.testing.assert_allclose(s.tracker.part.box, BIG_DOOR, atol=1)


def test_the_whole_object_again_takes_the_follower_cleared_and_its_keyframe_outlines_it(
    segmented,
):
    s = segmented
    follow_the_door(s)
    parent = s.tracker.part.parent
    s.tracker.command(parse_command(part_target(5, FRIDGE, part=False)))
    assert s.tracker.part is None and s.tracker.object is parent
    assert parent.follower is s.tracker.follower
    assert not s.tracker.follower.active  # the door's mask is not the fridge's
    # The fridge's keyframe is still being cut: YOLOE's outline of the fridge meanwhile.
    answer = seg_step(s, 6)
    assert bounds(answer["outline"]) == pytest.approx(list(norm_box(FRIDGE)), abs=2 / 960)
    s.executor.run_all()
    for seq in range(7, 13):
        answer = seg_step(s, seq)
    assert s.tracker.follower.reference_seq == 5
    assert [call[2] for call in s.segmenter.calls] == [pytest.approx(DOOR), pytest.approx(FRIDGE)]
    assert answer["state"] == "tracking"
    assert bounds(answer["outline"]) == pytest.approx(list(norm_box(FRIDGE)), abs=2 / 960)


def test_a_refresh_of_the_old_object_never_beats_jevs_keyframe(segmented):
    s = segmented
    s.vision.scenes.extend([[Thing(CUP, A), Thing(OTHER, C)]] * 20)
    seg_step(s, 0)
    s.tracker.command(parse_command(target(0, JEV_CUP)))
    s.executor.run_all()
    seg_step(s, 1)
    seg_step(s, 2)
    s.clock.t += 1
    # A refresh of the cup on frame 2 is on the way when jev says, about frame 1, that the
    # target is the other one: jev's keyframe waits for it.
    assert s.refresher.submit("target", 2, textured(), np.array(JEV_CUP))
    s.tracker.command(parse_command(target(1, JEV_OTHER)))
    s.executor.run_all()
    seg_step(s, 3)
    assert not s.tracker.follower.active  # the cup's mask was dropped, though newer than jev's
    s.executor.run_all()
    answer = seg_step(s, 4)
    assert s.tracker.follower.reference_seq == 1
    for seq in range(5, 12):
        answer = seg_step(s, seq)
    assert bounds(answer["outline"]) == pytest.approx(list(norm_box(JEV_OTHER)), abs=2 / 960)


def test_an_older_keyframe_never_lands_after_a_newer_one(segmented):
    s = segmented
    s.vision.scenes.extend([[Thing(CUP, A), Thing(OTHER, C)]] * 20)
    seg_step(s, 0)
    s.tracker.command(parse_command(target(0, JEV_CUP)))  # its keyframe is on the way...
    seg_step(s, 1)
    seg_step(s, 2)
    s.tracker.command(parse_command(target(2, JEV_OTHER)))  # ...when jev moves the target
    s.executor.run_all()
    seg_step(s, 3)
    assert not s.tracker.follower.active  # the cup's keyframe came back, and was dropped
    s.executor.run_all()
    seg_step(s, 4)
    assert s.tracker.follower.reference_seq == 2


def test_the_stream_carries_on_without_the_segmenter_once_its_executor_is_shut_down(
    world, segmenter, caplog
):
    stopped = ThreadPoolExecutor(max_workers=1)
    stopped.shutdown()
    tracker = StreamTracker(world, segmenter=segmenter, refresher=Refresher(segmenter, stopped))
    plain = StreamTracker(world)
    answers = []
    with caplog.at_level(logging.WARNING, logger="clio_tracker"):
        for t in (tracker, plain):
            step(t, 0)
            t.command(parse_command(target(0)))
            answers.append([without_ms(step(t, seq)) for seq in range(1, 6)])
    assert answers[0] == answers[1] and answers[0][-1]["found"]
    assert tracker.refresher is None
    assert sum("fake-segmenter" in r.message for r in caplog.records) == 1


# --- the WebSocket -----------------------------------------------------------------------------


@pytest.fixture
def app(world, fake_jev):
    finder = Finder(JevIdentifier(fake_jev.client()), world)
    sessions = Sessions(lambda: TrackerSession(world, FakeIdentifier(), ManualExecutor()))
    yield create_app(sessions, finder, lambda: StreamTracker(world), 50, lambda: {})
    finder.close()


def test_ready_then_one_mask_per_frame(app):
    with TestClient(app) as client, client.websocket_connect("/track") as ws:
        assert ws.receive_json() == {"type": "ready", "model": "fake-yoloe"}
        ws.send_bytes(frame(0))
        assert ws.receive_json()["found"] is False
        ws.send_text(target(0))
        ws.send_bytes(frame(1, scene=2))
        found = ws.receive_json()
        assert found["seq"] == 1 and found["found"] and found["name"] == "blue cup"
        ws.send_text("not json")  # logged and skipped; the stream carries on
        ws.send_text('{"type": "clear"}')
        ws.send_bytes(frame(2))
        assert ws.receive_json()["found"] is False
        ws.send_text(objects())
        ws.send_bytes(frame(3))
        assert ws.receive_json()["detections"] == []
        ws.send_text(target(3))
        ws.send_bytes(frame(4))
        assert ws.receive_json()["type"] == "mask"


def test_anchors_over_the_socket_and_a_bad_one_skipped(app):
    with TestClient(app) as client, client.websocket_connect("/track") as ws:
        assert ws.receive_json()["type"] == "ready"
        ws.send_text(anchor(0))  # target mode: logged and skipped
        ws.send_bytes(frame(0))
        assert ws.receive_json()["type"] == "mask"
        ws.send_text(objects(CUP_WORDS))
        ws.send_bytes(frame(1))
        (cup,) = ws.receive_json()["detections"]
        assert cup["state"] == "unknown" and cup["source"] is None  # jev hasn't answered
        ws.send_text(anchor(1, source="gemini"))  # malformed: logged and skipped
        ws.send_text(anchor(1, oid="spoon"))  # not followed: logged and skipped
        ws.send_text(anchor(1))
        ws.send_bytes(frame(2))
        (cup,) = ws.receive_json()["detections"]
        assert cup["found"] and cup["source"] == "er"
        assert cup["box"] == pytest.approx(list(norm_box(CUP)), abs=1e-3)


def test_a_foreign_origin_is_refused(app):
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect) as refused:
            with client.websocket_connect("/track", headers={"origin": "https://evil.example"}):
                pass
        assert refused.value.code == 1008


def test_the_stream_over_a_real_socket_through_uvicorn(app):
    from websockets.sync.client import connect

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        for _ in range(100):
            if server.started:
                break
            time.sleep(0.05)
        origin = f"http://localhost:{port}"
        with connect(f"ws://127.0.0.1:{port}/track", origin=origin) as ws:
            assert json.loads(ws.recv()) == {"type": "ready", "model": "fake-yoloe"}
            ws.send(frame(0))
            assert json.loads(ws.recv())["seq"] == 0
            ws.send(target(0))
            ws.send(frame(1, scene=2))
            answer = json.loads(ws.recv())
            assert answer["found"] and answer["seq"] == 1
    finally:
        server.should_exit = True
        thread.join(5)
