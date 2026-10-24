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
from conftest import Clock, ManualExecutor, models_under_test

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


def test_follows_the_named_person_through_a_pan_without_jev(bus_rgb, vision):
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


@pytest.fixture(scope="module", params=models_under_test())
def vision(request):
    """Each size the way it runs on a Mac: Core ML on the Neural Engine, else PyTorch."""
    return load_vision(request.param, backend="auto")


@pytest.fixture(scope="module")
def bus_rgb():
    from pathlib import Path

    import ultralytics

    bgr = cv2.imread(str(Path(ultralytics.__file__).parent / "assets" / "bus.jpg"))
    return np.ascontiguousarray(bgr[..., ::-1])


def test_track_stream_follows_a_target_given_once(bus_rgb, vision):
    """Peter's primary demo flow: one target over /track, then frames alone."""
    from clio_tracker.track import FrameHeader, StreamTracker

    tracker = StreamTracker(vision)
    n = 45
    hits, wrong, found = 0, 0, 0
    for i in range(n):
        frame, view = camera(bus_rgb, i, n)
        ok, buf = cv2.imencode(".jpg", frame[..., ::-1])
        if i == 1:  # jev's box arrives about one frame later, about frame 0
            x0, y0, x1, y1 = project(PERSON, camera(bus_rgb, 0, n)[1])[0] / [*OUT, *OUT]
            from clio_tracker.track import TargetBox

            tracker.command(TargetBox(0, [x0, y0, x1, y1], "man"))
        answer = tracker.step(FrameHeader(i, 1000.0 + 66 * i, *OUT), buf.tobytes())
        if i < 1 or not answer["found"]:
            continue
        found += 1
        box = np.array(answer["box"]) * [*OUT, *OUT]
        hits += iou(box, project(PERSON, view)[0])[0, 0] > 0.6
        wrong += iou(box, project(OTHERS, view)).max() > 0.5
        assert answer["outline"] and answer["contact"] and answer["name"] == "man"
    assert found == n - 1 and wrong == 0 and hits >= 0.9 * (n - 1)


class PlacesOnce:
    """jev placing every object on the first frame it is sent, then down."""

    name = "jev-once"

    def __init__(self, boxes: dict[str, np.ndarray]):
        self.boxes = boxes
        self.calls = 0

    def identify(self, image: FrameImage, queries: list[Query]) -> list[Identification]:
        self.calls += 1
        if self.calls > 1:
            raise RuntimeError("jev is down")
        size = [image.width, image.height] * 2
        return [Identification(q.id, 0.95, tuple(self.boxes[q.id] / size)) for q in queries]


def test_objects_mode_follows_two_people_named_once(bus_rgb, vision):
    """A lesson's flow: two objects in words over /track, jev placing both on the first frame."""
    from clio_tracker.track import FrameHeader, Modes, ObjectSet, StreamTracker

    n = 45
    people = {"man": PERSON, "left": OTHERS[0]}
    first = camera(bus_rgb, 0, n)[1]
    jev = PlacesOnce({k: project(box, first)[0] for k, box in people.items()})
    clock = Clock()
    session = TrackerSession(
        vision, jev, ManualExecutor(run_now=True), SessionSettings(identify_interval_s=0.5), clock
    )
    modes = Modes(StreamTracker(vision), lambda: session)
    man = Query("man", "The man in the dark jacket in the middle", "man")
    modes.command(ObjectSet([man, Query("left", "The person at the left edge", "person")]))
    hits = {"man": 0, "left": 0}
    for i in range(n):
        clock.t += 1 / 15
        frame, view = camera(bus_rgb, i, n)
        ok, buf = cv2.imencode(".jpg", frame[..., ::-1])
        answer = modes.step(FrameHeader(i, 1000.0 + 66 * i, *OUT), buf.tobytes())
        assert [d["id"] for d in answer["detections"]] == ["man", "left"]
        if i == 0:
            continue
        for d in answer["detections"]:
            assert d["found"] and d["outline"] and d["contact"]  # both, on every frame
            box = np.array(d["box"]) * [*OUT, *OUT]
            others = [b for k, b in people.items() if k != d["id"]] + [OTHERS[1]]
            assert iou(box, project(np.stack(others), view)).max() < 0.5  # never another person
            hits[d["id"]] += iou(box, project(people[d["id"]], view)[0])[0, 0] > 0.6
    assert jev.calls > 1  # it kept asking, and every later call failed
    assert hits["man"] >= 0.9 * (n - 1)
    assert hits["left"] >= 0.7 * (n - 1)  # it walks out of the view as the camera pans


def test_locate_outlines_jevs_box_with_yoloe(bus_rgb, vision):
    from clio_tracker.finder import Finder
    from clio_tracker.identify import JevIdentifier
    from clio_tracker.jev import JevClient, fake_transport

    h, w = bus_rgb.shape[:2]
    box = (PERSON / [w, h, w, h]).tolist()
    jev = JevIdentifier(JevClient("fake", transport=fake_transport(tuple(box))), "fake-jev")
    finder = Finder(jev, vision)
    ok, buf = cv2.imencode(".jpg", bus_rgb[..., ::-1])
    import base64

    answer, _ = finder.locate(
        "image/jpeg",
        base64.b64encode(buf.tobytes()).decode(),
        [Query("man", "The man in the black jacket", "man")],
    )
    finder.close()
    (d,) = answer["detections"]
    assert d["found"] and d["outline"] and len(d["outline"]) >= 3
    assert iou(np.array(d["box"]) * [w, h, w, h], PERSON)[0, 0] > 0.9
