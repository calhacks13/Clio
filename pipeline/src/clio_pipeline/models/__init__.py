"""Generated object models for the rebuilt scene (`clio scene`, docs/data-pipeline.md): each
declared object gets a mesh scaled to what was measured of it and placed relative to its tracked
position, made by one of three backends (packages/protocol/src/scene.ts, ModelBackend):

    primitive   a box or cylinder from the measured size and the crops' color; offline
    gemini-cad  Gemini writes a CAD program (parts with dimensions) from the crops, the label and
                the measured size; this package builds the mesh from it
    command     an external image-to-3D command ($CLIO_MODEL_COMMAND) makes the mesh from the
                best crop; this package scales and places it

The appearance is generated, never measured: scene.json says which backend made each model, from
which crops, and which measurement scaled and turned it.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..episode import Episode
from ..keyframes import Keyframe

MODEL_BACKENDS = ("primitive", "gemini-cad", "command")


def build_object_models(
    episode: Episode,
    keyframes: list[Keyframe],
    tracks: dict[str, Any],
    shapes: dict[str, Any] | None,
    out_dir: Path,
    *,
    backend: str = "primitive",
    log: Callable[[str], None] = lambda message: None,
) -> list[dict[str, Any]]:
    """Write model-<id>.glb (and cad-<id>.json, crop-<id>-<n>.jpg) for every drawable object of
    `tracks` (tracks.json) into `out_dir`, and return one SceneModel dict per object for
    scene.json's `objects`. `shapes` is shapes.json, or None when the compile has none. An object
    whose backend fails falls back to `primitive` with a `note` saying why; only a problem with
    every object at once raises."""
    raise NotImplementedError("clio_pipeline.models is built by the models work")
