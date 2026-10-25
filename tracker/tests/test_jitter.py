"""The offline steadiness benchmark (jitter.py): its camera, its measures, and a short real run."""

from __future__ import annotations

from dataclasses import replace

import cv2
import numpy as np
import pytest

from clio_tracker import jitter
from clio_tracker.jitter import OUT_H, OUT_W, Played, Sequence, measure, render

CALIPER = jitter.SCENES[0]


@pytest.fixture(scope="module")
def sequence() -> Sequence:
    frames = render(CALIPER, 3.0, seed=7)
    return Sequence(CALIPER, frames, jitter.looks(frames, 7))


def answer(box, state="tracking") -> dict:
    x1, y1, x2, y2 = (float(v) for v in box)
    n = [x1 / OUT_W, y1 / OUT_H, x2 / OUT_W, y2 / OUT_H]
    outline = [[n[0], n[1]], [n[2], n[1]], [n[2], n[3]], [n[0], n[3]]]
    return {"found": True, "box": n, "outline": outline, "point": [(n[0] + n[2]) / 2,
            (n[1] + n[3]) / 2], "contact": [(n[0] + n[2]) / 2, n[3]], "state": state}  # fmt: skip


def test_the_camera_moves_and_every_frame_knows_where_the_object_is(sequence):
    assert len(sequence.frames) == 75
    assert all(f.jpeg[:3] == b"\xff\xd8\xff" for f in sequence.frames)
    frames = sequence.frames
    shifts = [
        abs(b.affine[0, 2] - a.affine[0, 2]) for a, b in zip(frames, frames[1:], strict=False)
    ]
    assert max(shifts) > 1  # it shakes
    asked, answered, box = sequence.looks[0]
    assert asked == 0 and 25 <= answered <= 50 and box is not None


def test_a_tracker_answering_the_truth_scores_perfectly(sequence):
    played = Played(first=0)
    for f in sequence.frames:
        played.answers.append(answer(f.truth))
        played.step_ms.append(20.0)
        played.encode_ms.append(18.0)
    r = measure(sequence, played)
    assert r["lost"] == 0 and r["wrong"] == 0 and r["iou"] == pytest.approx(1.0)
    assert r["jitter_box"] < 0.05 and r["box_f2f"] > 0.99 and r["mask_f2f"] > 0.95
    assert r["swaps"] == 0 and r["ms"] == 20 and r["tracker_ms"] == 2


def test_wobble_misses_and_another_object_are_counted(sequence):
    rng = np.random.default_rng(0)
    played = Played(first=0)
    for i, f in enumerate(sequence.frames):
        if i % 10 == 5:
            played.answers.append({"found": False, "state": "lost"})
        elif i == 30:
            played.answers.append(answer([0, 0, 20, 20]))  # something else
        else:
            played.answers.append(answer(f.truth + rng.normal(0, 4, 4)))
        played.step_ms.append(20.0)
        played.encode_ms.append(18.0)
    r = measure(sequence, played)
    assert r["lost"] == pytest.approx(7 / 75) and r["lost_streaks"] == 7
    assert r["wrong"] == pytest.approx(1 / 67, abs=1e-3)
    assert r["jitter_box"] > 2


@pytest.mark.model
def test_a_short_run_on_real_weights_keeps_the_caliper_steady(sequence):
    from clio_tracker import track
    from clio_tracker.vision import load_vision

    vision = load_vision("yoloe-26s-seg", backend="torch")
    r = measure(sequence, jitter.play(sequence, track, vision, vision))
    assert r["frames"] > 30 and r["lost"] == 0 and r["wrong"] == 0
    assert r["iou"] > 0.8 and r["jitter_box"] < 2 and r["swaps"] <= 1


def _scene(name: str) -> jitter.Scene:
    return next(s for s in jitter.PART_SCENES if s.name == name)


