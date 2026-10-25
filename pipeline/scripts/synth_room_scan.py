"""Write fixtures/episodes/synthetic-room-scan/: a short lesson in a small room, recorded by a
headset with mesh detection and camera keyframes (docs/room-scene.md), for the compile's room
stage, `clio scene` and the viewer.

    cd pipeline && uv run python scripts/synth_room_scan.py            # the fixture
    cd pipeline && uv run python scripts/synth_room_scan.py --out /tmp/ep

Everything is computed, nothing is random: every run writes the same files (the JPEGs the same
bytes for one Pillow build). The scene, in the workspace frame W (origin at the table's front left
corner on its top, +x along its front edge, -z away from the learner, +y up):

- the room: 4.0 x 3.6 m and 2.6 m high, floor at y = -0.74, walls at x = -1.5 and 2.5 and at
  z = -2.1 and 1.5; a 1.0 x 0.6 m table 0.74 m high whose top is the workspace (x 0..1, z -0.6..0)
- the room scan, one snapshot at t = 0 (media/room-scan-1.glb, written as the headset writes it:
  no normals): mesh-1, the global mesh (floor, ceiling, walls, and the table's top and sides, on
  a grid of about 25 cm, posed at the floor's center and turned a quarter about +y, so its node
  transform matters), and mesh-2, the table's volume
- a red cup (a cylinder, 4 cm radius, 10 cm high) and a blue box (12 x 8 x 8 cm, turned 20
  degrees) on the table; neither moves
- 9 s at 30 Hz: the learner leans over the table and walks a 100 degree arc 0.8 m around its
  center, looking at the objects; no hands are tracked
- the tracker answers on every sixth frame (200 ms of capture time apart, 60 ms late): per object
  it sees, a measured box, outline and up to 16 depth samples (observations.ndjson), and the 3D
  state lifted from them (objects.ndjson, flags 10, observedT the capture time)
- 8 keyframes, one a second, on tracker frames (capturedT == observedT): 640 x 480 JPEGs of the
  room and the objects ray cast from the camera pose recorded with them
- environment.planes at t = 0 (floor, table, four walls), a two-step plan that points at the cup
  and then at the box (labels, detector queries, show phrases), finished as completed
"""

from __future__ import annotations

import argparse
import io
import json
import math
import shutil
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from clio_pipeline.glb import MeshData, Node, quat_matrix, write_glb

EPISODE_ID = "ep-synthetic-room-scan"
DEFAULT_OUT = Path(__file__).resolve().parents[2] / "fixtures" / "episodes" / "synthetic-room-scan"

FPS = 30
DURATION_MS = 9000.0
TRACKER_EVERY = 6  # frames: 200 ms
TRACKER_LAG_MS = 60.0
KEYFRAME_EVERY = 5  # tracker frames: 1 s
KEYFRAME_LAG_MS = 40.0

TABLE_HEIGHT = 0.74
ROOM_LO = np.array([-1.5, -TABLE_HEIGHT, -2.1])
ROOM_HI = np.array([2.5, 2.6 - TABLE_HEIGHT, 1.5])
TABLE_LO = np.array([0.0, -TABLE_HEIGHT, -0.6])
TABLE_HI = np.array([1.0, 0.0, 0.0])
CUP_BASE, CUP_RADIUS, CUP_HEIGHT = np.array([0.3, 0.0, -0.25]), 0.04, 0.10
BOX_BASE, BOX_SIZE, BOX_YAW = np.array([0.68, 0.0, -0.32]), np.array([0.12, 0.08, 0.08]), 20.0
LOOK_AT = np.array([0.49, 0.05, -0.285])  # between the two objects

# The global mesh's pose: the floor's center, a quarter turn about +y.
GLOBAL_POSE = ([0.5, -TABLE_HEIGHT, -0.3], [0.0, math.sqrt(0.5), 0.0, math.sqrt(0.5)])
TABLE_POSE = ([0.5, 0.0, -0.3], [0.0, 0.0, 0.0, 1.0])  # the table volume: its top's center

CAMERA = {
    "intrinsics": {"width": 1280, "height": 960, "fx": 800, "fy": 800, "cx": 640, "cy": 480},
    # 3 cm right, 2 cm up and 2.5 cm ahead of the eyes, pitched 15 degrees down
    "headFromCamera": [0.032, 0.02, -0.025, -0.1305, 0.0, 0.0, 0.9914],
    "source": "default",
}
KEYFRAME_SIZE = (640, 480)
SUPERSAMPLE = 2

