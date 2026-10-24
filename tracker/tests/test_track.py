"""The /track stream (TRACK.md): messages, tracking a named target, objects mode, and the
WebSocket itself."""

from __future__ import annotations

import json
import socket
import struct
import threading
import time
from types import SimpleNamespace

import pytest
import uvicorn
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from clio_tracker.finder import Finder
from clio_tracker.identify import JevIdentifier, Query
from clio_tracker.server import create_app
from clio_tracker.session import Sessions, SessionSettings, TrackerSession
from clio_tracker.track import (
    MAX_OBJECTS,
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
from clio_tracker.tracking import Sighting
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
