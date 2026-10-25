import numpy as np

from clio_pipeline.episode import Episode
from clio_pipeline.keyframes import Keyframe, load_keyframes


def keyframe(pose) -> Keyframe:
    return Keyframe(
        0,
        "keyframe-0001.jpg",
        None,
        0.0,
        0.0,
        np.asarray(pose, float),
        640,
        480,
        500.0,
        500.0,
        320.0,
        240.0,
    )


def test_projection_follows_the_webxr_camera_axes():
    # Camera at the origin, unrotated: it looks down -z with +y up.
    k = keyframe([0, 0, 0, 0, 0, 0, 1])
    uv, depth = k.project(np.array([[0, 0, -2], [0.2, 0.1, -1], [0, 0, 1]]))
    np.testing.assert_allclose(uv[0], [320, 240])
    np.testing.assert_allclose(uv[1], [420, 190])  # right of center, above it (v grows down)
    np.testing.assert_allclose(depth[:2], [2, 1])
    assert np.isnan(uv[2]).all() and depth[2] < 0
    assert k.in_image(uv[:2]).all()


def test_projection_is_the_inverse_of_the_camera_pose():
    turn = np.sin(np.pi / 4), np.cos(np.pi / 4)
    k = keyframe([1, 1.5, 2, 0, turn[0], 0, turn[1]])  # a quarter turn left: looks down -x
    point = np.array([[-1.0, 1.5, 2.0]])
    uv, depth = k.project(point)
    np.testing.assert_allclose(uv[0], [320, 240], atol=1e-9)
    np.testing.assert_allclose(depth, [2.0])
    back = k.world_from_camera() @ np.append(k.to_camera(point)[0], 1)
    np.testing.assert_allclose(back[:3], point[0])


def test_load_keyframes_keeps_arrived_images_in_capture_order(tmp_path):
    media = {"keyframe-0002.jpg": tmp_path / "b.jpg", "keyframe-0001.jpg": tmp_path / "a.jpg"}
    event = {
        "type": "scene.keyframe",
        "pose": [0, 1, 0, 0, 0, 0, 1],
        "width": 640,
        "height": 480,
        "intrinsics": {"fx": 500, "fy": 500, "cx": 320, "cy": 240},
    }
    events = [
        {**event, "t": 900, "capturedT": 850, "media": "keyframe-0002.jpg"},
        {**event, "t": 400, "capturedT": 950, "media": "keyframe-0001.jpg"},
        {**event, "t": 950, "capturedT": 990, "media": "keyframe-0003.jpg"},  # never arrived
        {**event, "t": 960, "capturedT": 991, "media": "keyframe-0004.jpg", "pose": [0, 1]},
    ]
    episode = Episode(
        tmp_path,
        {},
        np.zeros(0),
        np.zeros((0, 7)),
        np.zeros((0, 2, 25, 8)),
        np.zeros((0, 2)),
        np.zeros((0, 2), bool),
        events,
        [],
        {},
        None,
        media,
    )
    frames = load_keyframes(episode)
    assert [f.media for f in frames] == ["keyframe-0002.jpg", "keyframe-0001.jpg"]
    assert [f.index for f in frames] == [0, 1]
    assert frames[0].path == tmp_path / "b.jpg"
    with_missing = load_keyframes(episode, include_missing=True)
    assert [f.media for f in with_missing][-1] == "keyframe-0003.jpg"
    assert with_missing[-1].path is None
