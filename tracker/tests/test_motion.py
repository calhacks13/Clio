"""CameraMotion: the picture's motion between frames, from the pixels."""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from clio_tracker.motion import CameraMotion, compose, warp_box

W, H = 480, 360


@pytest.fixture(scope="module")
def world() -> np.ndarray:
    """A textured scene larger than the view: smoothed noise, like a cluttered table."""
    rng = np.random.default_rng(3)
    noise = rng.integers(0, 255, (900, 1200), dtype=np.uint8)
    gray = cv2.GaussianBlur(noise, (0, 0), 3)
    gray = cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX)
    return np.dstack([gray] * 3)


def view(
    world: np.ndarray, x: float, y: float, scale: float = 1.0
) -> tuple[np.ndarray, np.ndarray]:
    """The camera's frame of the world with its top left at (x, y), and world-to-frame."""
    m = np.array([[scale, 0, -scale * x], [0, scale, -scale * y]], dtype=np.float64)
    return cv2.warpAffine(world, m, (W, H), flags=cv2.INTER_LINEAR), m


def truth(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return compose(b, np.linalg.inv(np.vstack([a, [0, 0, 1]]))[:2])


@pytest.mark.parametrize(
    "dx, dy, scale",
    [(0, 0, 1.0), (6.5, -3.2, 1.0), (-20, 8, 1.0), (4, 2, 1.04), (120, 5, 1.0), (-150, 0, 1.0)],
)
def test_finds_pans_zooms_and_fast_glances(world, dx, dy, scale):
    motion = CameraMotion()
    first, a = view(world, 300, 250)
    second, b = view(world, 300 + dx, 250 + dy, scale)
    assert motion.update(first, 0) is None  # nothing to compare with yet
    m = motion.update(second, 1)
    assert m is not None
    expected = truth(a, b)
    for p in ([240, 180], [40, 40], [440, 320]):
        got = m[:, :2] @ p + m[:, 2]
        want = expected[:, :2] @ p + expected[:, 2]
        assert np.hypot(*(got - want)) < 1.5


def test_since_composes_the_steps_and_counts_unknown_ones_as_still(world):
    motion = CameraMotion()
    frames = [view(world, 300 + 5 * i, 250 - 2 * i) for i in range(6)]
    for seq, (frame, _) in enumerate(frames):
        motion.update(frame, seq)
    expected = truth(frames[1][1], frames[5][1])
    got = motion.since(1)
    np.testing.assert_allclose(got[:, 2], expected[:, 2], atol=1.0)
    np.testing.assert_allclose(motion.since(5), np.eye(2, 3), atol=1e-9)
    flat = np.full((H, W, 3), 128, np.uint8)
    motion.update(flat, 6)  # no texture: unknown
    np.testing.assert_allclose(motion.since(5), np.eye(2, 3), atol=1e-9)


def test_a_frame_of_another_size_starts_over(world):
    motion = CameraMotion()
    motion.update(view(world, 300, 250)[0], 0)
    small = cv2.resize(view(world, 302, 250)[0], (320, 240))
    assert motion.update(small, 1) is None


def test_warp_box_moves_and_scales_about_the_centre():
    m = np.array([[2.0, 0, 10], [0, 2.0, -5]])
    np.testing.assert_allclose(warp_box(np.array([10, 10, 30, 20]), m), [30, 15, 70, 35])
    np.testing.assert_allclose(warp_box(np.array([1, 2, 3, 4]), None), [1, 2, 3, 4])
