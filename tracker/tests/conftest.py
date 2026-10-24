"""A synthetic scene standing in for YOLOE, so tracking logic is tested without the model.

Each frame is a list of `Thing`s: a box in frame pixels and a unit appearance vector. `FakeVision`
scores a prompt against each thing by cosine (YOLOE's visual prompts behave alike: the same object
across views scores high, a look-alike lower), turns a box back into the appearance of the thing
under it, and outlines a thing as its box.
"""

from __future__ import annotations

import base64
import io
import json
import threading
from collections import deque
from concurrent.futures import Future
from dataclasses import dataclass

import httpx
import numpy as np
import pytest
from PIL import Image

from clio_tracker.geometry import Letterbox, Shape, iou
from clio_tracker.identify import FrameImage, Identification, Query
from clio_tracker.jev import JevClient
from clio_tracker.segment import SegEncoding
from clio_tracker.vision import Encoding, MaskCrop

W, H = 960, 720


def models_under_test() -> list[str]:
    """The checkpoints the real-model tests run on: CLIO_TRACKER_TEST_MODELS (e.g. "s,m,l"),
    else s (downloaded when missing) and every other size already in models/."""
    import os

    from clio_tracker.config import MODELS, model_name
    from clio_tracker.vision import default_models_dir

    wanted = os.environ.get("CLIO_TRACKER_TEST_MODELS")
    if wanted:
        return [model_name(m) for m in wanted.split(",") if m.strip()]
    here = default_models_dir()
    return [name for size, name in MODELS.items() if size == "s" or (here / f"{name}.pt").exists()]


def unit(v) -> np.ndarray:
    v = np.asarray(v, dtype=np.float32)
    return v / np.linalg.norm(v)


def appearance(seed: int) -> np.ndarray:
    return unit(np.random.default_rng(seed).normal(size=512))


def blend(a: np.ndarray, b: np.ndarray, cos: float) -> np.ndarray:
    """A unit vector at cosine `cos` from a, toward b."""
    b_perp = unit(b - (b @ a) * a)
    return unit(cos * a + np.sqrt(1 - cos**2) * b_perp)


@dataclass
class Thing:
    box: tuple[float, float, float, float]
    look: np.ndarray


class FakeVision:
    """`scenes` are taken in order, one per encode. `world` instead picks the scene by the
    frame's brightness (scene k is a frame filled with gray 10 * k), which survives JPEG, so a
    frame encoded twice (a /track target) shows the same scene both times."""

    model = "fake-yoloe"
    backend = "fake"

    def __init__(self) -> None:
        self.scenes: deque[list[Thing]] = deque()
        self.world: dict[int, list[Thing]] = {}

    def encode(self, rgb: np.ndarray | None = None, scene: list[Thing] | None = None) -> Encoding:
        if scene is not None:
            things = scene
        elif self.world and rgb is not None:
            things = self.world.get(int(round(float(rgb.mean()) / 10)), [])
        else:
            things = self.scenes.popleft()
        enc = Encoding(
            letterbox=Letterbox(W, H, W, 1.0, 0, 0),
            boxes=np.array([t.box for t in things], dtype=np.float32).reshape(-1, 4),
            features=np.zeros((1, len(things)), np.float32),
            mask_coefficients=np.zeros((1, len(things)), np.float32),
            protos=np.zeros((1, 1, 1), np.float32),
            savpe_x=np.zeros((1, 1, 1), np.float32),
            savpe_y=np.zeros((1, 1, 1), np.float32),
        )
        enc.things = things  # type: ignore[attr-defined]
        return enc

    def scores(self, enc: Encoding, prompts: np.ndarray) -> np.ndarray:
        looks = np.stack([t.look for t in enc.things]) if enc.things else np.zeros((0, 512))  # type: ignore[attr-defined]
        cos = np.atleast_2d(prompts) @ looks.T
        return np.clip((cos - 0.6) / 0.4, 0, 1).astype(np.float32) * 0.9

    def prompts(self, enc: Encoding, boxes: np.ndarray) -> np.ndarray:
        out = []
        for box in np.atleast_2d(boxes):
            things = enc.things  # type: ignore[attr-defined]
            overlaps = iou(np.array([t.box for t in things]), box)[:, 0] if things else []
            if len(overlaps) and overlaps.max() > 0.1:
                out.append(things[int(np.argmax(overlaps))].look)
            else:
                out.append(appearance(999))
        return np.stack(out)

    def shape(self, enc: Encoding, anchor: int, box: np.ndarray) -> Shape:
        x1, y1, x2, y2 = (float(v) for v in box)
        outline = [[x1 / W, y1 / H], [x2 / W, y1 / H], [x2 / W, y2 / H], [x1 / W, y2 / H]]
        return Shape(outline, [(x1 + x2) / 2 / W, (y1 + y2) / 2 / H], [(x1 + x2) / 2 / W, y2 / H])

    def mask(self, enc: Encoding, anchor: int, box: np.ndarray) -> MaskCrop:
        """The box filled, at 2 frame pixels per mask pixel."""
        x1, y1, x2, y2 = (float(v) for v in box)
        rows, cols = max(1, int(np.ceil((y2 - y1) / 2))), max(1, int(np.ceil((x2 - x1) / 2)))
        return MaskCrop(np.full((rows, cols), 10.0, np.float32), (x1, y1), 2.0)

    def outline_in_box(self, enc: Encoding, box: np.ndarray, min_iou: float = 0.5):
        things = enc.things  # type: ignore[attr-defined]
        if not things:
            return None
        overlaps = iou(np.array([t.box for t in things]), box)[:, 0]
        i = int(np.argmax(overlaps))
        if overlaps[i] < min_iou:
            return None
        found = np.array(things[i].box, dtype=np.float32)
        return found, self.shape(enc, i, found)


