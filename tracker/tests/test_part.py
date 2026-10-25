"""Following one part of an object (TRACK.md, `"part": true`): the part is never snapped to the
whole object's track; it is a box carried by the whole object's motion (or the camera's)."""

from __future__ import annotations

import json
import logging
import struct

import numpy as np
import pytest

from clio_tracker.follow import RegionFollower
from clio_tracker.geometry import iou
from clio_tracker.part import PartTracker, is_part, rounded_crop
from clio_tracker.track import BadMessage, StreamTracker, parse_command, parse_frame
from clio_tracker.tracking import Sighting, TrackerParams
from clio_tracker.vision import MaskCrop
from conftest import H, Thing, W, appearance, blend, scene_jpeg
from test_tracking import GRAY, FakeFollower, followed, pan, same

A = appearance(1)
B = blend(A, appearance(2), 0.85)  # a look-alike
WHOLE = (200.0, 200.0, 600.0, 520.0)  # the object YOLOE proposes
PART = (240.0, 230.0, 420.0, 380.0)  # one part of it: 21% of its box, IoU 0.21
BIG_PART = (220.0, 220.0, 470.0, 470.0)  # 49% of it, IoU 0.49: _place would take the whole
OTHER = (700.0, 300.0, 820.0, 460.0)


def frame(seq: int, scene: int) -> bytes:
    header = json.dumps(
        {"type": "frame", "seq": seq, "t": 1000.0 + 66 * seq, "width": W, "height": H}
    ).encode()
    return struct.pack(">I", len(header)) + header + scene_jpeg(scene)


def target(seq: int, box, name: str = "scroll wheel of mouse", part: bool | None = None) -> str:
    x0, y0, x1, y1 = box
    message = {"type": "target", "seq": seq, "box": [x0 / W, y0 / H, x1 / W, y1 / H], "name": name}
    if part is not None:
        message["part"] = part
    return json.dumps(message)


def shifted(box, dx: float, dy: float = 0.0) -> tuple[float, ...]:
    return (box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy)


class Stream:
    """A StreamTracker on FakeVision's world: scene k is a frame of gray 10 k."""

    def __init__(self, vision):
        self.vision = vision
        self.tracker = StreamTracker(vision)
        self.seq = -1
        self.scenes = 0

    def show(self, *things: Thing) -> dict:
        # Scene k is gray 10 k, so there are 25: a target must refer to one of the last 25 frames.
        self.scenes = self.scenes % 25 + 1
        self.vision.world[self.scenes] = list(things)
        self.seq += 1
        return self.tracker.step(*parse_frame(frame(self.seq, self.scenes)))

    def send(self, text: str) -> None:
        self.tracker.command(parse_command(text))


def box_of(answer: dict) -> np.ndarray:
    return np.asarray(answer["box"]) * [W, H, W, H]


# --- the confusion, reproduced -----------------------------------------------------------------


@pytest.mark.parametrize("part", [True, None])
@pytest.mark.parametrize("box", [PART, BIG_PART])
def test_a_part_box_is_not_snapped_to_the_whole_object(vision, part, box):
    """YOLOE proposes only the whole object. Before: jev's box around a part of it placed the
    whole object's track as the target (place_iou), or confirmed it (match_inside), and the whole
    object's mask was returned. Now the part is followed, flagged or not."""
    s = Stream(vision)
    for _ in range(3):
        s.show(Thing(WHOLE, A), Thing(OTHER, B))
    s.send(target(s.seq, box, part=part))
    answers = [s.show(Thing(WHOLE, A), Thing(OTHER, B)) for _ in range(5)]
    assert all(a["found"] for a in answers)
    assert iou(box_of(answers[-1]), box)[0, 0] > 0.85
    assert iou(box_of(answers[-1]), WHOLE)[0, 0] < 0.6
    # A second answer about the same part, now that the whole object is a track: the same.
    s.send(target(s.seq, box, part=part))
    later = [s.show(Thing(WHOLE, A), Thing(OTHER, B)) for _ in range(3)]
    assert iou(box_of(later[-1]), box)[0, 0] > 0.85