# Surfaces the ray caster tells apart.
FLOOR, CEILING, WALL_X0, WALL_X1, WALL_Z0, WALL_Z1, TABLE, CUP, CUP_TOP, BOX = range(10)
OBJECT_SURFACES = {"cup": (CUP, CUP_TOP), "box": (BOX,)}
LIGHT = np.array([0.3, 1.0, 0.5]) / np.linalg.norm([0.3, 1.0, 0.5])


# --- poses ----------------------------------------------------------------------------------------


def q4(values) -> list[float]:
    """Round like the recorder (0.1 mm, 1e-4), without -0.0."""
    return [round(float(v), 4) + 0.0 for v in values]


def quat_from_matrix(m: np.ndarray) -> np.ndarray:
    """Unit quaternion (x, y, z, w) of a rotation matrix, w >= 0."""
    w = math.sqrt(max(0.0, 1.0 + m[0, 0] + m[1, 1] + m[2, 2])) / 2.0
    x = math.copysign(
        math.sqrt(max(0.0, 1.0 + m[0, 0] - m[1, 1] - m[2, 2])) / 2.0, m[2, 1] - m[1, 2]
    )
    y = math.copysign(
        math.sqrt(max(0.0, 1.0 - m[0, 0] + m[1, 1] - m[2, 2])) / 2.0, m[0, 2] - m[2, 0]
    )
    z = math.copysign(
        math.sqrt(max(0.0, 1.0 - m[0, 0] - m[1, 1] + m[2, 2])) / 2.0, m[1, 0] - m[0, 1]
    )
    q = np.array([x, y, z, w])
    return q / np.linalg.norm(q)


def look_rotation(eye: np.ndarray, target: np.ndarray) -> np.ndarray:
    """A camera rotation (WebXR axes: looking down -z, +y up) at `eye` looking at `target`."""
    back = eye - target
    back /= np.linalg.norm(back)
    right = np.cross([0.0, 1.0, 0.0], back)
    right /= np.linalg.norm(right)
    return np.stack([right, np.cross(back, right), back], axis=1)


def compose(a: list[float], b: list[float]) -> np.ndarray:
    """Pose a then pose b (b expressed in a's frame), as [px, py, pz, qx, qy, qz, qw]."""
    ra = quat_matrix(a[3:])
    m = ra @ quat_matrix(b[3:])
    return np.concatenate([np.asarray(a[:3]) + ra @ np.asarray(b[:3]), quat_from_matrix(m)])


def head_pose(t: float) -> list[float]:
    """The head on its arc at `t` (ms), turned so the camera looks at LOOK_AT."""
    s = 0.5 - 0.5 * math.cos(math.pi * t / DURATION_MS)  # eases in and out
    angle = math.radians(-50.0 + 100.0 * s)
    center = np.array([0.5, 0.0, -0.3])
    height = 0.66 + 0.015 * math.sin(t / 700.0)
    eye = center + np.array([0.8 * math.sin(angle), height, 0.8 * math.cos(angle)])
    mount = np.asarray(CAMERA["headFromCamera"], dtype=float)
    mount_rotation = quat_matrix(mount[3:])
    rotation = look_rotation(eye, LOOK_AT) @ mount_rotation.T
    for _ in range(2):  # the camera sits a few cm from the eyes: aim it, not them
        camera = eye + rotation @ mount[:3]
        rotation = look_rotation(camera, LOOK_AT) @ mount_rotation.T
    return q4([*eye, *quat_from_matrix(rotation)])


@dataclass(frozen=True)
class View:
    position: np.ndarray
    rotation: np.ndarray  # camera to W
    width: int
    height: int
    fx: float
    fy: float
    cx: float
    cy: float


def camera_view(pose: list[float], width: int, height: int) -> View:
    """The camera at `pose` (W) with meta.camera's intrinsics scaled to width x height."""
    k = CAMERA["intrinsics"]
    sx, sy = width / k["width"], height / k["height"]
    q = np.asarray(pose[3:], dtype=float)
    return View(
        np.asarray(pose[:3], dtype=float),
        quat_matrix(q / np.linalg.norm(q)),
        width,
        height,
        k["fx"] * sx,
        k["fy"] * sy,
        k["cx"] * sx,
        k["cy"] * sy,
    )


# --- the ray caster -------------------------------------------------------------------------------


@dataclass
class Render:
    surface: np.ndarray  # (H, W) int: the surface each pixel sees
    points: np.ndarray  # (H, W, 3) where, in W
    rgb: np.ndarray  # (H, W, 3) float, sRGB 0..1


