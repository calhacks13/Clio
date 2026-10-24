from clio_pipeline.episode import load_episode
from clio_pipeline.held import HeldSpan, held_spans

CUP = {
    "id": "cup",
    "label": "cup",
    "position": [0.3, 0.0, -0.2],
    "radius": 0.04,
    "method": "layout",
}


def _pinch(b, t, hand, phase, near=None, distance=0.01):
    nearest = {"objectId": near, "distance": distance} if near else None
    b.event(t, "hand.pinch", hand=hand, phase=phase, point=[0.3, 0.0, -0.2], nearest=nearest)


def _grasp(b, t, hand, obj="cup", grip="pinch"):
    b.event(t, "object.grasped", objectId=obj, hand=hand, grip=grip, position=[0.3, 0.0, -0.2])


def _release(b, t, hand, obj="cup", reason="opened"):
    b.event(t, "object.released", objectId=obj, hand=hand, reason=reason, position=[0.3, 0, -0.2])


def _episode(new_episode, *features, objects=(CUP,)):
    b = new_episode(objects=list(objects))
    b.features(*features)
    b.frame(0.0)
    return b


def test_recorded_grasps_and_releases_become_spans(new_episode):
    b = _episode(new_episode, "object.grasp")
    _grasp(b, 500.0, "left")
    _release(b, 1500.0, "left")
    _grasp(b, 2000.0, "right", grip="fist")

    assert held_spans(load_episode(b.write())) == [
        HeldSpan("cup", "left", 500.0, 1500.0, "recorded", "pinch"),
        HeldSpan("cup", "right", 2000.0, None, "recorded", "fist"),
    ]


def test_a_grasp_by_the_other_hand_hands_the_object_over(new_episode):
    b = _episode(new_episode, "object.grasp")
    _grasp(b, 500.0, "left")
    _grasp(b, 700.0, "left")  # the same hand again changes nothing
    _grasp(b, 900.0, "right")
    _release(b, 1200.0, "right", reason="hand_lost")

    assert held_spans(load_episode(b.write())) == [
        HeldSpan("cup", "left", 500.0, 900.0, "recorded", "pinch"),
        HeldSpan("cup", "right", 900.0, 1200.0, "recorded", "pinch"),
    ]


def test_recorded_grasps_win_over_held_states_and_pinches(new_episode):
    b = _episode(new_episode, "object.flags", "object.grasp")
    _grasp(b, 500.0, "left")
    _pinch(b, 600.0, "right", "start", near="cup")
    b.track(
        800.0, b.object_state("cup", [0.3, 0.1, -0.2], source="pinch", flags=2, held_by="right")
    )

    assert held_spans(load_episode(b.write())) == [
        HeldSpan("cup", "left", 500.0, None, "recorded", "pinch")
    ]


def test_runs_of_held_states_become_spans(new_episode):
    b = _episode(new_episode, "object.flags")
    state = b.object_state
    for t in (1000.0, 1011.1, 1022.2):
        b.track(t, state("cup", [0.3, 0.1, -0.2], source="pinch", flags=2, held_by="left"))
    b.track(1033.3, state("cup", [0.3, 0.1, -0.2], source="pinch", flags=2, held_by=None))
    b.track(2000.0, state("cup", [0.3, 0.1, -0.2], source="pinch", flags=0, held_by="right"))

    assert held_spans(load_episode(b.write())) == [
        HeldSpan("cup", "left", 1000.0, 1033.3, "recorded", None),
        HeldSpan("cup", "right", 2000.0, None, "recorded", None),
    ]


def test_a_pinch_near_a_movable_object_picks_it_up_until_the_pinch_ends(new_episode):
    b = _episode(new_episode)
    _pinch(b, 500.0, "left", "start", near="cup", distance=0.07)  # within radius + 4 cm
    _pinch(b, 900.0, "left", "end")

    assert held_spans(load_episode(b.write())) == [
        HeldSpan("cup", "left", 500.0, 900.0, "inferred", "pinch")
    ]


def test_pinches_out_of_reach_or_on_a_held_object_pick_nothing_up(new_episode):
    b = _episode(new_episode)
    _pinch(b, 100.0, "left", "start", near="cup", distance=0.09)
    _pinch(b, 200.0, "left", "end")
    _pinch(b, 300.0, "right", "start", near="cup")
    _pinch(b, 400.0, "left", "start", near="cup")  # the right hand holds it
    _pinch(b, 500.0, "left", "end")

    assert held_spans(load_episode(b.write())) == [
        HeldSpan("cup", "right", 300.0, None, "inferred", "pinch")
    ]


