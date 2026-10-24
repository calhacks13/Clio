"""jev and HTTP identifiers against fake transports: no request leaves the machine."""

from __future__ import annotations

import base64
import json

import httpx
import numpy as np
import pytest

from clio_tracker.identify import (
    FrameImage,
    HttpIdentifier,
    IdentifierError,
    JevIdentifier,
    Query,
)

CAP = Query("cap", "Round blue plastic cap with a spray symbol", "washer fluid cap")
JUG = Query("jug", "A white plastic jug of washer fluid", "jug")


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def refuse(*_args, **_kwargs):
        raise AssertionError("a test tried to reach the network")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", refuse)


def jpeg(w: int, h: int) -> FrameImage:
    import cv2

    rgb = np.full((h, w, 3), 128, np.uint8)
    ok, buf = cv2.imencode(".jpg", rgb)
    assert ok
    return FrameImage(buf.tobytes(), "image/jpeg", rgb)


def jev(handler) -> JevIdentifier:
    return JevIdentifier("ts-key", transport=httpx.MockTransport(handler))


def test_jev_request_carries_a_noul_and_a_box_question_per_object():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["headers"] = request.headers
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "answers": {
                    "present_0": {"noul": 0.91},
                    "target_0": {
                        "left": 0.4,
                        "top": 0.5,
                        "right": 0.5,
                        "bottom": 0.6,
                        "confidence": 0.3,
                    },
                    "present_1": {"noul": 0.04},
                    "target_1": {
                        "left": 0.1,
                        "top": 0.1,
                        "right": 0.3,
                        "bottom": 0.4,
                        "confidence": 0.5,
                    },
                }
            },
        )

    image = jpeg(960, 720)
    cap, jug = jev(handler).identify(image, [CAP, JUG])
    assert seen["headers"]["authorization"] == "Bearer ts-key"
    assert seen["headers"]["typesafe-danger-zone-images"] == "true"
    body = seen["body"]
    assert body["model"] == "jev-1.14.0"
    (key,) = body["assets"]
    assert body["state"] == {"frame": key}
    asset = body["assets"][key]
    assert asset["type"] == "image" and asset["format"] == "jpg"
    assert base64.b64decode(asset["data_base64"]) == image.data  # sent as captured
    q = body["questions"]
    assert q["present_0"]["type"] == "noul" and q["target_0"]["type"] == "box"
    assert "`frame`" in q["target_0"]["instructions"]
    assert CAP.query in q["target_0"]["instructions"]
    assert cap.present == pytest.approx(0.91) and cap.box == (0.4, 0.5, 0.5, 0.6)
    assert jug.present == pytest.approx(0.04)


def test_jev_images_outside_its_size_rules_are_resized():
    image = jpeg(200, 150)
    sent = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        (asset,) = body["assets"].values()
        sent["jpeg"] = base64.b64decode(asset["data_base64"])
        return httpx.Response(200, json={"answers": {}})

    jev(handler).identify(image, [CAP])
    import cv2

    small = cv2.imdecode(np.frombuffer(sent["jpeg"], np.uint8), cv2.IMREAD_COLOR)
    assert min(small.shape[:2]) >= 280


@pytest.mark.parametrize(
    "box",
    [
        {"left": 0.5, "top": 0.5, "right": 0.5, "bottom": 0.6},  # zero width
        {"left": 0.6, "top": 0.5, "right": 0.4, "bottom": 0.6},  # reversed
        {"top": 0.5},
        None,
    ],
)
def test_broken_jev_boxes_are_dropped(box):
    def handler(_request):
        return httpx.Response(200, json={"answers": {"present_0": {"noul": 0.9}, "target_0": box}})

    (cap,) = jev(handler).identify(jpeg(960, 720), [CAP])
    assert cap.box is None and cap.present == pytest.approx(0.9)


def test_jev_errors_are_reported_not_retried():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(529, text="overloaded")

    with pytest.raises(IdentifierError, match="529"):
        jev(handler).identify(jpeg(960, 720), [CAP])
    assert len(calls) == 1


def test_http_identifier_speaks_clio_contract_and_keeps_the_best_detection():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "model": "gemini-3.5-flash-lite",
                "detections": [
                    {"id": "cap", "found": True, "box": [0.1, 0.1, 0.2, 0.2], "confidence": 0.4},
                    {"id": "cap", "found": True, "box": [0.4, 0.5, 0.5, 0.6], "confidence": 0.8},
                    {"id": "jug", "found": False},
                ],
            },
        )

    finder = HttpIdentifier(
        "http://127.0.0.1:8787/api/vision/locate", transport=httpx.MockTransport(handler)
    )
    cap, jug = finder.identify(jpeg(960, 720), [CAP, JUG])
    assert seen["body"]["objects"][0] == {"id": "cap", "query": CAP.query, "phrase": CAP.phrase}
    assert seen["body"]["image"]["mimeType"] == "image/jpeg"
    assert cap.box == (0.4, 0.5, 0.5, 0.6) and cap.present == pytest.approx(0.8)
    assert jug.present == 0.0 and jug.box is None
    assert finder.name == "gemini-3.5-flash-lite"
