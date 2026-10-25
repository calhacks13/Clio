"""`clio scene`: a generated model of each object of a compiled episode, in data/scenes/<id>/
(docs/room-scene.md).

    scene.json         SceneDoc (packages/protocol/src/scene.ts): the compile it was built from,
                       the inputs with their hashes, the options, the stages and every model
    model-<id>.glb     a model of each drawable object, scaled to its measured size
    cad-<id>.json      the CAD program a model was built from (gemini-cad)
    crop-<id>-<n>.jpg  the keyframe crops a model was made from

The room is not here: it is the Quest room scan the compile keeps (derived room.glb). A scene
reads the episode, with its keyframes (the camera stills the headset kept with their pose), and
its compile (manifest.json, required, then tracks.json and shapes.json), and runs one stage,
`models` (clio_pipeline.models). A stage that fails is recorded with what went wrong and
scene.json is still written; an object whose entry breaks the schema, or names a file the build
did not write, is left out and said. Like a compile, a scene is built in a hidden directory and
swapped in, under a per-episode lock in the scenes root (builddir.py), and it never writes into
the episode, its episodes directory or the compile.

A scene is stale when an input (meta.json, events.ndjson, observations.ndjson, the keyframe
JPEGs, derived/manifest.json, tracks.json, shapes.json), the options or the builder version
changed, or a file it lists is gone. Every compile writes a new manifest.json, so a new compile
makes the scene stale. With `if_stale=True` an up-to-date scene is kept and nothing is written.
"""

from __future__ import annotations

import re
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import __version__
from .builddir import (
    describe,
    episode_id_of,
    episode_lock,
    fingerprint_files,
    is_apart,
    make_work_dir,
    remove_leftovers,
    same_inputs,
    swap_in,
    utc_now,
)
from .derived_io import DERIVED_SCHEMA_ID, write_json
from .episode import load_episode
from .keyframes import load_keyframes
from .schema import SCENE_SCHEMA, SchemaSet, default_schemas, parse_json

SCENE_SCHEMA_ID = "clio.scene/1"
BUILDER_NAME = "clio_pipeline"
SCENE_FILE = "scene.json"
# packages/protocol/src/scene.ts ModelBackendSchema (clio_pipeline.models.MODEL_BACKENDS)
MODEL_BACKENDS = ("primitive", "gemini-cad", "command")
# File names the server serves from data/scenes/<id>/ (scene.ts SCENE_FILE_NAME).
SCENE_FILE_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,95}\.(json|glb|jpg)$")
# packages/protocol/src/episode.ts KEYFRAME_MEDIA
KEYFRAME_MEDIA = re.compile(r"^keyframe-([0-9]{4,5})\.jpg$")
# Inputs, by their names in scene.json: these in the episode, the keyframe JPEGs as
# "media/<name>", and these in the compile as "derived/<name>".
EPISODE_INPUTS = ("meta.json", "events.ndjson", "observations.ndjson")
DERIVED_INPUTS = ("manifest.json", "tracks.json", "shapes.json")


@dataclass
class SceneResult:
    episode_id: str
    out_dir: Path  # <scenes root>/<episode id>
    skipped: bool  # the scene was up to date (if_stale) and was kept as it was
    scene: dict[str, Any]


