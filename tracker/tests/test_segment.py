"""The SAM 2.1 segmenter: its mask crop, the mask cleanup, the name lookup and the setting."""

from __future__ import annotations

import numpy as np
import pytest

from clio_tracker.config import ConfigError, load_settings
from clio_tracker.segment import clean_mask, crop_mask, load_segmenter


def paste(crop, width: int, height: int) -> np.ndarray:
    """The crop's inside (logits > 0) as a frame-sized boolean mask, nearest-neighbour."""
    ys = np.floor((np.arange(height) + 0.5 - crop.origin[1]) / crop.scale)
    xs = np.floor((np.arange(width) + 0.5 - crop.origin[0]) / crop.scale)
    rows, cols = crop.logits.shape
    ok_y = (ys >= 0) & (ys < rows)
    ok_x = (xs >= 0) & (xs < cols)
    full = np.zeros((height, width), bool)
    patch = crop.logits[np.ix_(ys[ok_y].astype(int), xs[ok_x].astype(int))] > 0
    full[np.ix_(ok_y, ok_x)] = patch
    return full


def test_fake_segmenter_crop_covers_box(segmenter):
    enc = segmenter.encode(np.zeros((720, 960, 3), np.uint8))
    crop = segmenter.mask_in_box(enc, np.array([100.0, 200.0, 300.0, 400.0]))
    assert crop is not None and crop.scale >= 1.0
    assert crop.origin[0] <= 100 and crop.origin[1] <= 200
    assert (crop.logits > 0).sum() > 0


def test_fake_segmenter_records_every_call(segmenter):
    enc = segmenter.encode(np.zeros((720, 960, 3), np.uint8))
    segmenter.mask_in_box(enc, np.array([100.0, 200.0, 300.0, 400.0]))
    assert segmenter.calls == [(960, 720, (100.0, 200.0, 300.0, 400.0))]


def test_load_segmenter_none_and_unknown():
    assert load_segmenter("none") is None
    with pytest.raises(ValueError):
        load_segmenter("sam9")


def test_clean_mask_drops_specks():
    logits = np.full((20, 20), -10.0, np.float32)
    logits[5:15, 5:15] = 10.0
    logits[0, 0] = 10.0  # a speck
    out = clean_mask(logits)
    assert out[0, 0] < 0 and (out[5:15, 5:15] > 0).all()
    assert set(np.unique(out)) <= {-10.0, 10.0}


def test_crop_mask_grows_the_box_and_shrinks_to_256_pixels():
    logits = np.full((720, 960), -10.0, np.float32)
    logits[100:500, 200:700] = 10.0
    crop = crop_mask(logits, np.array([200.0, 100.0, 700.0, 500.0]))
    assert crop is not None
    assert crop.origin == (150.0, 60.0)  # 10% of 500 x 400 on every side
    assert crop.logits.shape == (205, 256) and crop.scale == pytest.approx(600 / 256)
    inside = paste(crop, 960, 720)
    assert inside[105:495, 205:695].all() and inside.sum() == pytest.approx(500 * 400, rel=0.02)


def test_crop_mask_is_clipped_to_the_frame_and_small_masks_stay_unscaled():
    logits = np.full((720, 960), -10.0, np.float32)
    logits[0:80, 0:80] = 10.0
    crop = crop_mask(logits, np.array([0.0, 0.0, 100.0, 100.0]))
    assert crop is not None and crop.origin == (0.0, 0.0) and crop.scale == 1.0
    assert crop.logits.shape == (110, 110)
    assert (crop.logits[:80, :80] > 0).all() and (crop.logits[80:, :] < 0).all()


def test_crop_mask_is_clipped_at_the_right_and_bottom_edges():
    logits = np.full((720, 960), -10.0, np.float32)
    logits[610:700, 820:940] = 10.0
    # 150 x 110: grown by 15 and 11, the bounds reach x = 965 and y = 721, past the frame.
    crop = crop_mask(logits, np.array([800.0, 600.0, 950.0, 710.0]))
    assert crop is not None
    assert crop.origin == (785.0, 589.0) and crop.scale == 1.0
    assert crop.logits.shape == (720 - 589, 960 - 785)  # ends at the frame edge, not past it
    inside = paste(crop, 960, 720)
    assert inside[610:700, 820:940].all() and inside.sum() == 90 * 120


def test_crop_mask_is_none_without_an_object():
    logits = np.full((720, 960), -10.0, np.float32)
    assert crop_mask(logits, np.array([100.0, 100.0, 300.0, 300.0])) is None
    logits[200:203, 200:203] = 10.0  # 9 pixels
    assert crop_mask(logits, np.array([100.0, 100.0, 300.0, 300.0])) is None
    logits[200:205, 200:205] = 10.0  # 25 pixels
    assert crop_mask(logits, np.array([100.0, 100.0, 300.0, 300.0])) is not None
    assert crop_mask(logits, np.array([300.0, 300.0, 300.0, 300.0])) is None


@pytest.mark.model
def test_sam2_small_masks_a_bright_square():
    pytest.importorskip("transformers")
    seg = load_segmenter("sam2.1-small")
    rgb = np.full((480, 640, 3), 30, np.uint8)
    rgb[150:330, 200:440] = 230
    crop = seg.mask_in_box(seg.encode(rgb), np.array([190.0, 140.0, 450.0, 340.0]))
    assert crop is not None
    assert max(crop.logits.shape) <= 256
    full = paste(crop, 640, 480)
    inside_area = 180 * 240
    inside = full[150:330, 200:440].sum()
    outside = full.sum() - inside
    assert inside > 0.9 * inside_area and outside <= 0.05 * inside_area


def test_settings_segmenter_default_and_validation():
    assert load_settings({}).segmenter == "auto"
    assert load_settings({"CLIO_TRACKER_SEGMENTER": "sam2.1-large"}).segmenter == "sam2.1-large"
    with pytest.raises(ConfigError):
        load_settings({"CLIO_TRACKER_SEGMENTER": "sam3"})
