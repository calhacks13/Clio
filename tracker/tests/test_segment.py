"""The SAM 2.1 segmenter: its mask crop, the mask cleanup, the name lookup and the setting."""

from __future__ import annotations

import logging
from dataclasses import replace

import numpy as np
import pytest

from clio_tracker import cli, segment
from clio_tracker.config import ConfigError, load_settings
from clio_tracker.segment import (
    candidate_bounds,
    clean_mask,
    crop_mask,
    load_segmenter,
    pick_candidate,
)


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


def test_candidate_bounds_are_the_masks_extent_in_pixel_edges():
    rows = np.zeros((2, 10), bool)
    cols = np.zeros((2, 12), bool)
    rows[0, 2:5] = True  # the first mask covers rows 2..4 and columns 3..8
    cols[0, 3:9] = True
    assert candidate_bounds(rows, cols).tolist() == [[3, 2, 9, 5], [0, 0, 0, 0]]  # 2nd is empty


def test_pick_candidate_prefers_the_mask_that_fills_the_prompt_box():
    whole_box = np.array([90.0, 50.0, 510.0, 270.0])
    part = [300.0, 180.0, 420.0, 240.0]
    whole = [100.0, 60.0, 500.0, 260.0]
    bounds = np.array([part, whole, whole])
    # The model is surest of the part (0.99), but the box is around the whole object.
    assert pick_candidate(np.array([0.99, 0.95, 0.60]), bounds, whole_box) == 1
    # A box around the part gets the part, though the whole object is a candidate too.
    part_box = np.array([295.0, 175.0, 425.0, 245.0])
    assert pick_candidate(np.array([0.95, 0.60, 0.97]), bounds, part_box) == 0


def test_pick_candidate_follows_the_model_when_the_bounds_agree():
    box = np.array([100.0, 100.0, 300.0, 300.0])
    bounds = np.array([[100.0, 100.0, 300.0, 300.0]] * 3)
    assert pick_candidate(np.array([0.5, 0.9, 0.7]), bounds, box) == 1


def test_pick_candidate_skips_an_empty_mask():
    box = np.array([100.0, 100.0, 300.0, 300.0])
    bounds = np.array(
        [[0.0, 0.0, 0.0, 0.0], [110.0, 110.0, 290.0, 290.0], [100.0, 100.0, 300.0, 300.0]]
    )
    assert pick_candidate(np.array([0.99, 0.8, 0.5]), bounds, box) == 1


def nested_rectangles() -> np.ndarray:
    """A bright 400 x 200 rectangle (x 100..500, y 60..260) on a dark frame, with a grayer
    120 x 60 rectangle inside it (x 300..420, y 180..240): a whole object and a part of it."""
    rgb = np.full((480, 640, 3), 30, np.uint8)
    rgb[60:260, 100:500] = 230
    rgb[180:240, 300:420] = 120
    return rgb


@pytest.mark.model
def test_sam2_small_takes_the_whole_object_for_a_loose_box_around_it():
    pytest.importorskip("transformers")
    seg = load_segmenter("sam2.1-small")
    box = np.array([90.0, 50.0, 510.0, 270.0])  # 10 px loose on every side
    crop = seg.mask_in_box(seg.encode(nested_rectangles()), box)
    assert crop is not None
    outer = paste(crop, 640, 480)[60:260, 100:500]
    assert outer.mean() >= 0.85


@pytest.mark.model
def test_sam2_small_takes_the_part_for_a_box_around_the_part():
    pytest.importorskip("transformers")
    seg = load_segmenter("sam2.1-small")
    box = np.array([290.0, 170.0, 430.0, 250.0])  # the inner rectangle, 10 px loose
    crop = seg.mask_in_box(seg.encode(nested_rectangles()), box)
    assert crop is not None
    full = paste(crop, 640, 480)
    assert full[180:240, 300:420].mean() >= 0.70
    outer_area = 400 * 200
    outside_part = full[60:260, 100:500].sum() - full[180:240, 300:420].sum()
    assert outside_part <= 0.20 * outer_area


def test_settings_segmenter_default_and_validation():
    assert load_settings({}).segmenter == "auto"
    assert load_settings({"CLIO_TRACKER_SEGMENTER": "sam2.1-large"}).segmenter == "sam2.1-large"
    with pytest.raises(ConfigError):
        load_settings({"CLIO_TRACKER_SEGMENTER": "sam3"})


def test_auto_starts_without_a_segmenter_when_it_fails_to_load(monkeypatch, caplog):
    def broken(name: str, device: str = "auto"):
        raise OSError("no SAM 2.1 weights in the cache, and no network")

    monkeypatch.setattr(segment, "load_segmenter", broken)
    settings = replace(load_settings({}), segmenter="auto")
    with caplog.at_level(logging.INFO, logger="clio_tracker"):
        assert cli._segmenter(settings) is None
    assert [r.levelno for r in caplog.records] == [logging.WARNING]
    assert "no SAM 2.1 weights in the cache" in caplog.text
    with pytest.raises(OSError):  # named on purpose: it still stops the tracker
        cli._segmenter(replace(settings, segmenter="sam2.1-small"))


def test_the_segmenter_is_warmed_up_with_an_encode_and_a_cut(monkeypatch, segmenter):
    monkeypatch.setattr(segment, "load_segmenter", lambda name, device="auto": segmenter)
    assert cli._segmenter(replace(load_settings({}), segmenter="sam2.1-small")) is segmenter
    ((width, height, _),) = segmenter.calls
    assert (width, height) == (640, 480)
