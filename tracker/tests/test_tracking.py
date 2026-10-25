"""ObjectTracker on synthetic scenes: lock, follow, coast, re-acquire, learn, heed jev."""

from __future__ import annotations

from collections import deque

import numpy as np
import pytest

from clio_tracker.follow import Followed, RegionFollower
from clio_tracker.geometry import iou
from clio_tracker.tracking import ObjectTracker
from clio_tracker.vision import MaskCrop
from conftest import H, Thing, W, appearance, blend, unit  # noqa: F401

A = appearance(1)
B = blend(A, appearance(2), 0.85)  # a look-alike: same kind of thing, another instance
FPS = 15


def at(x: float, y: float = 300, w: float = 120, h: float = 160) -> tuple[float, ...]:
    return (x, y, x + w, y + h)


class Run:
    """Feeds scenes to one tracker at FPS and keeps every sighting."""

    def __init__(self, vision, tracker: ObjectTracker | None = None):
        self.vision = vision
        self.tracker = tracker or ObjectTracker("cup", "blue cup")
        self.seq = 0
        self.t = 0.0
        self.encodings: dict[int, object] = {}

    def frame(self, *things: Thing):
        self.seq += 1
        self.t += 1 / FPS
        enc = self.vision.encode(scene=list(things))
        self.encodings[self.seq] = enc
        return self.tracker.step(enc, self.seq, self.t, self.vision)

    def jev(self, seq: int, box, present: bool = True) -> str:
        enc = self.encodings[seq]
        box = np.asarray(box, dtype=np.float32) if box is not None else None
        look = self.vision.prompts(enc, box)[0] if box is not None else None
        return self.tracker.identified(seq, self.t, present, box, look)


def test_nothing_to_follow_until_jev_names_it(vision):
    run = Run(vision)
    s = run.frame(Thing(at(100), A))
    assert not s.found and s.state == "unknown"
    assert run.tracker.wants_jev_now


def test_jev_box_becomes_the_target_on_the_next_frames(vision):
    run = Run(vision)
    run.frame(Thing(at(100), A), Thing(at(500), B))
    assert run.jev(1, at(100)) == "placed"
    s = run.frame(Thing(at(104), A), Thing(at(500), B))
    s = s if s.found else run.frame(Thing(at(108), A), Thing(at(500), B))
    assert s.found and s.state == "tracking"
    assert iou(s.box, at(108))[0, 0] > 0.8 or iou(s.box, at(104))[0, 0] > 0.8
    assert s.confidence >= 0.5 and run.tracker.target_by == "jev"
    assert not run.tracker.wants_jev_now


def locked(vision, x=100):
    run = Run(vision)
    run.frame(Thing(at(x), A), Thing(at(500), B))
    run.jev(1, at(x))
    for _ in range(3):
        run.frame(Thing(at(x), A), Thing(at(500), B))
    assert run.tracker.target_id is not None
    return run


def test_identity_holds_while_the_object_and_a_look_alike_move(vision):
    run = locked(vision)
    tid = run.tracker.target_id
    for i in range(30):
        s = run.frame(Thing(at(100 + 5 * i), A), Thing(at(500 - 3 * i, 320), B))
        assert s.found and s.track_id == tid
        assert iou(s.box, at(100 + 5 * i))[0, 0] > 0.7


def test_jev_moves_the_target_to_another_track(vision):
    run = locked(vision)
    for _ in range(3):
        run.frame(Thing(at(100), A), Thing(at(500), B))
    seq = run.seq
    first = run.tracker.target_id
    change = run.jev(seq, at(500))
    assert change.startswith(f"moved from track {first} to ")
    s = run.frame(Thing(at(100), A), Thing(at(502), B))
    assert s.found and iou(s.box, at(502))[0, 0] > 0.8


def test_answers_about_frames_before_one_already_applied_are_ignored(vision):
    run = locked(vision)
    run.frame(Thing(at(100), A), Thing(at(500), B))
    run.jev(run.seq, at(100))
    assert run.jev(1, at(500)) == "stale"


def test_a_lost_target_coasts_then_is_found_again_as_the_same_track(vision):
    run = locked(vision, x=300)
    tid = run.tracker.target_id
    gone = [run.frame(Thing(at(500), B)) for _ in range(8)]  # about 0.5 s out of view
    assert gone[0].found and gone[0].state == "coasting"
    assert gone[0].confidence < 0.9
    assert not gone[-1].found and gone[-1].state == "lost"
    back = run.frame(Thing(at(300), A), Thing(at(500), B))
    assert back.found and back.track_id == tid


