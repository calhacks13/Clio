"""ObjectTracker on synthetic scenes: lock, follow, coast, re-acquire, learn, heed jev."""

from __future__ import annotations

import numpy as np
import pytest

from clio_tracker.geometry import iou
from clio_tracker.tracking import ObjectTracker
from conftest import Thing, appearance, blend, unit  # noqa: F401

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
    for _ in range(40):  # 2.7 s away: the track is dropped
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
    for _ in range(40):
        normally.frame(Thing(at(500), B))
    s = [normally.frame(Thing(at(300), near), Thing(at(500), B)) for _ in range(2)][-1]
    assert s.found

    run = locked(vision)
    assert run.jev(run.seq, None, present=False) == "absent"
    assert run.tracker.target_id is None
    for _ in range(40):
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
