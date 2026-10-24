"""The split vision graph against Ultralytics' own YOLOE-26 forward pass (real weights).

The tracker rearranges YOLOE's head (prompt scoring folded per prompt, SAVPE split in two, the
one2one branch decoded by hand), so these tests pin each piece to the unmodified model.
"""

from __future__ import annotations

import numpy as np
import pytest

torch = pytest.importorskip("torch")

from clio_tracker.geometry import iou  # noqa: E402
from clio_tracker.vision import (  # noqa: E402
    TorchGraph,
    YoloeVision,
    default_models_dir,
    load_yoloe,
    prompt_masks,
)

pytestmark = pytest.mark.model
MODEL = "yoloe-26s-seg"
# The person on the left of Ultralytics' bus.jpg (810 x 1080), from its visual-prompt docs.
PERSON = np.array([221.52, 405.8, 344.98, 857.54], dtype=np.float32)


@pytest.fixture(scope="module")
def bus():
    from pathlib import Path

    import cv2
    import ultralytics

    bgr = cv2.imread(str(Path(ultralytics.__file__).parent / "assets" / "bus.jpg"))
    return bgr[..., ::-1].copy()


@pytest.fixture(scope="module")
def vision():
    net = load_yoloe(default_models_dir() / f"{MODEL}.pt")
    return YoloeVision(net, TorchGraph(net, "cpu"), MODEL)


@pytest.fixture(scope="module")
def reference():
    """An untouched (unfused) YOLOE-26 model."""
    from ultralytics import YOLOE

    return YOLOE(str(default_models_dir() / f"{MODEL}.pt")).model.float().eval()


def _input(vision, rgb):
    from clio_tracker.geometry import letterbox

    square, lb = letterbox(rgb, vision.size)
    x = torch.from_numpy(square.transpose(2, 0, 1)[None].copy()).float() / 255
    return x, lb


def _neck(net, x):
    head = net.model[-1]
    y = []
    for m in net.model[:-1]:
        if m.f != -1:
            x = y[m.f] if isinstance(m.f, int) else [x if j == -1 else y[j] for j in m.f]
        x = m(x)
        y.append(x if m.i in net.save else None)
    return [y[j] for j in head.f]


def test_visual_prompt_matches_ultralytics_get_vpe(vision, reference, bus):
    enc = vision.encode(bus)
    ours = vision.prompts(enc, PERSON)[0]
    x, lb = _input(vision, bus)
    mask = torch.from_numpy(prompt_masks(lb.to_input(PERSON[None]), (80, 80)))[None]
    with torch.no_grad():
        theirs = reference(x, vpe=mask, return_vpe=True)[0, 0].numpy()
    assert np.linalg.norm(ours) == pytest.approx(1.0, abs=1e-5)
    assert float(ours @ theirs) > 0.9999


def test_folded_scores_match_the_contrastive_head(vision, reference, bus):
    enc = vision.encode(bus)
    prompt = vision.prompts(enc, PERSON)
    ours = vision.scores(enc, prompt)[0]
    x, _ = _input(vision, bus)
    head = reference.model[-1]
    with torch.no_grad():
        feats = _neck(reference, x)
        vpe = torch.from_numpy(prompt)[None]
        logits = [
            head.one2one_cv4[i](head.one2one_cv3[i](feats[i]), vpe).flatten(2)
            for i in range(head.nl)
        ]
    theirs = torch.cat(logits, 2).sigmoid()[0, 0].numpy()
    assert ours.shape == theirs.shape == (8400,)
    np.testing.assert_allclose(ours, theirs, atol=2e-4)


def test_prompted_person_is_the_top_candidate(vision, bus):
    enc = vision.encode(bus)
    scores = vision.scores(enc, vision.prompts(enc, PERSON))[0]
    best = int(np.argmax(scores))
    box = enc.letterbox.to_frame(enc.boxes[best])
    assert scores[best] > 0.5
    assert iou(box, PERSON)[0, 0] > 0.9


def test_shape_traces_the_person(vision, bus):
    enc = vision.encode(bus)
    scores = vision.scores(enc, vision.prompts(enc, PERSON))[0]
    best = int(np.argmax(scores))
    box = enc.letterbox.to_frame(enc.boxes[best])
    shape = vision.shape(enc, best, box)
    assert shape.outline is not None and 3 <= len(shape.outline) <= 64
    xs = [p[0] * 810 for p in shape.outline]
    ys = [p[1] * 1080 for p in shape.outline]
    assert min(xs) >= box[0] - 2 and max(xs) <= box[2] + 2
    assert min(ys) >= box[1] - 2 and max(ys) <= box[3] + 2
    px, py = shape.point[0] * 810, shape.point[1] * 1080
    assert box[0] <= px <= box[2] and box[1] <= py <= box[3]


def test_tiny_boxes_still_prompt_one_cell():
    masks = prompt_masks(np.array([[100.0, 100.0, 101.0, 101.0]]), (80, 80))
    assert masks.sum() == 1 and masks[0, 12, 12] == 1


def test_coreml_graph_agrees_with_torch(vision, bus):
    from clio_tracker.coreml import CoreMLGraph, coreml_available

    if not coreml_available():
        pytest.skip("Core ML needs an Apple silicon Mac and the coreml extra")
    net = load_yoloe(default_models_dir() / f"{MODEL}.pt")
    ane = YoloeVision(net, CoreMLGraph.load_or_export(net, default_models_dir() / MODEL), MODEL)
    ref, enc = vision.encode(bus), ane.encode(bus)
    prompt_ref, prompt = vision.prompts(ref, PERSON), ane.prompts(enc, PERSON)
    assert float(prompt_ref[0] @ prompt[0]) > 0.995  # float16 on the Neural Engine
    s_ref, s = vision.scores(ref, prompt_ref)[0], ane.scores(enc, prompt)[0]
    assert int(np.argmax(s)) == int(np.argmax(s_ref))
    assert abs(float(s.max()) - float(s_ref.max())) < 0.03
    best = int(np.argmax(s))
    assert (
        iou(enc.letterbox.to_frame(enc.boxes[best]), ref.letterbox.to_frame(ref.boxes[best]))[0, 0]
        > 0.98
    )
