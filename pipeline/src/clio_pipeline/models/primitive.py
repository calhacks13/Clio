"""The primitive backend: a box or an upright cylinder at the measured size, in the color the crops
show. It needs nothing but numpy and Pillow, so it always works, and every other backend falls
back to it.

Round or not. A cylinder when what the plan calls the object names a round thing (the head noun
of its label, detector prompt or step phrases: "cup A", "white paper cup with a big letter A",
"the small glass vials"), or when its depth samples curve like part of a circle seen from the
side. A long round thing whose shape box lies flat (a pen, a tube on the table) is a box: an
upright cylinder would stand it on end. Everything else is a box. Both have slightly rounded
edges so the light catches them; their bounds are exactly the measured size.

Color. The robust median of the crop's pixels inside the tracker's outline (shrunk toward its
middle, away from the background at its edge) when the view has one, else of the middle of the
box; then the median over the views. Without a view the model is a neutral gray.
"""

from __future__ import annotations

import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from ..glb import MeshData, Node, write_glb
from .cad import Mesh, box_mesh, cylinder_mesh, srgb_to_linear
from .describe import ObjectWords
from .views import View

ROUND_NOUNS = frozenset(
    """
    ball battery beaker bottle bowl bucket can candle canister cap coaster coin cone cup
    cylinder dish disc disk flask funnel glass jar jug kettle lid marker mug pen pencil pipette
    plate pot puck roll saucer spool syringe thermos tin tube tumbler vase vial
    """.split()
)
# Round things that are often lying down on the table rather than standing up.
LONG_NOUNS = frozenset("battery candle marker pen pencil pipette roll syringe tube vial".split())
_STOP = frozenset(
    """
    with of on in for from near beside by next behind under at to that which and or inside
    holding containing filled full labelled labeled marked
    """.split()
)
GRAY = np.array([0.6, 0.6, 0.6])
CENTER_SHARE = 0.4  # of the box's width and height, around its middle
OUTLINE_SHRINK = 0.8  # the outline pulled toward its centroid, to stay off the background
MAX_PIXELS = 20000  # per view, enough for a median


def head_noun(phrase: str) -> str | None:
    """The noun a phrase is about, singular: "white paper cup with a big letter A" -> "cup",
    "cup B" -> "cup", "the small vials" -> "vial"."""
    words = re.findall(r"[a-z]+|\d+", phrase.lower())
    for i, word in enumerate(words):
        if word in _STOP:
            words = words[:i]
            break
    while words and (len(words[-1]) <= 1 or words[-1].isdigit()):
        words.pop()
    if not words:
        return None
    word = words[-1]
    for singular in (word, word[:-1] if word.endswith("s") and not word.endswith("ss") else ""):
        if singular in ROUND_NOUNS:
            return singular
    if word.endswith("es") and word[:-2] in ROUND_NOUNS:
        return word[:-2]
    return word[:-1] if word.endswith("s") and not word.endswith("ss") else word


def looks_round(words: ObjectWords, shape: dict | None) -> tuple[bool, str]:
    """Whether to model the object as an upright cylinder, and why."""
    box = (shape or {}).get("box")
    nouns = [n for n in map(head_noun, words.names()) if n]
    round_noun = next((n for n in nouns if n in ROUND_NOUNS), None)
    if round_noun is not None:
        if box is not None and round_noun in LONG_NOUNS and _lying(box["size"]):
            return False, f"a {round_noun} lying down"
        return True, f"a {round_noun}"
    if (
        shape is not None
        and box is not None
        and footprint_is_round(shape.get("points"), box["size"])
    ):
        return True, "its depth samples curve like a circle"
    return False, "nothing says it is round"


def _lying(size: list[float]) -> bool:
    long, short = max(size[0], size[2]), min(size[0], size[2])
    return long > 1.6 * size[1] and long > 2.0 * max(short, 1e-6)


