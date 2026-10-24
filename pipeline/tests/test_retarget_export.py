"""The LeRobot export's robot-profile mode, without LeRobot: the arrays, and the export wiring
against a stand-in for `LeRobotDataset` (tests/test_lerobot_export.py runs the real one when the
`lerobot` extra is installed)."""

import json
import sys
import types

import numpy as np
import pytest
from numpy.testing import assert_allclose

from clio_pipeline.episode import load_episode
from clio_pipeline.lerobot_export import (
    RETARGET_RESIDUAL_KEY,
    RETARGET_VALID_KEY,
    episode_arrays,
    export_lerobot,
    lerobot_features,
    robot_state_names,
)
from clio_pipeline.resample import resample_episode
from clio_pipeline.retarget import DEFAULT_PROFILE, load_profile, retarget_episode
from clio_pipeline.retarget.kinematics import quat_to_matrix

REACH_DOWN = (-0.4226, 0.0, 0.0, 0.9063)  # fingers forward and down, as in test_retarget_run.py
JOINTS = 12  # two 6-DoF arms


@pytest.fixture(scope="module")
def profile():
    return load_profile(DEFAULT_PROFILE)


def gappy_episode(new_episode):
    """10 frames at 10 Hz: the left hand always tracked and reachable; the right hand reachable
    but untracked at frames 0-1 and 4-6."""
    b = new_episode("ep-gappy")
    for k in range(10):
        right = None if k in (0, 1, 4, 5, 6) else b.hand((0.53, 0.22, -0.02 - 0.01 * k), REACH_DOWN)
        b.frame(
            k * 100.0,
            left=b.hand((0.27, 0.22, -0.02 + 0.01 * k), REACH_DOWN, pinch=0.08 - 0.006 * k),
            right=right,
        )
    return b


def test_robot_state_is_joint_values_then_one_gripper_per_arm(profile):
    names = robot_state_names(profile)

    assert names[:6] == list(profile.arms[0].joints)
    assert names[6:12] == list(profile.arms[1].joints)
    assert names[12:] == ["left_gripper", "right_gripper"]
    features = lerobot_features(["cup"], profile)
    assert features["observation.state"]["names"] == names
    assert features["action"]["shape"] == (14,)
    for key in (RETARGET_VALID_KEY, RETARGET_RESIDUAL_KEY):
        assert features[key] == {"dtype": "float32", "shape": (2,), "names": ["left", "right"]}
    assert not any(k.startswith("action.") for k in features)  # not policy actions


def test_robot_arrays_hold_the_last_solved_values_and_mask_the_rest(new_episode, profile):
    episode = load_episode(gappy_episode(new_episode).write())
    result = retarget_episode(episode, profile, fps=10)
    arrays = episode_arrays(episode, fps=10, robot_profile=profile)
    right_q = result.arms[1].q

    assert arrays.state.shape == (10, 14) and arrays.state.dtype == np.float32
    assert not np.isnan(arrays.state).any()
    assert_allclose(
        arrays.retarget_valid,
        [[1, 0], [1, 0], [1, 1], [1, 1], [1, 0], [1, 0]] + [[1, 0]] + [[1, 1]] * 3,
    )
    assert_allclose(arrays.state[:, :6], result.arms[0].q, atol=1e-6)
    assert_allclose(arrays.state[0, 6:12], right_q[2], atol=1e-6)  # before first solved: first
    assert_allclose(arrays.state[4:7, 6:12], np.repeat(right_q[3:4], 3, axis=0), atol=1e-6)
    assert_allclose(arrays.state[:, 12], result.arms[0].gripper, atol=1e-6)
    assert_allclose(arrays.state[4:7, 13], np.repeat(result.arms[1].gripper[3], 3), atol=1e-6)
    assert_allclose(arrays.retarget_residual_pos[[0, 1, 4, 5, 6], 1], 0.0)  # no target
    assert_allclose(arrays.retarget_residual_pos[:, 0], result.arms[0].residual_pos, atol=1e-6)
    assert_allclose(arrays.hand_mask[:, 1], arrays.retarget_valid[:, 1])


