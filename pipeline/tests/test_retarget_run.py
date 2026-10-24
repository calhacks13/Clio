import json
import math
import time
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest
from jsonschema import Draft202012Validator
from numpy.testing import assert_allclose

from clio_pipeline.episode import load_episode
from clio_pipeline.frames import INDEX_TIP, THUMB_TIP, WRIST
from clio_pipeline.resample import resample_episode
from clio_pipeline.retarget import DEFAULT_PROFILE, load_profile, retarget_doc, retarget_episode
from clio_pipeline.retarget.run import tool_targets

SCHEMA_DIR = Path(__file__).resolve().parents[2] / "packages" / "protocol" / "schema"
# Wrist turned 50 degrees about +x: fingers forward and down, as the synthetic fixtures hold it.
REACH_DOWN = (-0.4226, 0.0, 0.0, 0.9063)


@pytest.fixture(scope="module")
def profile():
    return load_profile(DEFAULT_PROFILE)


@pytest.fixture(scope="module")
def retarget_schema():
    return Draft202012Validator(
        json.loads((SCHEMA_DIR / "derived-retarget.schema.json").read_text())
    )


def arm_limits(profile, hand):
    chain = next(arm.chain for arm in profile.arms if arm.hand == hand)
    return chain.lower, chain.upper


def smooth_episode(new_episode, episode_id="ep-smooth", seconds=8.0, hz=30.0):
    """Both hands trace slow loops above the table, inside the example arms' reach."""
    b = new_episode(episode_id)
    for k in range(int(seconds * hz)):
        t = k * 1000.0 / hz
        a = 2 * math.pi * t / 4000.0
        left = (
            0.27 + 0.06 * math.cos(a),
            0.22 + 0.03 * math.sin(2 * a),
            -0.02 + 0.06 * math.sin(a),
        )
        right = (0.53 - 0.06 * math.cos(a), 0.22 + 0.03 * math.cos(a), -0.02 + 0.05 * math.sin(a))
        b.frame(
            round(t, 3),
            left=b.hand(left, REACH_DOWN, pinch=0.05),
            right=b.hand(right, REACH_DOWN, pinch=0.05),
        )
    return b


def test_retargeting_runs_on_the_compiled_tracks_grid(episode_dir, profile):
    episode = load_episode(episode_dir)

    result = retarget_episode(episode, profile, fps=30)

    assert np.array_equal(result.t, resample_episode(episode, 30).t)
    assert result.fps == 30 and len(result) == 90
    assert [arm.hand for arm in result.arms] == ["left", "right"]
    left = result.arms[0]
    assert left.q.shape == (90, 6) and left.links.shape == (90, 9, 3)
    assert left.target.shape == left.achieved.shape == (90, 7)


def test_an_untracked_hand_gets_no_target_and_no_joints(episode_dir, profile):
    episode = load_episode(episode_dir)
    tracked = resample_episode(episode, 30).tracked[:, 1]
    assert not tracked.all()  # the right hand drops out from t = 1000 to 1483 ms

    result = retarget_episode(episode, profile)
    right, doc = result.arms[1], retarget_doc(result, episode)["arms"][1]

    assert np.array_equal(right.has_target, tracked)
    assert np.isnan(right.q[~tracked]).all() and not right.reachable[~tracked].any()
    missing = np.flatnonzero(~tracked)
    for key in ("q", "gripper", "target", "achieved", "residualPosM", "residualRotRad", "links"):
        assert all(doc[key][k] is None for k in missing), key
    assert all(doc["q"][k] is not None for k in np.flatnonzero(tracked))


def test_smooth_hand_motion_gives_a_continuous_reachable_trajectory(new_episode, profile):
    result = retarget_episode(load_episode(smooth_episode(new_episode).write()), profile)

    for arm in result.arms:
        lower, upper = arm_limits(profile, arm.hand)
        assert arm.reachable.all(), arm.hand
        assert np.max(np.abs(np.diff(arm.q, axis=0))) < 0.5
        assert np.all((arm.q >= lower) & (arm.q <= upper))
        assert np.max(arm.residual_pos) <= profile.ik.tol_pos_m
        assert_allclose(arm.achieved[:, :3], arm.target[:, :3], atol=profile.ik.tol_pos_m)