def render(view: View, supersample: int = SUPERSAMPLE) -> Render:
    """Cast one ray per pixel (`supersample` squared per output pixel) into the scene."""
    s = supersample
    w, h = view.width * s, view.height * s
    # Pixel centers at integer coordinates: a supersampled pixel k sits at (k + 0.5) / s - 0.5.
    u, v = np.meshgrid((np.arange(w) + 0.5) / s - 0.5, (np.arange(h) + 0.5) / s - 0.5)
    local = np.stack([(u - view.cx) / view.fx, -(v - view.cy) / view.fy, -np.ones_like(u)], -1)
    d = local.reshape(-1, 3) @ view.rotation.T
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    o = np.broadcast_to(view.position, d.shape)

    t, surface, normal = _room(o, d)
    for hit in (_box(o, d, TABLE_LO, TABLE_HI, TABLE), _cup(o, d), _blue_box(o, d)):
        nearer = hit[0] < t
        t = np.where(nearer, hit[0], t)
        surface = np.where(nearer, hit[1], surface)
        normal = np.where(nearer[:, None], hit[2], normal)
    points = o + d * t[:, None]
    rgb = _albedo(surface, points) * (0.55 + 0.45 * np.clip(normal @ LIGHT, 0.0, 1.0))[:, None]
    return Render(surface.reshape(h, w), points.reshape(h, w, 3), rgb.reshape(h, w, 3))


def _room(o: np.ndarray, d: np.ndarray):
    """Where rays from inside the room leave it: (t, surface, inward normal)."""
    with np.errstate(divide="ignore"):
        exits = np.where(d > 0, (ROOM_HI - o) / d, (ROOM_LO - o) / d)
    axis = np.argmin(exits, axis=1)
    t = exits[np.arange(len(d)), axis]
    positive = d[np.arange(len(d)), axis] > 0
    faces = np.array([[WALL_X0, WALL_X1], [FLOOR, CEILING], [WALL_Z0, WALL_Z1]])
    surface = faces[axis, positive.astype(int)]
    normal = np.zeros_like(d)
    normal[np.arange(len(d)), axis] = np.where(positive, -1.0, 1.0)
    return t, surface, normal


def _box(o: np.ndarray, d: np.ndarray, lo, hi, surface_id: int):
    """Rays against an axis-aligned box seen from outside."""
    with np.errstate(divide="ignore", invalid="ignore"):
        t1, t2 = (lo - o) / d, (hi - o) / d
    near, far = np.minimum(t1, t2), np.maximum(t1, t2)
    axis = np.argmax(near, axis=1)
    t_in = near[np.arange(len(d)), axis]
    hit = (t_in <= far.min(axis=1)) & (t_in > 1e-6)
    normal = np.zeros_like(d)
    normal[np.arange(len(d)), axis] = -np.sign(d[np.arange(len(d)), axis])
    return np.where(hit, t_in, np.inf), np.full(len(d), surface_id), normal


def _blue_box(o: np.ndarray, d: np.ndarray):
    """The box, turned BOX_YAW about +y around its base: the ray in its own frame."""
    yaw = math.radians(BOX_YAW)
    turn = np.array(
        [[math.cos(yaw), 0, math.sin(yaw)], [0, 1, 0], [-math.sin(yaw), 0, math.cos(yaw)]]
    )
    half = BOX_SIZE / 2
    t, surface, normal = _box(
        (o - BOX_BASE) @ turn,
        d @ turn,
        [-half[0], 0, -half[2]],
        [half[0], BOX_SIZE[1], half[2]],
        BOX,
    )
    return t, surface, normal @ turn.T


def _cup(o: np.ndarray, d: np.ndarray):
    """A closed vertical cylinder standing on the table: its side, else its top."""
    p = o - CUP_BASE
    a = d[:, 0] ** 2 + d[:, 2] ** 2
    b = 2 * (p[:, 0] * d[:, 0] + p[:, 2] * d[:, 2])
    c = p[:, 0] ** 2 + p[:, 2] ** 2 - CUP_RADIUS**2
    disc = b * b - 4 * a * c
    with np.errstate(invalid="ignore", divide="ignore"):
        t_side = (-b - np.sqrt(disc)) / (2 * a)
        y = p[:, 1] + t_side * d[:, 1]
        side = (disc >= 0) & (t_side > 1e-6) & (y >= 0) & (y <= CUP_HEIGHT)
        t_top = (CUP_HEIGHT - p[:, 1]) / d[:, 1]
        top_xz = p[:, [0, 2]] + t_top[:, None] * d[:, [0, 2]]
        top = (t_top > 1e-6) & ((top_xz**2).sum(axis=1) <= CUP_RADIUS**2)
    t = np.where(side, t_side, np.where(top, t_top, np.inf))
    surface = np.where(side, CUP, CUP_TOP)
    hit = p + d * np.where(np.isfinite(t), t, 0.0)[:, None]
    radial = np.stack([hit[:, 0], np.zeros(len(d)), hit[:, 2]], axis=1) / CUP_RADIUS
    normal = np.where(side[:, None], radial, [0.0, 1.0, 0.0])
    return t, surface, normal