def test_a_part_of_the_followed_object_is_not_confirmed_as_the_whole(vision, caplog):
    """The stream already follows the whole object; jev then boxes a part of it under the same
    name. Before: match_inside confirmed the whole object's track."""
    s = Stream(vision)
    name = "silver metal caliper"
    s.show(Thing(WHOLE, A))
    s.send(target(0, WHOLE, name))
    for _ in range(3):
        a = s.show(Thing(WHOLE, A))
    assert iou(box_of(a), WHOLE)[0, 0] > 0.9
    with caplog.at_level(logging.INFO, logger="clio_tracker"):
        s.send(target(s.seq, PART, name))
    assert "confirmed" not in caplog.text and "part" in caplog.text
    a = [s.show(Thing(WHOLE, A)) for _ in range(3)][-1]
    assert iou(box_of(a), PART)[0, 0] > 0.85


# --- the message -------------------------------------------------------------------------------


def test_the_part_flag_parses_and_is_optional():
    assert parse_command(target(3, PART, part=True)).part is True
    assert parse_command(target(3, PART, part=False)).part is False
    assert parse_command(target(3, PART)).part is False  # pages that never send it
    with pytest.raises(BadMessage):
        parse_command(target(3, PART).replace('"type"', '"part": "yes", "type"'))


# --- telling a part from the whole ---------------------------------------------------------------


def test_is_part_needs_a_small_box_mostly_inside():
    p = TrackerParams()
    whole = np.array(WHOLE, np.float32)
    assert is_part(np.array(PART, np.float32), whole, p)
    assert not is_part(np.array((205.0, 205.0, 595.0, 515.0), np.float32), whole, p)  # jev's noise
    assert not is_part(np.array((150.0, 150.0, 300.0, 300.0), np.float32), whole, p)  # half out
    assert not is_part(np.array(OTHER, np.float32), whole, p)


def test_the_whole_object_is_followed_as_before(vision):
    s = Stream(vision)
    s.show(Thing(WHOLE, A), Thing(OTHER, B))
    s.send(target(0, (205.0, 210.0, 590.0, 515.0), "silver metal caliper"))
    a = [s.show(Thing(WHOLE, A), Thing(OTHER, B)) for _ in range(3)][-1]
    assert s.tracker.part is None and iou(box_of(a), WHOLE)[0, 0] > 0.9


def test_after_a_part_the_whole_object_again_continues_on_its_track(vision):
    """A part found by itself (no flag), then jev boxes the whole object: the object that held
    the part is the target, as the same track."""
    s = Stream(vision)
    name = "silver metal caliper"
    s.show(Thing(WHOLE, A))
    s.send(target(0, PART, name))
    for _ in range(3):
        s.show(Thing(WHOLE, A))
    assert s.tracker.part is not None and s.tracker.part.parent is not None
    parent = s.tracker.part.parent
    tid = parent.target_id
    s.send(target(s.seq, WHOLE, name))
    assert s.tracker.part is None and s.tracker.object is parent and parent.target_id == tid
    a = s.show(Thing(WHOLE, A))
    assert a["found"] and iou(box_of(a), WHOLE)[0, 0] > 0.9


# --- motion --------------------------------------------------------------------------------------


