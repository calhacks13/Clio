"""The tracking stream's rules (TRACK.md): messages, matching jev to the tracked mask, tracking a
moving object, losing it, and one model call at a time."""

from __future__ import annotations

import io
import json
import struct
import threading
import time

import numpy as np
import pytest
from PIL import Image, ImageDraw
from scipy import ndimage

from jev_finder.segmenter import SharedSegmenter
from jev_finder.tracker import (
    BadMessage,
    BoxChain,
    FrameHeader,
    TargetBox,
    Tracker,
    box_inside,
    box_iou,
    carry_box,
    pad_box,
    parse_command,
    parse_frame,
    shrink_mask,
)

W, H = 320, 240


def frame_message(header: dict | bytes, jpeg: bytes = b"\xff\xd8jpeg") -> bytes:
    raw = header if isinstance(header, bytes) else json.dumps(header).encode()
    return struct.pack(">I", len(raw)) + raw + jpeg


def jpeg(disc: tuple[float, float, float] | None = None, size=(W, H)) -> bytes:
    """A light frame with a dark disc (cx, cy, r in pixels), or none."""
    image = Image.new("RGB", size, (220, 220, 220))
    if disc:
        cx, cy, r = disc
        ImageDraw.Draw(image).ellipse([cx - r, cy - r, cx + r, cy + r], fill=(20, 20, 20))
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=95)
    return buffer.getvalue()


def header(seq: int) -> FrameHeader:
    return FrameHeader(seq=seq, t=1000.0 + seq, width=W, height=H)


class ShapeSegmenter:
    """SAM that sees: the mask is every dark piece that reaches into the prompt box, whole, as
    SAM segments an object the box only partly covers. Records prompts."""

    label = "shape-sam"

    def __init__(self):
        self.prompts: list[tuple[list[float], list[float] | None]] = []

    def segment(self, image, box, point=None):
        self.prompts.append((box, point))
        pieces, _ = ndimage.label(np.asarray(image.convert("L")) < 100)
        h, w = pieces.shape
        x0, y0, x1, y1 = box
        touched = np.unique(pieces[round(y0 * h) : round(y1 * h), round(x0 * w) : round(x1 * w)])
        return np.isin(pieces, touched[touched > 0]), 0.9


def chained(segmenter) -> Tracker:
    """A tracker following the target with a still-image segmenter, as SAM 2.1 Small does."""
    return Tracker(BoxChain(segmenter), segmenter.label)


def disc_box(cx: float, cy: float, r: float) -> list[float]:
    return [(cx - r) / W, (cy - r) / H, (cx + r) / W, (cy + r) / H]


# Messages


def test_parse_frame_splits_header_and_jpeg():
    head, data = parse_frame(
        frame_message({"type": "frame", "seq": 41, "t": 123.5, "width": 640, "height": 480})
    )
    assert head == FrameHeader(seq=41, t=123.5, width=640, height=480)
    assert data == b"\xff\xd8jpeg"


@pytest.mark.parametrize(
    "message",
    [
        b"\x00\x00",
        struct.pack(">I", 0) + b"{}jpeg",
        struct.pack(">I", 999) + b"{}jpeg",
        frame_message(b"not json"),
        frame_message({"type": "target", "seq": 1, "t": 0, "width": 1, "height": 1}),
        frame_message({"type": "frame", "seq": True, "t": 0, "width": 1, "height": 1}),
        frame_message({"type": "frame", "seq": 1, "t": "now", "width": 1, "height": 1}),
        frame_message({"type": "frame", "seq": 1, "t": 0, "width": 1}),
        frame_message({"type": "frame", "seq": 1, "t": 0, "width": 1, "height": 1}, b""),
    ],
)
def test_bad_frames_are_refused(message):
    with pytest.raises(BadMessage):
        parse_frame(message)


