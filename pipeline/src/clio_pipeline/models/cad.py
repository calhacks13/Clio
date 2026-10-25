"""CAD programs: what gemini-cad asks Gemini for, how an answer is checked, and how it becomes a
mesh (docs/room-scene.md, "Backends"). The primitive backend builds its box and cylinder here too.

A program is a list of named parts, each a primitive solid with its dimensions in meters, a
position, a rotation and a color, in the model's frame: +y up, origin at the bottom center of the
object, its front facing +z. The shapes and their `dims`:

    box       x, y, z: full lengths, centered; bevel: radius of its rounded edges (0: sharp)
    cylinder  radius, height: axis along y, centered; bevel: radius of its rounded rims
    cone      radiusBottom, radiusTop, height: a frustum along y, centered; one radius may be 0
    sphere    radius
    torus     radius (center to the middle of the tube), tube: a ring around y, lying in x-z;
              arc: the degrees of it kept, centered on +x (360, the default: the whole ring)
    capsule   radius, length: a cylinder of `length` along y with a half sphere on each end
    lathe     profile [[r, y], ...]: revolved about y, y from the part's position
    extrude   outline [[x, z], ...], height: a polygon in x-z extruded along y, centered

`rotation` is [x, y, z] in degrees about the part's position: x first, then y, then z, about
fixed axes (R = Rz Ry Rx). Colors are "#rrggbb" (sRGB); glTF wants linear factors, so they are
converted when written.

Everything is tessellated with numpy: smooth normals on curved surfaces, separate ones across
creases (a cylinder's rim, a lathe profile's corners), every triangle wound counter-clockwise seen
from the side its normals face. `fit_program` then scales the program uniformly so its height is
the measured one and moves its bottom center to the origin.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, replace
from typing import Any

import numpy as np

from ..glb import MeshData, Node

SHAPES = ("box", "cylinder", "cone", "sphere", "torus", "capsule", "lathe", "extrude")
MAX_PARTS = 48
MAX_POINTS = 128  # in a lathe profile or an extruded outline
SEGMENTS = 48  # around anything round
RINGS = 24  # pole to pole on a sphere, around a torus's tube
BEVEL_STEPS = 4  # per half of a rounded edge
CREASE_DEG = 35.0  # a lathe profile turning more than this at a point gets a sharp edge there
MIN_DIM_M = 1e-4  # 0.1 mm: anything thinner is not a part
MAX_DIM_M = 10.0  # nothing a lesson handles is this big
MAX_TURN_DEG = 3600.0
MIN_OPACITY = 0.15
DEFAULT_COLOR = "#9a9a9a"
DEFAULT_ROUGHNESS = 0.6

_HEX = re.compile(r"^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$")


class CadError(ValueError):
    """A CAD program, or a part of one, that cannot be built."""


# --- programs -------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Part:
    name: str
    shape: str
    dims: dict[str, Any]  # only the fields its shape reads, checked
    position: tuple[float, float, float]
    rotation: tuple[float, float, float]  # degrees
    color: str  # "#rrggbb", sRGB
    metalness: float
    roughness: float
    opacity: float

    def to_json(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "shape": self.shape,
            "dims": self.dims,
            "position": list(self.position),
            "rotation": list(self.rotation),
            "color": self.color,
            "metalness": self.metalness,
            "roughness": self.roughness,
            "opacity": self.opacity,
        }


@dataclass(frozen=True)
class Program:
    name: str
    parts: tuple[Part, ...]
    notes: str
    dropped: tuple[str, ...]  # what was left out of the answer, and why

    def to_json(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "parts": [p.to_json() for p in self.parts],
            "notes": self.notes,
        }


def validate_program(raw: Any) -> Program:
    """The parts of `raw` (a decoded answer) that can be built, at most MAX_PARTS. A part with an
    unknown shape, missing or impossible dims, or a bad position is left out and named in
    `dropped`; CadError when no part is left."""
    if not isinstance(raw, dict) or not isinstance(raw.get("parts"), list):
        raise CadError("not a CAD program: no list of parts")
    items = raw["parts"]
    dropped: list[str] = []
    if len(items) > MAX_PARTS:
        dropped.append(f"{len(items) - MAX_PARTS} parts past the first {MAX_PARTS}")
        items = items[:MAX_PARTS]
    parts: list[Part] = []
    names: set[str] = set()
    for i, item in enumerate(items):
        try:
            part = _part(item, i)
        except CadError as e:
            dropped.append(f"part {i + 1}: {e}")
            continue
        parts.append(replace(part, name=_unique(part.name, names)))
    if not parts:
        reason = f": {dropped[-1]}" if dropped else ""
        raise CadError(f"no part could be built{reason}")
    return Program(
        name=_text(raw.get("name"), 120) or "object",
        parts=tuple(parts),
        notes=_text(raw.get("notes"), 2000),
        dropped=tuple(dropped),
    )


def _part(item: Any, index: int) -> Part:
    if not isinstance(item, dict):
        raise CadError("not an object")
    shape = item.get("shape")
    if shape not in SHAPES:
        raise CadError(f"unknown shape {shape!r}")
    dims = item.get("dims")
    if not isinstance(dims, dict):
        raise CadError("no dims")
    rotation = item.get("rotation")
    return Part(
        name=_text(item.get("name"), 64) or f"part-{index + 1}",
        shape=shape,
        dims=_check_dims(shape, dims),
        position=_vec3(item.get("position"), "position", MAX_DIM_M),
        rotation=(0.0, 0.0, 0.0) if rotation is None else _vec3(rotation, "rotation", MAX_TURN_DEG),
        color=_hex(item.get("color")) or DEFAULT_COLOR,
        metalness=_unit(item.get("metalness"), 0.0),
        roughness=_unit(item.get("roughness"), DEFAULT_ROUGHNESS),
        opacity=max(MIN_OPACITY, _unit(item.get("opacity"), 1.0)),
    )


def _check_dims(shape: str, d: dict[str, Any]) -> dict[str, Any]:
    def length(key: str, *, zero_ok: bool = False, default: float | None = None) -> float:
        value = d.get(key)
        if value is None and default is not None:
            return default
        if not _is_number(value):
            raise CadError(f"{shape} needs dims.{key}")
        value = float(value)
        if value > MAX_DIM_M or value < (0.0 if zero_ok else MIN_DIM_M):
            raise CadError(f"dims.{key} = {value:g} m is impossible")
        return value

    if shape == "box":
        x, y, z = length("x"), length("y"), length("z")
        bevel = min(length("bevel", zero_ok=True, default=0.0), 0.5 * min(x, y, z))
        return {"x": x, "y": y, "z": z, "bevel": bevel}
    if shape == "cylinder":
        radius, height = length("radius"), length("height")
        bevel = min(length("bevel", zero_ok=True, default=0.0), radius, 0.5 * height)
        return {"radius": radius, "height": height, "bevel": bevel}
    if shape == "cone":
        bottom = length("radiusBottom", zero_ok=True, default=0.0)
        top = length("radiusTop", zero_ok=True, default=0.0)
        if max(bottom, top) < MIN_DIM_M:
            raise CadError("a cone needs radiusBottom or radiusTop")
        return {"radiusBottom": bottom, "radiusTop": top, "height": length("height")}
    if shape == "sphere":
        return {"radius": length("radius")}
    if shape == "torus":
        radius, tube = length("radius"), length("tube")
        if tube > radius:
            raise CadError("its tube is thicker than its ring")
        arc = d.get("arc", 360.0)
        if not _is_number(arc) or not 0 < float(arc) <= 360.0:
            raise CadError(f"dims.arc = {arc!r} is not between 0 and 360 degrees")
        return {"radius": radius, "tube": tube, "arc": max(float(arc), 10.0)}
    if shape == "capsule":
        return {"radius": length("radius"), "length": length("length", zero_ok=True, default=0.0)}
    if shape == "lathe":
        profile = _points(d.get("profile"), "profile")
        if min(r for r, _ in profile) < -1e-3:
            raise CadError("a lathe profile has a negative radius")
        profile = [[max(r, 0.0), y] for r, y in profile]
        if max(r for r, _ in profile) < MIN_DIM_M:
            raise CadError("a lathe profile on its axis has no width")
        # Closed to the axis (or on itself), the profile must enclose some area to be a solid.
        ring = np.asarray(profile + [[0.0, profile[-1][1]], [0.0, profile[0][1]]])
        if abs(_signed_area(ring)) < MIN_DIM_M**2 and abs(_signed_area(ring[:-2])) < MIN_DIM_M**2:
            raise CadError("a lathe profile needs some height")
        return {"profile": profile}
    outline = _points(d.get("outline"), "outline")
    if len(outline) < 3 or abs(_signed_area(np.asarray(outline))) < MIN_DIM_M**2:
        raise CadError("an extruded outline needs an area")
    if _self_crossing(np.asarray(outline)):
        raise CadError("its outline crosses itself")
    return {"outline": outline, "height": length("height")}


def _points(value: Any, key: str) -> list[list[float]]:
    if not isinstance(value, list) or not 2 <= len(value) <= MAX_POINTS:
        raise CadError(f"dims.{key} needs 2 to {MAX_POINTS} points")
    out: list[list[float]] = []
    for point in value:
        if (
            not isinstance(point, list | tuple)
            or len(point) != 2
            or not all(_is_number(v) and abs(v) <= MAX_DIM_M for v in point)
        ):
            raise CadError(f"dims.{key} has a point that is not two numbers in meters")
        if not out or math.dist(out[-1], point) > 1e-6:
            out.append([float(point[0]), float(point[1])])
    return out


def _vec3(value: Any, key: str, limit: float) -> tuple[float, float, float]:
    if (
        not isinstance(value, list | tuple)
        or len(value) != 3
        or not all(_is_number(v) and abs(v) <= limit for v in value)
    ):
        raise CadError(f"{key} is not three numbers")
    return (float(value[0]), float(value[1]), float(value[2]))


def _hex(value: Any) -> str | None:
    if not isinstance(value, str) or not (m := _HEX.match(value.strip())):
        return None
    digits = m.group(1).lower()
    if len(digits) == 3:
        digits = "".join(c * 2 for c in digits)
    return f"#{digits}"


def _unit(value: Any, default: float) -> float:
    return min(1.0, max(0.0, float(value))) if _is_number(value) else default


def _text(value: Any, limit: int) -> str:
    return " ".join(value.split())[:limit] if isinstance(value, str) else ""


def _unique(name: str, taken: set[str]) -> str:
    out, n = name, 2
    while out in taken:
        out, n = f"{name} {n}", n + 1
    taken.add(out)
    return out


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def hex_to_srgb(color: str) -> np.ndarray:
    """(3,) sRGB in 0..1 of "#rrggbb"."""
    digits = (_hex(color) or DEFAULT_COLOR)[1:]
    return np.array([int(digits[i : i + 2], 16) for i in (0, 2, 4)], dtype=np.float64) / 255.0


def srgb_to_hex(rgb: np.ndarray) -> str:
    values = np.clip(np.round(np.asarray(rgb, dtype=np.float64) * 255.0), 0, 255).astype(int)
    return "#" + "".join(f"{v:02x}" for v in values)


def srgb_to_linear(rgb: np.ndarray) -> np.ndarray:
    """sRGB 0..1 to the linear values glTF's baseColorFactor holds."""
    c = np.clip(np.asarray(rgb, dtype=np.float64), 0.0, 1.0)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