def test_the_part_moves_and_scales_with_its_parent(vision):
    """The object moves by itself (the camera does not): the part box goes with it, and grows
    with it when it comes closer."""
    s = Stream(vision)
    s.show(Thing(WHOLE, A))
    s.send(target(0, PART, part=True))
    for i in range(1, 11):
        a = s.show(Thing(shifted(WHOLE, 8 * i), A))
    assert iou(box_of(a), shifted(PART, 80))[0, 0] > 0.85
    # 1.5 times the size about the object's top left corner (all still in the frame).
    x0, y0, w, h = WHOLE[0] + 80, WHOLE[1], WHOLE[2] - WHOLE[0], WHOLE[3] - WHOLE[1]
    part = (x0 + 1.5 * (PART[0] - WHOLE[0]), y0 + 1.5 * (PART[1] - WHOLE[1]),
            x0 + 1.5 * (PART[2] - WHOLE[0]), y0 + 1.5 * (PART[3] - WHOLE[1]))  # fmt: skip
    for k in range(1, 11):
        a = s.show(Thing((x0, y0, x0 + (1 + k / 20) * w, y0 + (1 + k / 20) * h), A))
    a = [s.show(Thing((x0, y0, x0 + 1.5 * w, y0 + 1.5 * h), A)) for _ in range(10)][-1]
    assert iou(box_of(a), part)[0, 0] > 0.85
    assert a["state"] == "tracking"


def test_a_new_answer_reseeds_the_part_box(vision):
    s = Stream(vision)
    s.show(Thing(WHOLE, A))
    s.send(target(0, PART, part=True))
    for _ in range(3):
        s.show(Thing(WHOLE, A))
    other_part = (430.0, 400.0, 580.0, 500.0)  # another place on the same object
    s.send(target(s.seq, other_part, part=True))
    a = [s.show(Thing(WHOLE, A)) for _ in range(8)][-1]
    assert iou(box_of(a), other_part)[0, 0] > 0.85


class PanningStream(Stream):
    """Frames whose camera motion is told to the tracker, as motion.py would measure it."""

    def __init__(self, vision, monkeypatch):
        super().__init__(vision)
        self.pan: list[np.ndarray | None] = []
        monkeypatch.setattr(self.tracker.camera, "update", self._update)

    def _update(self, rgb, seq=None):
        m = self.pan.pop(0) if self.pan else None
        self.tracker.camera._log.append((seq, m))
        return m

    def show_panned(self, dx: float, *things: Thing) -> dict:
        self.pan.append(np.array([[1.0, 0, dx], [0, 1.0, 0]]))
        return self.show(*things)


def test_with_nothing_holding_it_the_camera_carries_the_part(vision, monkeypatch):
    """YOLOE proposes nothing around the part (a strip of text on a plain surface): the part box
    is carried by the camera's motion and drawn as a rounded rectangle."""
    s = PanningStream(vision, monkeypatch)
    s.show(Thing(OTHER, B))
    s.send(target(0, PART, part=True))
    assert s.tracker.part is not None and s.tracker.part.parent is None
    for _ in range(10):
        a = s.show_panned(-12, Thing(OTHER, B))
    assert a["found"] and a["state"] == "coasting"
    assert iou(box_of(a), shifted(PART, -120))[0, 0] > 0.85
    outline = np.asarray(a["outline"]) * [W, H]
    x0, y0, x1, y1 = shifted(PART, -120)
    assert outline[:, 0].min() >= x0 - 3 and outline[:, 0].max() <= x1 + 3
    assert outline[:, 1].min() >= y0 - 3 and outline[:, 1].max() <= y1 + 3
    corner = np.hypot(outline[:, 0] - x0, outline[:, 1] - y0).min()
    assert corner > 8  # a rounded corner, not the box's


def test_a_parent_cut_by_the_frame_edge_still_carries_the_part(vision, monkeypatch):
    """The object slides out by the left edge with the camera: its box is cut there, so its
    right side carries the part; the part is not squeezed along with the cut box."""
    s = PanningStream(vision, monkeypatch)
    whole = (100.0, 200.0, 500.0, 520.0)
    part = (330.0, 260.0, 470.0, 400.0)
    s.show(Thing(whole, A))
    s.send(target(0, part, part=True))
    s.show(Thing(whole, A))
    for i in range(1, 9):
        dx = -20 * i
        a = s.show_panned(-20, Thing((max(0.0, whole[0] + dx), 200.0, whole[2] + dx, 520.0), A))
    assert iou(box_of(a), shifted(part, -160))[0, 0] > 0.85


