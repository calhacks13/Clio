"""A synthetic scene standing in for YOLOE, so tracking logic is tested without the model.

Each frame is a list of `Thing`s: a box in frame pixels and a unit appearance vector. `FakeVision`
scores a prompt against each thing by cosine (YOLOE's visual prompts behave alike: the same object
across views scores high, a look-alike lower), turns a box back into the appearance of the thing
under it, and outlines a thing as its box.
"""

from __future__ import annotations

from collections import deque
from concurrent.futures import Future
from dataclasses import dataclass

import numpy as np
import pytest

from clio_tracker.geometry import Letterbox, Shape, iou
from clio_tracker.identify import FrameImage, Identification, Query
from clio_tracker.vision import Encoding

W, H = 960, 720


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
    model = "fake-yoloe"
    backend = "fake"

    def __init__(self) -> None:
        self.scenes: deque[list[Thing]] = deque()

    def encode(self, _rgb: np.ndarray | None = None, scene: list[Thing] | None = None) -> Encoding:
        things = scene if scene is not None else self.scenes.popleft()
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
        return Shape(outline, [(x1 + x2) / 2 / W, (y1 + y2) / 2 / H])


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


def norm_box(box) -> tuple[float, float, float, float]:
    x1, y1, x2, y2 = box
    return (x1 / W, y1 / H, x2 / W, y2 / H)


@pytest.fixture
def vision() -> FakeVision:
    return FakeVision()
