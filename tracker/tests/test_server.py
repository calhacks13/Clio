"""POST /locate in both modes, /track's objects mode, and the service's local-only rules."""

from __future__ import annotations

import base64
import json
import struct
import threading

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from clio_tracker.cli import _health
from clio_tracker.finder import Finder
from clio_tracker.identify import JevIdentifier
from clio_tracker.server import create_app
from clio_tracker.session import Sessions, TrackerSession
from clio_tracker.track import StreamTracker
from conftest import (
    Clock,
    FakeIdentifier,
    ManualExecutor,
    Thing,
    appearance,
    norm_box,
    scene_jpeg,
)

A = appearance(1)
BOX = (100.0, 300.0, 220.0, 460.0)


@pytest.fixture
def setup(vision, fake_jev):
    fake_jev.box = norm_box(BOX)
    jev = FakeIdentifier()
    jev.answers.append({"cup": (0.9, norm_box(BOX))})
    executor = ManualExecutor(run_now=True)
    clock = Clock()

    def tick():
        clock.t += 0.07
        return clock.t

    sessions = Sessions(lambda: TrackerSession(vision, jev, executor, clock=tick))
    finder = Finder(JevIdentifier(fake_jev.client()), vision)
    app = create_app(
        sessions, finder, lambda: StreamTracker(vision), 50, lambda: {"model": finder.model}
    )
    vision.world[3] = [Thing(BOX, A)]
    vision.scenes.extend([[Thing(BOX, A)]] * 10)
    yield TestClient(app), fake_jev
    finder.close()


def request(session: str | None = "headset-1", **overrides) -> dict:
    body = {
        "image": {"mimeType": "image/jpeg", "data": base64.b64encode(scene_jpeg(3)).decode()},
        "objects": [{"id": "cup", "query": "A blue ceramic cup", "phrase": "blue cup"}],
        **({"session": session} if session else {}),
    }
    return {**body, **overrides}


def test_with_a_session_it_answers_from_tracking_state(setup):
    client, _ = setup
    first = client.post("/locate", json=request()).json()
    assert first["model"] == "fake-jev+fake-yoloe"
    assert first["refreshMs"] == 50
    assert first["detections"] == [{"id": "cup", "found": False, "track": {"state": "unknown"}}]
    for _ in range(3):
        answer = client.post("/locate", json=request()).json()
    (d,) = answer["detections"]
    assert d["found"] and d["track"]["state"] == "tracking"
    assert all(0 <= v <= 1 for v in d["box"]) and len(d["point"]) == 2
    assert set(answer["timings"]) == {"encodeMs", "trackMs"}


def test_without_a_session_it_asks_jev_now_and_outlines_its_box(setup):
    client, fake_jev = setup
    r = client.post("/locate", json=request(session=None))
    assert r.status_code == 200
    answer = r.json()
    assert answer["model"] == "jev-1.14.0+fake-yoloe"
    (d,) = answer["detections"]
    assert d["found"] and d["confidence"] == 0.9
    assert d["box"] == pytest.approx(list(norm_box(BOX)), abs=1e-3)
    assert len(d["outline"]) == 4 and d["point"] == pytest.approx([160 / 960, 380 / 720])
    assert "jev;dur=" in r.headers["server-timing"]
    assert len(fake_jev.requests) == 1  # one jev call per request
    assert "refreshMs" not in answer


def test_a_box_yoloe_cannot_fill_is_sent_alone(setup):
    client, fake_jev = setup
    fake_jev.box = (0.6, 0.1, 0.9, 0.3)  # nothing there in the scene
    (d,) = client.post("/locate", json=request(session=None)).json()["detections"]
    assert d["found"] and d["outline"] is None and d["box"] == [0.6, 0.1, 0.9, 0.3]


