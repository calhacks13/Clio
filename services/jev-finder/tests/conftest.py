"""Shared test setup: no test ever reaches jev or any other network service."""

from __future__ import annotations

import base64
import io
import json
import threading

import httpx
import numpy as np
import pytest
from PIL import Image

from jev_finder.jev import JevClient
from jev_finder.tracker import BoxChain


@pytest.fixture(autouse=True)
def prohibit_real_network(monkeypatch):
    def blocked(*args, **kwargs):
        raise AssertionError("Tests must use a mock transport; external HTTP is disabled.")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", blocked)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", blocked)


class FakeJev:
    """jev's API without the network. Every object is present with `box` unless `answers` (by
    question key) says otherwise; `status` other than 200 fails the request; a `hold` event
    keeps jev from answering until it is set. Records requests."""

    def __init__(self):
        self.answers: dict[str, dict] = {}
        self.box = (0.3, 0.3, 0.7, 0.7)
        self.status = 200
        self.error: Exception | None = None
        self.hold: threading.Event | None = None
        self.requests: list[httpx.Request] = []

    def present(self, key: str, noul: float, box=None) -> None:
        self.answers[key] = {"noul": noul, "box": box}

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.hold:
            self.hold.wait(5)
        if self.error:
            raise self.error
        if self.status != 200:
            return httpx.Response(self.status, text="overloaded")
        answers = {}
        for name, question in json.loads(request.content)["questions"].items():
            _, key = name.split("_", 1)
            answer = self.answers.get(key, {})
            if question["type"] == "noul":
                answers[name] = {"type": "noul", "noul": answer.get("noul", 0.9)}
            else:
                left, top, right, bottom = answer.get("box") or self.box
                coords = {"left": left, "top": top, "right": right, "bottom": bottom}
                answers[name] = {"type": "box", "box": coords, "confidence": None}
        return httpx.Response(200, json={"answers": answers, "usage": {"input_tokens": 3300}})

    def body(self, index: int = -1) -> dict:
        return json.loads(self.requests[index].content)

    def client(self, timeout_s: float = 12.0) -> JevClient:
        transport = httpx.MockTransport(self.handle)
        return JevClient("test-key", timeout_s=timeout_s, transport=transport)


class FakeSegmenter:
    """SAM without the model: the mask for a box is the ellipse inscribed in it, or nothing
    when `empty`. Records what it was asked. A `hold` event keeps `segment` from answering until
    it is set; `segmenting` is set once a `segment` call is waiting on it."""

    label = "fake-sam"
    device = "cpu"

    def __init__(self):
        self.encoded: list[tuple[int, int]] = []
        self.boxes: list[list[list[float]]] = []
        self.prompts: list[tuple[list[float], list[float] | None]] = []
        self.empty = False
        self.hold: threading.Event | None = None
        self.segmenting = threading.Event()

    def segment(self, image: Image.Image, box: list[float], point=None) -> tuple[np.ndarray, float]:
        self.prompts.append((box, point))
        if self.hold:
            self.segmenting.set()
            self.hold.wait(5)
        return self.masks(self.encode(image), [box])[0], 0.9

    def track_session(self) -> BoxChain:
        return BoxChain(self)

    def encode(self, image: Image.Image) -> tuple[int, int]:
        self.encoded.append(image.size)
        return image.size

    def masks(self, encoded: tuple[int, int], boxes: list[list[float]]) -> list[np.ndarray]:
        self.boxes.append(boxes)
        w, h = encoded
        y, x = np.mgrid[:h, :w] + 0.5
        masks = []
        for x0, y0, x1, y1 in boxes:
            cx, cy = (x0 + x1) / 2 * w, (y0 + y1) / 2 * h
            rx, ry = (x1 - x0) / 2 * w, (y1 - y0) / 2 * h
            inside = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1
            masks.append(np.zeros((h, w), dtype=bool) if self.empty else inside)
        return masks


def encode_image(size=(960, 720), fmt="JPEG", color=(90, 120, 160)) -> str:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, fmt)
    return base64.b64encode(buffer.getvalue()).decode()


@pytest.fixture
def fake_jev() -> FakeJev:
    return FakeJev()


@pytest.fixture
def fake_segmenter() -> FakeSegmenter:
    return FakeSegmenter()


@pytest.fixture
def image_b64():
    return encode_image
