import copy
import hashlib
import json
import shutil

import numpy as np
import pytest
from numpy.testing import assert_allclose

from clio_pipeline.frames import quat_rotate
from clio_pipeline.retarget import DEFAULT_PROFILE, PROFILES_DIR, load_profile

BUNDLED = json.loads(DEFAULT_PROFILE.read_text())
URDF = (PROFILES_DIR / BUNDLED["urdf"]["path"]).resolve()


@pytest.fixture
def write_profile(tmp_path):
    """Copies the bundled profile and URDF into tmp_path (same layout) with the given changes."""

    def write(change=None, urdf_text: str | None = None):
        (tmp_path / "robots").mkdir(exist_ok=True)
        (tmp_path / "profiles").mkdir(exist_ok=True)
        urdf = tmp_path / "robots" / URDF.name
        if urdf_text is None:
            shutil.copy(URDF, urdf)
        else:
            urdf.write_text(urdf_text)
        doc = copy.deepcopy(BUNDLED)
        if change:
            change(doc)
        path = tmp_path / "profiles" / "test.json"
        path.write_text(json.dumps(doc))
        return path

    return write


def test_bundled_profile_is_an_example_with_one_arm_per_hand():
    profile = load_profile(DEFAULT_PROFILE)

    assert (profile.id, profile.version, profile.example) == ("clio-arm-6dof", 1, True)
    assert (profile.robot, profile.robot_type) == ("clio_arm_6dof", "clio_arm_6dof")
    assert profile.artifact_name == "retarget-clio-arm-6dof.json"
    assert profile.urdf_sha256 == hashlib.sha256(URDF.read_bytes()).hexdigest()
    assert [arm.hand for arm in profile.arms] == ["left", "right"]
    assert profile.arms[0].joints == (
        "left_shoulder_pan",
        "left_shoulder_lift",
        "left_elbow",
        "left_wrist_roll",
        "left_wrist_pitch",
        "left_wrist_rotate",
    )
    assert all(name.startswith("right_") for name in profile.arms[1].joints)
    assert (profile.ik.mode, profile.tcp_target) == ("approach_axis", "pinch_point")


def test_base_pose_is_given_in_the_export_frame_and_reported_in_the_workspace_frame():
    left, right = load_profile(DEFAULT_PROFILE).arms

    # robot frame (x = -z_W, y = -x_W, z = +y_W): 0.2 m behind the near edge, 0.3 / 0.5 m along
    assert_allclose(left.base_in_workspace[:3], [0.3, 0.0, 0.2], atol=1e-12)
    assert_allclose(right.base_in_workspace[:3], [0.5, 0.0, 0.2], atol=1e-12)
    q = left.base_in_workspace[3:]
    assert_allclose(quat_rotate(q, [1, 0, 0]), [0, 0, -1], atol=1e-12)  # base x: away from user
    assert_allclose(quat_rotate(q, [0, 0, 1]), [0, 1, 0], atol=1e-12)  # base z: up


def test_urdf_path_resolves_relative_to_the_profile_file(write_profile, monkeypatch, tmp_path):
    path = write_profile()
    monkeypatch.chdir(tmp_path / "robots")

    assert load_profile(path).urdf_path == (tmp_path / "robots" / URDF.name).resolve()


def test_a_urdf_that_no_longer_matches_its_pinned_sha256_is_refused(write_profile):
    path = write_profile(urdf_text=URDF.read_text().replace('upper="2.6"', 'upper="2.7"'))

    with pytest.raises(ValueError, match="SHA-256"):
        load_profile(path)


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda d: d.pop("solver"), "'solver' is a required property"),
        (lambda d: d["orientation"].update(mode="sideways"), "is not one of"),
        (lambda d: d["arms"][0].update(hand="third"), "is not one of"),
        (lambda d: d.update(id="Has Spaces"), "does not match"),
        (lambda d: d["tcp"].update(toolAlign=[0, 0, 1]), "too short"),
        (lambda d: d.update(colour="red"), "Additional properties"),
        (lambda d: d["solver"].update(maxIterations=0), "less than the minimum"),
    ],
)
def test_profile_that_breaks_the_schema_is_refused(write_profile, change, message):
    with pytest.raises(ValueError, match=message):
        load_profile(write_profile(change))


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda d: d["arms"][1].update(hand="left"), "only one arm"),
        (lambda d: d["arms"][1].update(baseLink="left_base_link", tipLink="left_tcp"), "share"),
        (lambda d: d["arms"][0].update(tipLink="left_elbow_link"), "no link"),
        (lambda d: d["arms"][0].update(restPose=[0, 0, 0]), "restPose has 3 values"),
        (lambda d: d["arms"][0].update(restPose=[0, 0, 3.0, 0, 0, 0]), "outside the joint limits"),
        (lambda d: d["gripper"].update(pinchOpenM=0.01), "larger than pinchClosedM"),
        (lambda d: d["tcp"].update(toolAlign=[0, 0, 0, 0]), "is zero"),
        (lambda d: d["urdf"].update(path="missing.urdf"), "does not exist"),
    ],
)
def test_profile_that_does_not_fit_its_robot_is_refused(write_profile, change, message):
    with pytest.raises(ValueError, match=message):
        load_profile(write_profile(change))


def test_quaternions_in_a_profile_are_normalized(write_profile):
    path = write_profile(lambda d: d["tcp"].update(toolAlign=[2.0, 0.0, 0.0, 0.0]))

    assert_allclose(load_profile(path).tool_align, [1, 0, 0, 0])
    assert np.isclose(np.linalg.norm(load_profile(path).arms[0].base_in_workspace[3:]), 1.0)