def test_absent_objects_are_not_found_with_jevs_confidence(setup):
    client, fake_jev = setup
    fake_jev.present("cup", 0.04)
    (d,) = client.post("/locate", json=request(session=None)).json()["detections"]
    assert d == {
        "id": "cup",
        "found": False,
        "point": None,
        "box": None,
        "outline": None,
        "confidence": 0.04,
    }


def test_a_second_request_while_jev_answers_gets_503_and_no_jev_call(setup):
    client, fake_jev = setup
    fake_jev.hold = threading.Event()
    results = []
    first = threading.Thread(
        target=lambda: results.append(client.post("/locate", json=request(session=None)))
    )
    first.start()
    while not fake_jev.requests:
        pass
    second = client.post("/locate", json=request(session=None))
    fake_jev.hold.set()
    first.join()
    assert second.status_code == 503 and "earlier" in second.json()["detail"]
    assert results[0].status_code == 200 and len(fake_jev.requests) == 1


def test_jev_failures_are_502_and_say_no_retry_was_sent(setup):
    client, fake_jev = setup
    fake_jev.status = 529
    r = client.post("/locate", json=request(session=None))
    assert r.status_code == 502 and "No automatic retry" in r.json()["detail"]


def test_bad_requests(setup):
    client, _ = setup
    assert client.post("/locate", json=request(objects=[])).status_code == 422
    gif = request(image={"mimeType": "image/gif", "data": "AAAA"})
    assert client.post("/locate", json=gif).status_code == 422
    not_b64 = request(image={"mimeType": "image/jpeg", "data": "data:xx"})
    assert client.post("/locate", json=not_b64).status_code == 400
    not_b64 = request(session=None, image={"mimeType": "image/jpeg", "data": "data:xx"})
    assert client.post("/locate", json=not_b64).status_code == 422
    nothing = request(objects=[{"id": "cup", "query": " ... "}])
    assert client.post("/locate", json=nothing).status_code == 422


def test_only_local_host_names_are_served(setup):
    client, _ = setup
    assert client.get("/health", headers={"host": "evil.example"}).status_code == 403
    health = client.get("/health").json()
    assert health == {"ok": True, "sessions": 0, "model": "jev-1.14.0+fake-yoloe"}


def test_health_and_reset(setup):
    client, _ = setup
    client.post("/locate", json=request())
    assert client.get("/health").json()["sessions"] == 1
    assert client.post("/reset").json() == {"ok": True}
    assert client.get("/health").json()["sessions"] == 0


def frame(seq: int, scene: int = 3) -> bytes:
    header = json.dumps(
        {"type": "frame", "seq": seq, "t": 1000.0 + 66 * seq, "width": 960, "height": 720}
    ).encode()
    return struct.pack(">I", len(header)) + header + scene_jpeg(scene)


def test_track_in_objects_mode_has_a_session_of_its_own(setup):
    client, fake_jev = setup
    cup = {"id": "cup", "phrase": "blue cup", "query": "A blue ceramic cup"}
    with client.websocket_connect("/track") as ws:
        assert ws.receive_json() == {"type": "ready", "model": "fake-yoloe"}
        ws.send_text(json.dumps({"type": "objects", "objects": [cup]}))
        ws.send_bytes(frame(0))
        first = ws.receive_json()
        assert first["type"] == "detections" and first["seq"] == 0
        assert [(d["id"], d["state"]) for d in first["detections"]] == [("cup", "unknown")]
        ws.send_bytes(frame(1))
        (d,) = ws.receive_json()["detections"]
        assert d["found"] and d["state"] == "tracking"
        assert d["box"] == pytest.approx(list(norm_box(BOX)), abs=1e-3)
        assert len(d["outline"]) == 4 and len(d["contact"]) == 2 and isinstance(d["track"], int)
        ws.send_text(json.dumps({"type": "objects", "objects": []}))
        ws.send_bytes(frame(2))
        assert ws.receive_json()["detections"] == []
    assert client.get("/health").json()["sessions"] == 0  # not one of the shared sessions
    assert fake_jev.requests == []  # the session's identifier, not the primary route's jev