def _albedo(surface: np.ndarray, p: np.ndarray) -> np.ndarray:
    """Surface colors (sRGB): a checkered floor, a different color for each wall, a rail on the
    far wall, wood grain on the table, a red cup and a blue box."""
    colors = np.array(
        [
            [0.55, 0.45, 0.35],  # floor
            [0.86, 0.86, 0.83],  # ceiling
            [0.62, 0.70, 0.78],  # wall at x = -1.5
            [0.70, 0.76, 0.62],  # wall at x = 2.5
            [0.80, 0.74, 0.62],  # the far wall, z = -2.1
            [0.78, 0.66, 0.68],  # the wall behind the learner, z = 1.5
            [0.72, 0.58, 0.40],  # table
            [0.80, 0.10, 0.10],  # cup
            [0.42, 0.05, 0.05],  # cup, seen from above
            [0.12, 0.30, 0.80],  # box
        ]
    )
    rgb = colors[surface]
    checker = ((np.floor(p[:, 0] / 0.5) + np.floor(p[:, 2] / 0.5)) % 2 == 1) & (surface == FLOOR)
    rgb[checker] *= 0.8
    rail = (surface == WALL_Z0) & (p[:, 1] > 0.2) & (p[:, 1] < 0.32)
    rgb[rail] = [0.45, 0.40, 0.34]
    grain = surface == TABLE
    rgb[grain] *= (0.94 + 0.06 * np.sin(p[grain, 2] * 90.0))[:, None]
    return rgb