def test_parse_target_and_clear():
    text = '{"type": "target", "seq": 37, "box": [0.31, 0.42, 0.58, 0.77], "name": "caliper"}'
    assert parse_command(text) == TargetBox(37, [0.31, 0.42, 0.58, 0.77], "caliper")
    assert parse_command('{"type": "target", "seq": 1, "box": [0, 0, 1, 1]}').name is None
    assert parse_command('{"type": "clear"}') is None


@pytest.mark.parametrize(
    "text",
    [
        "nope",
        "[]",
        '{"type": "frame"}',
        '{"type": "target", "box": [0.1, 0.1, 0.2, 0.2]}',
        '{"type": "target", "seq": 1, "box": [0.1, 0.1, 0.2]}',
        '{"type": "target", "seq": 1, "box": [0.3, 0.1, 0.2, 0.2]}',
        '{"type": "target", "seq": 1, "box": [0.1, 0.1, 1.2, 0.2]}',
        '{"type": "target", "seq": 1, "box": [0.1, 0.1, 0.2, 0.2], "name": 3}',
    ],
)
def test_bad_commands_are_refused(text):
    with pytest.raises(BadMessage):
        parse_command(text)


# Geometry


def test_box_helpers():
    assert box_iou([0, 0, 0.5, 0.5], [0, 0, 0.5, 0.5]) == 1
    assert box_iou([0, 0, 0.5, 0.5], [0.25, 0, 0.75, 0.5]) == pytest.approx(1 / 3)
    assert box_iou([0, 0, 0.2, 0.2], [0.5, 0.5, 1, 1]) == 0
    assert box_inside([0.4, 0.4, 0.5, 0.5], [0, 0, 1, 1]) == 1
    assert box_inside([0.4, 0.4, 0.6, 0.6], [0, 0, 0.5, 1]) == pytest.approx(0.5)
    assert box_inside([0, 0, 0.2, 0.2], [0.5, 0.5, 1, 1]) == 0
    assert pad_box([0.2, 0.4, 0.6, 0.6]) == pytest.approx([0.16, 0.38, 0.64, 0.62])
    assert pad_box([0, 0.5, 0.5, 1]) == pytest.approx([0, 0.45, 0.55, 1])
    # jev's box from a second ago follows the tracked box: moved right by 0.1, twice as wide.
    carried = carry_box([0.2, 0.2, 0.4, 0.4], then=[0.2, 0.2, 0.4, 0.4], now=[0.2, 0.2, 0.6, 0.4])
    assert carried == pytest.approx([0.2, 0.2, 0.6, 0.4])
    carried = carry_box([0.25, 0.2, 0.45, 0.4], then=[0.2, 0.2, 0.4, 0.4], now=[0.3, 0.2, 0.5, 0.4])
    assert carried == pytest.approx([0.35, 0.2, 0.55, 0.4])


# Tracking


def test_no_target_answers_without_segmenting():
    segmenter = ShapeSegmenter()
    answer = chained(segmenter).step(header(1), b"not even decoded")
    assert answer == {
        "type": "mask",
        "seq": 1,
        "t": 1001.0,
        "found": False,
        "name": None,
        "outline": None,
        "box": None,
        "point": None,
        "contact": None,
        "score": None,
        "ms": answer["ms"],
        "model": "shape-sam",
    }
    assert segmenter.prompts == []


def test_tracks_a_moving_shape_from_jevs_box():
    segmenter = ShapeSegmenter()
    tracker = chained(segmenter)
    r = 30
    jev_box = disc_box(80, 120, r)
    tracker.command(TargetBox(0, jev_box, "puck"))

    for seq in range(12):
        cx = 80 + 12 * seq  # 12 px a frame to the right
        answer = tracker.step(header(seq), jpeg((cx, 120, r)))
        assert answer["found"] and answer["name"] == "puck"
        assert answer["seq"] == seq and answer["t"] == 1000.0 + seq
        assert answer["box"] == pytest.approx(disc_box(cx, 120, r), abs=0.02)
        assert answer["point"] == pytest.approx([cx / W, 0.5], abs=0.02)
        assert answer["contact"] == pytest.approx([cx / W, (120 + r) / H], abs=0.02)
        assert 3 <= len(answer["outline"]) <= 64
        assert answer["score"] == 0.9
        assert set(answer["ms"]) == {"decode", "segment", "outline", "total"}

    # The first frame is prompted with jev's box alone; each later one with the previous mask's
    # box padded by 10% and the previous mask's deepest point.
    assert segmenter.prompts[0] == (jev_box, None)
    box, point = segmenter.prompts[5]
    previous = disc_box(80 + 12 * 4, 120, r)
    assert box == pytest.approx(pad_box(previous), abs=0.02)
    assert point == pytest.approx([(80 + 12 * 4) / W, 0.5], abs=0.02)


