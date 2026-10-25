"""How big an object's model is and where it sits, from what was measured of it
(docs/data-pipeline.md, "Measured 3D for objects"; SceneModel `size`, `sizeSource`, `placement`).

Which measurement sizes a model, best first:

    shape   the fused shape box (shapes.json), from depth samples on the object: the model's
            size, its bottom center the model's origin, its yaw the model's turn.
    extent  the estimated extent (tracks.json): the width across the camera and the height, from
            the finders' boxes at the object's depth. The depth along the camera was never
            measured, so it is taken equal to the width, as the viewer's extent box does.
    radius  the plan's approximate radius: 2r every way, a guess.

The depth samples cover only the sides the camera saw. An axis they barely spread along (under
MIN_AXIS_M: only the top was seen, or one flat face) takes its size from the extent or the radius
instead, and a round thing, which is as deep as it is wide, takes its width for its depth; both
are said in the notes. What the shape box grew by is pushed away from the camera that saw the
object (`place`), since the samples lie on the near side. A flat-topped box keeps its measured top
and grows downward, toward the table it stands on.

Where it sits. A camera-tracked object's position is where the camera's ray through the middle of
its box met the depth map: on the face the camera saw, about halfway up. With only an extent the
model is centered on that position, its bottom half its height below it. It is not pushed back
from the seen face: the face seen changes as the camera moves, and the depth behind it was never
measured; the viewer centers the extent box the same way. A layout placement is the point on the
table where the object stands, so an object sized only by its radius and placed by layout stands
on its position; any other is centered on it.

The turn. A shape box's yaw is measured. The box is the same box turned a quarter turn with its x
and z sizes swapped, so of those four turns the model takes the one whose front (+z) faces the
camera of its best view: what a generator saw there becomes the model's front. Without a shape
box the model is turned to face that camera (rotationSource "view", a guess), or not turned at
all ("none") when no view saw it.
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .cad import rows_times

MIN_AXIS_M = 0.01
OFF_RATIO = 0.25  # a fitted model's axis this far from the measurement is noted
DEFAULT_RADIUS_M = 0.03  # the plan's default radius (packages/protocol/src/procedure.ts)


@dataclass(frozen=True)
class Measured:
    size: np.ndarray  # (3,) x, y (up), z, m: along the shape box's axes, or across/up/along a view
    bottom: np.ndarray  # (3,) W offset from the tracked position to the model's bottom center
    yaw: float | None  # the shape box's yaw about +y (measured); None without a shape box
    source: str  # "shape" | "extent" | "radius"
    notes: tuple[str, ...] = ()
    grown: np.ndarray = field(default_factory=lambda: np.zeros(3))  # added to the shape box, m


@dataclass(frozen=True)
class Placement:
    size: np.ndarray  # (3,) the model's size along its own axes once turned
    offset: np.ndarray  # (3,) W, tracked position to model origin
    yaw: float  # about +y
    rotation_source: str  # "shape" | "view" | "none"

    @property
    def rotation(self) -> np.ndarray:
        return yaw_quat(self.yaw)


def measure(obj: dict[str, Any], shape: dict[str, Any] | None, *, round_: bool = False) -> Measured:
    """The size and bottom offset of one tracks.json object, from its shapes.json entry (or None)
    when that has a box, else its extent, else its radius. `round_`: the model is a round thing,
    as deep as it is wide."""
    extent = obj.get("extent")
    radius = obj.get("radius")
    box = (shape or {}).get("box")
    if box:
        return _from_box(box, extent, radius, round_)
    if extent:
        width, height = float(extent["width"]), float(extent["height"])
        return Measured(
            np.array([width, height, width]), np.array([0.0, -height / 2, 0.0]), None, "extent"
        )
    notes: tuple[str, ...] = ()
    if not radius:
        radius = DEFAULT_RADIUS_M
        notes = (f"no size was recorded: sized by the plan's default radius, {radius:g} m",)
    r = float(radius)
    stands = _governing_source(obj) == "layout"
    return Measured(
        np.full(3, 2 * r), np.array([0.0, 0.0 if stands else -r, 0.0]), None, "radius", notes
    )


def _from_box(
    box: dict[str, Any], extent: dict[str, Any] | None, radius: float | None, round_: bool
) -> Measured:
    measured = np.asarray(box["size"], dtype=np.float64)
    size = measured.copy()
    center = np.asarray(box["center"], dtype=np.float64)
    notes: list[str] = []
    width = float(extent["width"]) if extent else (2 * float(radius) if radius else MIN_AXIS_M)
    height = float(extent["height"]) if extent else (2 * float(radius) if radius else MIN_AXIS_M)
    fill = "the extent" if extent else ("the radius" if radius else f"{MIN_AXIS_M:g} m")
    if size[1] < MIN_AXIS_M:
        size[1] = max(height, MIN_AXIS_M)
        notes.append(f"its depth samples are flat: height from {fill}")
    thin = [axis for axis in (0, 2) if size[axis] < MIN_AXIS_M]
    for axis in thin:
        size[axis] = max(width, MIN_AXIS_M)
    if thin:
        axes = " and ".join("xz"[axis // 2] for axis in thin)
        notes.append(f"its depth samples are thin along {axes}: sized there from {fill}")
    if round_ and abs(size[0] - size[2]) > 1e-6:
        size[0] = size[2] = max(size[0], size[2])
        notes.append("round, so as deep as it is wide")
    top = center[1] + measured[1] / 2
    bottom = np.array([center[0], top - size[1], center[2]])
    grown = np.array([size[0] - measured[0], 0.0, size[2] - measured[2]])
    return Measured(size, bottom, yaw_of(box["rotation"]), "shape", tuple(notes), grown)


def _governing_source(obj: dict[str, Any]) -> str | None:
    """The placement method behind most of the object's valid positions."""
    sources = [
        s
        for s, p in zip(obj.get("source", []), obj.get("position", []), strict=False)
        if p is not None
    ]
    return Counter(sources).most_common(1)[0][0] if sources else None


