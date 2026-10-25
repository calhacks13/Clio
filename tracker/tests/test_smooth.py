"""Stabilizer: steady boxes and outlines, without lag from the camera and little from motion."""

from __future__ import annotations

import numpy as np

from clio_tracker.geometry import iou
from clio_tracker.smooth import Stabilizer
from clio_tracker.vision import MaskCrop

SIZE = (480, 360)
DT = 1 / 25


def filled(box, holes: tuple[float, float, float, float] | None = None) -> MaskCrop:
    """A mask filling `box` at 1 frame pixel per mask pixel; `holes` (box-relative) cut out."""
    x1, y1, x2, y2 = box
    rows, cols = int(np.ceil(y2 - y1)), int(np.ceil(x2 - x1))
    logits = np.full((rows, cols), 8.0, np.float32)
    if holes is not None:
        u1, v1, u2, v2 = holes
        logits[int(v1 * rows) : int(v2 * rows), int(u1 * cols) : int(u2 * cols)] = -8.0
    return MaskCrop(logits, (float(x1), float(y1)), 1.0)


def centre(b) -> np.ndarray:
    return np.array([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2])


def test_a_still_box_with_noise_comes_out_steady():
    rng = np.random.default_rng(1)
    s = Stabilizer()
    base = np.array([200, 120, 300, 260], dtype=np.float32)
    raw, out = [], []
    for i in range(100):
        box = base + rng.normal(0, 3, 4).astype(np.float32)
        shown, shape = s.sighted(i * DT, box, filled(box), SIZE)
        raw.append(centre(box))
        out.append(centre(shown))
        assert shape is not None and shape.outline

    def wobble(points):  # mean second difference, as the jitter benchmark measures it
        p = np.array(points[10:])
        return float(np.linalg.norm(p[2:] - 2 * p[1:-1] + p[:-2], axis=1).mean())

    assert wobble(out) < wobble(raw) / 3


def test_a_moving_box_is_followed_closely():
    """1 box size a second (a hand moving an object, no camera motion known): the filter's
    cutoff rises with the speed, so the shown box trails by a few percent of its size."""
    s = Stabilizer()
    for i in range(50):
        box = np.array([100 + 4 * i, 120, 200 + 4 * i, 220], dtype=np.float32)  # 100 px/s
        shown, _ = s.sighted(i * DT, box, filled(box), SIZE)
    assert abs(centre(shown)[0] - centre(box)[0]) < 6
    assert iou(shown, box)[0, 0] > 0.88


def test_speed_is_the_box_moving_on_its_own_in_box_sizes_a_second():
    """jev's pace reads it (ObjectTracker.steady): near 0 for a still box with noise, and at
    least the true speed for a moving box (measured against the filtered box, which trails)."""
    rng = np.random.default_rng(2)
    s = Stabilizer()
    assert s.speed == 0.0
    base = np.array([200, 120, 300, 220], dtype=np.float32)
    for i in range(50):
        box = base + rng.normal(0, 1, 4).astype(np.float32)
        s.sighted(i * DT, box, None, SIZE)
    assert s.speed < 0.3
    for i in range(50, 100):
        box = base + np.array([4, 0, 4, 0], np.float32) * (i - 50)  # 100 px/s, 1 size a second
        s.sighted(i * DT, box, None, SIZE)
    assert s.speed > 0.9


def test_camera_motion_is_followed_without_lag():
    s = Stabilizer()
    box = np.array([100, 100, 200, 200], dtype=np.float32)
    s.sighted(0.0, box, filled(box), SIZE)
    for i in range(1, 10):
        camera = np.array([[1.0, 0, 25.0], [0, 1.0, -5.0]])  # a fast pan: 25 px a frame
        s.moved(camera)
        box = box + np.array([25, -5, 25, -5], dtype=np.float32)
        shown, _ = s.sighted(i * DT, box, filled(box), SIZE)
        np.testing.assert_allclose(shown, box, atol=0.5)


def test_a_jump_starts_over_at_once():
    s = Stabilizer()
    a = np.array([50, 50, 150, 150], dtype=np.float32)
    for i in range(5):
        s.sighted(i * DT, a, filled(a), SIZE)
    b = np.array([300, 150, 400, 300], dtype=np.float32)  # another object
    shown, shape = s.sighted(5 * DT, b, filled(b), SIZE)
    np.testing.assert_allclose(shown, b)
    xs = [p[0] * SIZE[0] for p in shape.outline]
    assert min(xs) > 290


def test_a_one_frame_glitch_in_the_mask_does_not_show_but_two_frames_do():
    s = Stabilizer()
    box = np.array([100, 100, 300, 300], dtype=np.float32)
    for i in range(5):
        _, before = s.sighted(i * DT, box, filled(box), SIZE)
    hole = (0.0, 0.0, 0.5, 1.0)  # the left half missing (say, a part of the object for a frame)
    _, glitch = s.sighted(5 * DT, box, filled(box, hole), SIZE)
    left = min(p[0] for p in glitch.outline) * SIZE[0]
    assert left < 110  # still the whole object
    _, again = s.sighted(6 * DT, box, filled(box, hole), SIZE)
    assert min(p[0] for p in again.outline) * SIZE[0] > 190  # it lasted: now it shows
    assert before.contact is not None


def test_point_stays_put_on_a_long_shape():
    """The deepest pixel of a long bar hops along its ridge with tiny mask changes; the shown
    point stays in the middle."""
    rng = np.random.default_rng(2)
    s = Stabilizer()
    box = np.array([100, 160, 400, 200], dtype=np.float32)
    xs = []
    for i in range(30):
        crop = filled(box)
        crop.logits[:, :] += rng.normal(0, 2, crop.logits.shape).astype(np.float32)
        _, shape = s.sighted(i * DT, box, crop, SIZE)
        xs.append(shape.point[0] * SIZE[0])
    assert np.ptp(xs[5:]) < 6 and abs(np.mean(xs[5:]) - 250) < 10


def test_coasting_draws_the_last_outline_at_the_predicted_box():
    s = Stabilizer()
    box = np.array([100, 100, 200, 200], dtype=np.float32)
    s.sighted(0.0, box, filled(box), SIZE)
    shown, shape = s.coasting(DT, np.array([104, 100, 204, 200], dtype=np.float32), SIZE)
    assert shape is not None and shape.outline and 100 < shown[0] < 104
    assert Stabilizer().coasting(0.0, box, SIZE)[1] is None  # nothing seen yet