def keyframe_jpeg(frame: Render, quality: int = 85) -> bytes:
    """The supersampled render averaged down to one pixel per block, as a JPEG."""
    h, w, _ = frame.rgb.shape
    s = SUPERSAMPLE
    rgb = frame.rgb.reshape(h // s, s, w // s, s, 3).mean(axis=(1, 3))
    image = Image.fromarray(np.round(np.clip(rgb, 0, 1) * 255).astype(np.uint8), "RGB")
    out = io.BytesIO()
    image.save(out, "JPEG", quality=quality)
    return out.getvalue()


# --- the tracker ----------------------------------------------------------------------------------


def _hull(points: np.ndarray) -> np.ndarray:
    """Convex hull (monotone chain) of (N, 2) points, counterclockwise in image coordinates."""
    pts = sorted(set(map(tuple, points.tolist())))
    if len(pts) < 3:
        return np.asarray(pts, dtype=float)

    def half(seq):
        out: list[tuple[float, float]] = []
        for p in seq:
            while len(out) >= 2:
                (ax, ay), (bx, by) = out[-2], out[-1]
                if (bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax) > 0:
                    break
                out.pop()
            out.append(p)
        return out

    lower, upper = half(pts), half(reversed(pts))
    return np.asarray(lower[:-1] + upper[:-1], dtype=float)


def observe(frame: Render, object_id: str, min_pixels: int = 12) -> dict | None:
    """What a tracker would answer about one object on this frame: a normalized box, outline,
    point and contact, the tracked 3D point (the surface seen at the box's center) and up to 16
    depth samples on a 4 x 4 grid over the mask. None when the object is not in view."""
    h, w = frame.surface.shape
    mask = np.isin(frame.surface, OBJECT_SURFACES[object_id])
    rows, cols = np.nonzero(mask)
    if len(rows) < min_pixels:
        return None
    x0, x1, y0, y1 = cols.min() / w, (cols.max() + 1) / w, rows.min() / h, (rows.max() + 1) / h
    corners = np.concatenate(
        [np.stack([cols + dx, rows + dy], axis=1) for dx in (0, 1) for dy in (0, 1)]
    )
    hull = _hull(corners) / [w, h]
    if len(hull) > 24:
        hull = hull[np.linspace(0, len(hull), 24, endpoint=False).astype(int)]
    center = np.array([(x0 + x1) / 2 * w, (y0 + y1) / 2 * h])
    nearest = np.argmin((cols + 0.5 - center[0]) ** 2 + (rows + 0.5 - center[1]) ** 2)
    samples = []
    for gy in (0.2, 0.4, 0.6, 0.8):
        for gx in (0.2, 0.4, 0.6, 0.8):
            target = np.array([(x0 + gx * (x1 - x0)) * w, (y0 + gy * (y1 - y0)) * h])
            k = np.argmin((cols + 0.5 - target[0]) ** 2 + (rows + 0.5 - target[1]) ** 2)
            if abs(cols[k] + 0.5 - target[0]) <= 1.5 and abs(rows[k] + 0.5 - target[1]) <= 1.5:
                samples.append(q4(frame.points[rows[k], cols[k]]))
    return {
        "box": q4([x0, y0, x1, y1]),
        "outline": [q4(p) for p in hull],
        "point": q4([(x0 + x1) / 2, (y0 + y1) / 2]),
        "contact": q4([(x0 + x1) / 2, y1]),
        "position": q4(frame.points[rows[nearest], cols[nearest]]),
        "surface": samples,
    }


# --- the room scan --------------------------------------------------------------------------------


def _grid(origin, du, dv, normal, cell: float):
    """A grid of quads spanning origin + a du + b dv (a, b in 0..1), wound to face `normal`."""
    origin, du, dv = (np.asarray(x, dtype=float) for x in (origin, du, dv))
    nu = max(1, round(np.linalg.norm(du) / cell))
    nv = max(1, round(np.linalg.norm(dv) / cell))
    a, b = np.meshgrid(np.linspace(0, 1, nu + 1), np.linspace(0, 1, nv + 1), indexing="ij")
    points = origin + a.reshape(-1, 1) * du + b.reshape(-1, 1) * dv
    index = np.arange((nu + 1) * (nv + 1)).reshape(nu + 1, nv + 1)
    quads = np.stack(
        [index[:-1, :-1], index[1:, :-1], index[1:, 1:], index[:-1, 1:]], axis=-1
    ).reshape(-1, 4)
    triangles = np.concatenate([quads[:, [0, 1, 2]], quads[:, [0, 2, 3]]])
    if np.dot(np.cross(du, dv), normal) < 0:
        triangles = triangles[:, [0, 2, 1]]
    return points, triangles


def _box_faces(lo, hi, cell: float, *, inward: bool, bottom: bool = True):
    """The faces of a box as grids, their normals facing in (a room) or out (furniture)."""
    lo, hi = np.asarray(lo, dtype=float), np.asarray(hi, dtype=float)
    size = hi - lo
    ex, ey, ez = np.diag(size)
    sign = -1.0 if inward else 1.0
    faces = [
        (lo, ez, ey, [-sign, 0, 0]),
        (lo + ex, ez, ey, [sign, 0, 0]),
        (lo, ex, ez, [0, -sign, 0]),
        (lo + ey, ex, ez, [0, sign, 0]),
        (lo, ex, ey, [0, 0, -sign]),
        (lo + ez, ex, ey, [0, 0, sign]),
    ]
    if not bottom:
        del faces[2]
    return [_grid(o, du, dv, n, cell) for o, du, dv, n in faces]


def _merge(parts) -> tuple[np.ndarray, np.ndarray]:
    points, triangles, offset = [], [], 0
    for p, t in parts:
        points.append(p)
        triangles.append(t + offset)
        offset += len(p)
    return np.concatenate(points), np.concatenate(triangles)


def _local(points: np.ndarray, pose) -> np.ndarray:
    """W points in the frame of a mesh posed at `pose` (translation, rotation)."""
    translation, rotation = pose
    return (points - np.asarray(translation)) @ quat_matrix(rotation)


def room_scan() -> tuple[bytes, list[dict]]:
    """media/room-scan-1.glb and the event's mesh list."""
    room = _box_faces(ROOM_LO, ROOM_HI, 0.25, inward=True)
    table = _box_faces(TABLE_LO, TABLE_HI, 0.1, inward=False, bottom=False)
    global_points, global_triangles = _merge(room + table)
    corners = np.array(
        [[(TABLE_LO, TABLE_HI)[(k >> a) & 1][a] for a in range(3)] for k in range(8)]
    )
    faces = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
    volume = np.array([t for a, b, c, d in faces for t in ((a, b, c), (a, c, d))])
    meshes = [
        ("mesh-1", global_points, global_triangles, GLOBAL_POSE, "other", "global mesh", True),
        ("mesh-2", corners, volume, TABLE_POSE, "table", "table", False),
    ]
    nodes, entries = [], []
    for mesh_id, points, triangles, pose, kind, label, is_global in meshes:
        local = np.round(_local(points, pose), 5).astype(np.float32)
        extras = {"kind": kind, "label": label, "global": is_global}
        mesh = MeshData(local, triangles.astype(np.uint32))
        nodes.append(Node(mesh_id, mesh, translation=pose[0], rotation=pose[1], extras=extras))
        entries.append(
            {
                "id": mesh_id,
                "kind": kind,
                "label": label,
                "global": is_global,
                "vertices": len(local),
                "triangles": len(triangles),
            }
        )
    return write_glb(nodes), entries


def planes() -> list[dict]:
    """The planes a headset detects in this room: floor, table, walls (+y the plane normal)."""

    def upright(yaw_deg: float) -> list[float]:
        """A wall plane's rotation: +y (the normal) turned to horizontal, then yawed."""
        tilt = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], dtype=float)  # +y to +z
        yaw = math.radians(yaw_deg)
        turn = np.array(
            [[math.cos(yaw), 0, math.sin(yaw)], [0, 1, 0], [-math.sin(yaw), 0, math.cos(yaw)]]
        )
        return q4(quat_from_matrix(turn @ tilt))

    center = (ROOM_LO + ROOM_HI) / 2
    half = (ROOM_HI - ROOM_LO) / 2
    wall_y = center[1]

    def wall(id_, position, yaw, width):
        polygon = [[-width, -half[1]], [width, -half[1]], [width, half[1]], [-width, half[1]]]
        return {
            "id": id_,
            "kind": "wall",
            "label": "wall",
            "orientation": "vertical",
            "pose": q4([*position, *upright(yaw)]),
            "polygon": [q4(p) for p in polygon],
        }

    return [
        {
            "id": "plane-1",
            "kind": "floor",
            "label": "floor",
            "orientation": "horizontal",
            "pose": q4([center[0], ROOM_LO[1], center[2], 0, 0, 0, 1]),
            "polygon": [
                q4(p)
                for p in [
                    [-half[0], -half[2]],
                    [half[0], -half[2]],
                    [half[0], half[2]],
                    [-half[0], half[2]],
                ]
            ],
        },
        {
            "id": "plane-2",
            "kind": "table",
            "label": "table",
            "orientation": "horizontal",
            "pose": [0.5, 0.0, -0.3, 0.0, 0.0, 0.0, 1.0],
            "polygon": [[-0.5, -0.3], [0.5, -0.3], [0.5, 0.3], [-0.5, 0.3]],
        },
        wall("plane-3", [center[0], wall_y, ROOM_LO[2]], 0.0, half[0]),  # the far wall
        wall("plane-4", [ROOM_LO[0], wall_y, center[2]], 90.0, half[2]),
        wall("plane-5", [ROOM_HI[0], wall_y, center[2]], -90.0, half[2]),
        wall("plane-6", [center[0], wall_y, ROOM_HI[2]], 180.0, half[0]),
    ]


