"""`build_scene` over the synthetic room scan fixture, compiled first. scene.json is checked
against the generated JSON Schema with plain jsonschema, like test_compile.py. The object models
come from clio_pipeline.models, which other work builds: these tests stand a fake in for it, and
check what the stub does too."""

import json
import shutil
from pathlib import Path

import jsonschema
import numpy as np
import pytest

from clio_pipeline import models as models_module
from clio_pipeline import scene as scene_module
from clio_pipeline.compile import compile_episode
from clio_pipeline.scene import build_scene

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = json.loads((ROOT / "packages" / "protocol" / "schema" / "scene.schema.json").read_text())
FIXTURE = ROOT / "fixtures" / "episodes" / "synthetic-room-scan"
EPISODE_ID = "ep-synthetic-room-scan"


def _schema_errors(doc):
    validator = jsonschema.Draft202012Validator(SCHEMA)
    return [f"{list(e.absolute_path)}: {e.message[:200]}" for e in validator.iter_errors(doc)]


def _read(path):
    return json.loads(Path(path).read_text())


def _listing(path):
    return sorted(p.name for p in Path(path).iterdir())


@pytest.fixture
def data(tmp_path):
    """The fixture copied into <tmp>/data/episodes/ and compiled into <tmp>/data/derived/."""
    root = tmp_path / "data"
    episode = root / "episodes" / EPISODE_ID
    shutil.copytree(FIXTURE, episode)
    compile_episode(episode, root / "derived")
    return root


def _paths(data):
    return data / "episodes" / EPISODE_ID, data / "derived", data / "scenes"


def model(object_id="cup", **overrides):
    """A SceneModel whose files `fake_models` writes."""
    entry = {
        "id": object_id,
        "label": f"the {object_id}",
        "backend": "primitive",
        "generator": None,
        "model": f"model-{object_id}.glb",
        "cad": None,
        "crops": [
            {
                "file": f"crop-{object_id}-1.jpg",
                "keyframe": "keyframe-0001.jpg",
                "box": [0.4, 0.4, 0.5, 0.55],
                "from": "observation",
            }
        ],
        "size": [0.08, 0.1, 0.08],
        "sizeSource": "extent",
        "placement": {
            "offset": [0.0, -0.05, 0.0],
            "rotation": [0.0, 0.0, 0.0, 1.0],
            "rotationSource": "none",
        },
        "note": None,
    }
    return {**entry, **overrides}


@pytest.fixture
def fake_models(monkeypatch):
    """Stand in for models.build_object_models: it writes each entry's files (except names in
    `unwritten`) and returns `entries`; `calls` records what it was given."""
    state = {"entries": [model("cup"), model("box")], "unwritten": set(), "calls": []}

    def build(episode, keyframes, tracks, shapes, out_dir, *, backend="primitive", log=print):
        state["calls"].append(
            {"keyframes": len(keyframes), "tracks": tracks, "shapes": shapes, "backend": backend}
        )
        log("making models")
        for entry in state["entries"]:
            for name in scene_module._files_of(entry) if isinstance(entry, dict) else []:
                if name not in state["unwritten"]:
                    (Path(out_dir) / name).write_bytes(b"made")
        return state["entries"]

    monkeypatch.setattr(models_module, "build_object_models", build)
    return state


def test_a_scene_records_its_compile_inputs_and_models(data, fake_models):
    episode, derived, scenes = _paths(data)
    logged = []

    result = build_scene(episode, derived, scenes, log=logged.append)

    scene = _read(result.out_dir / "scene.json")
    assert scene == result.scene and _schema_errors(scene) == []
    assert result.out_dir == scenes / EPISODE_ID and result.skipped is False
    manifest_text = (derived / EPISODE_ID / "manifest.json").read_text()
    assert f'"compiledAt": "{scene["compiledAt"]}"' in manifest_text  # verbatim
    assert (scene["schema"], scene["episodeId"], scene["frame"]) == (
        "clio.scene/1",
        EPISODE_ID,
        "workspace",
    )
    assert scene["builder"] == {"name": "clio_pipeline", "version": "0.8.0"}
    assert scene["options"] == {"models": "primitive"}
    assert [i["name"] for i in scene["inputs"]] == [
        "meta.json",
        "events.ndjson",
        "observations.ndjson",
        *[f"media/keyframe-{n:04d}.jpg" for n in range(1, 9)],
        "derived/manifest.json",
        "derived/tracks.json",
        "derived/shapes.json",
    ]
    assert scene["keyframes"] == 8
    assert scene["stages"] == [{"name": "models", "status": "ok"}]
    assert [o["id"] for o in scene["objects"]] == ["cup", "box"]
    assert _listing(result.out_dir) == sorted(
        ["scene.json", "model-cup.glb", "model-box.glb", "crop-cup-1.jpg", "crop-box-1.jpg"]
    )
    assert _listing(scenes) == [f".{EPISODE_ID}.lock", EPISODE_ID]
    (call,) = fake_models["calls"]
    assert call["keyframes"] == 8 and call["backend"] == "primitive"
    assert call["tracks"]["kind"] == "tracks" and call["shapes"]["kind"] == "shapes"
    assert logged == [f"{EPISODE_ID}: 8 keyframes, models primitive", "making models"]