def test_an_unreachable_hand_is_flagged_with_its_residual_not_forced(new_episode, profile):
    b = new_episode("ep-far")
    for k in range(10):
        b.frame(
            k * 100.0, left=b.hand((0.3, 0.2, -0.05), REACH_DOWN), right=b.hand((0.5, 0.2, -2.0))
        )
    result = retarget_episode(load_episode(b.write()), profile, fps=10)
    left, right = result.arms

    assert left.reachable.all()
    assert not right.reachable.any() and right.has_target.all()
    assert np.all(right.residual_pos > 1.0)
    lower, upper = arm_limits(profile, "right")
    assert np.all((right.q >= lower) & (right.q <= upper))
    assert result.summary.reachable_fraction == 0.5
    assert result.summary.target_fraction == 1.0


def test_retarget_doc_validates_against_the_protocol_schema(episode_dir, profile, retarget_schema):
    episode = load_episode(episode_dir)
    doc = retarget_doc(retarget_episode(episode, profile), episode)

    assert list(retarget_schema.iter_errors(doc)) == []
    assert (doc["schema"], doc["kind"], doc["frame"], doc["fps"]) == (
        "clio.derived/1",
        "retarget",
        "workspace",
        30,
    )
    assert doc["episodeId"] == "ep-20261024-031502-test"
    assert doc["profile"] == {
        "id": "clio-arm-6dof",
        "version": 1,
        "robot": "Clio example arm",
        "robotType": "clio_arm_6dof",
        "urdfSha256": profile.urdf_sha256,
        "example": True,
        "orientationMode": "approach_axis",
        "tolPosM": 0.005,
        "tolRotRad": 0.09,
    }
    assert doc["t"][:3] == [0.0, 33.33, 66.67]
    assert doc["arms"][0]["baseInWorkspace"] == [0.3, 0.0, 0.2, -0.5, 0.5, 0.5, 0.5]
    text = json.dumps(doc, allow_nan=False)  # raises on NaN
    assert "-0.0," not in text
    q = doc["arms"][0]["q"][0]
    assert all(round(v, 5) == v for v in q)


def test_retarget_doc_of_an_episode_without_frames_is_still_valid(
    new_episode, profile, retarget_schema
):
    episode = load_episode(new_episode("ep-empty").write())
    doc = retarget_doc(retarget_episode(episode, profile), episode)

    assert list(retarget_schema.iter_errors(doc)) == []
    assert doc["t"] == [] and doc["arms"][0]["q"] == []
    assert doc["summary"] == {
        "reachableFraction": 0.0,
        "targetFraction": 0.0,
        "meanResidualPosM": None,
    }


def test_retargeting_is_deterministic(episode_dir, profile):
    episode = load_episode(episode_dir)

    first = retarget_doc(retarget_episode(episode, profile), episode)
    second = retarget_doc(retarget_episode(load_episode(episode_dir), profile), episode)

    assert json.dumps(first) == json.dumps(second)


def test_achieved_poses_and_links_are_in_the_workspace_frame(new_episode, profile):
    result = retarget_episode(
        load_episode(smooth_episode(new_episode, seconds=1.0).write()), profile
    )

    for arm in result.arms:
        assert_allclose(arm.links[:, 0], np.broadcast_to(arm.base_in_workspace[:3], (30, 3)))
        assert_allclose(arm.links[:, -1], arm.achieved[:, :3], atol=1e-9)  # last point: the tool