def test_a_target_leaving_by_the_edge_is_held_longer(vision):
    run = Run(vision)
    edge = (0, 300, 120, 460)
    run.frame(Thing(edge, A))
    run.jev(1, edge)
    for _ in range(3):
        run.frame(Thing(edge, A))
    held = [run.frame() for _ in range(10)]  # 0.67 s
    assert all(h.found for h in held)


def test_a_dropped_track_is_reacquired_by_appearance_not_by_score(vision):
    run = locked(vision)
    for _ in range(60):  # 4 s away: the track is dropped
        run.frame(Thing(at(500), B))
    assert run.tracker.target_id is None
    # The look-alike is alone and scores well, but does not look like the target.
    s = run.frame(Thing(at(500), B))
    assert not s.found
    s = run.frame(Thing(at(700), A), Thing(at(500), B))
    s = s if s.found else run.frame(Thing(at(700), A), Thing(at(500), B))
    assert s.found and iou(s.box, at(700))[0, 0] > 0.8
    assert run.tracker.target_by == "appearance"


def test_appearance_follows_a_turning_object_but_not_a_sudden_swap(vision):
    run = locked(vision)
    other_side = appearance(7)
    for i in range(1, 41):  # the object turns: its look drifts away from what jev saw
        look = blend(A, other_side, float(np.cos(np.radians(i))))
        run.frame(Thing(at(100), look), Thing(at(500), B))
    turned = blend(A, other_side, float(np.cos(np.radians(40))))
    assert float(run.tracker.running @ turned) > float(A @ turned) + 0.05
    assert float(run.tracker.prompt @ turned) > float(A @ turned)
    before = run.tracker.running.copy()
    stranger = appearance(9)  # a hand covers it: nothing like jev's view
    run.frame(Thing(at(100), stranger), Thing(at(500), B))
    np.testing.assert_allclose(run.tracker.running, before)


def test_jev_saying_absent_releases_the_target_and_raises_the_bar(vision):
    near = blend(A, appearance(4), 0.9)  # close enough to re-acquire normally, not after "absent"
    normally = locked(vision)
    for _ in range(60):
        normally.frame(Thing(at(500), B))
    s = [normally.frame(Thing(at(300), near), Thing(at(500), B)) for _ in range(2)][-1]
    assert s.found

    run = locked(vision)
    assert run.jev(run.seq, None, present=False) == "absent"
    assert run.tracker.target_id is None
    for _ in range(60):
        run.frame(Thing(at(500), B))
    s = [run.frame(Thing(at(300), near), Thing(at(500), B)) for _ in range(2)][-1]
    assert not s.found and s.state == "absent"


def test_doubt_asks_jev_early(vision):
    run = locked(vision)
    for _ in range(3):
        run.frame(Thing(at(100), blend(A, appearance(5), 0.7)), Thing(at(500), B))
    assert run.tracker.doubt >= 3 and run.tracker.wants_jev_now


@pytest.mark.parametrize("weight", [0.0, 0.5, 1.0])
def test_prompt_blends_anchor_and_running(weight):
    from clio_tracker.tracking import TrackerParams

    tr = ObjectTracker("x", None, TrackerParams(anchor_weight=weight))
    tr.anchor, tr.running = A, appearance(3)
    expected = unit(weight * A + (1 - weight) * tr.running)
    np.testing.assert_allclose(tr.prompt, expected, atol=1e-6)


def test_an_answer_about_a_frame_before_any_track_keeps_a_target_that_matches(vision):
    run = Run(vision)
    run.frame(Thing(at(100), A), Thing(at(500), B))  # frame 1: no prompt yet, no tracks
    run.frame(Thing(at(100), A), Thing(at(500), B))  # frame 2: the second jev call's frame
    run.jev(1, at(100))
    for _ in range(3):
        run.frame(Thing(at(100), A), Thing(at(500), B))
    tid = run.tracker.target_id
    assert run.jev(2, at(100)) == "kept: looks like it"
    assert run.tracker.target_id == tid


