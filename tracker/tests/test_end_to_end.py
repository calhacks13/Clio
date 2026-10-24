"""Real YOLOE-26 + ByteTrack on a moving camera: jev names a person once, the tracker keeps them.

The "camera" pans and zooms across Ultralytics' bus.jpg, which has four people. jev answers the
first frame only, then fails every later call, so everything after comes from tracking.
"""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from clio_tracker.geometry import iou
from clio_tracker.identify import FrameImage, Identification, Query
from clio_tracker.session import SessionSettings, TrackerSession
from clio_tracker.vision import load_vision
from conftest import Clock, ManualExecutor

pytestmark = pytest.mark.model
PERSON = np.array([221.52, 405.8, 344.98, 857.54], dtype=np.float32)  # in bus.jpg pixels
OTHERS = np.array([[52, 401, 243, 900], [671, 394, 809, 876]], dtype=np.float32)
OUT = (640, 480)


class OnceJev:
    name = "jev-once"

    def __init__(self, box: np.ndarray):
        self.box = box
        self.calls = 0

    def identify(self, image: FrameImage, queries: list[Query]) -> list[Identification]:
        self.calls += 1
        if self.calls > 1:
            raise RuntimeError("jev is down")
        w, h = image.width, image.height
        b = self.box
        return [Identification(queries[0].id, 0.95, (b[0] / w, b[1] / h, b[2] / w, b[3] / h))]


def camera(bus: np.ndarray, i: int, n: int) -> tuple[np.ndarray, np.ndarray]:
    """Frame i of a pan with a slow zoom: the image and a function of bus.jpg boxes."""
    h, w = bus.shape[:2]
    f = i / (n - 1)
    cw = int(w * (0.95 - 0.25 * f))
    ch = int(cw * OUT[1] / OUT[0])
    x0 = int((w - cw) * (0.1 + 0.5 * f))
    y0 = int(min(h - ch, 300 + 80 * f))
    crop = bus[y0 : y0 + ch, x0 : x0 + cw]
    sx, sy = OUT[0] / cw, OUT[1] / ch
    frame = cv2.resize(crop, OUT, interpolation=cv2.INTER_AREA)
    return frame, np.array([x0, y0, sx, sy], dtype=np.float32)


def project(box: np.ndarray, view: np.ndarray) -> np.ndarray:
    x0, y0, sx, sy = view
    b = (np.atleast_2d(box) - [x0, y0, x0, y0]) * [sx, sy, sx, sy]
    return b.clip([0, 0, 0, 0], [OUT[0], OUT[1], OUT[0], OUT[1]])


def test_follows_the_named_person_through_a_pan_without_jev(bus_rgb):
    vision = load_vision("yoloe-26s-seg", backend="torch")
    clock = Clock()
    n = 45
    first, view = camera(bus_rgb, 0, n)
    jev = OnceJev(project(PERSON, view)[0])
    session = TrackerSession(
        vision, jev, ManualExecutor(run_now=True), SessionSettings(identify_interval_s=0.5), clock
    )
    query = [Query("person", "The man in the dark jacket on the left of the bus", "man")]
    hits, wrong = 0, 0
    for i in range(n):
        clock.t += 1 / 15
        frame, view = camera(bus_rgb, i, n)
        ok, buf = cv2.imencode(".jpg", frame[..., ::-1])
        (d,), _ = session.locate(FrameImage(buf.tobytes(), "image/jpeg", frame), query)
        if i < 2 or not d["found"]:
            continue
        box = np.array(d["box"]) * [OUT[0], OUT[1], OUT[0], OUT[1]]
        truth = project(PERSON, view)[0]
        hits += iou(box, truth)[0, 0] > 0.6
        wrong += iou(box, project(OTHERS, view)).max() > 0.5
    assert jev.calls > 1  # it kept asking, and every later call failed
    assert wrong == 0
    assert hits >= 0.9 * (n - 2)


@pytest.fixture(scope="module")
def bus_rgb():
    from pathlib import Path

    import ultralytics

    bgr = cv2.imread(str(Path(ultralytics.__file__).parent / "assets" / "bus.jpg"))
    return np.ascontiguousarray(bgr[..., ::-1])