class FakeSegmenter:
    """Stands in for SAM 2.1: every box is its own mask, filled, at one frame pixel per mask
    pixel. Records every `mask_in_box` call as (frame width, frame height, box)."""

    name = "fake-segmenter"

    def __init__(self) -> None:
        self.calls: list[tuple[int, int, tuple]] = []

    def encode(self, rgb: np.ndarray) -> SegEncoding:
        return SegEncoding(rgb.shape[1], rgb.shape[0], None)

    def mask_in_box(self, enc: SegEncoding, box: np.ndarray) -> MaskCrop:
        self.calls.append((enc.width, enc.height, tuple(box)))
        x1, y1, x2, y2 = (float(v) for v in box)
        rows, cols = max(1, int(np.ceil(y2 - y1))), max(1, int(np.ceil(x2 - x1)))
        return MaskCrop(np.full((rows, cols), 10.0, np.float32), (x1, y1), 1.0)


class FakeIdentifier:
    """Answers from a script: each call pops the next {id: (present, normalized box)}."""

    name = "fake-jev"

    def __init__(self) -> None:
        self.calls: list[list[Query]] = []
        self.answers: deque[dict[str, tuple[float, tuple[float, ...] | None]] | Exception] = deque()

    def identify(self, image: FrameImage, queries: list[Query]) -> list[Identification]:
        self.calls.append(list(queries))
        answer = self.answers.popleft() if self.answers else {}
        if isinstance(answer, Exception):
            raise answer
        return [Identification(q.id, *answer.get(q.id, (0.0, None))) for q in queries]


class ManualExecutor:
    """Runs submitted work only when told to, like a jev call that takes a while."""

    def __init__(self, run_now: bool = False) -> None:
        self.run_now = run_now
        self.pending: list = []

    def submit(self, fn, *args, **kwargs):
        future: Future = Future()
        if self.run_now:
            fn(*args, **kwargs)
            future.set_result(None)
        else:
            self.pending.append((fn, args, kwargs))
        return future

    def run_all(self) -> None:
        while self.pending:
            fn, args, kwargs = self.pending.pop(0)
            fn(*args, **kwargs)


class Clock:
    def __init__(self, t: float = 100.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


def frame_image() -> FrameImage:
    return FrameImage(b"jpeg", "image/jpeg", np.zeros((H, W, 3), np.uint8))


def scene_jpeg(k: int) -> bytes:
    """A W x H JPEG that FakeVision.world reads as scene k."""
    import cv2

    ok, buf = cv2.imencode(".jpg", np.full((H, W, 3), 10 * k, np.uint8))
    assert ok
    return buf.tobytes()


def norm_box(box) -> tuple[float, float, float, float]:
    x1, y1, x2, y2 = box
    return (x1 / W, y1 / H, x2 / W, y2 / H)


@pytest.fixture
def vision() -> FakeVision:
    return FakeVision()


@pytest.fixture
def segmenter() -> FakeSegmenter:
    return FakeSegmenter()


@pytest.fixture(autouse=True)
def prohibit_real_network(monkeypatch):
    def blocked(*args, **kwargs):
        raise AssertionError("Tests must use a mock transport; external HTTP is disabled.")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", blocked)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", blocked)


class FakeJev:
    """jev's API without the network (from the jev finder's tests). Every object is present
    with `box` unless `answers` (by question key) says otherwise; `status` other than 200 fails
    the request; a `hold` event keeps jev from answering until it is set. Records requests."""

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


def encode_image(size=(960, 720), fmt="JPEG", color=(90, 120, 160)) -> str:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, fmt)
    return base64.b64encode(buffer.getvalue()).decode()


@pytest.fixture
def fake_jev() -> FakeJev:
    return FakeJev()


@pytest.fixture
def image_b64():
    return encode_image
