"""`object_extents`: each object's metric size from its measured boxes, the camera model and its
compiled depth."""

import numpy as np

from clio_pipeline.episode import load_episode
from clio_pipeline.extents import object_extents
from clio_pipeline.objects import object_series

GRID = np.arange(0.0, 1001.0, 50.0)  # 0, 50, ..., 1000 ms
LOOKING_AHEAD = [0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]  # the head 1 m up, looking along -z
# 0.1 of the frame wide and 0.05 high, around the image center.
BOX = (0.4, 0.3, 0.5, 0.35)


def _extents(b, grid=GRID):
    episode = load_episode(b.write())
    return object_extents(episode, object_series(episode, grid))


def _scene(new_episode, *, camera=True, head=LOOKING_AHEAD):
    """A cup 1.0 m ahead of a still head (frames every 50 ms), seen by a 1280 x 960 camera with
    f = 800 at the head."""
    b = new_episode(objects=[])
    for k in range(21):
        b.frame(50.0 * k, head=head)
    if camera:
        b.camera(width=1280, height=960, fx=800.0)
    b.track(100.0, b.object_state("cup", [0.0, 1.0, -1.0], source="detector"))
    return b


def test_a_box_at_the_objects_depth_measures_its_width_and_height(new_episode):
    b = _scene(new_episode)
    for t in (200.0, 300.0, 400.0):
        b.observation(t, "cup", box=BOX)

    # 0.1 * 1280 / 800 * 1.0 m across, 0.05 * 960 / 800 * 1.0 m up
    assert _extents(b) == {"cup": {"width": 0.16, "height": 0.06, "samples": 3}}


def test_the_extent_is_the_median_over_the_measured_boxes(new_episode):
    b = _scene(new_episode)
    b.observation(200.0, "cup", box=BOX)
    b.observation(300.0, "cup", box=(0.4, 0.3, 0.6, 0.4))  # twice as big
    b.observation(400.0, "cup", box=(0.4, 0.3, 0.7, 0.45))  # three times
    b.observation(500.0, "cup", status="predicted", box=(0.0, 0.0, 1.0, 1.0))  # not measured
    b.observation(600.0, "cup", status="lost", box=None, score=None)

    assert _extents(b)["cup"] == {"width": 0.32, "height": 0.12, "samples": 3}


def test_fewer_than_three_samples_give_no_extent(new_episode):
    b = _scene(new_episode)
    b.observation(200.0, "cup", box=BOX)
    b.observation(300.0, "cup", box=BOX)

    assert _extents(b) == {"cup": None}


def test_without_a_camera_model_every_object_has_no_extent(new_episode):
    b = _scene(new_episode, camera=False)
    for t in (200.0, 300.0, 400.0):
        b.observation(t, "cup", box=BOX)

    assert _extents(b) == {"cup": None}


def test_the_observations_frame_size_overrides_the_intrinsics(new_episode):
    b = _scene(new_episode)
    for k, t in enumerate((200.0, 300.0, 400.0)):
        b.observation(t, "cup", box=BOX, seq=k, frame_size=(640, 480))

    assert _extents(b)["cup"] == {"width": 0.08, "height": 0.03, "samples": 3}


def test_depth_follows_the_head_pose_and_the_camera_mount(new_episode):
    # The head 0.5 m behind where the plain scene has it and the camera 0.3 m ahead of the head:
    # 1.2 m to the cup.
    b = _scene(new_episode, head=[0.0, 1.0, 0.5, 0.0, 0.0, 0.0, 1.0])
    b.camera(
        width=1280, height=960, fx=800.0, head_from_camera=[0.0, 0.0, -0.3, 0.0, 0.0, 0.0, 1.0]
    )
    for t in (200.0, 300.0, 400.0):
        b.observation(t, "cup", box=BOX)

    assert _extents(b)["cup"] == {"width": 0.192, "height": 0.072, "samples": 3}


def test_the_head_pose_is_interpolated_to_the_capture_time(new_episode):
    b = new_episode(objects=[])
    for k in range(21):  # walking toward the cup: 2 m away at t = 0, 1 m at t = 1000
        b.frame(50.0 * k, head=[0.0, 1.0, round(1.0 - 0.05 * k, 4), 0.0, 0.0, 0.0, 1.0])
    b.camera(width=1280, height=960, fx=800.0)
    b.track(100.0, b.object_state("cup", [0.0, 1.0, -1.0], source="detector"))
    for t in (600.0, 700.0, 800.0):  # frames captured at 510 ms: a fifth of the way 500 -> 550
        b.observation(t, "cup", observed_t=510.0, box=BOX)

    # 1.49 m away: 0.16 * 1.49 across, 0.06 * 1.49 up
    assert _extents(b)["cup"] == {"width": 0.238, "height": 0.089, "samples": 3}


def test_a_frame_captured_inside_a_frame_gap_is_not_measured(new_episode):
    b = new_episode(objects=[])
    for t in (*range(0, 401, 50), *range(900, 1001, 50)):  # no frames from 400 to 900 ms
        b.frame(float(t), head=LOOKING_AHEAD)
    b.camera(width=1280, height=960, fx=800.0)
    b.track(100.0, b.object_state("cup", [0.0, 1.0, -1.0], source="detector"))
    for t in (200.0, 300.0, 400.0, 600.0):
        b.observation(t, "cup", box=BOX)

    assert _extents(b)["cup"]["samples"] == 3


def test_a_camera_turned_away_from_the_object_measures_nothing(new_episode):
    turned_around = [0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0]  # 180 degrees about +y: looking along +z
    b = _scene(new_episode, head=turned_around)
    for t in (200.0, 300.0, 400.0):
        b.observation(t, "cup", box=BOX)

    assert _extents(b) == {"cup": None}


def test_a_frame_without_a_compiled_position_is_not_measured(new_episode):
    b = _scene(new_episode)
    b.observation(50.0, "cup", box=BOX)  # before the cup was first seen
    for t in (200.0, 300.0, 400.0):
        b.observation(t, "cup", box=BOX)

    assert _extents(b)["cup"]["samples"] == 3