def build_scene(
    episode_dir: Path | str,
    derived_root: Path | str,
    scenes_root: Path | str,
    *,
    models: str = "primitive",
    if_stale: bool = False,
    log: Callable[[str], None] = lambda message: None,
) -> SceneResult:
    """Build the scene of one compiled episode into `scenes_root/<episode id>/`; a stage that
    fails is recorded in scene.json. Raises, leaving an earlier scene as it was, when there is
    no compile of the episode in `derived_root` (FileNotFoundError) or the episode cannot be
    read; when `scenes_root/<episode id>` would be the episode, inside it or beside it, or in the
    compile (ValueError, before anything is written); and when that directory exists but holds
    no earlier scene (FileExistsError, and it is left alone)."""
    episode_dir, derived_root, scenes_root = (
        Path(episode_dir),
        Path(derived_root),
        Path(scenes_root),
    )
    if models not in MODEL_BACKENDS:
        raise ValueError(f"models must be one of {', '.join(MODEL_BACKENDS)}, got {models!r}")
    episode_id = episode_id_of(episode_dir)
    derived_dir = derived_root / episode_id
    out_dir = scenes_root / episode_id
    _check_apart(episode_dir, derived_dir, scenes_root, out_dir)
    options = {"models": models}

    def kept() -> SceneResult | None:
        previous = _read_json(out_dir / SCENE_FILE)
        if previous is not None and _up_to_date(
            previous, episode_dir, derived_dir, out_dir, options
        ):
            return SceneResult(episode_id, out_dir, True, previous)
        return None

    if if_stale and (result := kept()) is not None:
        return result
    _read_compile(derived_dir, episode_id, derived_root)  # before anything is written
    scenes_root.mkdir(parents=True, exist_ok=True)
    with episode_lock(scenes_root, episode_id) as locked:
        if if_stale and (result := kept()) is not None:  # built while this one waited
            return result
        if locked:  # no other build of this episode is running
            remove_leftovers(scenes_root, episode_id)

        inputs = fingerprint_files(input_paths(episode_dir, derived_dir))  # before reading
        manifest = _read_compile(derived_dir, episode_id, derived_root)
        episode = load_episode(episode_dir)
        tracks = _read_json(derived_dir / "tracks.json")
        shapes = _read_json(derived_dir / "shapes.json")
        keyframes = load_keyframes(episode)
        log(f"{episode_id}: {len(keyframes)} keyframes, models {models}")

        work = make_work_dir(scenes_root, episode_id)
        try:
            scene = {
                "schema": SCENE_SCHEMA_ID,
                "episodeId": episode_id,
                "builtAt": utc_now(),
                "builder": {"name": BUILDER_NAME, "version": __version__},
                "frame": "workspace",
                "compiledAt": manifest["compiledAt"],
                "inputs": inputs,
                "options": options,
                "stages": [],
                "keyframes": len(keyframes),
                "objects": [],
            }
            if tracks is None:
                detail = "no tracks.json in the compile (its tracks stage failed)"
                stage, objects = {"name": "models", "status": "skipped", "detail": detail}, []
            else:
                stage, objects = _models_stage(
                    scene,
                    work,
                    lambda: _build_models(episode, keyframes, tracks, shapes, work, models, log),
                )
            scene["stages"].append(stage)
            scene["objects"] = objects
            write_json(work / SCENE_FILE, scene, indent=2)
            swap_in(work, out_dir, replaceable=_is_scene, refusal=_not_a_scene(out_dir))
        except BaseException:
            shutil.rmtree(work, ignore_errors=True)
            raise
    return SceneResult(episode_id, out_dir, False, scene)


# --- the models stage -----------------------------------------------------------------------------


def _build_models(episode, keyframes, tracks, shapes, out: Path, backend: str, log) -> Any:
    from .models import build_object_models  # its backends may need more than numpy

    return build_object_models(episode, keyframes, tracks, shapes, out, backend=backend, log=log)


