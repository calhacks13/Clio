"""The offline steadiness benchmark (jitter.py): its camera, its measures, and a short real run."""

from __future__ import annotations

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
