"""fixtures/episodes/synthetic-room-scan/ (scripts/synth_room_scan.py): what the generator writes,
and that its room scan, keyframes and observations agree with each other the way a headset's
would, since the scene build and the viewer are tested on it."""

import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from clio_pipeline.compile import compile_episode
from clio_pipeline.episode import load_episode
from clio_pipeline.frames import quat_multiply, quat_rotate
from clio_pipeline.keyframes import load_keyframes
from clio_pipeline.schema import validate_derived

PIPELINE = Path(__file__).resolve().parents[1]
FIXTURE = PIPELINE.parent / "fixtures" / "episodes" / "synthetic-room-scan"

pytestmark = pytest.mark.skipif(not FIXTURE.is_dir(), reason=f"no fixture at {FIXTURE}")


def _generator():
    spec = importlib.util.spec_from_file_location(
        "synth_room_scan", PIPELINE / "scripts" / "synth_room_scan.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # its dataclasses look their module up
    try:
        spec.loader.exec_module(module)
    finally:
        del sys.modules[spec.name]
    return module


def _files(root: Path) -> dict[str, Path]:
    return {str(p.relative_to(root)): p for p in sorted(root.rglob("*")) if p.is_file()}


def test_the_fixture_is_what_its_generator_writes(tmp_path):
    out = _generator().build(tmp_path / "ep")

    ours, theirs = _files(out), _files(FIXTURE)
    assert sorted(ours) == sorted(theirs)
    for name, path in ours.items():
        if name.endswith(".jpg"):  # encoders may differ by a level here and there
            a = np.asarray(Image.open(path), dtype=float)
            b = np.asarray(Image.open(theirs[name]), dtype=float)
            assert np.abs(a - b).mean() < 1.0, name
        else:
            assert path.read_bytes() == theirs[name].read_bytes(), name
    assert sum(p.stat().st_size for p in theirs.values()) < 1_000_000


def test_the_fixture_records_every_room_and_scene_feature():
    episode = load_episode(FIXTURE, validate=True)

    assert {"environment.meshes", "scene.keyframes", "object.surface"} <= set(
        episode.meta["features"]
    )
    (meshes,) = episode.events_of("environment.meshes")
    assert meshes["media"] in episode.media
    assert [(m["id"], m["kind"], m["global"]) for m in meshes["meshes"]] == [
        ("mesh-1", "other", True),
        ("mesh-2", "table", False),
    ]
    assert len(load_keyframes(episode)) == 8
    plan = {o["id"]: o for o in episode.plan["objects"]}
    assert plan["cup"]["label"] == "red cup" and plan["cup"]["tracking"]["query"]
    assert plan["box"]["label"] == "blue box" and plan["box"]["tracking"]["query"]


def test_each_keyframe_pose_is_the_head_pose_at_capture_and_the_camera_mount():
    episode = load_episode(FIXTURE)
    mount = np.asarray(episode.meta["camera"]["headFromCamera"], dtype=float)

    for keyframe in load_keyframes(episode):
        (k,) = np.flatnonzero(episode.t == keyframe.captured_t)
        head = episode.head[k]
        position = head[:3] + quat_rotate(head[3:], mount[:3])
        rotation = quat_multiply(head[3:], mount[3:])
        rotation /= np.linalg.norm(rotation)
        np.testing.assert_allclose(keyframe.pose[:3], position, atol=2e-4)
        recorded = keyframe.pose[3:] / np.linalg.norm(keyframe.pose[3:])  # rounded to 1e-4
        assert abs(float(np.dot(recorded, rotation))) > 1 - 1e-6


def test_each_keyframe_sees_both_objects_inside_their_observed_boxes():
    episode = load_episode(FIXTURE)
    observed = {(o["objectId"], o["observedT"]): o for o in episode.observations}
    centers = {
        "cup": np.array([0.3, 0.05, -0.25]),
        "box": np.array([0.68, 0.04, -0.32]),
    }

    for keyframe in load_keyframes(episode):
        image = Image.open(keyframe.path)
        assert image.size == (keyframe.width, keyframe.height) == (320, 240)
        for object_id, center in centers.items():
            box = observed[(object_id, keyframe.captured_t)]["box"]
            uv, _ = keyframe.project(center[None])
            u, v = uv[0]
            x, y = (u + 0.5) / keyframe.width, (v + 0.5) / keyframe.height
            assert box[0] < x < box[2] and box[1] < y < box[3], (keyframe.media, object_id)
            # and that is where the image shows it: red for the cup, blue for the box
            r, g, b = np.asarray(image, dtype=float)[int(v), int(u)]
            assert (r > 2 * b) if object_id == "cup" else (b > 2 * r), (keyframe.media, object_id)


def test_the_fixture_compiles_with_its_room_scan(tmp_path):
    result = compile_episode(FIXTURE, tmp_path / "derived")

    stages = {s["name"]: s["status"] for s in result.manifest["stages"]}
    assert stages == {
        "tracks": "ok",
        "shapes": "ok",
        "room": "ok",
        "environment": "ok",
        "retarget": "skipped",
        "quality": "ok",
    }
    room = json.loads((result.out_dir / "environment.json").read_text())["room"]
    bounds = {m["id"]: m["bounds"] for m in room["meshes"]}
    # The global mesh is posed a quarter turn about +y: its bounds are the room's only with it.
    assert bounds["mesh-1"] == {"min": [-1.5, -0.74, -2.1], "max": [2.5, 1.86, 1.5]}
    assert bounds["mesh-2"] == {"min": [0.0, -0.74, -0.6], "max": [1.0, 0.0, 0.0]}
    tracks = json.loads((result.out_dir / "tracks.json").read_text())
    assert {o["id"]: o["extent"] is not None for o in tracks["objects"]} == {
        "cup": True,
        "box": True,
    }
    assert validate_derived(result.out_dir) == []
