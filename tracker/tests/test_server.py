"""POST /locate speaks Clio's object-finder contract."""

from __future__ import annotations

import base64

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from clio_tracker.server import create_app
from clio_tracker.session import Sessions, TrackerSession
from conftest import Clock, FakeIdentifier, ManualExecutor, Thing, appearance, norm_box

A = appearance(1)
BOX = (100.0, 300.0, 220.0, 460.0)


@pytest.fixture
def client(vision):
    jev = FakeIdentifier()
    jev.answers.append({"cup": (0.9, norm_box(BOX))})
    executor = ManualExecutor(run_now=True)
    clock = Clock()

    def tick():
        clock.t += 0.07
        return clock.t

    sessions = Sessions(lambda: TrackerSession(vision, jev, executor, clock=tick))
    app = create_app(sessions, "fake-yoloe", 50, lambda: {"model": "fake-yoloe"})
    vision.scenes.extend([[Thing(BOX, A)]] * 10)
    return TestClient(app)


def request(**overrides) -> dict:
    ok, buf = cv2.imencode(".jpg", np.zeros((720, 960, 3), np.uint8))
    body = {
        "image": {"mimeType": "image/jpeg", "data": base64.b64encode(buf.tobytes()).decode()},
        "objects": [{"id": "cup", "query": "A blue ceramic cup", "phrase": "blue cup"}],
        "session": "headset-1",
    }
    return {**body, **overrides}


def test_locate_answers_in_clio_contract(client):
    first = client.post("/locate", json=request()).json()
    assert first["model"] == "fake-yoloe+fake-jev"
    assert first["refreshMs"] == 50
    assert first["detections"] == [{"id": "cup", "found": False, "track": {"state": "unknown"}}]
    for _ in range(3):
        answer = client.post("/locate", json=request()).json()
    (d,) = answer["detections"]
    assert d["found"] and d["track"]["state"] == "tracking"
    assert all(0 <= v <= 1 for v in d["box"]) and len(d["point"]) == 2
    assert set(answer["timings"]) == {"encodeMs", "trackMs"}


def test_bad_images_are_400_with_a_reason(client):
    r = client.post("/locate", json=request(image={"mimeType": "image/gif", "data": "AAAA"}))
    assert r.status_code == 400 and "mimeType" in r.json()["detail"]
    r = client.post("/locate", json=request(image={"mimeType": "image/jpeg", "data": "data:xx"}))
    assert r.status_code == 400 and "base64" in r.json()["detail"]
    r = client.post("/locate", json=request(image={"mimeType": "image/jpeg", "data": "AAAA"}))
    assert r.status_code == 400 and "decode" in r.json()["detail"]


def test_requests_must_name_1_to_16_objects(client):
    assert client.post("/locate", json=request(objects=[])).status_code == 422


def test_health_and_reset(client):
    client.post("/locate", json=request())
    assert client.get("/health").json() == {"ok": True, "sessions": 1, "model": "fake-yoloe"}
    assert client.post("/reset").json() == {"ok": True}
    assert client.get("/health").json()["sessions"] == 0
