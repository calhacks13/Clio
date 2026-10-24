import numpy as np
from numpy.testing import assert_allclose

from clio_pipeline.frames import (
    FINGER_CHAINS,
    HAND_JOINTS,
    INDEX_TIP,
    JOINT_INDEX,
    PINKY_TIP,
    THUMB_TIP,
    WRIST,
    make_quaternions_continuous,
    quat_rotate,
    workspace_to_robot_pose,
    workspace_to_robot_position,
    workspace_to_robot_quaternion,
)

S = np.sqrt(0.5)  # sin(45 deg) = cos(45 deg)


def test_named_joint_indices_match_the_protocol_offsets():
    # packages/protocol/test/episode.test.ts: thumb-tip at offset 32, index tip 72, pinky tip 192
    assert (WRIST, THUMB_TIP, INDEX_TIP, PINKY_TIP) == (0, 32 // 8, 72 // 8, 192 // 8)
    assert JOINT_INDEX["middle-finger-metacarpal"] == 10


def test_finger_chains_run_from_the_wrist_to_each_tip_covering_every_joint_once():
    assert [chain[-1] for chain in FINGER_CHAINS] == [4, 9, 14, 19, 24]
    assert all(chain[0] == 0 for chain in FINGER_CHAINS)
    assert sorted(j for chain in FINGER_CHAINS for j in chain[1:]) == list(range(1, 25))
    assert [HAND_JOINTS[j] for j in FINGER_CHAINS[0]] == [
        "wrist",
        "thumb-metacarpal",
        "thumb-phalanx-proximal",
        "thumb-phalanx-distal",
        "thumb-tip",
    ]


def test_position_converts_to_z_up_robot_frame():
    # x_r = -z_W, y_r = -x_W, z_r = +y_W
    assert_allclose(workspace_to_robot_position([1.0, 2.0, 3.0]), [-3.0, -1.0, 2.0])


def test_position_conversion_maps_each_workspace_axis():
    axes = np.eye(3).reshape(1, 3, 3)  # batch dims are kept
    assert_allclose(
        workspace_to_robot_position(axes),
        [
            [
                [0.0, -1.0, 0.0],  # +x (along the table edge) -> robot right (-y)
                [0.0, 0.0, 1.0],  # +y (up) -> robot up
                [-1.0, 0.0, 0.0],  # +z (toward the user) -> robot backward
            ]
        ],
    )


def test_nan_positions_stay_nan():
    assert np.isnan(workspace_to_robot_position([np.nan, np.nan, np.nan])).all()


def test_quat_rotate_rotates_vectors():
    z90 = [0.0, 0.0, S, S]
    assert_allclose(quat_rotate(z90, [1.0, 0.0, 0.0]), [0.0, 1.0, 0.0], atol=1e-12)


def test_identity_orientation_becomes_the_frame_change_rotation():
    q = workspace_to_robot_quaternion([0.0, 0.0, 0.0, 1.0])

    assert_allclose(q, [0.5, -0.5, -0.5, 0.5])
    # An object aligned with W has its local +x along W's +x, which is robot -y.
    assert_allclose(quat_rotate(q, [1.0, 0.0, 0.0]), [0.0, -1.0, 0.0], atol=1e-12)


def test_rotation_about_up_stays_a_rotation_about_up():
    # 90 deg about W +y (up) turns local +x to W -z (away from the user = robot forward)...
    q_w = [0.0, S, 0.0, S]
    q_r = workspace_to_robot_quaternion(q_w)

    # ...so in the robot frame local +x points forward (+x) and local +y stays up (+z).
    assert_allclose(quat_rotate(q_r, [1.0, 0.0, 0.0]), [1.0, 0.0, 0.0], atol=1e-12)
    assert_allclose(quat_rotate(q_r, [0.0, 1.0, 0.0]), [0.0, 0.0, 1.0], atol=1e-12)
    assert_allclose(q_r, [S, 0.0, 0.0, S], atol=1e-12)  # = 90 deg about robot +x


def test_pose_converts_position_and_orientation():
    pose = workspace_to_robot_pose([[1.0, 2.0, 3.0, 0.0, 0.0, 0.0, 1.0]])
    assert_allclose(pose, [[-3.0, -1.0, 2.0, 0.5, -0.5, -0.5, 0.5]])


def test_quaternion_signs_are_made_continuous_over_time():
    q = np.array([[0, 0, 0, 1.0], [0, 0, 0, -1.0], [np.nan] * 4, [0, 0, 0.1, -0.995]])

    out = make_quaternions_continuous(q)

    assert_allclose(out[[0, 1, 3]], [[0, 0, 0, 1.0], [0, 0, 0, 1.0], [0, 0, -0.1, 0.995]])
    assert np.isnan(out[2]).all()