def test_same_object_reseeds_from_jevs_box_moved_with_the_track():
    segmenter = ShapeSegmenter()
    tracker = chained(segmenter)
    r = 30
    tracker.command(TargetBox(0, disc_box(80, 120, r), "puck"))
    for seq in range(6):
        tracker.step(header(seq), jpeg((80 + 10 * seq, 120, r)))

    # jev measured frame 2 (disc at x=100) and drew its box 4 px further right than the mask.
    jev_box = disc_box(104, 120, r)
    tracker.command(TargetBox(2, jev_box, "hockey puck"))
    seed = tracker.seed
    assert seed == pytest.approx(disc_box(134, 120, r), abs=0.02)  # disc now at x=130
    assert len(tracker.history) == 6  # still the same object
    answer = tracker.step(header(6), jpeg((140, 120, r)))
    assert answer["found"] and answer["name"] == "hockey puck"
    assert segmenter.prompts[-1] == (seed, None)
    assert tracker.seed is None  # back to tracking from the mask


def test_different_object_switches_to_jevs_box():
    segmenter = ShapeSegmenter()
    tracker = chained(segmenter)
    tracker.command(TargetBox(0, disc_box(80, 120, 30), "puck"))
    for seq in range(3):
        tracker.step(header(seq), jpeg((80, 120, 30)))

    other = disc_box(250, 60, 20)
    assert box_iou(other, tracker.history[-1][1]) < 0.3
    tracker.command(TargetBox(1, other, "cap"))
    assert tracker.seed == other and not tracker.history
    answer = tracker.step(header(3), jpeg((250, 60, 20)))
    assert answer["found"] and answer["name"] == "cap"
    assert answer["box"] == pytest.approx(other, abs=0.02)
    assert segmenter.prompts[-1] == (other, None)


def test_target_is_matched_on_the_nearest_frame():
    tracker = chained(ShapeSegmenter())
    tracker.command(TargetBox(0, disc_box(60, 120, 25), "puck"))
    for seq in range(0, 40, 2):  # every other frame was answered, the disc moves 6 px a frame
        tracker.step(header(seq), jpeg((60 + 6 * seq, 120, 25)))
    seen_at_21 = disc_box(60 + 6 * 20, 120, 25)  # frame 21 was dropped; 20 is nearest
    assert box_iou(seen_at_21, disc_box(60 + 6 * 38, 120, 25)) < 0.3  # far from where it is now
    tracker.command(TargetBox(21, seen_at_21, "puck"))
    assert len(tracker.history) == 20  # matched: same object


def test_lost_object_is_reported_and_waits_for_the_next_target():
    segmenter = ShapeSegmenter()
    tracker = chained(segmenter)
    tracker.command(TargetBox(0, disc_box(100, 120, 30), "puck"))
    assert tracker.step(header(0), jpeg((100, 120, 30)))["found"]

    gone = tracker.step(header(1), jpeg(None))
    assert gone["found"] is False and gone["name"] is None and gone["outline"] is None
    calls = len(segmenter.prompts)
    assert tracker.step(header(2), jpeg((100, 120, 30)))["found"] is False
    assert len(segmenter.prompts) == calls  # nothing to track until jev answers again

    tracker.command(TargetBox(2, disc_box(100, 120, 30), "puck"))
    assert tracker.step(header(3), jpeg((100, 120, 30)))["found"]