# --- the episode ----------------------------------------------------------------------------------

HAND_JOINTS = [
    "wrist",
    *[f"thumb-{j}" for j in ("metacarpal", "phalanx-proximal", "phalanx-distal", "tip")],
    *[
        f"{finger}-finger-{j}"
        for finger in ("index", "middle", "ring", "pinky")
        for j in ("metacarpal", "phalanx-proximal", "phalanx-intermediate", "phalanx-distal", "tip")
    ],
]
OBJECTS = [
    {
        "id": "cup",
        "label": "red cup",
        "kind": "container",
        "description": "A red plastic cup standing on the left half of the table",
        "radius": 0.04,
        "hidden": False,
        "placement": {"method": "detect", "hint": "left half of the table"},
        "tracking": {"query": "red plastic cup", "moves": False},
    },
    {
        "id": "box",
        "label": "blue box",
        "kind": "item",
        "description": "A small blue cardboard box lying on the right half of the table",
        "radius": 0.06,
        "hidden": False,
        "placement": {"method": "detect", "hint": "right half of the table"},
        "tracking": {"query": "small blue cardboard box", "moves": False},
    },
]
STEPS = [
    {
        "id": "point-cup",
        "instruction": "Point at the red cup on the table.",
        "doneWhen": "the learner points at the red cup",
        "targets": ["cup"],
        "hand": "either",
        "action": {"verb": "point_at", "object": "cup", "hand": "either"},
        "show": [
            {
                "object": "cup",
                "role": "act",
                "phrase": "red plastic cup",
                "description": "Red plastic cup, about 8 cm across and 10 cm tall, standing "
                "upright on the left half of the table",
            }
        ],
        "success": {"type": "confirm", "by": "either"},
        "mistakes": [],
    },
    {
        "id": "point-box",
        "instruction": "Now point at the blue box beside it.",
        "doneWhen": "the learner points at the blue box",
        "targets": ["box"],
        "hand": "either",
        "action": {"verb": "point_at", "object": "box", "hand": "either"},
        "show": [
            {
                "object": "box",
                "role": "act",
                "phrase": "small blue box",
                "description": "Small blue cardboard box, 12 by 8 by 8 cm, lying on the right "
                "half of the table, turned a little",
            }
        ],
        "success": {"type": "confirm", "by": "either"},
        "mistakes": [],
    },
]


