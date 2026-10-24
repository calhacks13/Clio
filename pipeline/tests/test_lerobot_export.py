import json

import pytest
from numpy.testing import assert_allclose

from clio_pipeline.lerobot_export import STATE_NAMES, export_lerobot, robot_state_names
from clio_pipeline.retarget import DEFAULT_PROFILE, load_profile

lerobot_dataset = pytest.importorskip("lerobot.datasets.lerobot_dataset")

S = 0.7071
TITLE = "Fold a T-shirt in two seconds"
LAY_FLAT = "Lay the shirt flat in the outline, face up, collar on the left."
PINCH_SHOULDER = "With your left hand, pinch the shirt at the shoulder dot."
PINCH_MIDDLE = "Keep holding. With your right hand, pinch the middle dot."
LEFT_0 = [0.18, -0.1, 0.08, 0.5, -0.5, -0.5, 0.5, 0.05]  # see test_lerobot_arrays.py
RIGHT = [0.18, -0.4, 0.08, S, 0.0, 0.0, S, 0.04]


def _load(root):
    return lerobot_dataset.LeRobotDataset("clio/test", root=root)


@pytest.fixture
def exported(episode_dir, tmp_path):
    result = export_lerobot([episode_dir], tmp_path / "dataset", repo_id="clio/test", fps=30)
    return result, _load(tmp_path / "dataset")


def test_exported_dataset_loads_back_with_frames_tasks_and_state(exported):
    result, ds = exported

    assert (ds.num_episodes, len(ds), ds.fps) == (1, 90, 30)
    assert [ds[k]["task"] for k in (2, 10, 45, 80)] == [
        TITLE,
        LAY_FLAT,
        PINCH_SHOULDER,
        PINCH_MIDDLE,
    ]
    item = ds[0]
    assert tuple(item["observation.state"].shape) == (16,)
    assert_allclose(item["observation.state"].numpy(), LEFT_0 + RIGHT, atol=1e-5)
    assert_allclose(ds[37]["observation.hand_mask"].numpy(), [1.0, 0.0])
    assert tuple(item["observation.environment_state"].shape) == (9,)
    assert item["step.action_verb"] == ""
    assert result.codebase_version == "v3.0"


def test_dataset_metadata_names_the_robot_and_features(exported, tmp_path):
    info = json.loads((tmp_path / "dataset" / "meta" / "info.json").read_text())

    assert (info["codebase_version"], info["robot_type"], info["fps"]) == (
        "v3.0",
        "human_hands",
        30,
    )
    assert info["features"]["observation.state"]["names"] == STATE_NAMES
    assert info["features"]["observation.environment_state"]["names"][:3] == [
        "hem_x",
        "hem_y",
        "hem_z",
    ]


def test_each_clio_episode_becomes_one_lerobot_episode_with_provenance(
    make_default_episode, tmp_path
):
    first = make_default_episode("ep-first")
    planned = make_default_episode("ep-planned", plan=True)

    result = export_lerobot([first, planned], tmp_path / "ds2", repo_id="clio/test", fps=30)
    ds = _load(tmp_path / "ds2")

    assert (ds.num_episodes, len(ds)) == (2, 180)
    assert [ds[90 + k]["step.action_verb"] for k in (10, 45, 80)] == ["other", "pinch", ""]
    sidecar = [
        json.loads(line)
        for line in (tmp_path / "ds2" / "meta" / "clio_episodes.jsonl").read_text().splitlines()
    ]
    assert [(s["episode_index"], s["episode_id"], s["frames"]) for s in sidecar] == [
        (0, "ep-first", 90),
        (1, "ep-planned", 90),
    ]
    assert sidecar[1]["plan_origin"]["kind"] == "generated"
    assert [m["kind"] for m in sidecar[0]["mistakes"]] == ["wrong_hand"]
    assert sidecar[0]["mistakes"][0]["frame_index"] == 45  # t = 1500 ms
    assert sidecar[0]["skipped_media"] == ["egocentric.webm"]
    assert [e.frames for e in result.episodes] == [90, 90]


def test_refuses_to_overwrite_an_existing_dataset_unless_asked(episode_dir, tmp_path):
    out = tmp_path / "dataset"
    out.mkdir()
    (out / "keep.txt").write_text("x")

    with pytest.raises(FileExistsError):
        export_lerobot([episode_dir], out, repo_id="clio/test")

    export_lerobot([episode_dir], out, repo_id="clio/test", overwrite=True)
    assert not (out / "keep.txt").exists()
    assert _load(out).num_episodes == 1


def test_episode_without_frames_is_skipped(episode_dir, new_episode, tmp_path):
    empty = new_episode("ep-empty").write()

    result = export_lerobot([empty, episode_dir], tmp_path / "ds", repo_id="clio/test")

    assert result.skipped == [(empty, "no frames")]
    assert [e.episode_id for e in result.episodes] == ["ep-20261024-031502-test"]
    assert _load(tmp_path / "ds").num_episodes == 1


def test_nothing_to_export_is_an_error(new_episode, tmp_path):
    with pytest.raises(ValueError, match="no frames"):
        export_lerobot([new_episode("ep-empty").write()], tmp_path / "ds", repo_id="clio/test")
    assert not (tmp_path / "ds").exists()


def test_free_recording_without_procedure_exports_an_empty_task(new_episode, tmp_path):
    b = new_episode("ep-free", procedure=None)
    for k in range(4):
        b.frame(k * 100.0, left=b.hand((0.1, 0.1, -0.2)))
    export_lerobot([b.write()], tmp_path / "ds", repo_id="clio/test", fps=10)

    ds = _load(tmp_path / "ds")

    assert [ds[k]["task"] for k in range(len(ds))] == [""] * 4


def test_robot_profile_exports_the_retargeted_joint_trajectory(episode_dir, tmp_path):
    profile = load_profile(DEFAULT_PROFILE)
    export_lerobot([episode_dir], tmp_path / "robot", repo_id="clio/test", robot_profile=profile)

    ds = _load(tmp_path / "robot")
    info = json.loads((tmp_path / "robot" / "meta" / "info.json").read_text())

    assert (info["robot_type"], ds.num_episodes, len(ds)) == ("clio_arm_6dof", 1, 90)
    names = info["features"]["observation.state"]["names"]
    assert names == robot_state_names(profile)
    assert names[0] == "left_shoulder_pan" and names[-2:] == ["left_gripper", "right_gripper"]
    assert info["features"]["action"]["names"] == names
    item = ds[37]
    assert tuple(item["observation.state"].shape) == (14,)
    assert_allclose(item["observation.retarget.valid"].numpy(), [1.0, 0.0])
    assert tuple(item["observation.retarget.residual_pos"].shape) == (2,)
    assert_allclose(ds[36]["action"].numpy(), item["observation.state"].numpy())
    sidecar = json.loads((tmp_path / "robot" / "meta" / "clio_episodes.jsonl").read_text())
    assert sidecar["retarget"]["urdf_sha256"] == profile.urdf_sha256