def test_a_track_born_where_the_target_was_lost_continues_it(vision):
    """In a close-up the whole object and one part of it can swap scores: ByteTrack then drops
    the target's track and starts another where it was. That one carries on as the target,
    though it looks only fairly like it, and a later jev answer about the old track means it."""
    big = (0.0, 40.0, 600.0, 460.0)
    part = (0.0, 40.0, 140.0, 120.0)  # inside the old box, too small to match it
    run = Run(vision)
    run.frame(Thing(big, A), Thing(at(700, 300), B))
    run.jev(1, big)
    for _ in range(3):
        run.frame(Thing(big, A), Thing(at(700, 300), B))
    before = run.seq
    first = run.tracker.target_id
    part_look = blend(A, appearance(8), 0.82)  # under the 0.88 bar for a stranger track
    sightings = [run.frame(Thing(part, part_look), Thing(at(700, 300), B)) for _ in range(3)]
    assert all(s.found for s in sightings)
    assert sightings[-1].state == "tracking" and sightings[-1].track_id != first
    assert iou(sightings[-1].box, part)[0, 0] > 0.8
    assert run.jev(before, big) == "confirmed"  # resolved to the track that continued it


def test_a_look_alike_already_there_does_not_take_over(vision):
    """Only a track born after the target was last seen can continue it: a look-alike tracked
    all along inside the target's box is not taken when the target disappears."""
    big = (0.0, 40.0, 600.0, 460.0)
    small = (20.0, 50.0, 140.0, 130.0)  # inside it, but too small for ByteTrack to match
    run = Run(vision)
    run.frame(Thing(big, A), Thing(small, B))
    run.jev(1, big)
    for _ in range(3):
        run.frame(Thing(big, A), Thing(small, B))
    target = run.tracker.target_id
    gone = [run.frame(Thing(small, B)) for _ in range(5)]
    assert all(s.track_id in (target, None) for s in gone)
    assert not any(s.state == "tracking" for s in gone)


# --- steadier tracking: weak sightings, camera motion, jev's box at once ---------------------


class MovingRun(Run):
    """A Run whose frames can say how the camera moved since the frame before."""

    def frame(self, *things: Thing, camera=None):
        self.seq += 1
        self.t += 1 / FPS
        enc = self.vision.encode(scene=list(things))
        self.encodings[self.seq] = enc
        return self.tracker.step(enc, self.seq, self.t, self.vision, camera)

    def jev(self, seq: int, box, present: bool = True, carry=None) -> str:
        enc = self.encodings[seq]
        box = np.asarray(box, dtype=np.float32)
        look = self.vision.prompts(enc, box)[0]
        return self.tracker.identified(seq, self.t, present, box, look, carry)


def pan(dx: float, dy: float = 0.0) -> np.ndarray:
    return np.array([[1.0, 0, dx], [0, 1.0, dy]])


def moved(box, dx: float, dy: float = 0.0) -> tuple[float, ...]:
    return (box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy)


def locked_moving(vision, x=100) -> MovingRun:
    run = MovingRun(vision)
    run.frame(Thing(at(x), A), Thing(at(500), B))
    run.jev(1, at(x))
    for _ in range(3):
        run.frame(Thing(at(x), A), Thing(at(500), B))
    assert run.tracker.target_id is not None
    return run


def test_a_weak_sighting_on_the_predicted_box_continues_the_target(vision):
    """YOLOE's score for the object dips under ByteTrack's floor for a few frames (blur, glare):
    the target continues on it where it was predicted, instead of coasting and being lost."""
    run = locked_moving(vision)
    tid = run.tracker.target_id
    dim = blend(A, appearance(11), 0.64)  # scores about 0.08, under ByteTrack's 0.10
    for _ in range(10):
        s = run.frame(Thing(at(102), dim), Thing(at(500), B))
        assert s.found and s.state == "tracking" and s.track_id == tid
    s = run.frame(Thing(at(104), A), Thing(at(500), B))
    assert s.state == "tracking" and s.track_id == tid


def test_a_weak_candidate_away_from_the_prediction_is_not_taken(vision):
    run = locked_moving(vision)
    dim = blend(A, appearance(11), 0.64)
    s = run.frame(Thing(at(260), dim), Thing(at(500), B))  # no overlap with where it was
    assert s.state == "coasting"


