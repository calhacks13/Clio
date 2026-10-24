import numpy as np
import pytest

from clio_pipeline.episode import load_episode
from clio_pipeline.objects import grid_times, object_series
from clio_pipeline.resample import resample_episode

GRID = np.arange(0.0, 1001.0, 50.0)  # 0, 50, ..., 1000 ms


def _series(b, grid=GRID, **policy):
    return object_series(load_episode(b.write()), grid, **policy)


def _at(series, t):
    return int(np.flatnonzero(np.isclose(series.t, t))[0])


def _episode(new_episode, objects=()):
    b = new_episode(objects=list(objects))
    b.frame(0.0)
    b.frame(1000.0)
    return b


def test_there_is_no_position_before_an_object_is_first_seen(new_episode):
    b = _episode(new_episode)
    b.track(300.0, b.object_state("cup", [0.3, 0.0, -0.2], source="detector"))

    cup = _series(b)["cup"]

    first = _at(cup, 300.0)
    assert not cup.valid[:first].any()
    assert np.isnan(cup.position[:first]).all()
    assert cup.source[:first] == [None] * first
    np.testing.assert_allclose(cup.position[first], [0.3, 0.0, -0.2])


def test_a_lost_estimate_leaves_a_gap_until_the_object_is_seen_again(new_episode):
    b = _episode(new_episode)
    state = b.object_state
    b.track(100.0, state("cup", [0.3, 0.0, -0.2], source="detector", flags=10))
    b.track(400.0, state("cup", [0.3, 0.0, -0.2], source="detector", confidence=0.1, flags=0))
    b.track(700.0, state("cup", [0.5, 0.0, -0.2], source="detector", flags=10))

    cup = _series(b)["cup"]

    gap = (cup.t >= 400.0) & (cup.t < 700.0)
    assert not cup.valid[gap].any() and not cup.tracked[gap].any()
    assert np.isnan(cup.position[gap]).all() and np.isnan(cup.confidence[gap]).all()
    assert set(np.array(cup.source, dtype=object)[gap]) == {"detector"}
    # Nothing is interpolated toward the lost estimate either.
    np.testing.assert_allclose(cup.position[_at(cup, 350.0)], [0.3, 0.0, -0.2])
    np.testing.assert_allclose(cup.position[_at(cup, 700.0)], [0.5, 0.0, -0.2])


def test_an_estimate_holds_across_a_long_gap_without_being_tracked(new_episode):
    b = _episode(new_episode)
    b.track(100.0, b.object_state("cup", [0.3, 0.0, -0.2], source="detector"))
    b.track(900.0, b.object_state("cup", [0.5, 0.0, -0.2], source="detector"))

    cup = _series(b)["cup"]

    held = (cup.t >= 100.0) & (cup.t < 900.0)
    assert cup.valid[held].all() and not cup.interpolated.any()
    np.testing.assert_allclose(cup.position[held], [[0.3, 0.0, -0.2]] * held.sum())
    assert cup.tracked.tolist() == [100.0 <= t <= 200.0 or t >= 900.0 for t in cup.t]


def test_a_short_gap_between_measurements_is_interpolated_and_flagged(new_episode):
    b = _episode(new_episode)
    b.track(100.0, b.object_state("cup", [0.3, 0.0, -0.2], source="marker"))
    b.track(300.0, b.object_state("cup", [0.5, 0.2, -0.2], source="marker"))  # 200 ms later

    cup = _series(b)["cup"]

    np.testing.assert_allclose(cup.position[_at(cup, 150.0)], [0.35, 0.05, -0.2])
    np.testing.assert_allclose(cup.position[_at(cup, 250.0)], [0.45, 0.15, -0.2])
    assert cup.interpolated.tolist() == [100.0 < t < 300.0 for t in cup.t]
    assert not cup.tracked[_at(cup, 250.0)]  # 150 ms after the last measurement