def place(measured: Measured, toward_camera: np.ndarray | None) -> Placement:
    """The model's turn and offset, given the direction from the object to its best view's camera
    (W; None when no view saw it). See the module docstring."""
    view = _view_yaw(toward_camera)
    if measured.yaw is not None:
        turns = measured.yaw + np.arange(4) * (math.pi / 2)
        k = int(np.argmax(np.cos(turns - view))) if view is not None else 0
        size = measured.size if k % 2 == 0 else measured.size[[2, 1, 0]]
        offset = measured.bottom + _push(measured, toward_camera)
        return Placement(size, offset, _wrap(float(turns[k])), "shape")
    if view is not None:
        return Placement(measured.size, measured.bottom, view, "view")
    return Placement(measured.size, measured.bottom, 0.0, "none")


def _push(measured: Measured, toward_camera: np.ndarray | None) -> np.ndarray:
    """Half of what the shape box grew by along each of its horizontal axes, away from the
    camera: the samples lie on the near side."""
    if toward_camera is None or measured.yaw is None or not measured.grown.any():
        return np.zeros(3)
    out = np.zeros(3)
    for axis, grown in ((0, measured.grown[0]), (2, measured.grown[2])):
        direction = box_axis(measured.yaw, axis)
        side = float(direction @ toward_camera)
        if grown > 0 and abs(side) > 1e-6:
            out -= math.copysign(grown / 2, side) * direction
    return out


def box_axis(yaw: float, axis: int) -> np.ndarray:
    """The box's x (axis 0) or z (axis 2) in W: R_y(yaw) applied to [1, 0, 0] or [0, 0, 1]."""
    c, s = math.cos(yaw), math.sin(yaw)
    return np.array([c, 0.0, -s]) if axis == 0 else np.array([s, 0.0, c])


def box_corners(
    position: np.ndarray, measured: Measured, toward_camera: np.ndarray | None
) -> np.ndarray:
    """(8, 3) corners in W of the measured box at `position`, turned by its measured yaw or else
    to face the camera: what a keyframe would see of it."""
    yaw = measured.yaw if measured.yaw is not None else (_view_yaw(toward_camera) or 0.0)
    sx, sy, sz = measured.size
    local = np.array(
        [[x, y, z] for x in (-sx / 2, sx / 2) for y in (0.0, sy) for z in (-sz / 2, sz / 2)]
    )
    c, s = math.cos(yaw), math.sin(yaw)
    turn = np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])
    return np.asarray(position, dtype=np.float64) + measured.bottom + rows_times(local, turn)


def _view_yaw(toward_camera: np.ndarray | None) -> float | None:
    """The yaw turning +z toward the camera, or None without a camera or one straight above."""
    if toward_camera is None:
        return None
    x, z = float(toward_camera[0]), float(toward_camera[2])
    return math.atan2(x, z) if math.hypot(x, z) > 1e-3 else None


def yaw_of(q: Any) -> float:
    """The yaw of a rotation about +y given as [x, y, z, w]."""
    return 2.0 * math.atan2(float(q[1]), float(q[3]))


def yaw_quat(yaw: float) -> np.ndarray:
    return np.array([0.0, math.sin(yaw / 2), 0.0, math.cos(yaw / 2)])


def _wrap(angle: float) -> float:
    return (angle + math.pi) % (2 * math.pi) - math.pi


def off_axes(size: np.ndarray, measured: np.ndarray, source: str) -> str | None:
    """How the fitted model's measured horizontal axes differ from the measurement by more than
    OFF_RATIO, in words; None when they agree. Only measured axes count: the extent's depth is a
    guess."""
    axes = (0,) if source == "extent" else (0, 2)
    off = [a for a in axes if measured[a] > 0 and abs(size[a] / measured[a] - 1) > OFF_RATIO]
    if not off:
        return None
    names = {0: "across", 2: "deep"}
    return ", ".join(f"{size[a]:.3f} m {names[a]} (measured {measured[a]:.3f})" for a in off)