def frame_time(k: int) -> float:
    return round(k * 1000.0 / FPS, 3)


def meta() -> dict:
    procedure = {"id": "point-at-objects", "version": 1, "title": "Point at the cup and the box"}
    return {
        "schema": "clio.episode/1",
        "episodeId": EPISODE_ID,
        "createdAt": "2026-10-25T06:00:00.000Z",
        "mode": "learn",
        "procedure": procedure,
        "operator": {"role": "learner"},
        "clock": {"timeline": "performance.now", "startEpochMs": 1792908000000.0},
        "space": {
            "frame": "workspace",
            "units": "m",
            "upAxis": "+y",
            "worldFromWorkspace": [-0.5, TABLE_HEIGHT, -0.3, 0.0, 0.0, 0.0, 1.0],
            "calibration": "pinch_two_corners",
            "anchored": False,
        },
        "hands": {
            "joints": HAND_JOINTS,
            "jointFields": ["px", "py", "pz", "qx", "qy", "qz", "qw", "radius"],
        },
        "objects": [
            {
                "id": "cup",
                "label": "red cup",
                "position": q4(CUP_BASE + [0, CUP_HEIGHT / 2, 0]),
                "radius": 0.04,
                "method": "detector",
            },
            {
                "id": "box",
                "label": "blue box",
                "position": q4(BOX_BASE + [0, BOX_SIZE[1] / 2, 0]),
                "radius": 0.06,
                "method": "detector",
            },
        ],
        "coach": {"kind": "scripted"},
        "device": {
            "userAgent": "clio-synth",
            "emulated": True,
            "xrFeatures": ["local-floor", "plane-detection", "mesh-detection", "camera-access"],
        },
        "app": {"version": "synthetic"},
        "features": [
            "object.flags",
            "object.observations",
            "object.surface",
            "environment.planes",
            "environment.meshes",
            "scene.keyframes",
        ],
        "camera": CAMERA,
        "plan": {
            "schema": "clio.procedure/1",
            **procedure,
            "origin": {
                "kind": "generated",
                "goal": "show me the cup and the box",
                "model": "synthetic",
                "createdAt": "2026-10-25T05:59:50.000Z",
            },
            "summary": "Point at a red cup, then at the blue box beside it.",
            "workspace": {"size": [1.0, 0.6]},
            "objects": OBJECTS,
            "steps": STEPS,
            "coach": {},
        },
    }


def build(out: Path) -> Path:
    """Write the episode to `out` (replacing what is there) and return it."""
    # numpy's BLAS on macOS reports floating-point errors from large matmuls whose results are
    # fine; the values are checked by `clio validate` and the tests instead.
    with np.errstate(divide="ignore", over="ignore", invalid="ignore"):
        return _build(out)