def _tool(arm, chain, q):
    """The tool position of joint values `q`, in W."""
    base = arm.base_in_workspace
    return quat_to_matrix(base[3:]) @ chain.tip(q)[1] + base[:3]


def test_residual_pos_is_the_error_of_the_joint_values_exported(new_episode, profile):
    # The right hand is reachable for 5 frames, then far out of reach: those frames hold the
    # last solution, and their residual is that held configuration's error, not the solver's.
    b = new_episode("ep-reach-then-far")
    for k in range(10):
        right = (0.53, 0.22, -0.02) if k < 5 else (0.53, 0.22, -2.0)
        b.frame(
            k * 100.0,
            left=b.hand((0.27, 0.22, -0.02), REACH_DOWN),
            right=b.hand(right, REACH_DOWN) if k != 2 else None,
        )
    arrays = episode_arrays(load_episode(b.write()), fps=10, robot_profile=profile)
    right, chain = arrays.retargeted.arms[1], profile.arms[1].chain
    held = arrays.state[:, 6:12].astype(np.float64)

    has = right.has_target
    expected = [
        np.linalg.norm(_tool(right, chain, held[k]) - right.target[k, :3]) for k in range(10)
    ]

    assert has.tolist() == [k != 2 for k in range(10)]
    assert_allclose(arrays.retarget_valid[:, 1], [1, 1, 0, 1, 1, 0, 0, 0, 0, 0])
    assert_allclose(arrays.retarget_residual_pos[has, 1], np.array(expected)[has], atol=1e-4)
    assert arrays.retarget_residual_pos[2, 1] == 0.0  # no target
    # Held frames: much further off than the discarded best effort; solved ones: the same.
    assert np.all(arrays.retarget_residual_pos[5:, 1] > right.residual_pos[5:] + 0.1)
    solved = [0, 1, 3, 4]
    assert_allclose(arrays.retarget_residual_pos[solved, 1], right.residual_pos[solved], atol=1e-5)


def test_robot_export_holds_across_a_frame_gap_and_the_hands_export_bridges_it(
    frame_gap_episode_dir, profile
):
    episode = load_episode(frame_gap_episode_dir)

    robot = episode_arrays(episode, fps=30, robot_profile=profile)
    hands = episode_arrays(episode, fps=30)

    t = robot.resampled.t
    gap = (t > 1010.0) & (t < 2990.0)
    before = np.flatnonzero(t < 990.0)[-1]
    assert not robot.retarget_valid[gap].any() and not robot.hand_mask[gap].any()
    assert robot.retarget_valid[(t < 990.0) | (t > 3010.0)].all()
    assert_allclose(robot.state[gap], np.repeat(robot.state[before : before + 1], gap.sum(), 0))
    assert_allclose(robot.retarget_residual_pos[gap], 0.0)
    # human_hands, unchanged: every gap interpolated and marked tracked.
    assert hands.hand_mask.all()
    plain = resample_episode(episode, fps=30)
    assert np.array_equal(hands.resampled.tracked, plain.tracked)
    assert np.array_equal(hands.resampled.hands, plain.hands, equal_nan=True)
    assert len(set(np.round(hands.state[gap, 1], 4))) > 10  # the left wrist moves through it


def test_robot_action_is_the_next_state_a_one_frame_horizon(new_episode, profile):
    arrays = episode_arrays(
        load_episode(gappy_episode(new_episode).write()), fps=10, robot_profile=profile
    )

    assert_allclose(arrays.action[:-1], arrays.state[1:])
    assert_allclose(arrays.action[-1], arrays.state[-1])


def test_an_arm_that_is_never_solved_exports_zeros_with_valid_zero(episode_dir, profile):
    # the default episode's right hand points sideways at -x, low and far: out of reach
    arrays = episode_arrays(load_episode(episode_dir), fps=30, robot_profile=profile)

    assert not arrays.retarget_valid[:, 1].any()
    assert_allclose(arrays.state[:, 6:12], 0.0)
    assert arrays.retarget_valid[:, 0].all()