def test_tool_target_is_the_chosen_hand_point_with_the_wrist_orientation(episode_dir, profile):
    hands = resample_episode(load_episode(episode_dir), 30).hands[:, 0].astype(np.float64)
    pinch_point = 0.5 * (hands[:, THUMB_TIP, :3] + hands[:, INDEX_TIP, :3])

    target = tool_targets(hands, profile)

    assert_allclose(target[:, :3], pinch_point)
    # toolAlign is 180 degrees about x: the tool's +z runs along the fingers (wrist -z)
    assert_allclose(target[0, 3:], [1.0, 0.0, 0.0, 0.0], atol=1e-6)
    wrist = tool_targets(
        hands,
        replace(profile, tcp_target="wrist", wrist_to_tcp=np.array([0, 0, -0.1, 0, 0, 0, 1.0])),
    )
    assert_allclose(wrist[:, :3], hands[:, WRIST, :3] + [0, 0, -0.1], atol=1e-6)
    scaled = tool_targets(hands, replace(profile, workspace_scale=0.5))
    pivot = profile.workspace_pivot
    assert_allclose(scaled[:, :3], pivot + 0.5 * (pinch_point - pivot))


def test_gripper_follows_the_pinch_and_closes_while_an_object_is_held(new_episode, profile):
    b = new_episode("ep-grasp")
    b.meta["features"] = ["object.grasp"]
    pinches = [0.09, 0.08, 0.05, 0.02, 0.01, 0.07, 0.07, 0.07]
    for k, pinch in enumerate(pinches):
        b.frame(k * 100.0, right=b.hand((0.5, 0.2, -0.05), REACH_DOWN, pinch=pinch))
    b.event(
        500.0, "object.grasped", objectId="cup", hand="right", grip="pinch", position=[0.5, 0, -0.2]
    )
    b.event(
        700.0,
        "object.released",
        objectId="cup",
        hand="right",
        reason="opened",
        position=[0.5, 0, -0.2],
    )
    result = retarget_episode(load_episode(b.write()), profile, fps=10)
    left, right = result.arms

    # open at 0.08 m, closed at 0.02 m, clamped; held from 500 to 700 ms
    assert_allclose(right.gripper, [0.0, 0.0, 0.5, 1.0, 1.0, 1.0, 1.0, 1.0 / 6.0], atol=1e-6)
    assert np.isnan(left.gripper).all()  # the left hand is never tracked


def test_without_recorded_grasps_the_gripper_follows_the_pinch_alone(new_episode, profile):
    b = new_episode("ep-no-grasp-feature")
    for k in range(3):
        b.frame(k * 100.0, right=b.hand((0.5, 0.2, -0.05), REACH_DOWN, pinch=0.07))
    b.event(0.0, "object.grasped", objectId="cup", hand="right", grip="pinch", position=[0, 0, 0])
    result = retarget_episode(load_episode(b.write()), profile, fps=10)

    assert_allclose(result.arms[1].gripper, [1.0 / 6.0] * 3, atol=1e-6)


def test_a_minute_of_two_handed_motion_retargets_in_a_few_seconds(new_episode, profile):
    episode = load_episode(smooth_episode(new_episode, "ep-minute", seconds=60.0).write())

    start = time.perf_counter()
    result = retarget_episode(episode, profile)
    elapsed = time.perf_counter() - start

    assert len(result) == 1800 and len(result.arms) == 2
    assert elapsed < 3.0  # about 0.45 s when measured


def test_a_gap_in_the_recorded_frames_gets_no_target(frame_gap_episode_dir, profile):
    episode = load_episode(frame_gap_episode_dir)

    result = retarget_episode(episode, profile)

    gap = (result.t > 1010.0) & (result.t < 2990.0)
    outside = (result.t < 990.0) | (result.t > 3010.0)
    for arm in result.arms:
        assert not arm.has_target[gap].any() and not arm.reachable[gap].any(), arm.hand
        assert np.isnan(arm.gripper[gap]).all()
        assert arm.has_target[outside].all() and arm.reachable[outside].all(), arm.hand