# --- the outline ---------------------------------------------------------------------------------


def test_the_outline_is_the_parents_mask_inside_the_part_box(vision, monkeypatch):
    """The parent's mask is a disc (a wheel, a bottle seen from above) and the part box takes in
    its right edge: the outline follows the disc's edge there and the part box's elsewhere, and
    point and contact are inside the part."""
    cx, cy, r = 400.0, 360.0, 150.0
    disc_box = (cx - r, cy - r, cx + r, cy + r)
    part = (450.0, 260.0, 548.0, 460.0)  # its right corners are outside the disc

    def mask(enc, anchor, box):
        x1, y1, x2, y2 = (float(v) for v in box)
        xs = x1 + (np.arange(int((x2 - x1) / 2)) + 0.5) * 2
        ys = y1 + (np.arange(int((y2 - y1) / 2)) + 0.5) * 2
        d = np.hypot(xs[None, :] - cx, ys[:, None] - cy) - r
        return MaskCrop(np.clip(-d, -20, 20).astype(np.float32), (x1, y1), 2.0)

    monkeypatch.setattr(vision, "mask", mask)
    s = Stream(vision)
    s.show(Thing(disc_box, A))
    s.send(target(0, part, part=True))
    a = [s.show(Thing(disc_box, A)) for _ in range(6)][-1]
    assert a["found"] and a["state"] == "tracking"
    outline = np.asarray(a["outline"]) * [W, H]
    assert np.hypot(outline[:, 0] - cx, outline[:, 1] - cy).max() < r + 4  # inside the disc
    assert outline[:, 0].min() >= part[0] - 3 and outline[:, 0].max() <= part[2] + 3
    assert outline[:, 1].min() >= part[1] - 3 and outline[:, 1].max() <= part[3] + 3
    for corner in ((part[2], part[1]), (part[2], part[3])):  # cut off by the disc's edge
        assert np.hypot(outline[:, 0] - corner[0], outline[:, 1] - corner[1]).min() > 15
    assert np.hypot(outline[:, 0] - part[0], outline[:, 1] - part[1]).min() < 4  # the box's
    for key in ("point", "contact"):
        x, y = np.asarray(a[key]) * [W, H]
        assert part[0] - 3 <= x <= part[2] + 3 and part[1] - 3 <= y <= part[3] + 3


