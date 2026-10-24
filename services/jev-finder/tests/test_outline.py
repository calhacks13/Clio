from __future__ import annotations

import numpy as np
import pytest
from scipy import ndimage

from jev_finder.bench import mask_box
from jev_finder.outline import mask_shape, outer_contour, simplify


def shoelace(ring: np.ndarray) -> float:
    x, y = np.asarray(ring, dtype=float).T
    return float(np.dot(x, np.roll(y, -1)) - np.dot(np.roll(x, -1), y)) / 2


def disc(h: int, w: int, cx: float, cy: float, r: float) -> np.ndarray:
    y, x = np.mgrid[:h, :w]
    return (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r**2


def inside(mask: np.ndarray, point: list[float]) -> bool:
    h, w = mask.shape
    return bool(mask[int(point[1] * h), int(point[0] * w)])


def test_rectangle_traces_its_four_corners_clockwise():
    mask = np.zeros((10, 20), dtype=bool)
    mask[2:5, 4:9] = True
    contour = outer_contour(mask)
    assert contour.tolist() == [[9, 2], [9, 5], [4, 5], [4, 2]]
    assert shoelace(contour) == mask.sum()  # positive: clockwise on screen with y down
    shape = mask_shape(mask)
    assert shape.box == pytest.approx(mask_box(mask)) == [0.2, 0.2, 0.45, 0.5]
    assert shape.outline == [[0.45, 0.2], [0.45, 0.5], [0.2, 0.5], [0.2, 0.2]]
    assert shape.area == 15
    assert shape.point == [0.325, 0.35]  # the center pixel of the 5x3 block


def test_single_pixel_and_full_frame():
    pixel = np.zeros((4, 4), dtype=bool)
    pixel[1, 2] = True
    assert outer_contour(pixel).tolist() == [[3, 1], [3, 2], [2, 2], [2, 1]]
    full = mask_shape(np.ones((6, 8), dtype=bool))
    assert full.outline == [[1, 0], [1, 1], [0, 1], [0, 0]]
    assert full.box == [0, 0, 1, 1]
    assert full.point == pytest.approx([0.5, 0.5], abs=0.1)


def test_empty_mask_has_no_shape():
    assert mask_shape(np.zeros((5, 5), dtype=bool)) is None


def test_convex_disc():
    mask = disc(300, 400, 180, 140, 90)
    shape = mask_shape(mask)
    assert 3 <= len(shape.outline) <= 64
    assert shape.box == pytest.approx(mask_box(mask), abs=1e-4)
    polygon = np.array(shape.outline) * [400, 300]
    assert shoelace(polygon) == pytest.approx(mask.sum(), rel=0.02)
    assert shape.point == pytest.approx([180 / 400, 140 / 300], abs=0.01)


def test_concave_l_shape_keeps_the_inner_corner():
    mask = np.zeros((12, 12), dtype=bool)
    mask[1:11, 1:4] = True  # vertical bar
    mask[8:11, 1:11] = True  # foot
    contour = outer_contour(mask)
    assert contour.tolist() == [[4, 1], [4, 8], [11, 8], [11, 11], [1, 11], [1, 1]]
    assert shoelace(contour) == mask.sum()
    shape = mask_shape(mask)
    assert len(shape.outline) == 6
    assert inside(mask, shape.point)


def test_concave_crescent_point_stays_on_the_object():
    mask = disc(200, 200, 100, 100, 80) & ~disc(200, 200, 140, 100, 70)
    shape = mask_shape(mask)
    assert inside(mask, shape.point)
    assert len(shape.outline) <= 64
    assert shape.box == pytest.approx(mask_box(mask), abs=1e-4)


def test_hole_is_ignored_by_the_outline_but_not_by_the_point():
    mask = disc(200, 200, 100, 100, 80) & ~disc(200, 200, 100, 100, 40)
    contour = outer_contour(mask)
    assert shoelace(contour) == ndimage.binary_fill_holes(mask).sum()
    shape = mask_shape(mask)
    assert shape.box == pytest.approx(mask_box(mask), abs=1e-4)
    # The deepest point is in the ring, not in the hole at the center.
    assert inside(mask, shape.point)
    assert np.hypot(shape.point[0] - 0.5, shape.point[1] - 0.5) > 0.2


def test_two_blobs_keep_only_the_largest():
    big = disc(100, 300, 220, 50, 40)
    small = disc(100, 300, 50, 50, 20)
    shape = mask_shape(big | small)
    assert shape.area == big.sum()
    assert shape.box == pytest.approx(mask_box(big), abs=1e-4)
    assert shape.point[0] > 0.6


def test_pieces_touching_at_a_corner_are_one_piece():
    mask = np.zeros((4, 4), dtype=bool)
    mask[1, 1] = mask[2, 2] = True
    contour = outer_contour(mask)
    assert contour.tolist() == [[2, 1], [2, 2], [3, 2], [3, 3], [2, 3], [2, 2], [1, 2], [1, 1]]
    assert mask_shape(mask).area == 2


def test_object_cut_off_by_the_frame_edge_keeps_its_point_inside():
    mask = np.zeros((100, 100), dtype=bool)
    mask[:, :30] = True
    shape = mask_shape(mask)
    assert shape.box == [0, 0, 0.3, 1]
    assert shape.point[0] == pytest.approx(0.15, abs=0.01)


def test_simplify_flattens_stair_steps():
    diagonal = np.zeros((200, 200), dtype=bool)
    rows, cols = np.mgrid[:200, :200]
    diagonal[cols <= rows] = True  # a staircase triangle with ~400 corners
    contour = outer_contour(diagonal)
    assert len(contour) > 300
    simple = simplify(contour)
    assert len(simple) <= 4


def test_simplify_caps_long_rings_at_64_points():
    angles = np.linspace(0, 2 * np.pi, 5000, endpoint=False)
    radius = 100 + 10 * np.sin(angles * 37)  # a wavy outline with many real features
    ring = np.stack([radius * np.cos(angles), radius * np.sin(angles)], axis=1)
    simple = simplify(ring)
    assert 3 <= len(simple) <= 64
    assert simplify(ring, max_points=10).shape[0] <= 10
    assert simplify(ring[:3]).shape == (3, 2)


def test_specks_do_not_pull_the_point_off_center():
    mask = disc(200, 200, 100, 100, 80)
    rng = np.random.default_rng(0)
    mask &= rng.random(mask.shape) > 0.003  # single-pixel specks, as glare leaves in a mask
    shape = mask_shape(mask)
    assert shape.point == pytest.approx([0.5, 0.5], abs=0.02)


def test_contact_is_the_middle_of_the_lowest_edge():
    rectangle = np.zeros((10, 20), dtype=bool)
    rectangle[2:5, 4:9] = True
    assert mask_shape(rectangle).contact == [0.325, 0.5]  # x 6.5 of 20, bottom edge y 5 of 10

    # A mug: a body with a handle on the right that ends above the base.
    mug = np.zeros((100, 100), dtype=bool)
    mug[20:90, 20:60] = True
    mug[30:60, 60:75] = True
    assert mask_shape(mug).contact == [0.4, 0.9]

    # One stray pixel below a corner (joined at that corner) doesn't move it off the base.
    tall = np.zeros((200, 100), dtype=bool)
    tall[20:180, 20:60] = True
    tall[180, 60] = True
    contact = mask_shape(tall).contact
    assert contact == pytest.approx([0.4, 181 / 200], abs=0.006)