def test_without_a_robot_profile_the_arrays_are_unchanged(episode_dir):
    arrays = episode_arrays(load_episode(episode_dir), fps=30)

    assert arrays.state.shape == (90, 16)
    assert arrays.retargeted is None and arrays.retarget_valid is None


class _FakeDataset:
    """Records what export_lerobot hands to LeRobotDataset and checks it against the features."""

    created: list["_FakeDataset"] = []

    def __init__(self, root, features, robot_type, fps):
        self.root, self.features, self.robot_type, self.fps = root, features, robot_type, fps
        self.frames: list[dict] = []
        self.episodes = 0

    @classmethod
    def create(cls, repo_id, fps, features, root, robot_type, use_videos):
        root.mkdir(parents=True)
        dataset = cls(root, features, robot_type, fps)
        cls.created.append(dataset)
        return dataset

    def add_frame(self, frame):
        assert set(frame) == set(self.features) | {"task"}
        for key, value in frame.items():
            if self.features.get(key, {}).get("dtype") == "float32":
                assert value.dtype == np.float32 and value.shape == self.features[key]["shape"]
        self.frames.append(frame)

    def save_episode(self):
        self.episodes += 1

    def finalize(self):
        (self.root / "meta").mkdir()
        info = {"codebase_version": "v3.0", "robot_type": self.robot_type, "fps": self.fps}
        (self.root / "meta" / "info.json").write_text(json.dumps(info))


@pytest.fixture
def fake_lerobot(monkeypatch):
    _FakeDataset.created = []
    module = types.ModuleType("lerobot.datasets.lerobot_dataset")
    module.LeRobotDataset = _FakeDataset
    monkeypatch.setitem(sys.modules, "lerobot", types.ModuleType("lerobot"))
    monkeypatch.setitem(sys.modules, "lerobot.datasets", types.ModuleType("lerobot.datasets"))
    monkeypatch.setitem(sys.modules, "lerobot.datasets.lerobot_dataset", module)
    return _FakeDataset


def test_export_with_a_robot_profile_names_the_robot_and_records_its_provenance(
    episode_dir, profile, fake_lerobot, tmp_path
):
    result = export_lerobot(
        [episode_dir], tmp_path / "ds", repo_id="clio/test", robot_profile=profile
    )

    (dataset,) = fake_lerobot.created
    assert dataset.robot_type == "clio_arm_6dof"
    assert dataset.features["observation.state"]["names"] == robot_state_names(profile)
    assert len(dataset.frames) == 90 and result.episodes[0].frames == 90
    assert_allclose(dataset.frames[37][RETARGET_VALID_KEY], [1.0, 0.0])
    sidecar = json.loads((tmp_path / "ds" / "meta" / "clio_episodes.jsonl").read_text())
    retarget = sidecar["retarget"]
    assert retarget["profile_id"] == "clio-arm-6dof" and retarget["profile_version"] == 1
    assert retarget["urdf_sha256"] == profile.urdf_sha256
    assert retarget["example"] is True and retarget["action_horizon_frames"] == 1
    assert retarget["reachable_fraction"] == pytest.approx(90 / 165)  # the left arm only
    assert retarget["target_fraction"] == pytest.approx((90 + 75) / 180)


def test_export_without_a_robot_profile_keeps_the_human_hands_features(
    episode_dir, fake_lerobot, tmp_path
):
    export_lerobot([episode_dir], tmp_path / "ds", repo_id="clio/test")

    (dataset,) = fake_lerobot.created
    assert dataset.robot_type == "human_hands"
    assert RETARGET_VALID_KEY not in dataset.features
    sidecar = json.loads((tmp_path / "ds" / "meta" / "clio_episodes.jsonl").read_text())
    assert "retarget" not in sidecar
