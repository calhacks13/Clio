"""Meshes for the primitive models (docs/room-scene.md, "Object models"): a box and a capped
cylinder, either with rounded edges, tessellated with numpy. Smooth normals on curved surfaces,
separate ones across creases (a cylinder's rim), every triangle wound counter-clockwise seen from
the side its normals face. Colors are sRGB in the pipeline; glTF wants linear factors.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

SEGMENTS = 48  # around anything round
BEVEL_STEPS = 4  # per half of a rounded edge


def srgb_to_linear(rgb: np.ndarray) -> np.ndarray:
    """sRGB 0..1 to the linear values glTF's baseColorFactor holds."""
    c = np.clip(np.asarray(rgb, dtype=np.float64), 0.0, 1.0)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


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
