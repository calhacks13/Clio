"""Generated object models for the rebuilt scene (`clio scene`, docs/room-scene.md): each
declared object gets a mesh scaled to what was measured of it and placed relative to its tracked
position, made by one of three backends (packages/protocol/src/scene.ts, ModelBackend):

    primitive   a box or cylinder from the measured size and the crops' color; offline
    gemini-cad  Gemini writes a CAD program (parts with dimensions) from the crops, the label and
                the measured size; this package builds the mesh from it
    command     an external image-to-3D command ($CLIO_MODEL_COMMAND) makes the mesh from the
                best crop; this package scales and places it

The appearance is generated, never measured: scene.json says which backend made each model, from
which crops, and which measurement scaled and turned it.

Which objects. Every tracks.json object that is not hidden, has had a position, and is an item,
container or tool; points and regions are places, not things. An object the plan does not
declare (kind null) is modelled only when the camera measured a size for it (an extent or a shape
box): a layout dot has neither. A declared part (`partOf`) is left out when the whole it belongs
to, or a whole above that, is modelled: the whole is followed and recorded with it, and the
part's model would sit inside the whole's. A part whose whole is not modelled gets its own.

For each one (views.py, fit.py): the best keyframe views and their crops, the measured size and
the placement, then the backend. A backend that fails, or cannot run (no key, no command, no
crop for the command), gives way to the primitive, with a note saying why. One object's failure
does not stop the others; it gets `model: null` and a note. Only a failure of every object raises.

Files, in `out_dir`: model-<stem>.glb, cad-<stem>.json (gemini-cad) and crop-<stem>-<n>.jpg, where
the stem is the object id when it is a plain lowercase slug (packages/protocol SCENE_FILE_NAME),
else a cleaned id with a short hash.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

from ..episode import Episode
from ..keyframes import Keyframe
from .describe import ObjectWords, object_words
from .fit import Measured, Placement, measure, off_axes, place
from .primitive import crop_color, looks_round, write_primitive
from .settings import ModelSettings
from .views import Images, Observations, View, save_crops, select_views

MODEL_BACKENDS = ("primitive", "gemini-cad", "command")
DRAWN_KINDS = frozenset({"item", "container", "tool"})

__all__ = ["MODEL_BACKENDS", "ModelSettings", "build_object_models", "drawable_objects"]

_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def build_object_models(
    episode: Episode,
    keyframes: list[Keyframe],
    tracks: dict[str, Any],
    shapes: dict[str, Any] | None,
    out_dir: Path,
    *,
    backend: str = "primitive",
    log: Callable[[str], None] = lambda message: None,
    settings: ModelSettings | None = None,
) -> list[dict[str, Any]]:
    """Write model-<id>.glb (and cad-<id>.json, crop-<id>-<n>.jpg) for every drawable object of
    `tracks` (tracks.json) into `out_dir`, and return one SceneModel dict per object for
    scene.json's `objects`. `shapes` is shapes.json, or None when the compile has none. An object
    whose backend fails falls back to `primitive` with a `note` saying why; only a problem with
    every object at once raises. `settings` replaces the environment (tests)."""
    if backend not in MODEL_BACKENDS:
        raise ValueError(f"unknown model backend {backend!r}; one of {', '.join(MODEL_BACKENDS)}")
    settings = settings or ModelSettings()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    shapes_by_id = {s["id"]: s for s in (shapes or {}).get("objects", []) if "id" in s}
    drawn, skipped = drawable_objects(tracks, shapes_by_id)
    for obj_id, why in skipped.items():
        log(f"models: {obj_id}: no model ({why})")
    build = _Build(
        episode=episode,
        keyframes=[k for k in keyframes if k.path is not None],
        grid_t=np.asarray(tracks.get("t", []), dtype=np.float64),
        shapes=shapes_by_id,
        out_dir=out_dir,
        backend=backend,
        settings=settings,
        log=log,
        stems=file_stems([o["id"] for o in drawn]),
    )
    results: list[dict[str, Any]] = []
    failures: list[str] = []
    for obj in drawn:
        try:
            results.append(build.one(obj))
        except Exception as e:  # one object's failure must not stop the others
            log(f"models: {obj['id']}: failed: {type(e).__name__}: {e}")
            failures.append(f"{obj['id']}: {e}")
            results.append(build.failed(obj, e))
    if drawn and len(failures) == len(drawn):
        raise RuntimeError(f"no object model could be made: {'; '.join(failures)}")
    return results


def drawable_objects(
    tracks: dict[str, Any], shapes_by_id: dict[str, dict[str, Any]] | None = None
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """The tracks.json objects that get a model, in tracks order, and why each other one does not
    (see the module docstring)."""
    shapes_by_id = shapes_by_id or {}
    objects = [o for o in tracks.get("objects", []) if isinstance(o, dict) and "id" in o]
    by_id = {o["id"]: o for o in objects}

    def own_reason(o: dict[str, Any]) -> str | None:
        if o.get("hidden"):
            return "hidden"
        kind = o.get("kind")
        if kind is None:
            if not (o.get("extent") or (shapes_by_id.get(o["id"]) or {}).get("box")):
                return "not declared and never measured"
        elif kind not in DRAWN_KINDS:
            return f"a {kind}"
        if not any(p is not None for p in o.get("position", [])):
            return "it never had a position"
        return None

    own = {o["id"]: own_reason(o) for o in objects}
    reasons = dict(own)
    for o in objects:
        if own[o["id"]] is not None:
            continue
        # The topmost whole above it that could be drawn on its own is drawn, so this part is in
        # it. Walk up partOf (a cycle in a broken plan stops the walk).
        whole, seen, top = o.get("partOf"), {o["id"]}, None
        while whole in by_id and whole not in seen:
            if own[whole] is None:
                top = whole
            seen.add(whole)
            whole = by_id[whole].get("partOf")
        if top is not None:
            reasons[o["id"]] = f"part of {top}, which is modelled whole"
    drawn = [o for o in objects if reasons[o["id"]] is None]
    return drawn, {k: v for k, v in reasons.items() if v is not None}


def file_stems(ids: list[str]) -> dict[str, str]:
    """A file-name stem per object id: the id itself when it is a lowercase slug, else the id
    cleaned up with a short hash of it, so two ids never share files."""
    out: dict[str, str] = {}
    taken: set[str] = set()
    for obj_id in ids:
        stem = obj_id
        if not _SLUG.fullmatch(obj_id) or obj_id in taken:
            clean = re.sub(r"[^a-z0-9_-]+", "-", obj_id.lower()).strip("-_")[:56] or "object"
            stem = f"{clean}-{hashlib.sha1(obj_id.encode('utf-8')).hexdigest()[:6]}"
        taken.add(stem)
        out[obj_id] = stem
    return out


class _Build:
    def __init__(self, **kwargs: Any) -> None:
        self.__dict__.update(kwargs)
        self.observations = Observations(self.episode.observations)
        self.images = Images()
        self.plan = self.episode.plan

    def one(self, obj: dict[str, Any]) -> dict[str, Any]:
        obj_id, stem = obj["id"], self.stems[obj["id"]]
        _clear(self.out_dir, stem)
        words = object_words(self.plan, obj_id, obj.get("label") or obj_id)
        shape = self.shapes.get(obj_id)
        round_, why_round = looks_round(words, shape)
        measured = measure(obj, shape, round_=round_)
        views = select_views(
            obj, self.grid_t, measured, self.keyframes, self.observations, self.images
        )
        placement = place(measured, views[0].toward_camera if views else None)
        crops = save_crops(views, self.out_dir, stem)
        color = crop_color(views)
        notes = list(measured.notes)
        if not views:
            notes.append("no keyframe showed it")
        made = self._backend(obj, stem, words, measured, placement, views, color, notes)
        if made is None:
            size = write_primitive(
                self.out_dir / f"model-{stem}.glb", placement.size, round_, color, object_id=obj_id
            )
            made = ("primitive", None, None, size)
            if color is None:
                notes.append("gray: no crop to take its color from")
            shape_word = "cylinder" if round_ else "box"
            self.log(f"models: {obj_id}: primitive {shape_word} ({why_round}), {measured.source}")
        used, generator, cad, size = made
        return _scene_model(
            obj, used, generator, f"model-{stem}.glb", cad, crops, size, measured, placement, notes
        )

    def _backend(
        self,
        obj: dict[str, Any],
        stem: str,
        words: ObjectWords,
        measured: Measured,
        placement: Placement,
        views: list[View],
        color: np.ndarray | None,
        notes: list[str],
    ) -> tuple[str, str | None, str | None, np.ndarray] | None:
        """(backend, generator, cad file, size) from gemini-cad or the command, or None when the
        primitive should be drawn (always for "primitive"; on a failure, with a note)."""
        if self.backend == "primitive":
            return None
        try:
            if self.backend == "gemini-cad":
                from .gemini import make_cad_model

                cad = make_cad_model(
                    object_id=obj["id"],
                    stem=stem,
                    words=words,
                    measured=measured,
                    placement=placement,
                    views=views,
                    color=color,
                    out_dir=self.out_dir,
                    settings=self.settings,
                )
                notes.extend(cad.notes)
                if not views:
                    notes.append("Gemini modelled it from its name alone")
                self.log(f"models: {obj['id']}: gemini-cad ({cad.generator}), {measured.source}")
                return "gemini-cad", cad.generator, cad.cad, cad.size
            template = self.settings.model_command
            if template is None:
                raise RuntimeError("CLIO_MODEL_COMMAND is not set")
            if not views:
                raise RuntimeError("no crop to give it")
            from .command import make_command_model

            size = make_command_model(
                template,
                image=self.out_dir / f"crop-{stem}-1.jpg",
                label=words.label,
                model_path=self.out_dir / f"model-{stem}.glb",
                height=float(placement.size[1]),
                timeout_s=self.settings.command_timeout_s,
            )
            off = off_axes(size, placement.size, measured.source)
            if off:
                notes.append(f"the command's model is {off} after fitting its height")
            self.log(f"models: {obj['id']}: command, {measured.source}")
            return "command", template, None, size
        except Exception as e:  # any failure of a generator falls back to the primitive
            _clear(self.out_dir, stem, crops=False)
            notes.append(f"the {self.backend} backend failed ({e}), so it is a primitive")
            self.log(f"models: {obj['id']}: {self.backend} failed: {e}")
            return None

    def failed(self, obj: dict[str, Any], error: Exception) -> dict[str, Any]:
        stem = self.stems[obj["id"]]
        _clear(self.out_dir, stem)
        try:
            measured = measure(obj, self.shapes.get(obj["id"]))
        except Exception:  # the measurement itself was the problem
            measured = Measured(np.zeros(3), np.zeros(3), None, "radius")
        placement = place(measured, None)
        return _scene_model(
            obj,
            "primitive",
            None,
            None,
            None,
            [],
            np.zeros(3),
            measured,
            placement,
            [f"no model could be made ({error})"],
        )


def _scene_model(
    obj: dict[str, Any],
    backend: str,
    generator: str | None,
    model: str | None,
    cad: str | None,
    crops: list[dict[str, Any]],
    size: np.ndarray,
    measured: Measured,
    placement: Placement,
    notes: list[str],
) -> dict[str, Any]:
    note = "; ".join(notes)
    return {
        "id": obj["id"],
        "label": obj.get("label") or obj["id"],
        "backend": backend,
        "generator": generator,
        "model": model,
        "cad": cad,
        "crops": crops,
        "size": _rounded(size),
        "sizeSource": measured.source,
        "placement": {
            "offset": _rounded(placement.offset),
            "rotation": _rounded(placement.rotation, 6),
            "rotationSource": placement.rotation_source,
        },
        "note": (note[0].upper() + note[1:] + ".") if note else None,
    }


def _clear(out_dir: Path, stem: str, *, crops: bool = True) -> None:
    """Remove what an earlier build wrote for this stem, so no stale file outlives it."""
    names = [f"model-{stem}.glb", f"cad-{stem}.json"]
    for name in names:
        (out_dir / name).unlink(missing_ok=True)
    if crops:
        pattern = re.compile(rf"^crop-{re.escape(stem)}-\d+\.jpg$")
        for path in out_dir.iterdir():
            if pattern.match(path.name):
                path.unlink()


def _rounded(values: np.ndarray, decimals: int = 4) -> list[float]:
    return [round(float(v), decimals) + 0.0 for v in np.asarray(values, dtype=np.float64)]