def _build(out: Path) -> Path:
    frames = int(DURATION_MS * FPS / 1000) + 1
    heads = [head_pose(frame_time(k)) for k in range(frames)]
    lines = [
        {"t": frame_time(k), "head": heads[k], "left": None, "right": None} for k in range(frames)
    ]

    glb, meshes = room_scan()
    media = {"room-scan-1.glb": glb}
    events = [
        {
            "t": 0.0,
            "type": "procedure.started",
            "procedureId": "point-at-objects",
            "version": 1,
            "stepCount": 2,
        },
        {"t": 0.0, "type": "coach.status", "state": "ready"},
        {"t": 0.0, "type": "environment.planes", "planes": planes()},
        {"t": 15.0, "type": "environment.meshes", "media": "room-scan-1.glb", "meshes": meshes},
        {
            "t": 100.0,
            "type": "step.entered",
            "stepId": "point-cup",
            "index": 0,
            "instruction": STEPS[0]["instruction"],
            "targets": ["cup"],
        },
        {
            "t": 4200.0,
            "type": "step.completed",
            "stepId": "point-cup",
            "index": 0,
            "by": "user",
            "forced": False,
            "durationMs": 4100.0,
        },
        {
            "t": 4200.0,
            "type": "step.entered",
            "stepId": "point-box",
            "index": 1,
            "instruction": STEPS[1]["instruction"],
            "targets": ["box"],
        },
        {
            "t": 8600.0,
            "type": "step.completed",
            "stepId": "point-box",
            "index": 1,
            "by": "user",
            "forced": False,
            "durationMs": 4400.0,
        },
        {"t": 8600.0, "type": "procedure.completed", "durationMs": 8600.0},
    ]
    observations, states = [], []
    tracker_frames = range(TRACKER_EVERY, frames - TRACKER_EVERY, TRACKER_EVERY)
    for n, k in enumerate(tracker_frames):
        captured = frame_time(k)
        pose = q4(compose(heads[k], CAMERA["headFromCamera"]))
        keyframe = (n + 1) % KEYFRAME_EVERY == 0
        width, height = KEYFRAME_SIZE
        frame = render(camera_view(pose, width, height))
        if keyframe:
            name = (
                f"keyframe-{len([e for e in events if e['type'] == 'scene.keyframe']) + 1:04d}.jpg"
            )
            media[name] = keyframe_jpeg(frame)
            view = camera_view(pose, width, height)
            events.append(
                {
                    "t": round(captured + KEYFRAME_LAG_MS, 3),
                    "type": "scene.keyframe",
                    "media": name,
                    "capturedT": captured,
                    "pose": pose,
                    "width": width,
                    "height": height,
                    "intrinsics": {"fx": view.fx, "fy": view.fy, "cx": view.cx, "cy": view.cy},
                }
            )
        answered = round(captured + TRACKER_LAG_MS, 3)
        for track_id, object_id in enumerate(("cup", "box"), start=1):
            seen = observe(frame, object_id)
            if seen is None:
                continue
            score = round(0.84 + 0.06 * math.sin(n * 0.7 + track_id), 2)
            observations.append(
                {
                    "t": answered,
                    "observedT": captured,
                    "objectId": object_id,
                    "status": "measured",
                    "role": "tracker",
                    "source": "yoloe-26l-seg",
                    "box": seen["box"],
                    "outline": seen["outline"],
                    "point": seen["point"],
                    "contact": seen["contact"],
                    "score": score,
                    "frame": {"seq": k, "width": 1280, "height": 960},
                    "trackId": str(track_id),
                    "surface": seen["surface"],
                }
            )
            state = {
                "id": object_id,
                "position": seen["position"],
                "orientation": None,
                "confidence": score,
                "source": "detector",
                "locationFlags": 10,
                "observedT": captured,
                "heldBy": None,
            }
            states.append({"t": answered, "objects": [state]})

    events.sort(key=lambda e: e["t"])
    if out.exists():
        shutil.rmtree(out)
    (out / "media").mkdir(parents=True)
    (out / "meta.json").write_text(json.dumps(meta(), indent=2) + "\n")
    _ndjson(out / "frames.ndjson", lines)
    _ndjson(out / "events.ndjson", events)
    _ndjson(out / "objects.ndjson", states)
    _ndjson(out / "observations.ndjson", observations)
    batches = math.ceil(DURATION_MS / 1000)
    finish = {
        "durationMs": frame_time(frames - 1),
        "outcome": "completed",
        "stepsCompleted": 2,
        "stepsTotal": 2,
        "batches": batches,
    }
    (out / "finish.json").write_text(json.dumps(finish, indent=2) + "\n")
    (out / "batches.json").write_text(json.dumps({"received": list(range(batches)), "gaps": []}))
    for name, data in media.items():
        (out / "media" / name).write_bytes(data)
    return out


def _ndjson(path: Path, records: list[dict]) -> None:
    with path.open("w") as f:
        for record in records:
            f.write(json.dumps(record, separators=(",", ":")) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"default {DEFAULT_OUT}")
    out = build(parser.parse_args().out)
    size = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    print(f"wrote {out} ({size / 1024:.0f} KiB)")


if __name__ == "__main__":
    main()