def test_dense_estimates_are_resampled_without_the_interpolated_flag(new_episode):
    b = _episode(new_episode)
    for k in range(0, 61):
        x = round(0.3 + 0.001 * k, 4)
        b.track(100.0 + k * 1000.0 / 72.0, b.object_state("cup", [x, 0.0, -0.2], source="marker"))

    cup = _series(b)["cup"]

    window = (cup.t >= 100.0) & (cup.t <= 900.0)
    assert cup.tracked[window].all() and not cup.interpolated.any()
    np.testing.assert_allclose(cup.position[_at(cup, 500.0), 0], 0.3 + 0.001 * 400 * 72 / 1000)


def test_orientations_are_blended_only_between_two_known_ones(new_episode):
    b = _episode(new_episode)
    half_turn = [0.0, 0.7071, 0.0, 0.7071]  # 90 degrees about +y
    b.track(100.0, b.object_state("cup", [0, 0, 0], orientation=[0, 0, 0, 1], source="marker"))
    b.track(200.0, b.object_state("cup", [0, 0, 0], orientation=half_turn, source="marker"))
    b.track(300.0, b.object_state("cup", [0, 0, 0], source="detector"))

    cup = _series(b)["cup"]

    q = cup.orientation[_at(cup, 150.0)]
    np.testing.assert_allclose(q, [0.0, 0.3827, 0.0, 0.9239], atol=1e-3)  # 45 degrees
    np.testing.assert_allclose(cup.orientation[_at(cup, 200.0)], half_turn)
    assert np.isnan(cup.orientation[_at(cup, 300.0) :]).all()
    assert cup.orientation_valid.tolist() == [100.0 <= t < 300.0 for t in cup.t]


def test_an_estimate_is_placed_at_the_time_it_was_measured(new_episode):
    b = _episode(new_episode)
    b.track(100.0, b.object_state("cup", [0.3, 0.0, -0.2], source="detector"))
    b.track(600.0, b.object_state("cup", [0.5, 0.0, -0.2], source="detector", observed_t=400.0))

    cup = _series(b)["cup"]

    np.testing.assert_allclose(cup.position[_at(cup, 350.0)], [0.3, 0.0, -0.2])
    np.testing.assert_allclose(cup.position[_at(cup, 400.0)], [0.5, 0.0, -0.2])
    assert cup.tracked[_at(cup, 450.0)] and not cup.tracked[_at(cup, 550.0)]


def test_an_estimate_measured_before_the_start_replaces_the_placement(new_episode):
    cup = {"id": "cup", "label": "cup", "position": [0.0, 0.0, 0.0], "radius": 0.04}
    b = _episode(new_episode, [{**cup, "method": "layout"}])
    b.track(20.0, b.object_state("cup", [0.3, 0.0, -0.2], source="detector", observed_t=-30.0))

    series = _series(b)["cup"]

    np.testing.assert_allclose(series.position[0], [0.3, 0.0, -0.2])
    assert series.source[0] == "detector"


def test_older_estimates_get_flags_from_their_source(episode_dir):
    ep = load_episode(episode_dir)
    series = object_series(ep, grid_times(ep, 30))

    shoulder, middle = series["shoulder"], series["middle"]
    assert shoulder.valid.all() and not shoulder.tracked.any()  # layout, then pinch
    assert not middle.tracked[middle.t < 2000.0].any()  # layout
    assert middle.tracked[(middle.t >= 2000.0) & (middle.t <= 2100.0)].all()  # marker
    assert not middle.tracked[middle.t > 2100.0].any()
    assert middle.orientation_valid.tolist() == (middle.t >= 2000.0).tolist()


def test_confidence_is_kept_only_for_measured_sources(episode_dir):
    ep = load_episode(episode_dir)
    series = object_series(ep, grid_times(ep, 30))

    assert np.isnan(series["shoulder"].confidence).all()  # layout and pinch
    middle = series["middle"]
    assert np.isnan(middle.confidence[middle.t < 2000.0]).all()
    assert (middle.confidence[middle.t >= 2000.0] == 0.95).all()