def test_a_models_failure_fails_its_stage_and_the_scene_is_still_written(data, monkeypatch):
    episode, derived, scenes = _paths(data)

    def unbuilt(*args, **kwargs):  # what the stub on this branch does
        raise NotImplementedError("clio_pipeline.models is built by the models work")

    monkeypatch.setattr(models_module, "build_object_models", unbuilt)

    result = build_scene(episode, derived, scenes, models="gemini-cad")

    assert result.scene["stages"] == [
        {
            "name": "models",
            "status": "failed",
            "detail": "NotImplementedError: clio_pipeline.models is built by the models work",
        }
    ]
    assert result.scene["objects"] == [] and result.scene["options"] == {"models": "gemini-cad"}
    assert _schema_errors(_read(result.out_dir / "scene.json")) == []


def test_objects_that_break_the_schema_or_miss_files_are_left_out(data, fake_models):
    episode, derived, scenes = _paths(data)
    fake_models["entries"] = [
        model("cup", size=[np.float32(0.08), np.float64(0.1), 0.08]),
        model("box", size=[0.1, 0.1]),
        model("lid"),
        "not a model",
        model("spoon", size=[0.1, float("nan"), 0.1]),
    ]
    fake_models["unwritten"] = {"crop-lid-1.jpg"}

    result = build_scene(episode, derived, scenes)

    assert [o["id"] for o in result.scene["objects"]] == ["cup"]
    stage = result.scene["stages"][0]
    assert stage["status"] == "ok"
    assert stage["detail"].startswith("left out box: $.size: ")
    assert "left out lid: its crop-lid-1.jpg was not written" in stage["detail"]
    assert "left out #3: not an object (str)" in stage["detail"]
    assert "left out spoon: not strict JSON (" in stage["detail"]
    assert result.scene["objects"][0]["size"] == pytest.approx([0.08, 0.1, 0.08])
    assert _schema_errors(_read(result.out_dir / "scene.json")) == []


@pytest.mark.parametrize("returned", [None, {"cup": 1}])
def test_models_that_return_no_list_fail_the_stage(data, fake_models, returned):
    episode, derived, scenes = _paths(data)
    fake_models["entries"] = returned

    result = build_scene(episode, derived, scenes)

    assert result.scene["stages"][0]["status"] == "failed"
    assert result.scene["objects"] == []


def test_without_tracks_the_models_stage_is_skipped(data, fake_models):
    episode, derived, scenes = _paths(data)
    (derived / EPISODE_ID / "tracks.json").unlink()

    result = build_scene(episode, derived, scenes)

    assert result.scene["stages"] == [
        {
            "name": "models",
            "status": "skipped",
            "detail": "no tracks.json in the compile (its tracks stage failed)",
        }
    ]
    assert fake_models["calls"] == []
    assert "derived/tracks.json" not in [i["name"] for i in result.scene["inputs"]]


# --- staleness ------------------------------------------------------------------------------------


def test_an_up_to_date_scene_is_kept_untouched(data, fake_models):
    episode, derived, scenes = _paths(data)
    first = build_scene(episode, derived, scenes)
    stamp = (first.out_dir / "scene.json").stat().st_mtime_ns

    again = build_scene(episode, derived, scenes, if_stale=True)

    assert again.skipped is True and again.scene == first.scene
    assert (again.out_dir / "scene.json").stat().st_mtime_ns == stamp
    assert len(fake_models["calls"]) == 1