@pytest.mark.parametrize(
    ("mask_box", "problem"),
    [
        ([0.30, 0.30, 0.34, 0.34], "collapse"),  # a sliver of the previous area
        ([0.05, 0.05, 0.95, 0.95], "blow-up"),  # leaked into the table
        ([0.48, 0.20, 0.68, 0.40], "jump"),  # same size, somewhere else in the padded box
    ],
)
def test_implausible_masks_lose_the_object(mask_box, problem):
    class Scripted:
        label = "scripted"
        boxes = [[0.2, 0.2, 0.4, 0.4], mask_box]

        def segment(self, image, box, point=None):
            mask = np.zeros((H, W), dtype=bool)
            x0, y0, x1, y1 = self.boxes.pop(0)
            mask[round(y0 * H) : round(y1 * H), round(x0 * W) : round(x1 * W)] = True
            return mask, 0.9

    tracker = chained(Scripted())
    tracker.command(TargetBox(0, [0.2, 0.2, 0.4, 0.4], "cap"))
    assert tracker.step(header(0), jpeg())["found"]
    assert tracker.step(header(1), jpeg())["found"] is False, problem
    assert tracker.tracked is None and tracker.name is None


def test_a_small_part_of_jevs_box_is_found():
    class Small:
        label = "small"

        def segment(self, image, box, point=None):
            mask = np.zeros((H, W), dtype=bool)
            mask[100:110, 150:160] = True  # a hundredth of the box below
            return mask, 0.8

    tracker = chained(Small())
    tracker.command(TargetBox(0, [0.1, 0.1, 0.9, 0.9], "cap"))
    assert tracker.step(header(0), jpeg())["found"]


def test_seed_mask_must_lie_in_jevs_box():
    class Elsewhere:
        label = "elsewhere"

        def segment(self, image, box, point=None):
            mask = np.zeros((H, W), dtype=bool)
            mask[200:230, 280:310] = True
            return mask, 0.8

    tracker = chained(Elsewhere())
    tracker.command(TargetBox(0, [0.1, 0.1, 0.3, 0.3], "cap"))
    assert tracker.step(header(0), jpeg())["found"] is False


def test_clear_drops_the_target():
    segmenter = ShapeSegmenter()
    tracker = chained(segmenter)
    tracker.command(TargetBox(0, disc_box(100, 120, 30), "puck"))
    tracker.step(header(0), jpeg((100, 120, 30)))
    tracker.command(None)
    calls = len(segmenter.prompts)
    answer = tracker.step(header(1), jpeg((100, 120, 30)))
    assert answer["found"] is False and answer["name"] is None
    assert len(segmenter.prompts) == calls


def test_unreadable_jpeg_is_not_found_but_keeps_tracking():
    tracker = chained(ShapeSegmenter())
    tracker.command(TargetBox(0, disc_box(100, 120, 30), "puck"))
    assert tracker.step(header(0), b"\x89PNG not a jpeg")["found"] is False
    assert tracker.step(header(1), jpeg((100, 120, 30)))["found"]


def test_large_frames_are_shrunk_to_sam_size():
    sizes = []

    class Sizes(ShapeSegmenter):
        def segment(self, image, box, point=None):
            sizes.append(image.size)
            return super().segment(image, box, point)

    tracker = chained(Sizes())
    tracker.command(TargetBox(0, [0.3, 0.3, 0.7, 0.7], "puck"))
    answer = tracker.step(header(0), jpeg((1000, 750, 300), size=(2000, 1500)))
    assert max(sizes[0]) <= 1024
    assert answer["box"] == pytest.approx([0.35, 0.3, 0.65, 0.7], abs=0.02)


# One model call at a time


