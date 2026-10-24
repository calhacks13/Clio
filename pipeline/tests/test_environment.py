import math

import numpy as np
import pytest

from clio_pipeline.environment import environment_doc
from clio_pipeline.episode import load_episode
from clio_pipeline.frames import quat_rotate

IDENTITY = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]
YAW_90 = [0.0, 0.7071, 0.0, 0.7071]
YAW_30 = [0.0, round(math.sin(math.pi / 12), 4), 0.0, round(math.cos(math.pi / 12), 4)]
# A 1.24 x 0.8 m table outline centered on its plane's origin.
CENTERED = [[-0.62, -0.4], [0.62, -0.4], [0.62, 0.4], [-0.62, 0.4]]


def _doc(b):
    return environment_doc(load_episode(b.write()))


def test_the_table_is_the_workspace_origin_sized_by_the_plan(planned_episode_dir):
    doc = environment_doc(load_episode(planned_episode_dir))

    assert doc["table"] == {"pose": IDENTITY, "size": [0.8, 0.6], "source": "plan"}
    assert (doc["schema"], doc["kind"], doc["frame"]) == (
        "clio.derived/1",
        "environment",
        "workspace",
    )


def _table_corners(table):
    """The table rectangle's corners in W, from its pose and [+x, -z] size."""
    pose = np.array(table["pose"])
    sx, sz = table["size"]
    local = np.array([[0, 0, 0], [sx, 0, 0], [sx, 0, -sz], [0, 0, -sz]], dtype=float)
    return quat_rotate(pose[3:], local) + pose[:3]


def _plane_corners(plane):
    pose = np.array(plane["pose"], dtype=float)
    local = np.array([[x, 0.0, z] for x, z in plane["polygon"]])
    return quat_rotate(pose[3:] / np.linalg.norm(pose[3:]), local) + pose[:3]


def _same_points(a, b):
    a, b = np.round(a, 3).tolist(), np.round(b, 3).tolist()
    return sorted(a) == sorted(b)


def test_without_a_plan_the_largest_detected_table_is_the_table(new_episode):
    b = new_episode()
    b.frame(0.0)
    small = [[0, 0], [0.2, 0], [0.2, -0.1], [0, -0.1]]
    turned = [[0, 0], [0.5, 0], [0.5, -1.2], [0, -1.2]]  # 0.5 along its x, 1.2 along its -z
    big = b.plane("plane-2", pose=[0, 0, 0, *YAW_90], polygon=turned)
    b.planes(0.0, b.plane("plane-1", polygon=small), big)

    table = _doc(b)["table"]

    # Sized along the plane's own axes, and turned with it.
    assert table == {"pose": [0.0, 0.0, 0.0, *YAW_90], "size": [0.5, 1.2], "source": "planes"}
    assert _same_points(_table_corners(table), _plane_corners(big))


def test_a_table_from_a_plane_sits_on_the_plane_not_at_the_workspace_origin(new_episode):
    b = new_episode()
    b.frame(0.0)
    detected = b.plane("plane-2", pose=[0.5, 0, -0.32, 0, 0, 0, 1], polygon=CENTERED)
    b.planes(0.0, detected)

    table = _doc(b)["table"]

    # The outline spans x -0.12 .. 1.12 and z -0.72 .. 0.08 in W.
    assert table == {
        "pose": [-0.12, 0.0, 0.08, 0, 0, 0, 1.0],
        "size": [1.24, 0.8],
        "source": "planes",
    }
    assert _same_points(_table_corners(table), _plane_corners(detected))


def test_a_yawed_table_plane_keeps_its_size(new_episode):
    b = new_episode()
    b.frame(0.0)
    detected = b.plane("plane-2", pose=[0.2, -0.05, -0.3, *YAW_30], polygon=CENTERED)
    b.planes(0.0, detected)

    table = _doc(b)["table"]

    assert table["size"] == [1.24, 0.8]  # its bounding box in W would be about 1.47 x 1.31
    assert table["pose"][3:] == YAW_30
    assert table["pose"][1] == -0.05  # on the plane
    assert _same_points(_table_corners(table), _plane_corners(detected))


def test_without_a_plan_or_a_table_plane_the_size_is_unknown(new_episode):
    b = new_episode()
    b.frame(0.0)
    b.planes(0.0, b.plane("plane-1", "wall", orientation="vertical"))

    assert _doc(b)["table"] == {"pose": IDENTITY, "size": None, "source": "calibration"}


def test_the_floor_is_local_floor_seen_from_the_workspace(episode_dir):
    # worldFromWorkspace puts the workspace origin at (-0.4, 0.75, -0.5) in local-floor.
    floor = environment_doc(load_episode(episode_dir))["floor"]

    assert floor == {"pose": [0.4, -0.75, 0.5, 0.0, 0.0, 0.0, 1.0], "tableHeightM": 0.75}