@pytest.mark.parametrize(
    "change",
    [
        "recompiled",
        "keyframe arrived",
        "observation",
        "models option",
        "model file gone",
        "builder",
    ],
)
def test_changes_make_the_scene_stale(data, fake_models, monkeypatch, change):
    episode, derived, scenes = _paths(data)
    first = build_scene(episode, derived, scenes)
    models = "primitive"
    if change == "recompiled":
        compile_episode(episode, derived)
    elif change == "keyframe arrived":
        shutil.copy(
            episode / "media" / "keyframe-0001.jpg", episode / "media" / "keyframe-0009.jpg"
        )
    elif change == "observation":
        with (episode / "observations.ndjson").open("a") as f:
            f.write(json.dumps({"t": 8900, "objectId": "cup"}) + "\n")
    elif change == "models option":
        models = "command"
    elif change == "model file gone":
        (first.out_dir / "model-box.glb").unlink()
    else:
        monkeypatch.setattr(scene_module, "__version__", "9.9.9")

    again = build_scene(episode, derived, scenes, models=models, if_stale=True)

    assert again.skipped is False
    assert len(fake_models["calls"]) == 2


def test_a_room_scan_change_reaches_the_scene_through_the_compile(data, fake_models):
    episode, derived, scenes = _paths(data)
    build_scene(episode, derived, scenes)
    glb = episode / "media" / "room-scan-1.glb"
    data_bytes = bytearray(glb.read_bytes())
    data_bytes[-1] ^= 0x01
    glb.write_bytes(bytes(data_bytes))

    assert build_scene(episode, derived, scenes, if_stale=True).skipped is True  # not recompiled
    assert compile_episode(episode, derived, if_stale=True).skipped is False
    assert build_scene(episode, derived, scenes, if_stale=True).skipped is False


# --- what is refused, what is kept ----------------------------------------------------------------


def test_without_a_compile_nothing_is_written(data):
    episode, _, scenes = _paths(data)

    with pytest.raises(FileNotFoundError, match="run `clio compile` first"):
        build_scene(episode, data / "elsewhere", scenes)

    assert not scenes.exists()


def test_an_unreadable_episode_raises_and_keeps_the_previous_scene(data, fake_models):
    episode, derived, scenes = _paths(data)
    first = build_scene(episode, derived, scenes)
    with (episode / "events.ndjson").open("a") as f:
        f.write("not json\n")

    with pytest.raises(ValueError, match="events.ndjson"):
        build_scene(episode, derived, scenes)

    assert _read(first.out_dir / "scene.json") == first.scene
    assert _listing(scenes) == [f".{EPISODE_ID}.lock", EPISODE_ID]


@pytest.mark.parametrize("where", ["episodes", "episode", "derived", "compile"])
def test_scenes_never_go_into_the_episode_or_the_compile(data, where):
    episode, derived, _ = _paths(data)
    out = {
        "episodes": episode.parent,
        "episode": episode,
        "derived": derived,
        "compile": derived / EPISODE_ID,
    }[where]
    before = sorted(p.relative_to(data) for p in data.rglob("*"))

    with pytest.raises(ValueError, match="will not build the scene"):
        build_scene(episode, derived, out)

    assert sorted(p.relative_to(data) for p in data.rglob("*")) == before


def test_a_directory_that_is_not_a_scene_is_never_replaced(data, fake_models):
    episode, derived, scenes = _paths(data)
    occupied = scenes / EPISODE_ID
    occupied.mkdir(parents=True)
    (occupied / "notes.txt").write_text("mine")

    with pytest.raises(FileExistsError, match="not a scene"):
        build_scene(episode, derived, scenes)

    assert _listing(occupied) == ["notes.txt"]
    assert _listing(scenes) == [f".{EPISODE_ID}.lock", EPISODE_ID]


def test_a_build_removes_what_killed_builds_left_behind(data, fake_models):
    episode, derived, scenes = _paths(data)
    build_scene(episode, derived, scenes)
    leftovers = [f".{EPISODE_ID}.k3j_x9q2", f".{EPISODE_ID}.old-0a1b2c3d"]
    for name in leftovers:
        (scenes / name).mkdir()

    build_scene(episode, derived, scenes)

    assert _listing(scenes) == [f".{EPISODE_ID}.lock", EPISODE_ID]


def test_an_unknown_backend_is_refused(data):
    episode, derived, scenes = _paths(data)

    with pytest.raises(ValueError, match="models must be one of"):
        build_scene(episode, derived, scenes, models="trellis")


def test_the_backends_match_the_models_package():
    from clio_pipeline.cli import SCENE_MODEL_BACKENDS

    assert scene_module.MODEL_BACKENDS == models_module.MODEL_BACKENDS == SCENE_MODEL_BACKENDS
