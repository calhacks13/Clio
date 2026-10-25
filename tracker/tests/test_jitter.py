"""The offline steadiness benchmark (jitter.py): its camera, its measures, and a short real run."""

from __future__ import annotations

import threading
from dataclasses import replace
from time import perf_counter

import cv2
import numpy as np
import pytest

from clio_tracker import cli, jitter, track
from clio_tracker.jitter import OUT_H, OUT_W, Played, Sequence, measure, render
from clio_tracker.refresh import Refresher
from clio_tracker.segment import SegEncoding
from clio_tracker.vision import MaskCrop
from conftest import FakeVision, Thing, appearance

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


def _patch_fill(bgr: np.ndarray, part, side: str) -> np.ndarray:
    """The strip of photo just outside the part on `side`, tiled across the part's width."""
    x1, y1, x2, y2 = (int(v) for v in part)
    w, sw = x2 - x1, jitter.ERASE_STRIP
    reps = -(-w // sw)
    if side == "left":
        return np.tile(bgr[y1:y2, x1 - sw : x1], (1, reps, 1))[:, :w]
    return np.tile(bgr[y1:y2, x2 : x2 + sw], (1, reps, 1))[:, -w:]


def _erased(name: str, t: float, side: str) -> None:
    """What the moved part leaves uncovered of its original place is the tiled strip, and no
    longer the part's own pixels."""
    scene = _scene(name)
    bgr = cv2.imread(str(scene.path))
    moved, box = jitter._move_part(bgr, scene.part, t, scene.motion)
    x1, y1, x2, y2 = (int(v) for v in scene.part)
    uncovered = np.zeros(bgr.shape[:2], bool)
    uncovered[y1:y2, x1:x2] = True
    uncovered[y1:y2, int(box[0]) : int(box[2])] = False  # the moved copy covers these
    assert uncovered.sum() > 0.2 * (x2 - x1) * (y2 - y1)
    expected = np.zeros_like(bgr)
    expected[y1:y2, x1:x2] = _patch_fill(bgr, scene.part, side)
    assert np.array_equal(moved[uncovered], expected[uncovered])
    ghost = np.abs(moved[uncovered].astype(int) - bgr[uncovered].astype(int))
    assert ghost.mean() > 5  # the original part is gone from there


@pytest.mark.parametrize(("t", "side"), [(0.5, "left"), (1.5, "right")])
def test_slide_erases_the_original(t, side):
    # Sliding right (t = 0.5 s) opens the gap on the left; sliding left, on the right.
    _erased("jaw-slide", t, side)


def test_swing_erases_the_original():
    _erased("plate-swing", 1.5, "right")  # the hinge is the right edge, the gap opens on the left


# --- the segmenter, the refreshes it costs and the summary rows -------------------------------


class RefreshingTracker:
    """Stands in for StreamTracker with a refresher: asks for the target's mask on every frame
    and answers the target's box."""

    def __init__(self, vision, params=None, segmenter=None, refresher=None):
        self.refresher, self.target, self.returned = refresher, None, []
        self.drawn = {"follower": 3, "yoloe": 1}  # the stream's counters: found frames, by source

    def command(self, target) -> None:
        self.target = target

    def step(self, header, jpeg: bytes) -> dict:
        self.refresher.drain()
        reply: dict = {"found": False, "state": "lost"}
        if self.target is not None:
            rgb = cv2.cvtColor(cv2.imdecode(np.frombuffer(jpeg, np.uint8), 1), cv2.COLOR_BGR2RGB)
            box = np.array(self.target.box) * [OUT_W, OUT_H, OUT_W, OUT_H]
            self.refresher.submit("target", header.seq, rgb, box)
            reply = answer(box)
        self.returned.append(reply)
        return reply


def _two_seconds() -> Sequence:
    frames = render(CALIPER, 2.0, seed=7)
    return Sequence(CALIPER, frames, jitter.looks(frames, 7))


def test_run_with_fake_segmenter_reports_refreshes(monkeypatch):
    # `run` loads real YOLOE, so this plays one sequence with `play`, as `run` does.
    monkeypatch.setattr(jitter, "_finder_cache", {})
    seq, made, trackers = _two_seconds(), [], []

    def make_tracker(vision, params, **kwargs):
        made.append(kwargs)
        trackers.append(RefreshingTracker(vision, params, **kwargs))
        return trackers[-1]

    fake = jitter.load_jitter_segmenter("fake")
    assert fake.name == "fake-segmenter"
    played = jitter.play(seq, track, FakeVision(), FakeVision(), segmenter=fake,
                         make_tracker=make_tracker)  # fmt: skip
    r = measure(seq, played)
    assert r["refreshes"] >= 1
    assert played.drawn == {"follower": 3, "yoloe": 1} and r["followed"] == 0.75
    assert isinstance(made[0]["refresher"], Refresher)
    assert made[0]["segmenter"].name == "fake-segmenter"
    assert made[0]["refresher"].segmenter is made[0]["segmenter"]
    # The harness does not touch what the tracker answers.
    assert played.answers == trackers[0].returned and len(played.answers) == len(seq.frames)
    assert all(a is b for a, b in zip(played.answers, trackers[0].returned, strict=True))
    assert set(played.answers[-1]) == {"found", "box", "outline", "point", "contact", "state"}
    assert not [t for t in threading.enumerate() if t.name.startswith("segment")]  # shut down


class Recording:
    """A tracker that answers nothing and notes how it was built and what it was told."""

    def __init__(self, *args, **kwargs):
        self.args, self.kwargs, self.targets = args, kwargs, []

    def command(self, target) -> None:
        self.targets.append(target)

    def step(self, header, jpeg: bytes) -> dict:
        return {"found": False, "state": "lost"}


def test_without_a_segmenter_the_tracker_is_built_as_before(monkeypatch):
    monkeypatch.setattr(jitter, "_finder_cache", {})
    seq, built = _two_seconds(), []
    _, _, jev_box = seq.looks[0]
    yoloe_box = tuple(float(v) for v in jev_box + 3)  # what YOLOE says is the object
    vision = FakeVision()
    vision.scenes.extend([[Thing(yoloe_box, appearance(1))]] * 5)

    def make_tracker(*args, **kwargs):
        built.append(Recording(*args, **kwargs))
        return built[-1]

    played = jitter.play(seq, track, vision, vision, make_tracker=make_tracker)
    assert built[0].kwargs == {}  # no segmenter, no refresher
    assert played.refreshes == 0 and measure(seq, played)["refreshes"] == 0
    assert played.drawn is None and np.isnan(measure(seq, played)["followed"])  # no follower
    sent = built[0].targets[0]  # the look is outlined by YOLOE's box, as before
    assert sent.box == pytest.approx(np.array(yoloe_box) / [OUT_W, OUT_H, OUT_W, OUT_H], abs=1e-6)


class HalfSegmenter:
    """Cuts the left half of any box."""

    name = "half"

    def encode(self, rgb):
        return SegEncoding(rgb.shape[1], rgb.shape[0], None)

    def mask_in_box(self, enc, box):
        x1, y1, x2, y2 = (float(v) for v in box)
        rows, cols = int(y2 - y1), int((x2 - x1) / 2)
        return MaskCrop(np.full((rows, cols), 10.0, np.float32), (x1, y1), 1.0)


class EmptySegmenter(HalfSegmenter):
    name = "empty"

    def mask_in_box(self, enc, box):
        return None


class OutsideSegmenter(HalfSegmenter):
    """A mask with nothing inside it."""

    name = "outside"

    def mask_in_box(self, enc, box):
        return MaskCrop(np.full((8, 8), -10.0, np.float32), (0.0, 0.0), 1.0)


def test_the_look_is_outlined_by_the_segmenter_when_one_is_loaded(monkeypatch):
    monkeypatch.setattr(jitter, "_finder_cache", {})
    seq = _two_seconds()
    _, _, box = seq.looks[0]
    x1, y1, x2, y2 = (float(v) for v in box)
    sent = jitter._target(seq, 0, box, None, HalfSegmenter())  # YOLOE (None here) is not asked
    expected = np.array([x1, y1, (x1 + x2) / 2, y1 + int(y2 - y1)]) / ([OUT_W, OUT_H] * 2)
    assert sent == pytest.approx(expected, abs=1.5 / OUT_W)


@pytest.mark.parametrize("segmenter", [EmptySegmenter(), OutsideSegmenter()])
def test_a_segmenter_that_cuts_nothing_leaves_the_look_to_yoloe(monkeypatch, segmenter):
    # As /locate does: SAM has nothing in jev's box, so YOLOE outlines it.
    monkeypatch.setattr(jitter, "_finder_cache", {})
    seq = _two_seconds()
    _, _, jev_box = seq.looks[0]
    yoloe_box = tuple(float(v) for v in jev_box + 3)
    vision = FakeVision()
    vision.scenes.append([Thing(yoloe_box, appearance(1))])
    sent = jitter._target(seq, 0, jev_box, vision, segmenter)
    assert sent == pytest.approx(np.array(yoloe_box) / [OUT_W, OUT_H, OUT_W, OUT_H], abs=1e-6)
    assert sent != pytest.approx(jev_box / [OUT_W, OUT_H, OUT_W, OUT_H], abs=1e-6)


@pytest.mark.parametrize("segmenter", [EmptySegmenter(), OutsideSegmenter()])
def test_the_look_keeps_jevs_box_when_neither_segmenter_nor_yoloe_find_it(monkeypatch, segmenter):
    monkeypatch.setattr(jitter, "_finder_cache", {})
    seq = _two_seconds()
    _, _, jev_box = seq.looks[0]
    vision = FakeVision()
    vision.scenes.append([])  # YOLOE sees nothing
    sent = jitter._target(seq, 0, jev_box, vision, segmenter)
    assert sent == pytest.approx(jev_box / [OUT_W, OUT_H, OUT_W, OUT_H], abs=1e-6)


def test_the_counting_wrapper_counts_calls_and_forwards_the_rest():
    inner = HalfSegmenter()
    inner.device = "cpu"  # something a tracker might read off its segmenter
    counted = jitter._CountedSegmenter(inner)
    rgb = np.zeros((OUT_H, OUT_W, 3), np.uint8)
    box = np.array([10.0, 10.0, 50.0, 40.0])
    for _ in range(3):
        counted.mask_in_box(counted.encode(rgb), box)
    assert counted.calls == 3 and counted.name == "half" and counted.device == "cpu"
    assert not hasattr(counted, "nothing_like_this")  # no attribute is made up


def test_the_fake_segmenter_fills_the_box_and_none_is_no_segmenter():
    assert jitter.load_jitter_segmenter("none") is None
    fake = jitter.load_jitter_segmenter("fake")
    crop = fake.mask_in_box(fake.encode(np.zeros((OUT_H, OUT_W, 3), np.uint8)),
                            np.array([10.4, 20.0, 50.0, 60.0]))  # fmt: skip
    assert crop.scale == 1.0 and crop.origin == (10.4, 20.0)
    assert crop.logits.shape == (40, 40) and (crop.logits > 0).all()


def _truthful(scene: jitter.Scene, refreshes: int = 0) -> tuple[Sequence, dict]:
    frames = render(scene, 1.0, seed=7)
    seq = Sequence(scene, frames, jitter.looks(frames, 7))
    played = Played(first=0, refreshes=refreshes)
    for f in frames:
        played.answers.append(answer(f.truth) if f.truth is not None else
                              {"found": False, "state": "lost"})  # fmt: skip
        played.step_ms.append(20.0)
        played.encode_ms.append(18.0)
    return seq, measure(seq, played)


def test_moving_scenes_have_their_own_summary_row():
    scenes = [CALIPER, _scene("vernier"), _scene("jaw-slide"), _scene("plate-swing")]
    made = [_truthful(s, refreshes=3) for s in scenes]
    sequences, results = [m[0] for m in made], [m[1] for m in made]
    rows = jitter.summary_rows(sequences, {"now": results})
    assert [(label, r["scene"]) for label, r in rows] == [
        ("now", "all"), ("now", "parts"), ("now", "moving")
    ]  # fmt: skip
    by = {r["scene"]: r for _, r in rows}
    assert by["all"]["frames"] == results[0]["frames"]
    assert by["parts"]["frames"] == results[1]["frames"]  # not the moving ones: comparable
    assert by["moving"]["frames"] == results[2]["frames"] + results[3]["frames"]
    assert by["moving"]["refreshes"] == 6 and by["parts"]["refreshes"] == 3
    # Without moving scenes there is no moving row.
    assert [r["scene"] for _, r in jitter.summary_rows(sequences[:2], {"now": results[:2]})] == [
        "all", "parts"
    ]  # fmt: skip


def test_the_table_has_a_refreshes_and_a_followed_column():
    _, r = _truthful(CALIPER, refreshes=4)
    assert r["refreshes"] == 4 and np.isnan(r["followed"])
    head, row = jitter.table([("now", {**r, "followed": 0.5})]).splitlines()
    for name, value in (("refreshes", "4"), ("followed", "50.0%")):
        end = head.index(name) + len(name)  # the columns are right-aligned
        assert row[:end].split()[-1] == value
    rows = jitter.summary_rows(
        [_truthful(CALIPER)[0]] * 2, {"now": [{**r, "followed": 0.5}, {**r, "followed": 1.0}]}
    )
    assert rows[0][1]["followed"] == 0.75  # averaged over the sequences


@pytest.mark.parametrize("name", ["none", "sam2.1-small"])
def test_the_jitter_command_hands_its_segmenter_to_the_harness(monkeypatch, name):
    seen = []
    monkeypatch.setattr(jitter, "run", lambda *args, **kwargs: seen.append(kwargs) or 0)
    assert cli.main(["jitter", "--segmenter", name, "--scene", "jaw-slide"]) == 0
    assert seen[0]["segmenter"] == name


def test_pace_holds_each_frame_to_the_streams_frame_time(monkeypatch):
    # The headset's stream runs at 40 to 75 ms a frame, the harness at 20: the refresher paces by
    # wall clock, so a real segmenter would refresh half as often per frame. `pace` sleeps.
    monkeypatch.setattr(jitter, "_finder_cache", {})
    frames = render(CALIPER, 1.0, seed=7)
    seq = Sequence(CALIPER, frames, jitter.looks(frames, 7))
    assert len(frames) == 25

    def wall(pace: bool) -> tuple[float, Played]:
        vision = FakeVision()
        vision.scenes.extend([[]] * len(frames))
        t0 = perf_counter()
        played = jitter.play(seq, track, vision, vision, pace=pace)
        return perf_counter() - t0, played

    free, _ = wall(False)
    paced, played = wall(True)
    assert free < 0.5
    assert paced >= 0.9  # 25 frames at 25 a second
    assert len(played.answers) == 25
    assert np.median(played.step_ms) < 30  # the wait is not counted as the tracker's time


def test_a_frame_slower_than_the_stream_is_not_slowed_further(monkeypatch):
    sleeps: list[float] = []
    monkeypatch.setattr(jitter, "sleep", sleeps.append)
    clock = iter(x * 0.1 for x in range(1000))  # every perf_counter call is 100 ms later
    monkeypatch.setattr(jitter, "perf_counter", lambda: next(clock))
    frames = render(CALIPER, 0.2, seed=7)
    seq = Sequence(CALIPER, frames, jitter.looks(frames, 7))
    vision = FakeVision()
    vision.scenes.extend([[]] * len(frames))
    jitter.play(seq, track, vision, vision, pace=True)
    assert sleeps == []  # 100 ms in `step` already outlasts a 40 ms frame


def test_the_harness_loads_its_segmenter_on_the_device_asked_for(monkeypatch):
    seen = []
    monkeypatch.setattr(jitter, "run", lambda *args, **kwargs: seen.append(kwargs) or 0)
    assert cli.main(["jitter", "--device", "cpu", "--segmenter", "sam2.1-small"]) == 0
    assert seen[0]["device"] == "cpu"
    loads = []
    monkeypatch.setattr(jitter, "load_segmenter", lambda *args: loads.append(args))
    jitter.load_jitter_segmenter("sam2.1-large", "cpu")
    assert loads == [("sam2.1-large", "cpu")]


def test_the_jitter_command_runs_without_a_segmenter_unless_given_one_and_paces_one(monkeypatch):
    # CLIO_TRACKER_SEGMENTER is the service's; the harness compares runs, so it is told on the
    # command line, and a segmenter is paced unless --no-pace says otherwise.
    seen = []
    monkeypatch.setattr(jitter, "run", lambda *args, **kwargs: seen.append(kwargs) or 0)
    monkeypatch.setenv("CLIO_TRACKER_SEGMENTER", "sam2.1-small")
    for argv in (
        [],
        ["--segmenter", "none"],
        ["--pace"],
        ["--segmenter", "sam2.1-small"],
        ["--segmenter", "auto", "--no-pace"],
    ):
        assert cli.main(["jitter", *argv]) == 0
    assert [(k["segmenter"], k["pace"]) for k in seen] == [
        ("none", False),
        ("none", False),
        ("none", True),
        ("sam2.1-small", True),
        ("auto", False),
    ]