def test_track_refuses_a_foreign_origin_or_host(setup):
    client, _ = setup
    for headers in ({"origin": "https://evil.example"}, {"host": "evil.example"}):
        with pytest.raises(WebSocketDisconnect) as refused:
            with client.websocket_connect("/track", headers=headers) as ws:
                ws.send_text(json.dumps({"type": "objects", "objects": []}))
        assert refused.value.code == 1008


def test_scene_jpeg_reads_back_as_its_scene():
    rgb = cv2.imdecode(np.frombuffer(scene_jpeg(3), np.uint8), cv2.IMREAD_COLOR)
    assert round(float(rgb.mean()) / 10) == 3


# --- the segmenter -----------------------------------------------------------------------------

LOOSE = (90.0, 290.0, 230.0, 470.0)  # jev's box around BOX, a little loose: the fake mask


def bounds(outline: list[list[float]]) -> list[float]:
    xs, ys = zip(*outline, strict=True)
    return [min(xs), min(ys), max(xs), max(ys)]


@pytest.fixture
def outlined(vision, fake_jev, segmenter):
    """The service as `clio-tracker serve` builds it with a segmenter, jev placing BOX loosely."""
    fake_jev.box = norm_box(LOOSE)
    finder = Finder(JevIdentifier(fake_jev.client()), vision, segmenter)
    sessions = Sessions(lambda: TrackerSession(vision, FakeIdentifier(), ManualExecutor()))
    app = create_app(
        sessions,
        finder,
        lambda: StreamTracker(vision),
        50,
        lambda: _health(finder, vision, segmenter),
    )
    vision.world[3] = [Thing(BOX, A)]
    yield TestClient(app), segmenter, finder
    finder.close()


def test_health_reports_segmenter(outlined, vision):
    client, _, finder = outlined
    assert client.get("/health").json() == {
        "ok": True,
        "sessions": 0,
        "model": "jev-1.14.0+fake-yoloe+fake-segmenter",
        "backend": "fake",
        "segmenter": "fake-segmenter",
    }
    plain = Finder(finder.identifier, vision)
    assert _health(plain, vision, None) == {
        "model": "jev-1.14.0+fake-yoloe",
        "backend": "fake",
        "segmenter": None,
    }
    plain.close()


def test_without_a_session_the_segmenter_outlines_jevs_box(outlined):
    client, segmenter, _ = outlined
    answer = client.post("/locate", json=request(session=None)).json()
    assert answer["model"] == "jev-1.14.0+fake-yoloe+fake-segmenter"
    (d,) = answer["detections"]
    # The fake mask fills jev's box; YOLOE would outline BOX, 10 pixels inside it.
    assert d["found"] and d["confidence"] == 0.9
    assert d["box"] == pytest.approx(list(norm_box(LOOSE)), abs=1e-3)
    assert bounds(d["outline"]) == pytest.approx(list(norm_box(LOOSE)), abs=1 / 960)
    x0, y0, x1, y1 = norm_box(LOOSE)
    assert x0 < d["point"][0] < x1 and y0 < d["point"][1] < y1
    ((width, height, box),) = segmenter.calls
    assert (width, height) == (960, 720) and box == pytest.approx(LOOSE, abs=0.01)


def test_without_a_session_yoloe_outlines_what_the_segmenter_cannot(outlined, monkeypatch):
    client, segmenter, _ = outlined
    monkeypatch.setattr(segmenter, "mask_in_box", lambda enc, box: None)
    (d,) = client.post("/locate", json=request(session=None)).json()["detections"]
    assert d["found"] and d["box"] == pytest.approx(list(norm_box(BOX)), abs=1e-3)
    assert bounds(d["outline"]) == pytest.approx(list(norm_box(BOX)), abs=1e-3)