def _photo_box(box, affine) -> np.ndarray:
    """A box in frame pixels back in photo pixels (inverting the frame's affine)."""
    tx, ty, s = affine[0, 2], affine[1, 2], affine[0, 0]
    return (np.asarray(box, dtype=np.float64) - [tx, ty, tx, ty]) / s


def test_slide_scene_truth_moves_and_whole_stays():
    scene = _scene("jaw-slide")
    frames = render(scene, 2.0, seed=7)
    first = _photo_box(frames[0].truth, frames[0].affine)
    later = _photo_box(frames[12].truth, frames[12].affine)
    assert first == pytest.approx(scene.part, abs=0.5)
    assert abs(later[0] - first[0]) > 2
    for f in frames:  # the whole object is the photo's box through the camera, cut by the frame
        tx, ty, s = f.affine[0, 2], f.affine[1, 2], f.affine[0, 0]
        expected = (np.array(scene.box) * s + [tx, ty, tx, ty]).clip(0, [OUT_W, OUT_H] * 2)
        assert f.whole == pytest.approx(expected, abs=0.5)


def test_swing_scene_truth_narrows():
    scene = _scene("plate-swing")
    frames = render(scene, 3.2, seed=2)  # the frame at t = 3 s is the 76th
    mid, end = round(1.5 * jitter.FPS), round(3.0 * jitter.FPS)
    for i in (0, mid, end):  # a box cut by the frame's edge would not show the width
        t = frames[i].truth
        assert t is not None and t.min() > 0.5 and (t < [OUT_W - 0.5, OUT_H - 0.5] * 2).all()

    def width(i: int) -> float:
        box = _photo_box(frames[i].truth, frames[i].affine)
        return float(box[2] - box[0])

    assert 0.4 < width(mid) / width(0) < 0.6
    assert width(end) / width(0) == pytest.approx(1.0, rel=0.05)
    right = [_photo_box(frames[i].truth, frames[i].affine)[2] for i in (0, mid, end)]
    assert right == pytest.approx([right[0]] * 3, abs=0.5)  # the hinge stays put


def test_the_moved_patch_is_where_the_true_box_says():
    for name, t in (("jaw-slide", 0.5), ("plate-swing", 1.5)):
        scene = _scene(name)
        bgr = cv2.imread(str(scene.path))
        moved, box = jitter._move_part(bgr, scene.part, t, scene.motion)
        px1, py1, px2, py2 = scene.part
        patch = bgr[py1:py2, px1:px2]
        x1, y1, x2, y2 = (int(v) for v in box)
        assert moved.shape == bgr.shape and (y1, y2) == (py1, py2)
        if scene.motion == "slide":
            assert x1 != px1 and x2 - x1 == px2 - px1  # it only slides
            expected = patch
        else:
            assert x2 == px2 and 0.4 * (px2 - px1) < x2 - x1 < 0.6 * (px2 - px1)  # on its hinge
            expected = cv2.resize(patch, (x2 - x1, y2 - y1), interpolation=cv2.INTER_LINEAR)
        got = moved[y1:y2, x1:x2].astype(int)
        assert np.abs(got - expected).max() <= 2  # the patch is where the true box says
        outside = np.ones(bgr.shape[:2], bool)
        outside[y1:y2, :] = False
        assert np.array_equal(moved[outside], bgr[outside])  # only the patch's rows change


def test_scenes_without_motion_are_unchanged():
    vernier = next(s for s in jitter.PART_SCENES if s.name == "vernier")
    assert vernier.motion is None
    a = render(vernier, 1.0, seed=7)
    b = render(replace(vernier, motion=None), 1.0, seed=7)
    for i in (0, 10, 20):
        assert a[i].jpeg == b[i].jpeg
    assert all(
        np.array_equal(x.truth, y.truth) and np.array_equal(x.whole, y.whole)
        for x, y in zip(a, b, strict=True)
    )
    slid = render(replace(vernier, motion="slide"), 1.0, seed=7)
    assert slid[10].jpeg != a[10].jpeg  # the comparison above is not vacuous
