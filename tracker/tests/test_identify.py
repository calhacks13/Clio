"""Identifiers against fake transports: no request leaves the machine. The jev request itself is
tested in test_jev.py; here, what the tracker gets back from it."""

from __future__ import annotations

import io
import json

import httpx
import numpy as np
import pytest
from PIL import Image

from clio_tracker.identify import (
    FrameImage,
    HttpIdentifier,
    IdentifierError,
    JevIdentifier,
    Query,
)

CAP = Query("cap", "Round blue plastic cap with a spray symbol", "washer fluid cap")
JUG = Query("jug", "A white plastic jug of washer fluid", "jug")


def jpeg(w: int, h: int) -> FrameImage:
    buffer = io.BytesIO()
    Image.new("RGB", (w, h), (128, 128, 128)).save(buffer, "JPEG")
    return FrameImage(buffer.getvalue(), "image/jpeg", np.full((h, w, 3), 128, np.uint8))


def test_jev_presence_and_boxes_per_object(fake_jev):
    fake_jev.present("cap", 0.91, (0.4, 0.5, 0.5, 0.6))
    fake_jev.present("jug", 0.04)
    cap, jug = JevIdentifier(fake_jev.client()).identify(jpeg(960, 720), [CAP, JUG])
    assert cap.id == "cap" and cap.present == pytest.approx(0.91)
    assert cap.box == pytest.approx((0.4, 0.5, 0.5, 0.6))
    assert jug.present == pytest.approx(0.04) and jug.box is None
    assert len(fake_jev.requests) == 1  # one call for both objects


def test_jev_boxes_on_a_padded_frame_map_back_to_the_frame(fake_jev):
    # 200 x 100 is padded to 280 x 280 for jev; its box in the padded frame comes back in 0..1
    # of the 200 x 100 frame.
    fake_jev.box = (40 / 280, 90 / 280, 240 / 280, 190 / 280)  # exactly the frame's area
    (cap,) = JevIdentifier(fake_jev.client()).identify(jpeg(200, 100), [CAP])
    assert cap.box == pytest.approx((0.0, 0.0, 1.0, 1.0), abs=0.01)


def test_jev_failures_become_identifier_errors_with_their_status(fake_jev):
    fake_jev.status = 529
    with pytest.raises(IdentifierError, match="No automatic retry") as failed:
        JevIdentifier(fake_jev.client()).identify(jpeg(960, 720), [CAP])
    assert failed.value.status == 502 and len(fake_jev.requests) == 1


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
    assert cap.box == pytest.approx((0.4, 0.5, 0.5, 0.6)) and cap.present == pytest.approx(0.8)
    assert jug.present == 0.0 and jug.box is None
    assert finder.name == "gemini-3.5-flash-lite"


def test_http_identifier_errors():
    def handler(_request):
        return httpx.Response(503, text="busy")

    finder = HttpIdentifier("http://127.0.0.1:8787/x", transport=httpx.MockTransport(handler))
    with pytest.raises(IdentifierError, match="503"):
        finder.identify(jpeg(960, 720), [CAP])
