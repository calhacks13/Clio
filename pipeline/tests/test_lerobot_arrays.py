import numpy as np
from numpy.testing import assert_allclose

from clio_pipeline.episode import load_episode
from clio_pipeline.lerobot_export import STATE_NAMES, episode_arrays

S = 0.7071  # the builder's quantized sin(45 deg)
TITLE = "Fold a T-shirt in two seconds"
LAY_FLAT = "Lay the shirt flat in the outline, face up, collar on the left."
PINCH_SHOULDER = "With your left hand, pinch the shirt at the shoulder dot."
PINCH_MIDDLE = "Keep holding. With your right hand, pinch the middle dot."

# Robot frame: x = -z_W, y = -x_W, z = +y_W. In the default episode the left wrist starts at
# W (0.1, 0.08, -0.18) with identity orientation and pinch 0.05; the right wrist sits at
# W (0.4, 0.08, -0.18), rotated 90 deg about W +y (= 90 deg about robot +x), pinch 0.04.
LEFT_0 = [0.18, -0.1, 0.08, 0.5, -0.5, -0.5, 0.5, 0.05]
RIGHT = [0.18, -0.4, 0.08, S, 0.0, 0.0, S, 0.04]


def test_state_is_wrist_pose_and_pinch_per_hand_in_the_robot_frame(episode_dir):
    arrays = episode_arrays(load_episode(episode_dir), fps=30)

    assert arrays.state.shape == (90, 16) and arrays.state.dtype == np.float32
    assert STATE_NAMES[:8] == [
        "left_wrist_x",
        "left_wrist_y",
        "left_wrist_z",
        "left_wrist_qx",
        "left_wrist_qy",
        "left_wrist_qz",
        "left_wrist_qw",
        "left_pinch",
    ]
    assert_allclose(arrays.state[0], LEFT_0 + RIGHT, atol=1e-5)


def test_missing_hand_holds_its_last_known_state_and_is_masked(episode_dir):
    arrays = episode_arrays(load_episode(episode_dir), fps=30)

    # grid frame 37 is t = 1233 ms, inside the right hand's dropout (source frames 60-89)
    assert_allclose(arrays.hand_mask[37], [1.0, 0.0])
    assert_allclose(arrays.state[37, 8:], RIGHT, atol=1e-5)
    assert not np.isnan(arrays.state).any()


def test_hand_never_seen_before_takes_its_first_tracked_state(new_episode):
    b = new_episode()
    b.frame(0.0, left=None)
    b.frame(100.0, left=b.hand((0.1, 0.2, -0.3), pinch=0.02))
    arrays = episode_arrays(load_episode(b.write()), fps=10)

    assert_allclose(arrays.hand_mask[:, 0], [0.0, 1.0])
    assert_allclose(arrays.state[0, :8], [0.3, -0.1, 0.2, 0.5, -0.5, -0.5, 0.5, 0.02], atol=1e-5)
    # the right hand is never tracked: zeros, identity orientation, closed pinch
    assert_allclose(arrays.state[:, 8:], [[0, 0, 0, 0, 0, 0, 1, 0]] * 2)


def test_action_is_the_next_state_and_the_last_frame_repeats(episode_dir):
    arrays = episode_arrays(load_episode(episode_dir), fps=30)

    assert_allclose(arrays.action[:-1], arrays.state[1:])
    assert_allclose(arrays.action[-1], arrays.state[-1])


def test_environment_state_lists_object_positions_by_sorted_id(episode_dir):
    arrays = episode_arrays(
        load_episode(episode_dir), fps=30, object_ids=["hem", "middle", "shoulder"]
    )

    assert arrays.environment_state.shape == (90, 9)
    # shoulder at W (0.14, 0, -0.18) until the tracker moves it at t = 500
    assert_allclose(arrays.environment_state[0, 6:], [0.18, -0.14, 0.0], atol=1e-6)
    assert_allclose(arrays.environment_state[0, :3], [0.18, -0.68, 0.0], atol=1e-6)  # hem


def test_task_is_the_active_step_instruction(episode_dir):
    arrays = episode_arrays(load_episode(episode_dir), fps=30)

    # grid frame k is t = k * 33.3 ms
    assert [arrays.task[k] for k in (2, 10, 45, 80)] == [
        TITLE,
        LAY_FLAT,
        PINCH_SHOULDER,
        PINCH_MIDDLE,
    ]


def test_episode_without_frames_gives_empty_arrays_of_the_right_width(new_episode):
    arrays = episode_arrays(load_episode(new_episode().write()), fps=30, object_ids=["a", "b"])

    assert len(arrays) == 0
    assert arrays.state.shape == (0, 16) and arrays.action.shape == (0, 16)
    assert arrays.environment_state.shape == (0, 6)
