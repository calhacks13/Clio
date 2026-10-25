"""`object_shapes`: depth samples fused as offsets from each object's compiled position, the
yaw-aligned box that sums them up, and the shapes.json document."""

import math

import numpy as np
import pytest

from clio_pipeline.derived_io import dump_json
from clio_pipeline.episode import load_episode
from clio_pipeline.objects import object_series
from clio_pipeline.schema import derived_problems
from clio_pipeline.shapes import has_depth_samples, object_shapes, shapes_doc

GRID = np.arange(0.0, 1001.0, 50.0)  # 0, 50, ..., 1000 ms
AT = [0.3, 0.0, -0.2]  # where the cup rests
# Five surface points around the cup, each well inside its own 1 cm voxel.
OFFSETS = [
    [0.055, 0.025, 0.005],
    [-0.055, 0.025, 0.005],
    [0.005, 0.105, 0.005],
    [0.005, 0.005, 0.055],
    [0.005, 0.005, -0.055],
]


def _around(position, offsets):
    """Surface points in W, rounded like the recorder."""
    return [[round(p + o, 4) for p, o in zip(position, offset, strict=True)] for offset in offsets]


def _scene(new_episode, episode_id="ep-custom"):
    b = new_episode(episode_id, objects=[])
    b.frame(0.0)
    b.frame(1000.0)
    b.track(100.0, b.object_state("cup", AT, source="detector"))
    return b


def _compiled(b):
    episode = load_episode(b.write())
    return episode, object_series(episode, GRID)


def _shapes(b, **policy):
    return object_shapes(*_compiled(b), **policy)


def _sorted(points):
    return sorted(map(tuple, points))


def _yaw_degrees(rotation):
    x, y, z, w = rotation
    assert x == 0.0 and z == 0.0, rotation
    return math.degrees(2.0 * math.atan2(y, w))


def test_samples_from_two_still_frames_fuse_into_offsets_from_the_position(new_episode):
    b = _scene(new_episode)
    b.observation(200.0, "cup", surface=_around(AT, OFFSETS))
    b.observation(400.0, "cup", surface=_around(AT, OFFSETS))

    cup = _shapes(b)["cup"]

    np.testing.assert_allclose(_sorted(cup["points"]), _sorted(OFFSETS), atol=1e-4)
    assert (cup["samples"], cup["frames"]) == (10, 2)
    assert (cup["firstT"], cup["lastT"]) == (200.0, 400.0)


def test_offsets_follow_the_compiled_position_of_each_frame(new_episode):
    b = _scene(new_episode)
    moved = [0.5, 0.0, -0.4]
    b.track(600.0, b.object_state("cup", moved, source="detector"))
    b.observation(200.0, "cup", surface=_around(AT, OFFSETS))
    b.observation(800.0, "cup", surface=_around(moved, OFFSETS))  # the same shape, elsewhere

    cup = _shapes(b)["cup"]

    np.testing.assert_allclose(_sorted(cup["points"]), _sorted(OFFSETS), atol=1e-4)
    assert cup["frames"] == 2


def test_a_frame_while_the_object_is_held_contributes_nothing(new_episode):
    b = _scene(new_episode).features("object.grasp")
    b.event(300.0, "object.grasped", objectId="cup", hand="right", grip="pinch", position=AT)
    b.event(500.0, "object.released", objectId="cup", hand="right", reason="opened", position=AT)
    b.events.sort(key=lambda e: e["t"])
    b.observation(200.0, "cup", surface=_around(AT, OFFSETS))
    b.observation(400.0, "cup", surface=_around(AT, OFFSETS))  # in hand

    cup = _shapes(b)["cup"]

    assert (cup["samples"], cup["frames"]) == (5, 1)
    assert (cup["firstT"], cup["lastT"]) == (200.0, 200.0)


def test_a_frame_without_a_compiled_position_contributes_nothing(new_episode):
    b = _scene(new_episode)
    b.observation(50.0, "cup", surface=_around(AT, OFFSETS))  # before the cup was first seen

    assert _shapes(b)["cup"] == {
        "id": "cup",
        "points": [],
        "box": None,
        "samples": 0,
        "frames": 0,
        "firstT": None,
        "lastT": None,
    }


def test_only_observations_that_saw_the_object_with_samples_give_a_shape(new_episode):
    b = _scene(new_episode)
    b.observation(200.0, "cup")  # no samples
    b.observation(300.0, "cup", status="predicted", surface=_around(AT, OFFSETS))  # coasting
    b.observation(400.0, "cup", surface=[])
    b.observation(500.0, "bottle", surface=_around(AT, OFFSETS))  # never tracked in 3D

    assert _shapes(b) == {}


def test_samples_in_one_voxel_become_their_mean(new_episode):
    b = _scene(new_episode)
    b.observation(200.0, "cup", surface=_around(AT, [[0.012, 0.0, 0.0], [0.018, 0.0, 0.0]]))

    cup = _shapes(b)["cup"]

    np.testing.assert_allclose(cup["points"], [[0.015, 0.0, 0.0]], atol=1e-4)
    assert cup["samples"] == 2