# --- meshes ---------------------------------------------------------------------------------------


@dataclass
class Mesh:
    """Triangles in some frame: positions, unit normals, (M, 3) vertex indices."""

    positions: np.ndarray
    normals: np.ndarray
    triangles: np.ndarray

    def transformed(self, matrix: np.ndarray, offset: np.ndarray | None = None) -> Mesh:
        """Positions through the 3x3 `matrix` (then `offset`); normals through its inverse
        transpose, so a stretch keeps them perpendicular to the surface."""
        positions = rows_times(self.positions, matrix)
        if offset is not None:
            positions = positions + offset
        normals = rows_times(self.normals, np.linalg.inv(matrix).T)
        normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
        return Mesh(positions, normals, self.triangles.copy())


def rows_times(rows: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    """Each row vector through `matrix` (rows @ matrix.T). einsum rather than BLAS: Accelerate's
    matmul raises spurious floating point warnings on exact zeros."""
    return np.einsum("ij,kj->ik", rows, matrix)


def shape_mesh(shape: str, dims: dict[str, Any]) -> Mesh:
    """A checked part shape (see `validate_program`) in the part's own frame."""
    if shape == "box":
        return box_mesh(dims["x"], dims["y"], dims["z"], bevel=dims.get("bevel", 0.0))
    if shape == "cylinder":
        return cylinder_mesh(dims["radius"], dims["height"], bevel=dims.get("bevel", 0.0))
    if shape == "cone":
        return cone_mesh(dims["radiusBottom"], dims["radiusTop"], dims["height"])
    if shape == "sphere":
        return sphere_mesh(dims["radius"])
    if shape == "torus":
        return torus_mesh(dims["radius"], dims["tube"], arc_deg=dims.get("arc", 360.0))
    if shape == "capsule":
        return capsule_mesh(dims["radius"], dims["length"])
    if shape == "lathe":
        return lathe_mesh(dims["profile"])
    if shape == "extrude":
        return extrude_mesh(dims["outline"], dims["height"])
    raise CadError(f"unknown shape {shape!r}")


def box_mesh(x: float, y: float, z: float, *, bevel: float = 0.0) -> Mesh:
    """A box of these full sizes about the origin. With a bevel its edges and corners are
    rounded with that radius: each face is a grid, and every grid point outside the inner box is
    pushed out to `bevel` from it, so the rounding is smooth and the faces stay flat."""
    half = np.array([x, y, z], dtype=np.float64) / 2.0
    r = float(min(max(bevel, 0.0), half.min()))
    inner = half - r
    coords = [_bevel_coords(h, r) for h in half]
    positions: list[np.ndarray] = []
    normals: list[np.ndarray] = []
    triangles: list[np.ndarray] = []
    count = 0
    for axis in range(3):
        u, v = [a for a in range(3) if a != axis]
        for sign in (-1.0, 1.0):
            cu, cv = np.meshgrid(coords[u], coords[v], indexing="ij")
            p = np.zeros((*cu.shape, 3))
            p[..., axis] = sign * half[axis]
            p[..., u], p[..., v] = cu, cv
            p = p.reshape(-1, 3)
            core = np.clip(p, -inner, inner)
            out = p - core
            length = np.linalg.norm(out, axis=1, keepdims=True)
            face = np.zeros(3)
            face[axis] = sign
            n = np.where(length > 1e-12, out / np.maximum(length, 1e-12), face)
            positions.append(core + r * n if r > 0 else p)
            normals.append(n)
            triangles.append(_grid_triangles(len(coords[u]), len(coords[v])) + count)
            count += len(p)
    return orient(
        Mesh(np.concatenate(positions), np.concatenate(normals), np.concatenate(triangles))
    )


def _bevel_coords(half: float, r: float) -> np.ndarray:
    """Grid coordinates along one box axis: the flat middle, then a rounded edge spread by angle
    (a face holds half of each edge's quarter circle, the neighbouring face the other half)."""
    if r <= 0:
        return np.array([-half, half])
    edge = (half - r) + r * np.tan(np.linspace(0.0, math.pi / 4, BEVEL_STEPS + 1))
    return np.concatenate([-edge[::-1], edge])


def _grid_triangles(nu: int, nv: int) -> np.ndarray:
    i, j = np.meshgrid(np.arange(nu - 1), np.arange(nv - 1), indexing="ij")
    a = (i * nv + j).reshape(-1)
    b, c, d = a + nv, a + nv + 1, a + 1
    return np.concatenate([np.stack([a, b, c], 1), np.stack([a, c, d], 1)])


def cylinder_mesh(
    radius: float, height: float, *, bevel: float = 0.0, radius_z: float | None = None
) -> Mesh:
    """A capped cylinder about the origin, axis along y, its rims rounded by `bevel`. With
    `radius_z` its section is an ellipse: `radius` along x, `radius_z` along z."""
    h, b = height / 2.0, float(min(max(bevel, 0.0), radius, height / 2.0))
    points: list[tuple[float, float]] = [(0.0, -h), (radius - b, -h)]
    normals: list[tuple[float, float]] = [(0.0, -1.0), (0.0, -1.0)]
    for center_y, start in ((-h + b, -math.pi / 2), (h - b, 0.0)):
        # A quarter circle round each rim; with no bevel it is one point turning its normal,
        # which leaves a sharp edge (the zero-length steps make no triangles).
        for a in np.linspace(start, start + math.pi / 2, 2 * BEVEL_STEPS + 1):
            points.append((radius - b + b * math.cos(a), center_y + b * math.sin(a)))
            normals.append((math.cos(a), math.sin(a)))
    points += [(radius - b, h), (0.0, h)]
    normals += [(0.0, 1.0), (0.0, 1.0)]
    mesh = revolve(points, normals)
    if radius_z is not None and radius_z != radius:
        mesh = mesh.transformed(np.diag([1.0, 1.0, radius_z / radius]))
    return mesh


def cone_mesh(radius_bottom: float, radius_top: float, height: float) -> Mesh:
    h = height / 2.0
    side = np.array([height, radius_bottom - radius_top])
    side /= np.linalg.norm(side)
    points = [(0.0, -h), (radius_bottom, -h), (radius_bottom, -h), (radius_top, h)]
    points += [(radius_top, h), (0.0, h)]
    normals = [(0.0, -1.0), (0.0, -1.0), tuple(side), tuple(side), (0.0, 1.0), (0.0, 1.0)]
    return revolve(points, normals)


def sphere_mesh(radius: float) -> Mesh:
    a = np.linspace(-math.pi / 2, math.pi / 2, RINGS + 1)
    n = np.stack([np.cos(a), np.sin(a)], axis=1)
    return revolve(radius * n, n)


def capsule_mesh(radius: float, length: float) -> Mesh:
    half = RINGS // 2
    a = np.concatenate(
        [np.linspace(-math.pi / 2, 0.0, half + 1), np.linspace(0.0, math.pi / 2, half + 1)]
    )
    n = np.stack([np.cos(a), np.sin(a)], axis=1)
    lift = np.where(np.arange(len(a)) <= half, -length / 2.0, length / 2.0)
    return revolve(radius * n + np.stack([np.zeros_like(lift), lift], axis=1), n)


def torus_mesh(radius: float, tube: float, *, arc_deg: float = 360.0) -> Mesh:
    """A ring around y in the x-z plane. Less than a full turn keeps `arc_deg` of it centered on
    +x (a handle), its ends closed with flat caps."""
    a = np.linspace(0.0, 2 * math.pi, RINGS + 1)[:-1]
    n = np.stack([np.cos(a), np.sin(a)], axis=1)
    points = n * tube + [radius, 0.0]
    if arc_deg >= 360.0:
        return revolve(points, n, closed=True)
    half = math.radians(arc_deg) / 2.0
    start, end = math.pi / 2 - half, math.pi / 2 + half  # revolve's angle is 0 at +z, 90 at +x
    meshes = [revolve(points, n, closed=True, theta=(start, end))]
    for angle, sign in ((start, -1.0), (end, 1.0)):
        meshes.append(_tube_cap(points, angle, sign * _tangent(angle)))
    return merge(meshes)


def _tangent(theta: float) -> np.ndarray:
    return np.array([math.cos(theta), 0.0, -math.sin(theta)])


def _tube_cap(points: np.ndarray, theta: float, normal: np.ndarray) -> Mesh:
    ring = _revolved(points, theta)
    center = ring.mean(axis=0)
    positions = np.concatenate([center[None], ring])
    k = len(ring)
    triangles = np.stack([np.zeros(k, int), 1 + np.arange(k), 1 + (np.arange(k) + 1) % k], 1)
    return orient(Mesh(positions, np.tile(normal, (k + 1, 1)), triangles))


def _revolved(points: np.ndarray, theta: float) -> np.ndarray:
    p = np.asarray(points, dtype=np.float64)
    return np.stack([p[:, 0] * math.sin(theta), p[:, 1], p[:, 0] * math.cos(theta)], axis=1)


def lathe_mesh(profile: list[list[float]]) -> Mesh:
    """A profile [[r, y], ...] revolved about y. An end off the axis is closed to it with a flat
    cap; a profile that comes back to its first point is a closed ring. Normals are smooth along
    the profile except where it turns by more than CREASE_DEG."""
    p = np.asarray(profile, dtype=np.float64).reshape(-1, 2)
    closed = len(p) >= 3 and np.linalg.norm(p[0] - p[-1]) < 1e-6
    if closed:
        p = p[:-1]
    else:
        if p[0, 0] > 1e-9:
            p = np.concatenate([[[0.0, p[0, 1]]], p])
        if p[-1, 0] > 1e-9:
            p = np.concatenate([p, [[0.0, p[-1, 1]]]])
    if _signed_area(p) < 0:  # the solid must be on the left going along the profile
        p = p[::-1]
    points, normals = _creased(p, closed)
    return revolve(points, normals, closed=closed)


def _creased(p: np.ndarray, closed: bool) -> tuple[np.ndarray, np.ndarray]:
    """Profile points with a normal each: the mean of the two segments' normals where the profile
    bends gently, two copies of the point (one per segment) where it creases."""
    seg = np.roll(p, -1, axis=0) - p if closed else p[1:] - p[:-1]
    seg_n = np.stack([seg[:, 1], -seg[:, 0]], axis=1)
    seg_n /= np.maximum(np.linalg.norm(seg_n, axis=1, keepdims=True), 1e-12)
    crease = math.cos(math.radians(CREASE_DEG))
    points: list[np.ndarray] = []
    normals: list[np.ndarray] = []
    for i in range(len(p)):
        before = seg_n[i - 1] if closed or i > 0 else None
        after = seg_n[i] if closed or i < len(seg_n) else None
        if before is None or after is None:
            points.append(p[i])
            normals.append(after if after is not None else before)
        elif float(before @ after) >= crease:
            mean = before + after
            points.append(p[i])
            normals.append(mean / max(np.linalg.norm(mean), 1e-12))
        else:
            # On a closed profile a crease at the first point works the same way: its first copy
            # carries the closing segment's normal, and the last row joins back to it.
            points += [p[i], p[i]]
            normals += [before, after]
    return np.asarray(points), np.asarray(normals)


def extrude_mesh(outline: list[list[float]], height: float) -> Mesh:
    """A polygon [[x, z], ...] in the x-z plane, extruded along y about the origin: flat caps
    (ear clipped, so the outline may be concave) and one flat quad per side."""
    poly = np.asarray(outline, dtype=np.float64).reshape(-1, 2)
    if len(poly) >= 2 and np.linalg.norm(poly[0] - poly[-1]) < 1e-6:
        poly = poly[:-1]
    if _signed_area(poly) < 0:
        poly = poly[::-1]
    poly = _drop_collinear(poly)
    caps = triangulate(poly)
    h = height / 2.0
    k = len(poly)
    meshes = []
    for y, ny in ((-h, -1.0), (h, 1.0)):
        positions = np.stack([poly[:, 0], np.full(k, y), poly[:, 1]], axis=1)
        meshes.append(orient(Mesh(positions, np.tile([0.0, ny, 0.0], (k, 1)), caps.copy())))
    edge = np.roll(poly, -1, axis=0) - poly
    side = np.stack([edge[:, 1], np.zeros(k), -edge[:, 0]], axis=1)
    side /= np.maximum(np.linalg.norm(side, axis=1, keepdims=True), 1e-12)
    a, b = poly, np.roll(poly, -1, axis=0)
    quads = np.stack(
        [
            np.stack([a[:, 0], np.full(k, -h), a[:, 1]], 1),
            np.stack([b[:, 0], np.full(k, -h), b[:, 1]], 1),
            np.stack([b[:, 0], np.full(k, h), b[:, 1]], 1),
            np.stack([a[:, 0], np.full(k, h), a[:, 1]], 1),
        ],
        axis=1,
    ).reshape(-1, 3)
    base = 4 * np.arange(k)[:, None]
    tris = np.concatenate([base + [0, 1, 2], base + [0, 2, 3]])
    meshes.append(orient(Mesh(quads, np.repeat(side, 4, axis=0), tris)))
    return merge(meshes)


def revolve(
    points: Any,
    normals: Any,
    *,
    closed: bool = False,
    theta: tuple[float, float] = (0.0, 2 * math.pi),
    segments: int = SEGMENTS,
) -> Mesh:
    """Profile points [r, y] with their normals [nr, ny] swept about y from theta[0] to theta[1]
    (0 at +z, a quarter turn at +x). `closed` joins the last point back to the first."""
    pts = np.asarray(points, dtype=np.float64).reshape(-1, 2)
    nrm = np.asarray(normals, dtype=np.float64).reshape(-1, 2)
    steps = max(3, math.ceil(segments * (theta[1] - theta[0]) / (2 * math.pi) - 1e-9))
    th = np.linspace(theta[0], theta[1], steps + 1)
    s, c = np.sin(th)[None, :], np.cos(th)[None, :]
    rows, width = len(pts), steps + 1
    pos = np.stack(
        [pts[:, :1] * s, np.broadcast_to(pts[:, 1:], (rows, width)), pts[:, :1] * c], axis=-1
    )
    nor = np.stack(
        [nrm[:, :1] * s, np.broadcast_to(nrm[:, 1:], (rows, width)), nrm[:, :1] * c], axis=-1
    )
    i = np.arange(rows if closed else rows - 1)
    j = np.arange(steps)
    a = (i[:, None] * width + j).reshape(-1)
    b = (((i + 1) % rows)[:, None] * width + j).reshape(-1)
    tris = np.concatenate([np.stack([a, b, b + 1], 1), np.stack([a, b + 1, a + 1], 1)])
    return orient(Mesh(pos.reshape(-1, 3), nor.reshape(-1, 3), tris))


def orient(mesh: Mesh) -> Mesh:
    """Drop triangles without area (a revolved point on the axis, a crease's twin points), wind
    every other one counter-clockwise seen from the side its vertex normals face, normalize the
    normals and drop vertices no triangle uses."""
    p, t = mesh.positions, np.asarray(mesh.triangles, dtype=np.int64).reshape(-1, 3)
    if len(t) == 0 or len(p) == 0:
        return Mesh(np.zeros((0, 3)), np.zeros((0, 3)), np.zeros((0, 3), dtype=np.int64))
    face = np.cross(p[t[:, 1]] - p[t[:, 0]], p[t[:, 2]] - p[t[:, 0]])
    scale = float(np.ptp(p, axis=0).max()) or 1.0
    keep = np.linalg.norm(face, axis=1) > 1e-10 * scale * scale
    t, face = t[keep], face[keep]
    flip = np.einsum("ij,ij->i", face, mesh.normals[t].sum(axis=1)) < 0
    t[flip] = t[flip][:, [0, 2, 1]]
    used, inverse = np.unique(t.reshape(-1), return_inverse=True)
    normals = mesh.normals[used]
    normals = normals / np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
    return Mesh(p[used], normals, inverse.reshape(-1, 3))


def merge(meshes: list[Mesh]) -> Mesh:
    offsets = np.cumsum([0] + [len(m.positions) for m in meshes])
    return Mesh(
        np.concatenate([m.positions for m in meshes]),
        np.concatenate([m.normals for m in meshes]),
        np.concatenate([m.triangles + o for m, o in zip(meshes, offsets, strict=False)]),
    )


def triangulate(poly: np.ndarray) -> np.ndarray:
    """Ear clipping of a simple counter-clockwise polygon (K, 2): (K - 2, 3) indices."""
    remaining = list(range(len(poly)))
    out: list[tuple[int, int, int]] = []
    while len(remaining) > 3:
        m = len(remaining)
        for k in range(m):
            i0, i1, i2 = remaining[k - 1], remaining[k], remaining[(k + 1) % m]
            a, b, c = poly[i0], poly[i1], poly[i2]
            if _cross(b - a, c - b) <= 1e-15:
                continue  # reflex: not an ear
            others = [j for j in remaining if j not in (i0, i1, i2)]
            if any(_in_triangle(poly[j], a, b, c) for j in others):
                continue
            out.append((i0, i1, i2))
            remaining.pop(k)
            break
        else:
            raise CadError("the outline could not be split into triangles")
    out.append(tuple(remaining))
    return np.asarray(out, dtype=np.int64)


def _cross(u: np.ndarray, v: np.ndarray) -> float:
    return float(u[0] * v[1] - u[1] * v[0])


def _in_triangle(p: np.ndarray, a: np.ndarray, b: np.ndarray, c: np.ndarray) -> bool:
    return _cross(b - a, p - a) >= 0 and _cross(c - b, p - b) >= 0 and _cross(a - c, p - c) >= 0


def _signed_area(poly: np.ndarray) -> float:
    x, y = poly[:, 0], poly[:, 1]
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def _drop_collinear(poly: np.ndarray) -> np.ndarray:
    keep = [
        abs(_cross(poly[i] - poly[i - 1], poly[(i + 1) % len(poly)] - poly[i])) > 1e-12
        for i in range(len(poly))
    ]
    return poly[np.asarray(keep)] if sum(keep) >= 3 else poly


def _self_crossing(poly: np.ndarray) -> bool:
    """Whether two edges of the closed polygon that do not share a corner cross."""
    k = len(poly)
    edges = [(poly[i], poly[(i + 1) % k]) for i in range(k)]
    for i in range(k):
        for j in range(i + 1, k):
            if j == i + 1 or (i == 0 and j == k - 1):
                continue
            (p1, p2), (q1, q2) = edges[i], edges[j]
            d1, d2 = _cross(p2 - p1, q1 - p1), _cross(p2 - p1, q2 - p1)
            d3, d4 = _cross(q2 - q1, p1 - q1), _cross(q2 - q1, p2 - q1)
            if d1 * d2 < 0 and d3 * d4 < 0:
                return True
    return False


def euler_matrix(degrees: tuple[float, float, float]) -> np.ndarray:
    """R = Rz Ry Rx of [x, y, z] degrees: about x first, then y, then z (fixed axes)."""
    x, y, z = (math.radians(v) for v in degrees)
    cx, sx, cy, sy, cz, sz = (
        math.cos(x),
        math.sin(x),
        math.cos(y),
        math.sin(y),
        math.cos(z),
        math.sin(z),
    )
    rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return rz @ ry @ rx


def part_mesh(part: Part) -> Mesh:
    """A part's mesh in the program's frame: turned about its position, then moved there."""
    return shape_mesh(part.shape, part.dims).transformed(
        euler_matrix(part.rotation), np.asarray(part.position)
    )


# --- fitting --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class FittedCad:
    nodes: list[Node]  # one per part, positions in meters with the origin at the bottom center
    size: np.ndarray  # (3,) bounds after fitting
    scale: float  # applied uniformly to the program
    program_size: np.ndarray  # (3,) bounds as the program gave them


def fit_program(program: Program, height: float) -> FittedCad:
    """The program scaled uniformly so its bounds are `height` tall, its bottom center moved to
    the origin, one GLB node per part with its color and material."""
    meshes = [part_mesh(part) for part in program.parts]
    points = np.concatenate([m.positions for m in meshes])
    low, high = points.min(axis=0), points.max(axis=0)
    span = high - low
    if span[1] < MIN_DIM_M:
        raise CadError("the program has no height")
    scale = float(height) / float(span[1])
    origin = np.array([(low[0] + high[0]) / 2.0, low[1], (low[2] + high[2]) / 2.0])
    nodes = [
        Node(
            name=part.name,
            mesh=MeshData(
                ((m.positions - origin) * scale).astype(np.float32),
                m.triangles.astype(np.uint32),
                m.normals.astype(np.float32),
            ),
            base_color=(*srgb_to_linear(hex_to_srgb(part.color)).tolist(), part.opacity),
            metallic=part.metalness,
            roughness=part.roughness,
            extras={"shape": part.shape},
        )
        for part, m in zip(program.parts, meshes, strict=True)
    ]
    return FittedCad(nodes, span * scale, scale, span)