def test_the_camera_motion_keeps_the_track_through_a_fast_glance(vision):
    """The whole picture jumps 160 px in one frame: with the camera's motion the track's
    prediction jumps too, so it is the same track; without it, the target is missed."""
    run = locked_moving(vision)
    tid = run.tracker.target_id
    s = run.frame(Thing(at(260), A), Thing(at(660), B), camera=pan(160))
    assert s.state == "tracking" and s.track_id == tid

    blind = locked_moving(vision)
    s = blind.frame(Thing(at(260), A), Thing(at(660), B))
    assert s.state != "tracking" or s.track_id != blind.tracker.target_id


def test_a_target_out_of_view_is_not_drawn_and_comes_back_as_the_same_track(vision):
    run = locked_moving(vision, x=300)
    tid = run.tracker.target_id
    # A glance to the right: the object leaves the view by the left edge.
    gone = [run.frame(camera=pan(-400))] + [run.frame(camera=pan(0)) for _ in range(20)]
    assert all(not g.found and g.state == "lost" for g in gone)
    back = run.frame(Thing(at(300), A), camera=pan(400))
    assert back.found and back.state == "tracking" and back.track_id == tid


def test_jev_box_with_no_track_is_followed_from_the_next_frame(vision):
    """The object scores under ByteTrack's bar for a new track (0.45): jev's box is enough to
    start one, at once."""
    run = MovingRun(vision)
    run.frame(Thing(at(100), A), Thing(at(500), B))
    run.frame(Thing(at(100), A), Thing(at(500), B))
    seen_now = blend(A, appearance(12), 0.75)  # scores about 0.34 against jev's view
    run.frame(Thing(at(100), seen_now), Thing(at(500), B))
    assert run.jev(1, at(100)) == "placed"
    s = run.frame(Thing(at(100), seen_now), Thing(at(500), B))
    assert s.found and s.state == "tracking" and iou(s.box, at(100))[0, 0] > 0.9
    assert run.tracker.target_by == "jev" and not run.tracker.wants_jev_now


def test_jev_box_is_carried_to_where_its_object_is_now(vision):
    """jev answers about frame 1 four frames later; the camera has turned since, moving
    everything 40 px a frame. Its box is carried along, so it lands on its object."""
    run = MovingRun(vision)
    run.frame(Thing(at(100), A), Thing(at(400), B))
    for k in range(1, 5):
        run.frame(Thing(at(100 + 40 * k), A), Thing(at(400 + 40 * k), B), camera=pan(40))
    assert run.jev(1, at(100), carry=pan(160)) == "placed"
    s = run.frame(Thing(at(300), A), Thing(at(600), B), camera=pan(40))
    assert s.found and iou(s.box, at(300))[0, 0] > 0.9


def test_jev_box_around_a_part_of_the_target_confirms_it(vision):
    """jev boxes the whole object while YOLOE follows a part of it inside (IoU under 0.3):
    the same object, not a new placement."""
    big = (100.0, 100.0, 500.0, 500.0)
    part = (120.0, 120.0, 300.0, 300.0)  # IoU 0.2 with the whole, all inside it
    run = MovingRun(vision)
    run.frame(Thing(part, A), Thing(at(700, 100), B))
    run.jev(1, part)
    for _ in range(3):
        run.frame(Thing(part, A), Thing(at(700, 100), B))
    assert run.jev(run.seq, big) == "confirmed"


def test_old_views_still_score_after_a_poor_one(vision):
    """jev's latest view of the object is a poor one (half out of frame, say): it becomes the
    anchor, but the object still scores against jev's earlier views."""
    run = locked_moving(vision)
    odd = blend(A, appearance(13), 0.5)
    box = np.asarray(at(100), dtype=np.float32)
    assert run.tracker.identified(run.seq, run.t, True, box, odd) == "confirmed"
    assert float(run.tracker.prompt @ A) < 0.95  # the prompt alone has moved off the object
    for _ in range(3):
        s = run.frame(Thing(at(100), A), Thing(at(500), B))
    assert s.found and s.state == "tracking" and s.track_id == run.tracker.target_id


# --- the follower's mask (follow.py): shown when confident and agreeing with ByteTrack --------

GRAY = np.zeros((H, W), np.uint8)