def test_a_lone_voxel_is_dropped_once_there_are_many(new_episode):
    b = _scene(new_episode)
    line = [[0.005 + 0.01 * i, 0.005, 0.005] for i in range(60)]
    b.observation(200.0, "cup", surface=_around(AT, [*line, [0.5, 0.5, 0.5]]))  # one stray hit
    b.observation(400.0, "cup", surface=_around(AT, line))

    cup = _shapes(b)["cup"]

    assert len(cup["points"]) == 60 and max(p[0] for p in cup["points"]) < 0.6
    assert cup["samples"] == 121


def test_a_few_voxels_all_stay_even_with_one_hit_each(new_episode):
    b = _scene(new_episode)
    b.observation(200.0, "cup", surface=_around(AT, OFFSETS[:3]))

    cup = _shapes(b)["cup"]

    assert len(cup["points"]) == 3 and cup["box"] is None  # fewer than 4 points: no box


def test_points_are_capped_by_a_uniform_stride(new_episode):
    b = _scene(new_episode)
    line = [[0.005 + 0.01 * i, 0.005, 0.005] for i in range(10)]
    b.observation(200.0, "cup", surface=_around(AT, line))

    cup = _shapes(b, max_points=4)["cup"]

    xs = [p[0] for p in cup["points"]]
    np.testing.assert_allclose(xs, [0.005, 0.035, 0.065, 0.095], atol=1e-4)
    assert cup["samples"] == 10


@pytest.mark.parametrize(
    "direction, yaw",
    [((1.0, 0.0), 0.0), ((0.0, 1.0), 90.0), ((1.0, -1.0), 45.0)],
    ids=["along x", "along z", "diagonal"],
)
def test_the_box_follows_the_long_axis_of_the_points(new_episode, direction, yaw):
    dx, dz = np.array(direction) / np.hypot(*direction)
    px, pz = -dz, dx  # the perpendicular horizontal axis
    points = [
        [0.02 * i * dx + 0.015 * j * px, 0.015, 0.02 * i * dz + 0.015 * j * pz]
        for i in range(-7, 8)
        for j in (-1, 0, 1)
    ]  # 28 cm long, 3 cm across, resting 1.5 cm above the position
    b = _scene(new_episode)
    b.observation(200.0, "cup", surface=_around(AT, points))

    box = _shapes(b)["cup"]["box"]

    assert abs(_yaw_degrees(box["rotation"])) % 180.0 == pytest.approx(yaw, abs=0.1)
    np.testing.assert_allclose(box["size"], [0.28, 0.0, 0.03], atol=1e-3)
    np.testing.assert_allclose(box["center"], [0.0, 0.015, 0.0], atol=1e-3)


def test_the_box_sides_span_the_2nd_to_98th_percentile(new_episode):
    b = _scene(new_episode)
    line = [[0.005 + 0.01 * i, 0.005, 0.005] for i in range(50)]  # x from 0.005 to 0.495
    b.observation(200.0, "cup", surface=_around(AT, [*line, [1.0, 0.005, 0.005]]))  # an outlier

    box = _shapes(b, min_hits=1)["cup"]["box"]

    # The 2nd percentile of 51 points is the second (0.015), the 98th the fiftieth (0.495): the
    # outlier is left out.
    assert box["size"][0] == pytest.approx(0.48, abs=1e-3)
    assert box["center"][0] == pytest.approx(0.255, abs=1e-3)
    assert _yaw_degrees(box["rotation"]) == pytest.approx(0.0, abs=1e-6)


def test_has_depth_samples_needs_an_observation_with_a_surface(new_episode):
    without = _scene(new_episode, "ep-without")
    without.observation(200.0, "cup")
    without.observation(300.0, "cup", surface=[])
    with_samples = _scene(new_episode, "ep-with")
    with_samples.observation(200.0, "cup", surface=_around(AT, OFFSETS))

    assert has_depth_samples(load_episode(without.write())) is False
    assert has_depth_samples(load_episode(with_samples.write())) is True


def test_the_shapes_doc_matches_its_schema(new_episode):
    b = _scene(new_episode)
    b.observation(200.0, "cup", surface=_around(AT, OFFSETS))
    b.observation(400.0, "cup", surface=_around(AT, OFFSETS))
    episode, series = _compiled(b)
    shapes = object_shapes(episode, series, voxel_m=0.01, min_hits=2)

    doc = shapes_doc(episode, GRID, shapes, fps=20, voxel_m=0.01, min_hits=2)

    assert derived_problems(doc, "shapes") == []
    assert (doc["schema"], doc["kind"], doc["frame"], doc["fps"]) == (
        "clio.derived/1",
        "shapes",
        "workspace",
        20,
    )
    assert doc["episodeId"] == episode.episode_id and doc["t"] == GRID.tolist()
    assert doc["policy"] == {"voxelM": 0.01, "minHits": 2, "reachM": 0.3}
    assert [o["id"] for o in doc["objects"]] == ["cup"]
    assert doc["objects"][0]["box"] is not None
    dump_json(doc)  # strict JSON: no NaN anywhere


@pytest.mark.parametrize("policy", [{"voxel_m": 0.0}, {"min_hits": 0}, {"max_points": 0}])
def test_the_fusing_policy_must_be_positive(new_episode, policy):
    b = _scene(new_episode)
    b.observation(200.0, "cup", surface=_around(AT, OFFSETS))

    with pytest.raises(ValueError):
        _shapes(b, **policy)
