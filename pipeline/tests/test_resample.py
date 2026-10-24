import numpy as np
import pytest
from numpy.testing import assert_allclose

from clio_pipeline.episode import load_episode
from clio_pipeline.resample import resample_episode, resample_objects, uniform_times

Q_Y90 = [0.0, 0.7071, 0.0, 0.7071]
Q_Y45 = [0.0, 0.38268343, 0.0, 0.92387953]  # nlerp/slerp halfway from identity to Q_Y90
TITLE = "Fold a T-shirt in two seconds"


def _four_frames(new_episode, right_quat_at_50=Q_Y90):
    """Frames at t = 0, 50, 100, 150 ms. Left wrist x = 0.0, 0.1, 0.2, 0.3 and pinch 0.01 ..
    0.04; head x = 0.0, 0.2, 0.4, 0.6. Right hand: identity at 0, rotated at 50, untracked at
    100, back at 150. Step A is entered at t = 60."""
    b = new_episode()
    right = [
        b.hand((0.4, 0.08, -0.18)),
        b.hand((0.4, 0.08, -0.18), right_quat_at_50),
        None,
        b.hand((0.4, 0.08, -0.18), right_quat_at_50),
    ]
    for k in range(4):
        b.frame(
            50.0 * k,
            head=[0.2 * k, 0.45, 0.35, 0.0, 0.0, 0.0, 1.0],
            left=b.hand((0.1 * k, 0.08, -0.18), pinch=0.01 * (k + 1)),
            right=right[k],
        )
    b.step_entered(60.0, "a", 0, "Do A.")
    return load_episode(b.write())


def test_uniform_times_span_first_to_last_frame():
    assert_allclose(
        uniform_times(np.array([0.0, 50.0, 150.0]), fps=40), [0, 25, 50, 75, 100, 125, 150]
    )
    assert_allclose(uniform_times(np.array([10.0, 110.0]), fps=30), [10, 43.333333, 76.666667, 110])
    assert uniform_times(np.array([]), fps=30).shape == (0,)


def test_positions_and_pinch_are_interpolated_linearly(new_episode):
    r = resample_episode(_four_frames(new_episode), fps=40)

    assert_allclose(r.t, [0, 25, 50, 75, 100, 125, 150])
    assert_allclose(r.hands[:, 0, 0, 0], [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3], atol=1e-6)
    assert_allclose(r.pinch[:, 0], [0.01, 0.015, 0.02, 0.025, 0.03, 0.035, 0.04], atol=1e-6)
    assert_allclose(r.head[:, 0], [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6], atol=1e-12)


def test_hand_missing_in_either_neighbor_is_missing(new_episode):
    r = resample_episode(_four_frames(new_episode), fps=40)

    # source right hand: tracked at 0 and 50, missing at 100, tracked at 150
    assert r.tracked[:, 1].tolist() == [True, True, True, False, False, False, True]
    assert np.isnan(r.hands[3:6, 1]).all() and np.isnan(r.pinch[3:6, 1]).all()
    assert not np.isnan(r.hands[[0, 1, 2, 6], 1]).any()


def test_quaternions_are_interpolated_on_the_sphere(new_episode):
    r = resample_episode(_four_frames(new_episode), fps=40)

    assert_allclose(r.hands[1, 1, 0, 3:7], Q_Y45, atol=1e-4)
    assert_allclose(np.linalg.norm(r.hands[1, 1, :, 3:7], axis=-1), 1.0, atol=1e-6)


def test_quaternion_interpolation_takes_the_short_way_round(new_episode):
    flipped = [-c for c in Q_Y90]  # the same rotation as Q_Y90
    r = resample_episode(_four_frames(new_episode, right_quat_at_50=flipped), fps=40)

    assert_allclose(r.hands[1, 1, 0, 3:7], Q_Y45, atol=1e-4)


def test_labels_come_from_the_nearest_previous_frame(new_episode):
    r = resample_episode(_four_frames(new_episode), fps=40)

    assert r.source_index.tolist() == [0, 0, 1, 1, 2, 2, 3]
    # t = 75 is after step A was entered (60) but its nearest previous frame (50) is not.
    assert list(r.task) == [TITLE] * 4 + ["Do A."] * 3
    assert r.step_index.tolist() == [-1, -1, -1, -1, 0, 0, 0]


def test_default_episode_at_30_fps_has_90_frames(episode_dir):
    r = resample_episode(load_episode(episode_dir), fps=30)

    # 2983.333 ms of 60 Hz frames -> grid 0, 33.3, ..., 2966.7 (2983.333 * 30 / 1000 = 89.5)
    assert len(r.t) == 90
    assert r.hands.shape == (90, 2, 25, 8)


def test_object_positions_hold_the_latest_update(episode_dir):
    ep = load_episode(episode_dir)

    pos = resample_objects(ep, np.array([0.0, 600.0, 2000.0]), ["middle", "shoulder"])

    assert pos.shape == (3, 2, 3)
    assert_allclose(pos[:, 1], [[0.14, 0.0, -0.18], [0.141, 0.0, -0.181], [0.15, 0.02, -0.18]])
    assert_allclose(pos[:, 0], [[0.4, 0.0, -0.18], [0.4, 0.0, -0.18], [0.402, 0.001, -0.179]])


def test_object_positions_before_the_first_sighting_use_the_first_sighting(new_episode):
    b = new_episode(objects=[])
    b.frame(0.0)
    b.track(250.0, b.object_state("syringe", [0.2, 0.05, -0.1]))
    ep = load_episode(b.write())

    pos = resample_objects(ep, np.array([100.0, 300.0]), ["syringe", "never-seen"])

    assert_allclose(pos[:, 0], [[0.2, 0.05, -0.1], [0.2, 0.05, -0.1]])
    assert np.isnan(pos[:, 1]).all()


def test_rejects_a_non_positive_fps(episode_dir):
    with pytest.raises(ValueError, match="fps"):
        resample_episode(load_episode(episode_dir), fps=0)


def _gap_episode(new_episode):
    """Frames at 0, 50, 300 and 350 ms: a 250 ms hole between 50 and 300."""
    b = new_episode()
    for t in (0.0, 50.0, 300.0, 350.0):
        b.frame(t, head=[t / 1000, 0.45, 0.35, 0, 0, 0, 1], left=b.hand((t / 1000, 0.08, -0.18)))
    return load_episode(b.write())


def test_with_a_max_gap_a_longer_frame_gap_is_not_interpolated(new_episode):
    r = resample_episode(_gap_episode(new_episode), fps=40, max_gap_ms=100.0)

    inside = (r.t > 50.0) & (r.t < 300.0)  # 75 .. 275 ms
    assert r.head_valid.tolist() == (~inside).tolist() and r.max_gap_ms == 100.0
    assert np.isnan(r.head[inside]).all() and not np.isnan(r.head[~inside]).any()
    assert not r.tracked[inside].any() and r.tracked[~inside, 0].all()
    assert np.isnan(r.hands[inside]).all() and np.isnan(r.pinch[inside]).all()
    assert_allclose(r.hands[r.t == 25.0, 0, 0, 0], [0.025], atol=1e-6)  # a short gap still is


def test_without_a_max_gap_every_frame_gap_is_interpolated(new_episode):
    r = resample_episode(_gap_episode(new_episode), fps=40)

    assert r.head_valid.all() and r.max_gap_ms is None
    assert r.tracked[:, 0].all()
    assert_allclose(r.head[r.t == 175.0, 0], [0.175], atol=1e-9)