def test_shared_segmenter_runs_one_call_at_a_time():
    class Counting:
        label = "counting"
        device = "cpu"

        def __init__(self):
            self.running = 0
            self.most = 0
            self.guard = threading.Lock()

        def _call(self):
            with self.guard:
                self.running += 1
                self.most = max(self.most, self.running)
            time.sleep(0.005)
            with self.guard:
                self.running -= 1

        def encode(self, image):
            self._call()
            return image.size

        def masks(self, encoded, boxes):
            self._call()
            return []

        def segment(self, image, box, point=None):
            self._call()
            return np.zeros((2, 2), dtype=bool), 0.0

        def track_session(self):
            return BoxChain(self)

    model = Counting()
    shared = SharedSegmenter(model)
    image = Image.new("RGB", (4, 4))
    session = shared.track_session()
    calls = [
        lambda: shared.encode(image),
        lambda: shared.masks(None, [[0, 0, 1, 1]]),
        lambda: shared.segment(image, [0, 0, 1, 1]),
        lambda: session.follow(image, [0, 0, 1, 1], [0.5, 0.5]),
    ]
    threads = [threading.Thread(target=lambda c=c: [c() for _ in range(10)]) for c in calls * 2]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(5)
    assert model.most == 1
    assert shared.label == "counting" and shared.device == "cpu"


def test_session_starts_corrects_and_follows():
    class Recording:
        def __init__(self):
            self.calls = []

        def _mask(self, box):
            mask = np.zeros((H, W), dtype=bool)
            x0, y0, x1, y1 = box
            mask[round(y0 * H) : round(y1 * H), round(x0 * W) : round(x1 * W)] = True
            return mask, 0.8

        def start(self, image, box):
            self.calls.append("start")
            return self._mask(box)

        def correct(self, image, box):
            self.calls.append("correct")
            return self._mask(box)

        def follow(self, image, box, point):
            self.calls.append("follow")
            return self._mask(box)

        def reset(self):
            self.calls.append("reset")

    session = Recording()
    tracker = Tracker(session, "recording")
    tracker.command(TargetBox(0, [0.2, 0.2, 0.4, 0.4], "cap"))
    tracker.step(header(0), jpeg())
    tracker.step(header(1), jpeg())
    tracker.command(TargetBox(1, [0.21, 0.2, 0.41, 0.4], "cap"))  # same object
    tracker.step(header(2), jpeg())
    tracker.command(TargetBox(2, [0.6, 0.6, 0.8, 0.8], "mug"))  # another one
    tracker.step(header(3), jpeg())
    tracker.command(None)
    assert session.calls == ["start", "follow", "correct", "start", "reset"]


def test_a_failed_correction_starts_over_from_jevs_box():
    class Drifted:
        """Follows fine, but the correction lands nowhere, as when the track drifted."""

        def __init__(self):
            self.calls = []

        def _mask(self, box):
            mask = np.zeros((H, W), dtype=bool)
            x0, y0, x1, y1 = box
            mask[round(y0 * H) : round(y1 * H), round(x0 * W) : round(x1 * W)] = True
            return mask, 0.8

        def start(self, image, box):
            self.calls.append("start")
            return self._mask(box)

        def correct(self, image, box):
            self.calls.append("correct")
            return np.zeros((H, W), dtype=bool), 0.1

        def follow(self, image, box, point):
            self.calls.append("follow")
            return self._mask(box)

        def reset(self):
            self.calls.append("reset")

    session = Drifted()
    tracker = Tracker(session, "drifted")
    tracker.command(TargetBox(0, [0.2, 0.2, 0.4, 0.4], "cap"))
    tracker.step(header(0), jpeg())
    tracker.command(TargetBox(0, [0.22, 0.2, 0.42, 0.4], "cap"))
    answer = tracker.step(header(1), jpeg())
    assert answer["found"] and answer["box"] == pytest.approx([0.22, 0.2, 0.42, 0.4], abs=0.01)
    assert session.calls == ["start", "correct", "start"]


def test_masks_are_traced_at_about_320_px():
    mask = np.zeros((480, 640), dtype=bool)
    mask[120:360, 160:480] = True
    small = shrink_mask(mask)
    assert small.shape == (240, 320)
    assert small[60:180, 80:240].all() and small.sum() == 120 * 160
    assert shrink_mask(mask[:, :500]).shape == (480, 500)  # under twice the width: unchanged