class FakeFollower:
    """Stands in for RegionFollower: each `step` returns the next scripted answer (None once
    the script is used up) and every `set_reference` is recorded."""

    def __init__(self) -> None:
        self.answers: deque[Followed | None] = deque()
        self.references: list[tuple[int, MaskCrop]] = []
        self.steps: list[int] = []
        self._seq: int | None = None

    @property
    def active(self) -> bool:
        return self._seq is not None

    @property
    def reference_seq(self) -> int | None:
        return self._seq

    def set_reference(self, seq: int, crop: MaskCrop) -> None:
        self.references.append((seq, crop))
        self._seq = seq

    def step(self, seq: int, gray: np.ndarray, camera, t: float) -> Followed | None:
        self.steps.append(seq)
        return self.answers.popleft() if self.answers else None

    def clear(self) -> None:
        self._seq = None


def followed(box, confident: bool = True) -> Followed:
    """A follower's answer: `box` filled, at one frame pixel per mask pixel."""
    b = np.asarray(box, dtype=np.float32)
    rows, cols = int(np.ceil(b[3] - b[1])), int(np.ceil(b[2] - b[0]))
    crop = MaskCrop(np.full((rows, cols), 10.0, np.float32), (float(b[0]), float(b[1])), 1.0)
    return Followed(b, crop, 40 if confident else 3, 0.9 if confident else 0.2, confident)


class FollowRun(MovingRun):
    """A MovingRun that hands the tracker a gray frame each time, for its follower, and jev's
    mask with jev's answer."""

    def __init__(self, vision, follower=None, tracker: ObjectTracker | None = None):
        super().__init__(vision, tracker or ObjectTracker("cup", "blue cup", follower=follower))

    def frame(self, *things: Thing, camera=None):
        self.seq += 1
        self.t += 1 / FPS
        enc = self.vision.encode(scene=list(things))
        self.encodings[self.seq] = enc
        return self.tracker.step(enc, self.seq, self.t, self.vision, camera, gray=GRAY)

    def jev(self, seq: int, box, present: bool = True, carry=None, mask=None) -> str:
        enc = self.encodings[seq]
        box = np.asarray(box, dtype=np.float32)
        look = self.vision.prompts(enc, box)[0]
        return self.tracker.identified(seq, self.t, present, box, look, carry, mask=mask)


def locked_following(vision, follower) -> FollowRun:
    """Locked on the cup at at(100), the follower holding the segmenter's cut of jev's box."""
    run = FollowRun(vision, follower)
    run.frame(Thing(at(100), A), Thing(at(500), B))
    run.jev(1, at(100), mask=followed(at(100)).crop)
    for _ in range(3):
        run.frame(Thing(at(100), A), Thing(at(500), B))
    assert run.tracker.target_id is not None
    return run


def yoloe_crop(s) -> bool:
    """The sighting's mask is YOLOE's (FakeVision's: the tracked box at 2 pixels a cell)."""
    origin = (float(s.measured[0]), float(s.measured[1]))
    return s.crop is not None and s.crop.scale == 2.0 and s.crop.origin == origin


def test_confident_follower_mask_replaces_yoloe_crop(vision):
    follower = FakeFollower()
    run = FollowRun(vision, follower)
    run.frame(Thing(at(100), A), Thing(at(500), B))
    keyframe = followed(at(100)).crop
    assert run.jev(1, at(100), mask=keyframe) == "placed"
    answer = followed(at(103, 302, 116, 150))  # the segmenter's tighter cut, inside YOLOE's box
    follower.answers.append(answer)
    s = run.frame(Thing(at(100), A), Thing(at(500), B))
    assert s.found and s.state == "tracking"
    assert s.crop is answer.crop
    np.testing.assert_array_equal(s.measured, answer.box)
    np.testing.assert_allclose(s.box, answer.box)  # the first sighting: nothing to smooth from
    assert s.shape is not None and s.shape.outline is not None
    assert not run.tracker.wants_refresh


