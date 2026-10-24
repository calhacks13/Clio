"""The /track stream (TRACK.md): messages, tracking a named target, and the WebSocket itself."""

from __future__ import annotations

import json
import socket
import struct
import threading
import time

import pytest
import uvicorn
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from clio_tracker.finder import Finder
from clio_tracker.identify import JevIdentifier
from clio_tracker.server import create_app
from clio_tracker.session import Sessions
from clio_tracker.track import (
    BadMessage,
    FrameHeader,
    StreamTracker,
    TargetBox,
    parse_command,
    parse_frame,
)
from conftest import Thing, appearance, blend, scene_jpeg

A = appearance(1)
B = blend(A, appearance(2), 0.85)  # a look-alike
CUP = (100.0, 300.0, 220.0, 460.0)
OTHER = (600.0, 280.0, 720.0, 440.0)


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


# --- tracking ----------------------------------------------------------------------------------


def step(tracker: StreamTracker, seq: int, scene: int = 1) -> dict:
    return tracker.step(*parse_frame(frame(seq, scene)))


def test_no_target_answers_not_found(world):
    answer = step(StreamTracker(world), 0)
    assert answer["type"] == "mask" and answer["found"] is False and answer["state"] == "idle"
    assert answer["outline"] is None and answer["name"] is None and answer["model"] == "fake-yoloe"


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


# --- the WebSocket -----------------------------------------------------------------------------


@pytest.fixture
def app(world, fake_jev):
    finder = Finder(JevIdentifier(fake_jev.client()), world)
    yield create_app(Sessions(lambda: None), finder, lambda: StreamTracker(world), 50, lambda: {})
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