def footprint_is_round(points: list | None, size: list[float]) -> bool:
    """Whether the samples' horizontal spread lies on a circle about as wide as the box: a fitted
    circle (least squares) with small residuals, covering at least a quarter turn."""
    if not points or len(points) < 20:
        return False
    xz = np.asarray(points, dtype=np.float64)[:, [0, 2]]
    a = np.column_stack([2 * xz, np.ones(len(xz))])
    (cx, cz, c), *_ = np.linalg.lstsq(a, (xz**2).sum(axis=1), rcond=None)
    r2 = c + cx * cx + cz * cz
    if r2 <= 0:
        return False
    r = float(np.sqrt(r2))
    d = xz - [cx, cz]
    residual = float(np.sqrt(np.mean((np.linalg.norm(d, axis=1) - r) ** 2)))
    angles = np.sort(np.arctan2(d[:, 1], d[:, 0]))
    gaps = np.diff(np.concatenate([angles, angles[:1] + 2 * np.pi]))
    covered = 2 * np.pi - float(gaps.max())
    width = max(size[0], size[2])
    return residual <= 0.1 * r and 0.6 * width <= 2 * r <= 1.5 * width and covered >= np.pi / 2


def crop_color(views: list[View]) -> np.ndarray | None:
    """(3,) sRGB 0..1: the median over the views of each view's robust median color."""
    colors = [c for v in views if (c := _view_color(v)) is not None]
    return np.median(np.asarray(colors), axis=0) if colors else None


def _view_color(view: View) -> np.ndarray | None:
    if view.crop is None:
        return None
    pixels = np.asarray(view.crop, dtype=np.float64).reshape(-1, 3) / 255.0
    mask = _outline_mask(view) if view.outline is not None else None
    if mask is None or mask.sum() < 16:
        mask = _center_mask(view)
    chosen = pixels[mask.reshape(-1)]
    if len(chosen) == 0:
        return None
    if len(chosen) > MAX_PIXELS:
        chosen = chosen[np.linspace(0, len(chosen) - 1, MAX_PIXELS).astype(np.int64)]
    return robust_median(chosen)


def robust_median(pixels: np.ndarray) -> np.ndarray:
    """The median of the half of the pixels nearest the median: highlights, shadows and stray
    background drop out."""
    first = np.median(pixels, axis=0)
    distance = np.linalg.norm(pixels - first, axis=1)
    near = pixels[distance <= np.percentile(distance, 50)]
    return np.median(near if len(near) else pixels, axis=0)


def _outline_mask(view: View) -> np.ndarray | None:
    assert view.crop is not None and view.outline is not None
    points = view.box_in_crop(view.outline)
    points = points.mean(axis=0) + (points - points.mean(axis=0)) * OUTLINE_SHRINK
    image = Image.new("L", view.crop.size, 0)
    ImageDraw.Draw(image).polygon([tuple(p) for p in points.tolist()], fill=1)
    return np.asarray(image, dtype=bool)


def _center_mask(view: View) -> np.ndarray:
    assert view.crop is not None
    (x0, y0), (x1, y1) = view.box_in_crop()
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hw, hh = max(1.0, (x1 - x0) * CENTER_SHARE / 2), max(1.0, (y1 - y0) * CENTER_SHARE / 2)
    ys, xs = np.mgrid[0 : view.crop.height, 0 : view.crop.width]
    return (np.abs(xs + 0.5 - cx) <= hw) & (np.abs(ys + 0.5 - cy) <= hh)


def primitive_mesh(size: np.ndarray, round_: bool) -> Mesh:
    """A box or an upright (elliptic) cylinder filling `size`, its bottom center at the origin."""
    sx, sy, sz = (float(v) for v in size)
    if round_:
        bevel = min(0.004, 0.1 * min(sx, sy, sz))
        mesh = cylinder_mesh(sx / 2, sy, bevel=bevel, radius_z=sz / 2)
    else:
        mesh = box_mesh(sx, sy, sz, bevel=min(0.006, 0.08 * min(sx, sy, sz)))
    mesh.positions = mesh.positions + [0.0, sy / 2, 0.0]
    return mesh


def write_primitive(
    path: Path, size: np.ndarray, round_: bool, color: np.ndarray | None, *, object_id: str
) -> np.ndarray:
    """Write the primitive GLB; returns its size."""
    mesh = primitive_mesh(size, round_)
    rgb = srgb_to_linear(GRAY if color is None else color)
    node = Node(
        name="cylinder" if round_ else "box",
        mesh=MeshData(
            mesh.positions.astype(np.float32),
            mesh.triangles.astype(np.uint32),
            mesh.normals.astype(np.float32),
        ),
        base_color=(*rgb.tolist(), 1.0),
        roughness=0.7,
    )
    write_glb([node], path, extras={"clio": {"object": object_id, "backend": "primitive"}})
    return np.ptp(mesh.positions, axis=0)