def test_doubting_follower_falls_back_and_wants_refresh(vision):
    follower = FakeFollower()
    run = locked_following(vision, follower)
    assert not run.tracker.wants_refresh
    for k in range(2):
        unsure = followed(at(102), confident=False)
        follower.answers.append(unsure)
        s = run.frame(Thing(at(100), A), Thing(at(500), B))
        assert s.state == "tracking" and yoloe_crop(s)
        np.testing.assert_array_equal(s.measured, at(100))
        assert run.tracker.wants_refresh == (k == 1)
    np.testing.assert_array_equal(run.tracker.refresh_box, unsure.box)
    sure = followed(at(101))
    follower.answers.append(sure)
    s = run.frame(Thing(at(100), A), Thing(at(500), B))
    assert s.crop is sure.crop and not run.tracker.wants_refresh  # confident again: no doubt
    run.tracker.refreshed(run.seq, None)  # the segmenter found nothing: one frame of doubt...
    assert not run.tracker.wants_refresh
    follower.answers.append(followed(at(102), confident=False))
    run.frame(Thing(at(100), A), Thing(at(500), B))
    assert run.tracker.wants_refresh  # ...and the next frame's makes two


def test_follower_disagreeing_with_bytetrack_is_doubted(vision):
    follower = FakeFollower()
    run = locked_following(vision, follower)
    for k in range(2):
        follower.answers.append(followed(at(500)))  # confident, but on the look-alike
        s = run.frame(Thing(at(100), A), Thing(at(500), B))
        assert s.state == "tracking" and yoloe_crop(s)
        np.testing.assert_array_equal(s.measured, at(100))
        assert iou(s.box, at(100))[0, 0] > 0.9
        assert run.tracker.wants_refresh == (k == 1)
    # The follower is on the wrong object: the refresh re-anchors on the one ByteTrack holds.
    np.testing.assert_array_equal(run.tracker.refresh_box, at(100))


def test_follower_inside_the_tracked_box_agrees(vision):
    """In objects mode a part is followed as an object: ByteTrack holds the whole, the
    segmenter's mask is the part. A follower box inside the tracked box agrees with it, as a
    part and its whole do; one as small cut by the box's edge does not."""
    follower = FakeFollower()
    run = locked_following(vision, follower)
    tracked = at(100)  # (100, 300, 220, 460)
    inside = followed((130, 340, 190, 404))  # a fifth of the tracked box, IoU 0.2
    follower.answers.append(inside)
    s = run.frame(Thing(tracked, A), Thing(at(500), B))
    assert s.crop is inside.crop
    np.testing.assert_array_equal(s.measured, inside.box)
    straddling = followed((190, 340, 250, 404))  # the same size, half outside the tracked box
    follower.answers.append(straddling)
    s = run.frame(Thing(tracked, A), Thing(at(500), B))
    assert yoloe_crop(s)
    np.testing.assert_array_equal(s.measured, tracked)


def test_jev_moving_the_target_lets_its_keyframe_in(vision):
    """jev's mask comes from jev's frame, older than a refresh of the old object that came back
    meanwhile: moving the target forgets the old object's mask, so jev's is taken."""
    follower = RegionFollower()
    run = locked_following(vision, follower)
    crop = MaskCrop(np.full((20, 30), 10.0, np.float32), (100.0, 100.0), 2.0)
    for _ in range(2):
        run.frame(Thing(at(100), A), Thing(at(500), B))
    jev_seq = run.seq - 1
    run.tracker.refreshed(run.seq, crop)  # a refresh of the old object, on a newer frame
    run.frame(Thing(at(100), A), Thing(at(500), B))
    assert follower.reference_seq == run.seq - 1
    assert run.jev(jev_seq, at(500)).startswith("moved from track")
    run.tracker.refreshed(jev_seq, crop)  # jev's keyframe, a moment later
    assert follower.reference_seq == jev_seq
    run.frame(Thing(at(100), A), Thing(at(500), B))
    assert run.jev(run.seq, at(500)) == "confirmed"  # the same object: the mask stays
    assert follower.reference_seq == jev_seq
    assert run.tracker.identified(run.seq, run.t, False, None, None) == "absent"
    assert not follower.active


def test_identified_with_mask_sets_reference(vision):
    follower = FakeFollower()
    run = FollowRun(vision, follower)
    for _ in range(3):
        run.frame(Thing(at(100), A), Thing(at(500), B))
    crop = followed(at(100)).crop
    run.jev(2, at(100), mask=crop)
    assert len(follower.references) == 1
    seq, given = follower.references[0]
    assert seq == 2 and given is crop
    assert follower.steps == [1, 2, 3]  # stepped on every frame, also before it had a mask