def test_a_turned_workspace_turns_the_floor_back(default_episode):
    default_episode.meta["space"]["worldFromWorkspace"] = [1.0, 0.8, 0.0, *YAW_90]

    floor = _doc(default_episode)["floor"]

    pose = np.array(floor["pose"])
    # Floor pose composed with worldFromWorkspace is the identity: the world origin maps home.
    back = quat_rotate(YAW_90, pose[:3]) + [1.0, 0.8, 0.0]
    np.testing.assert_allclose(back, [0, 0, 0], atol=1e-3)
    np.testing.assert_allclose(pose[3:], [0.0, -0.7071, 0.0, 0.7071], atol=1e-4)
    assert floor["tableHeightM"] == 0.8


@pytest.mark.parametrize("calibration", ["default_in_front", "none"])
def test_a_guessed_workspace_gives_the_floor_but_no_table_height(default_episode, calibration):
    default_episode.meta["space"]["calibration"] = calibration

    floor = _doc(default_episode)["floor"]

    assert floor == {"pose": [0.4, -0.75, 0.5, 0.0, 0.0, 0.0, 1.0], "tableHeightM": None}


@pytest.mark.parametrize("calibration", ["default_in_front", "none"])
def test_without_a_calibration_a_detected_table_gives_the_table_height(
    default_episode, calibration
):
    # W placed in front of a 1.65 m head (y = 1.2); the detected table is 0.45 m below it.
    space = default_episode.meta["space"]
    space["calibration"] = calibration
    space["worldFromWorkspace"] = [-0.3, 1.2, -0.45, *YAW_90]
    default_episode.planes(
        0.0, default_episode.plane("plane-1", pose=[0.3, -0.45, -0.2, *IDENTITY[3:]])
    )

    doc = _doc(default_episode)

    assert doc["floor"]["tableHeightM"] == 0.75
    assert doc["table"]["source"] == "planes" and doc["table"]["pose"][1] == -0.45


def test_a_calibrated_workspace_height_wins_over_a_detected_table(default_episode):
    default_episode.planes(0.0, default_episode.plane("plane-1", pose=[0, -0.02, 0, *IDENTITY[3:]]))

    assert _doc(default_episode)["floor"]["tableHeightM"] == 0.75


def test_planes_keep_their_latest_shape_and_when_they_were_seen(featured_episode_dir):
    planes = environment_doc(load_episode(featured_episode_dir))["planes"]

    # The table is in every snapshot, so it was seen to the end; the floor was left out at 1500.
    assert [(p["id"], p["kind"], p["firstSeenT"], p["lastSeenT"]) for p in planes] == [
        ("plane-1", "table", 0.0, 2983.33),
        ("plane-2", "floor", 0.0, 1500.0),
    ]
    assert planes[0]["polygon"] == [[-0.1, 0.1], [1.0, 0.1], [1.0, -0.7], [-0.1, -0.7]]
    assert planes[1]["pose"] == [0.4, -0.75, 0.5, 0.0, 0.0, 0.0, 1.0]


def test_a_plane_was_last_seen_when_a_snapshot_first_left_it_out(new_episode):
    b = new_episode()
    b.frame(0.0)
    b.frame(3500.0)
    b.finish = {
        "durationMs": 5000.0,
        "outcome": "completed",
        "stepsCompleted": 0,
        "stepsTotal": 0,
        "batches": 4,
    }
    wall = b.plane("plane-2", "wall", orientation="vertical")
    b.planes(0.0, b.plane("plane-1"), wall)
    b.planes(1000.0, b.plane("plane-1"))
    b.planes(2000.0, b.plane("plane-1"), wall)  # back again
    b.planes(3000.0, b.plane("plane-1"))
    b.planes(3200.0, b.plane("plane-1"))

    planes = _doc(b)["planes"]

    # Seen to the end of the episode: the finish, later than the last frame.
    assert [(p["id"], p["firstSeenT"], p["lastSeenT"]) for p in planes] == [
        ("plane-1", 0.0, 5000.0),
        ("plane-2", 0.0, 3000.0),
    ]


def test_episodes_without_plane_events_have_no_planes(episode_dir):
    assert environment_doc(load_episode(episode_dir))["planes"] == []


@pytest.mark.parametrize("size", [[0.6, 0.4], [1.0, 0.5]])
def test_the_plan_size_wins_over_detected_tables(new_episode, plan, size):
    plan["workspace"]["size"] = size
    b = new_episode()
    b.meta["plan"] = plan
    b.frame(0.0)
    b.planes(0.0, b.plane("plane-1"))

    assert _doc(b)["table"]["size"] == size