def test_held_by_follows_the_held_spans(featured_episode_dir):
    ep = load_episode(featured_episode_dir)
    syringe = object_series(ep, grid_times(ep, 30))["syringe"]

    assert syringe.held_by == ["right" if 1600.0 <= t < 2000.0 else None for t in syringe.t]
    assert [(s.hand, s.start_t, s.end_t) for s in syringe.held_spans] == [("right", 1600.0, 2000.0)]


def test_a_carry_whose_hand_is_unknown_is_held_by_no_hand(new_episode):
    b = new_episode()
    b.meta["objects"] = [
        {
            "id": "cup",
            "label": "Cup",
            "position": [0.3, 0.0, -0.2],
            "radius": 0.04,
            "method": "layout",
        }
    ]
    for i in range(10):
        b.frame(i * 20.0, right=None)
    for t in (60.0, 80.0, 100.0, 120.0):  # frame-rate pinch estimates with no pinch event
        b.track(t, b.object_state("cup", [0.3, 0.1, -0.2], source="pinch"))
    ep = load_episode(b.write())

    cup = object_series(ep, grid_times(ep, 50))["cup"]

    assert cup.held.tolist() == [60.0 <= t < 120.0 for t in cup.t]
    assert cup.held_by == [None] * len(cup.t)


def test_featured_syringe_is_valid_until_it_is_lost(featured_episode_dir):
    ep = load_episode(featured_episode_dir)
    syringe = object_series(ep, grid_times(ep, 30))["syringe"]

    assert syringe.valid.tolist() == [150.0 <= t < 2500.0 for t in syringe.t]
    assert syringe.source[_at(syringe, 1800.0)] == "pinch"
    assert syringe.label == "syringe" and syringe.kind is None and syringe.radius is None


def test_series_share_the_resampled_grid(episode_dir):
    ep = load_episode(episode_dir)
    grid = resample_episode(ep, fps=30).t

    series = object_series(ep, grid)

    assert list(series) == ["shoulder", "middle", "hem"]
    assert all(np.array_equal(s.t, grid) for s in series.values())
    np.testing.assert_array_equal(grid_times(ep, 30), grid)


def test_plan_details_label_each_series(planned_episode_dir):
    ep = load_episode(planned_episode_dir)

    shoulder = object_series(ep, grid_times(ep, 30))["shoulder"]

    assert (shoulder.label, shoulder.kind, shoulder.radius, shoulder.hidden) == (
        "shoulder dot",
        "point",
        0.025,
        False,
    )


@pytest.mark.parametrize("gap, interpolated", [(80.0, False), (200.0, True), (300.0, False)])
def test_the_policy_decides_what_counts_as_a_gap(new_episode, gap, interpolated):
    b = _episode(new_episode)
    b.track(100.0, b.object_state("cup", [0.3, 0.0, -0.2], source="marker"))
    b.track(100.0 + gap, b.object_state("cup", [0.5, 0.0, -0.2], source="marker"))

    cup = _series(b, np.array([100.0 + gap / 2]))["cup"]

    assert cup.interpolated.tolist() == [interpolated]
    blended = gap <= 250.0
    np.testing.assert_allclose(cup.position[0, 0], 0.4 if blended else 0.3)


def test_a_detected_placement_is_valid_but_never_tracked(new_episode):
    # meta.objects is a snapshot taken when the episode was created; when it was measured is not
    # recorded, so it never counts as measured just now.
    placed = {"id": "cup", "label": "cup", "position": [0.3, 0.0, -0.2], "radius": 0.04}
    b = _episode(new_episode, objects=[{**placed, "method": "detector"}])

    cup = _series(b)["cup"]

    assert cup.valid.all() and not cup.tracked.any()
    assert cup.source == ["detector"] * len(GRID)


def test_a_loss_is_placed_at_its_line_not_at_its_observed_t(new_episode):
    b = _episode(new_episode)
    state = b.object_state
    b.track(100.0, state("cup", [0.3, 0.0, -0.2], source="detector", flags=10))
    b.track(390.0, state("cup", [0.3, 0.0, -0.2], source="detector", flags=0, observed_t=270.0))

    cup = _series(b)["cup"]

    assert cup.valid.tolist() == [100.0 <= t < 390.0 for t in cup.t]