def test_plan_points_and_hidden_objects_cannot_be_picked_up(new_episode, plan):
    dot = {**CUP, "id": "shoulder"}
    zone = {**CUP, "id": "zone"}
    b = _episode(new_episode, objects=(dot, zone))
    plan["objects"].append({**plan["objects"][3], "id": "zone", "kind": "item", "hidden": True})
    b.meta["plan"] = plan
    _pinch(b, 100.0, "left", "start", near="shoulder")  # a point in the plan
    _pinch(b, 200.0, "left", "end")
    _pinch(b, 300.0, "left", "start", near="zone")
    _pinch(b, 400.0, "left", "end")

    assert held_spans(load_episode(b.write())) == []


def test_frame_rate_pinch_estimates_no_pinch_explains_are_a_carry(new_episode):
    b = _episode(new_episode)
    for t in (1000.0, 1013.9, 1027.8, 1041.7):
        b.track(t, b.object_state("cup", [0.3, 0.1, -0.2], source="pinch"))
    b.track(1200.0, b.object_state("cup", [0.3, 0.1, -0.2], source="pinch"))  # a lone estimate
    for t in (1500.0, 1513.9):
        b.track(t, b.object_state("cup", [0.3, 0.1, -0.2], source="pinch"))

    assert held_spans(load_episode(b.write())) == [
        HeldSpan("cup", None, 1000.0, 1041.7, "inferred", None),
        HeldSpan("cup", None, 1500.0, 1513.9, "inferred", None),
    ]


def test_estimates_during_a_pinch_grasp_are_not_a_second_carry(new_episode):
    b = _episode(new_episode)
    _pinch(b, 990.0, "right", "start", near="cup")
    _pinch(b, 1030.0, "right", "end")
    for t in (1000.0, 1013.9, 1027.8, 1041.7, 1055.6):
        b.track(t, b.object_state("cup", [0.3, 0.1, -0.2], source="pinch"))

    # The run continues after the pinch ends: the closed hand picked the cup up again.
    assert held_spans(load_episode(b.write())) == [
        HeldSpan("cup", "right", 990.0, 1030.0, "inferred", "pinch"),
        HeldSpan("cup", None, 1041.7, 1055.6, "inferred", None),
    ]


def test_inferred_grasps_in_the_default_episode(episode_dir):
    # The shoulder dot is not in a plan here, so it counts as movable.
    assert held_spans(load_episode(episode_dir)) == [
        HeldSpan("shoulder", "left", 1700.0, 2500.0, "inferred", "pinch")
    ]


def test_spans_report_whether_they_cover_a_time():
    span = HeldSpan("cup", "left", 500.0, 900.0, "recorded", "pinch")

    assert [span.covers(t) for t in (499.0, 500.0, 899.0, 900.0)] == [False, True, True, False]
    assert HeldSpan("cup", "left", 500.0, None, "recorded", None).covers(1e9)


def test_objects_whose_states_do_not_record_held_by_are_inferred(new_episode):
    # An object.flags episode whose cup states leave heldBy out (a tracker that knows nothing of
    # grasps) says nothing about holding: the pinch decides, as in an older episode.
    bottle = {**CUP, "id": "bottle"}
    b = _episode(new_episode, "object.flags", objects=(CUP, bottle))
    _pinch(b, 500.0, "left", "start", near="cup")
    _pinch(b, 900.0, "left", "end")
    for t in (600.0, 700.0):
        b.track(t, b.object_state("cup", [0.3, 0.1, -0.2], source="detector", flags=10))
    b.track(
        800.0, b.object_state("bottle", [0.3, 0.1, -0.2], source="pinch", flags=2, held_by="right")
    )

    assert held_spans(load_episode(b.write())) == [
        HeldSpan("cup", "left", 500.0, 900.0, "inferred", "pinch"),
        HeldSpan("bottle", "right", 800.0, None, "recorded", None),
    ]


def test_states_without_held_by_neither_end_nor_start_a_run(new_episode):
    b = _episode(new_episode, "object.flags")
    state = b.object_state
    b.track(1000.0, state("cup", [0.3, 0.1, -0.2], source="pinch", flags=2, held_by="left"))
    b.track(1100.0, state("cup", [0.3, 0.1, -0.2], source="detector", flags=10))  # says nothing
    b.track(1200.0, state("cup", [0.3, 0.1, -0.2], source="pinch", flags=2, held_by=None))

    assert held_spans(load_episode(b.write())) == [
        HeldSpan("cup", "left", 1000.0, 1200.0, "recorded", None)
    ]