def test_rounded_crop_is_inside_the_box_with_round_corners():
    box = np.array([100.0, 50.0, 300.0, 150.0], np.float32)
    crop = rounded_crop(box)
    inside = crop.logits > 0
    assert inside[inside.shape[0] // 2].all() and inside[:, inside.shape[1] // 2].all()
    assert not inside[0, 0] and not inside[-1, -1]


def test_a_box_cut_by_the_frame_edge_is_not_taken_for_a_part(vision, monkeypatch):
    """The object is half out of view on jev's frame, so jev's box is a sliver at the edge; by
    the time it arrives the object is back in view. It is the whole object, not a part."""
    s = PanningStream(vision, monkeypatch)
    name = "round speaker"
    s.show(Thing(WHOLE, A))
    s.send(target(0, WHOLE, name))
    for _ in range(3):
        s.show(Thing(WHOLE, A))
    out = (0.0, 200.0, 150.0, 520.0)  # the speaker cut by the left edge
    s.show_panned(-450, Thing(out, A))
    edge_seq = s.seq
    s.show_panned(450, Thing(WHOLE, A))
    s.send(target(edge_seq, out, name))
    assert s.tracker.part is None


# --- the follower's mask (follow.py): the part on its own pixels ------------------------------

FPS = 15
DOOR = (450.0, 250.0, 590.0, 470.0)  # a part on the whole's right side: a door, a sliding jaw


class PartRun:
    """Feeds scenes straight to one PartTracker at FPS, as the stream does. `old` calls it as
    before there was a follower: no gray frame, no mask with jev's answer."""

    def __init__(self, vision, follower=None, old: bool = False):
        self.vision = vision
        self.old = old
        self.tracker = (
            PartTracker("target", "door of fridge")
            if old
            else PartTracker("target", "door of fridge", follower=follower)
        )
        self.seq = 0
        self.t = 0.0
        self.encodings: dict[int, object] = {}

    def frame(self, *things: Thing, camera=None) -> Sighting:
        self.seq += 1
        self.t += 1 / FPS
        enc = self.vision.encode(scene=list(things))
        self.encodings[self.seq] = enc
        if self.old:
            return self.tracker.step(enc, self.seq, self.t, self.vision, camera)
        return self.tracker.step(enc, self.seq, self.t, self.vision, camera, gray=GRAY)

    def jev(self, seq: int, box, present: bool = True, carry=None, mask=None) -> str:
        enc = self.encodings[seq]
        b = None if box is None else np.asarray(box, dtype=np.float32)
        if self.old:
            return self.tracker.identified(seq, self.t, present, b, enc, self.vision, carry)
        return self.tracker.identified(seq, self.t, present, b, enc, self.vision, carry, mask=mask)


SCENE = (Thing(WHOLE, A), Thing(OTHER, B))


def test_part_uses_follower_mask_when_confident(vision):
    """A confident follower's box is the part box and its mask the outline; the confidence,
    state and track are the parent's, as they are without a follower."""
    base = PartRun(vision, old=True)
    follower = FakeFollower()
    run = PartRun(vision, follower)
    base.frame(*SCENE)
    run.frame(*SCENE)
    assert run.jev(1, DOOR, mask=followed(DOOR).crop) == base.jev(1, DOOR)
    answer = followed((455, 262, 584, 461))  # the segmenter's tighter cut, inside jev's box
    follower.answers.append(answer)
    before, s = base.frame(*SCENE), run.frame(*SCENE)
    assert s.found and s.state == "tracking"
    assert (s.confidence, s.state, s.track_id) == (before.confidence, before.state, before.track_id)
    assert s.track_id is not None and s.track_id == run.tracker.parent.target_id
    assert s.crop is answer.crop
    np.testing.assert_array_equal(s.measured, answer.box)
    np.testing.assert_allclose(s.box, answer.box)  # the first sighting: nothing to smooth from
    np.testing.assert_array_equal(run.tracker.box, answer.box)
    assert s.shape is not None and s.shape.outline is not None
    assert not run.tracker.wants_refresh


def test_part_with_no_parent_shows_the_follower_mask_and_coasts(vision):
    """Nothing holds the part (a strip of text on a plain surface): a confident follower still
    gives its box and mask, with the part's own coasting confidence, as without one."""
    base = PartRun(vision, old=True)
    follower = FakeFollower()
    run = PartRun(vision, follower)
    base.frame(Thing(OTHER, B))
    run.frame(Thing(OTHER, B))
    base.jev(1, PART)
    run.jev(1, PART, mask=followed(PART).crop)
    assert run.tracker.parent is None
    for k in range(3):
        answer = followed(shifted(PART, 5 * k))
        follower.answers.append(answer)
        before, s = base.frame(Thing(OTHER, B)), run.frame(Thing(OTHER, B))
        assert s.found and s.state == "coasting" and s.track_id is None
        assert s.confidence == before.confidence
        assert s.crop is answer.crop
        np.testing.assert_array_equal(s.measured, answer.box)


def locked_part(vision, follower) -> PartRun:
    """The door of WHOLE followed, the follower holding the segmenter's cut of jev's box."""
    run = PartRun(vision, follower)
    run.frame(*SCENE)
    run.jev(1, DOOR, mask=followed(DOOR).crop)
    for _ in range(3):
        s = run.frame(*SCENE)
    assert s.found and s.state == "tracking" and run.tracker.parent is not None
    return run


def test_part_follows_its_own_motion_out_of_parent_box(vision):
    """The door swings out of the fridge's box while the fridge stays put. A confident follower
    keeps the part on its own pixels, 200 px past the parent's box, and the parent does not pull
    it back; once the follower is unsure, the part rides on from where it last was."""
    follower = FakeFollower()
    run = locked_part(vision, follower)
    for i in range(1, 21):
        answer = followed(shifted(DOOR, 18 * i))
        follower.answers.append(answer)
        s = run.frame(*SCENE)
        assert s.found and s.state == "tracking" and s.crop is answer.crop
        np.testing.assert_array_equal(s.measured, answer.box)
    out = shifted(DOOR, 360)  # its left side 210 px right of the parent's right side
    assert out[0] - WHOLE[2] > 200
    for _ in range(8):
        follower.answers.append(followed(out))
        s = run.frame(*SCENE)
    assert s.found and s.state == "tracking"
    np.testing.assert_array_equal(s.measured, out)
    np.testing.assert_allclose(s.box, out, atol=1)
    np.testing.assert_array_equal(run.tracker.box, out)
    parent = run.tracker.parent
    assert iou(parent.box_on(run.seq), WHOLE)[0, 0] > 0.95  # the parent still followed
    follower.answers.append(followed(out, confident=False))
    s = run.frame(*SCENE)
    assert s.found and s.state == "tracking"
    np.testing.assert_allclose(s.measured, out, atol=1e-3)  # not snapped back to the parent


def test_part_falls_back_to_ride_when_follower_doubts(vision):
    """An unsure follower changes nothing shown: the part rides on its parent and is outlined
    as without one; after two frames of doubt it asks to be cut out again, around the
    follower's box. A confident frame ends the doubt; a refresh that found nothing is a frame
    of it."""
    base = PartRun(vision, old=True)
    follower = FakeFollower()
    run = PartRun(vision, follower)

    def scene(i: int) -> tuple[Thing, ...]:
        return (Thing(shifted(WHOLE, 8 * i), A), Thing(OTHER, B))

    base.frame(*scene(0))
    run.frame(*scene(0))
    base.jev(1, DOOR)
    run.jev(1, DOOR, mask=followed(DOOR).crop)
    for i in range(1, 6):
        unsure = followed(shifted(DOOR, -30), confident=False)  # left behind on the background
        follower.answers.append(unsure)
        s = run.frame(*scene(i))
        same(base.frame(*scene(i)), s)
        assert run.tracker.wants_refresh == (i >= 2)
    assert s.measured[0] > DOOR[0] + 20  # today's ride: it moved with the parent
    np.testing.assert_array_equal(run.tracker.refresh_box, unsure.box)
    refresh = followed(s.measured).crop
    run.tracker.refreshed(run.seq, refresh)
    seq, given = follower.references[-1]
    assert seq == run.seq and given is refresh
    sure = followed(shifted(s.measured, 8))
    follower.answers.append(sure)
    s = run.frame(*scene(6))
    assert s.crop is sure.crop and not run.tracker.wants_refresh  # confident again: no doubt
    np.testing.assert_array_equal(run.tracker.refresh_box, sure.box)
    run.tracker.refreshed(run.seq, None)  # the segmenter found nothing: one frame of doubt...
    assert not run.tracker.wants_refresh
    follower.answers.append(followed(sure.box, confident=False))
    run.frame(*scene(7))
    assert run.tracker.wants_refresh  # ...and the next frame's makes two


def test_part_identified_with_mask_sets_reference(vision):
    follower = FakeFollower()
    run = PartRun(vision, follower)
    for _ in range(3):
        run.frame(*SCENE)
    assert not run.tracker.wants_refresh  # no part yet: nothing to cut out
    crop = followed(DOOR).crop
    run.jev(2, DOOR, mask=crop)
    assert len(follower.references) == 1
    seq, given = follower.references[0]
    assert seq == 2 and given is crop
    run.frame(*SCENE)
    assert follower.steps == [1, 2, 3, 4]  # every frame, also before there was a part or a mask
    run.jev(3, shifted(DOOR, 12, -6))  # jev's box again, a little off: the same part
    assert len(follower.references) == 1 and follower.active


def test_part_reseeded_on_another_part_drops_the_old_mask(vision):
    """jev boxes another part of the same object, farther than its own size away: the old
    part's mask is forgotten, so jev's keyframe, from an older frame than a refresh of the old
    part, is taken. The same part boxed again keeps the mask; not in view drops it."""
    follower = RegionFollower()
    run = PartRun(vision, follower)
    crop = MaskCrop(np.full((20, 30), 10.0, np.float32), (460.0, 260.0), 2.0)
    run.frame(*SCENE)
    run.jev(1, DOOR, mask=crop)
    for _ in range(3):
        run.frame(*SCENE)
    run.tracker.refreshed(4, crop)  # a refresh of the door, on a newer frame than jev's next
    run.frame(*SCENE)
    assert follower.reference_seq == 4
    run.jev(2, shifted(DOOR, 6, 4))  # the door again
    run.tracker.refreshed(2, crop)  # its keyframe, older than the refresh: ignored
    assert follower.reference_seq == 4
    unsure = run.tracker.refresh_box  # the follower, unsure on a blank frame: the door's mask
    assert DOOR[0] <= unsure[0] and unsure[2] <= DOOR[2] and DOOR[1] <= unsure[1] <= DOOR[3]
    assert run.jev(3, PART).startswith("part")  # another part of the fridge
    assert not follower.active
    np.testing.assert_array_equal(run.tracker.refresh_box, PART)  # not the door's box
    run.tracker.refreshed(3, crop)  # its keyframe, a moment later
    assert follower.reference_seq == 3
    run.frame(*SCENE)
    assert run.jev(run.seq, None, present=False, mask=crop) == "part absent"
    assert not follower.active
    run.frame(*SCENE)
    assert not run.tracker.wants_refresh  # not in view: nothing to cut out


def test_part_without_follower_is_identical_to_before(vision):
    """Without a follower the new arguments change nothing: the gray frames, jev's masks and
    the refresh answers are ignored, and nothing asks for a refresh."""
    before = PartRun(vision, old=True)
    after = PartRun(vision, follower=None)
    crop = followed(DOOR).crop

    def both(*things: Thing, camera=None) -> None:
        same(before.frame(*things, camera=camera), after.frame(*things, camera=camera))
        assert not after.tracker.wants_refresh

    both(*SCENE)
    assert before.jev(1, DOOR) == after.jev(1, DOOR, mask=crop)
    for i in range(6):
        both(Thing(shifted(WHOLE, 8 * i), A), Thing(OTHER, B))  # the parent moves
    after.tracker.refreshed(after.seq, crop)
    after.tracker.refreshed(after.seq, None)
    for _ in range(3):
        both(Thing(OTHER, B))  # the parent is missed: it coasts, then the camera carries the part
    both(Thing(shifted(WHOLE, 80), A), Thing(OTHER, B), camera=pan(40))
    other = shifted(PART, 80)  # another part, now that the parent is back
    assert before.jev(before.seq, other) == after.jev(after.seq, other, mask=crop)
    for _ in range(3):
        both(Thing(shifted(WHOLE, 80), A), Thing(OTHER, B))
    gone = after.jev(after.seq, None, present=False, mask=crop)
    assert before.jev(before.seq, None, present=False) == gone
    both(Thing(shifted(WHOLE, 80), A), Thing(OTHER, B))