def _models_stage(
    scene: dict[str, Any], work: Path, build: Callable[[], Any]
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Run `build` (models.build_object_models into `work`) and keep the entries that are
    SceneModels whose files are in `work`. Returns the stage and the objects."""
    try:
        objects = build()
    except Exception as e:  # the scene is still written, with the failure in it
        return {"name": "models", "status": "failed", "detail": describe(e)}, []
    if not isinstance(objects, list):
        detail = f"models returned {type(objects).__name__}, not a list of objects"
        return {"name": "models", "status": "failed", "detail": detail}, []
    kept, problems = _valid_objects(scene, objects, work)
    stage: dict[str, Any] = {"name": "models", "status": "ok"}
    if problems:
        stage["detail"] = "; ".join(problems)
        if len(stage["detail"]) > 600:
            stage["detail"] = stage["detail"][:597] + "..."
    return stage, kept


def _valid_objects(
    scene: dict[str, Any], objects: list[Any], work: Path
) -> tuple[list[dict[str, Any]], list[str]]:
    """The objects that fit scene.json (each checked in the scene as it stands) and whose files
    the build wrote, and why each other one was left out."""
    try:
        schemas: SchemaSet | None = default_schemas()
    except FileNotFoundError:  # installed away from packages/protocol: files are still checked
        schemas = None
    kept, problems = [], []
    for k, obj in enumerate(objects):
        name = obj.get("id", f"#{k}") if isinstance(obj, dict) else f"#{k}"
        problem = None
        if not isinstance(obj, dict):
            problem = f"not an object ({type(obj).__name__})"
        elif schemas is not None and (
            found := schemas.first_problem(SCENE_SCHEMA, {**scene, "objects": [obj]})
        ):
            path, message = found
            problem = f"{path.replace('$.objects[0]', '$')}: {message}"
        else:
            missing = [f for f in _files_of(obj) if not (work / f).is_file()]
            if missing:
                problem = (
                    f"its {', '.join(missing)} {'was' if len(missing) == 1 else 'were'} not written"
                )
        if problem is None:
            kept.append(obj)
        else:
            problems.append(f"left out {name}: {problem}")
    return kept, problems


def _files_of(obj: dict[str, Any]) -> list[str]:
    """The scene files a SceneModel names: its model, CAD program and crops."""
    files = [obj.get("model"), obj.get("cad")]
    files += [crop.get("file") for crop in obj.get("crops") or [] if isinstance(crop, dict)]
    return [f for f in files if isinstance(f, str)]


# --- inputs and staleness -------------------------------------------------------------------------


def input_paths(episode_dir: Path, derived_dir: Path) -> dict[str, Path]:
    """Every input a scene may read, by its name in scene.json, whether it exists or not."""
    paths = {name: episode_dir / name for name in EPISODE_INPUTS}
    media = episode_dir / "media"
    found = []
    if media.is_dir():
        found = [
            (int(m.group(1)), p) for p in media.iterdir() if (m := KEYFRAME_MEDIA.match(p.name))
        ]
    for _, path in sorted(found):
        paths[f"media/{path.name}"] = path
    for name in DERIVED_INPUTS:
        paths[f"derived/{name}"] = derived_dir / name
    return paths


def _up_to_date(
    scene: dict[str, Any],
    episode_dir: Path,
    derived_dir: Path,
    out_dir: Path,
    options: dict[str, Any],
) -> bool:
    """Same builder version and options, every file it lists still there, and identical inputs
    (sizes compared first; files are hashed only when every size matches)."""
    try:
        builder = scene["builder"]
        if (scene["schema"], builder["name"], builder["version"]) != (
            SCENE_SCHEMA_ID,
            BUILDER_NAME,
            __version__,
        ):
            return False
        if scene["options"] != options:
            return False
        if any(not (out_dir / f).is_file() for obj in scene["objects"] for f in _files_of(obj)):
            return False
        return same_inputs(scene["inputs"], input_paths(episode_dir, derived_dir))
    except (KeyError, TypeError, ValueError, AttributeError, OSError):
        return False


# --- files ----------------------------------------------------------------------------------------


def _read_compile(derived_dir: Path, episode_id: str, derived_root: Path) -> dict[str, Any]:
    path = derived_dir / "manifest.json"
    if not path.is_file():
        raise FileNotFoundError(
            f"no compile of {episode_id} in {derived_root}: run `clio compile` first"
        )
    manifest = _read_json(path)
    if manifest is None or manifest.get("schema") != DERIVED_SCHEMA_ID:
        raise ValueError(f"{path} is not a {DERIVED_SCHEMA_ID} manifest: compile again")
    if not isinstance(manifest.get("compiledAt"), str):
        raise ValueError(f"{path} has no compiledAt: compile again")
    return manifest


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        doc = parse_json(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    return doc if isinstance(doc, dict) else None


def _check_apart(episode_dir: Path, derived_dir: Path, scenes_root: Path, out_dir: Path) -> None:
    """Raw files and compiles are never touched: refuse a scene that would be the episode, in it
    or around it, in its episodes directory, or in a compile or around one."""
    out, derived = out_dir.resolve(), derived_dir.resolve()
    if not is_apart(episode_dir, scenes_root, out_dir):
        raise ValueError(
            f"will not build the scene of {episode_dir} in {scenes_root}: scenes never go into "
            "an episode or its episodes directory (use a scenes root such as data/scenes)"
        )
    if (
        scenes_root.resolve() == derived.parent
        or out.is_relative_to(derived)
        or derived.is_relative_to(out)
    ):
        raise ValueError(
            f"will not build the scene of {episode_dir} in {scenes_root}: scenes never go into "
            "the derived root or a compile (use a scenes root such as data/scenes)"
        )


def _is_scene(out_dir: Path) -> bool:
    """Whether `out_dir` holds an earlier scene (a clio.scene/1 scene.json)."""
    scene = _read_json(out_dir / SCENE_FILE)
    return scene is not None and scene.get("schema") == SCENE_SCHEMA_ID


def _not_a_scene(out_dir: Path) -> str:
    return (
        f"{out_dir} exists and is not a scene (no {SCENE_SCHEMA_ID} scene.json): not replacing it"
    )