def test_identified_with_none_mask_keeps_yoloe_outline(vision):
    follower = FakeFollower()
    run = FollowRun(vision, follower)
    run.frame(Thing(at(100), A), Thing(at(500), B))
    run.jev(1, at(100), mask=None)
    s = [run.frame(Thing(at(100), A), Thing(at(500), B)) for _ in range(2)][-1]
    assert follower.references == [] and not follower.active
    assert s.state == "tracking" and yoloe_crop(s)
    assert run.tracker.wants_refresh  # a target and no mask yet: ask for one...
    np.testing.assert_array_equal(run.tracker.refresh_box, at(100))  # ...on the tracked box


def test_refreshed_older_than_reference_is_ignored(vision):
    follower = RegionFollower()
    run = FollowRun(vision, follower)
    for _ in range(7):
        run.frame(Thing(at(100), A), Thing(at(500), B))
    crop = MaskCrop(np.full((20, 30), 10.0, np.float32), (100.0, 100.0), 2.0)
    run.jev(7, at(100), mask=crop)
    assert follower.reference_seq == 7
    run.frame(Thing(at(100), A), Thing(at(500), B))
    run.tracker.refreshed(3, crop)  # asked before jev's frame, answered after jev
    assert follower.reference_seq == 7
    run.frame(Thing(at(100), A), Thing(at(500), B))
    assert follower.reference_seq == 7
    run.tracker.refreshed(run.seq, crop)  # a newer one does take over
    assert follower.reference_seq == run.seq


def test_coasting_with_confident_follower_keeps_mask(vision):
    follower = FakeFollower()
    run = locked_following(vision, follower)
    answer = followed(at(104))
    follower.answers.append(answer)
    s = run.frame(Thing(at(500), B))  # YOLOE misses the cup on this frame
    assert s.found and s.state == "tracking" and s.track_id == run.tracker.target_id
    assert s.crop is answer.crop
    np.testing.assert_array_equal(s.measured, answer.box)
    assert not run.tracker.wants_refresh
    for k in range(2):
        follower.answers.append(followed(at(104), confident=False))
        s = run.frame(Thing(at(500), B))  # the follower is unsure too: it coasts as without one
        assert s.found and s.state == "coasting" and s.crop is None
        assert run.tracker.wants_refresh == (k == 1)
    gone = [run.frame(Thing(at(500), B)) for _ in range(8)]
    assert gone[-1].state == "lost" and not run.tracker.wants_refresh  # nothing in sight to cut


def same(a, b) -> None:
    assert (a.found, a.state, a.track_id, a.confidence, a.shape) == (
        b.found,
        b.state,
        b.track_id,
        b.confidence,
        b.shape,
    )
    for x, y in ((a.box, b.box), (a.measured, b.measured)):
        assert (x is None) == (y is None)
        if x is not None:
            np.testing.assert_array_equal(x, y)
    assert (a.crop is None) == (b.crop is None)
    if a.crop is not None:
        np.testing.assert_array_equal(a.crop.logits, b.crop.logits)
        assert (a.crop.origin, a.crop.scale) == (b.crop.origin, b.crop.scale)


def test_no_follower_is_identical_to_before(vision):
    """Without a follower the new arguments change nothing: the gray frames, jev's masks and
    the refresh answers are ignored, and nothing asks for a refresh."""
    before = MovingRun(vision)
    after = FollowRun(vision, tracker=ObjectTracker("cup", "blue cup", follower=None))
    crop = followed(at(100)).crop

    def both(*things: Thing, camera=None) -> None:
        same(before.frame(*things, camera=camera), after.frame(*things, camera=camera))
        assert not after.tracker.wants_refresh

    both(Thing(at(100), A), Thing(at(500), B))
    assert before.jev(1, at(100)) == after.jev(1, at(100), mask=crop)
    for i in range(6):
        both(Thing(at(100 + 5 * i), A), Thing(at(500), B))
    after.tracker.refreshed(after.seq, crop)
    after.tracker.refreshed(after.seq, None)
    for _ in range(3):
        both(Thing(at(500), B))  # missed: it coasts
    both(Thing(at(165), A), Thing(at(540), B), camera=pan(40))
    assert before.jev(before.seq, at(165)) == after.jev(after.seq, at(165), mask=crop)
    for _ in range(3):
        both(Thing(at(165), A), Thing(at(540), B))
