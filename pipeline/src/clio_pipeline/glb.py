"""Binary glTF 2.0 (GLB) with numpy only: the room scans the headset uploads, room.glb, and the
scene's colored room and object models.

What it writes is deliberately plain: one node per mesh, each with its own triangle mesh
(POSITION, optional NORMAL and COLOR_0, uint32 indices) and an optional base-color material,
in meters and +y up like the workspace frame W. What it reads is what it writes plus what common
exporters produce for triangle meshes (any node hierarchy with TRS or matrix transforms, float
positions, unsigned byte/short/int indices, float or normalized integer colors). Textures and
other attributes are not read; `transform_glb` rescales and moves any GLB, textures included,
by adding a root node and leaving the binary chunk as it is.
"""

from __future__ import annotations

import json
import struct
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

GLB_MAGIC = 0x46546C67  # "glTF"
_JSON_CHUNK = 0x4E4F534A  # "JSON"
_BIN_CHUNK = 0x004E4942  # "BIN\0"

_FLOAT, _UBYTE, _USHORT, _UINT, _BYTE, _SHORT = 5126, 5121, 5123, 5125, 5120, 5122
_COMPONENT_DTYPE = {
    _FLOAT: np.float32,
    _UBYTE: np.uint8,
    _USHORT: np.uint16,
    _UINT: np.uint32,
    _BYTE: np.int8,
    _SHORT: np.int16,
}
_TYPE_SIZE = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
_TRIANGLES = 4

FloatSeq = Sequence[float] | np.ndarray


@dataclass
class MeshData:
    """A triangle mesh in its node's local frame."""

    positions: np.ndarray  # (N, 3) float32, meters
    indices: np.ndarray | None = None  # (M, 3) uint32 triangles; None: every 3 positions
    normals: np.ndarray | None = None  # (N, 3) float32, unit
    colors: np.ndarray | None = None  # (N, 3) or (N, 4) float32 in 0..1 (linear)

    def triangles(self) -> np.ndarray:
        if self.indices is not None:
            return np.asarray(self.indices, dtype=np.uint32).reshape(-1, 3)
        return np.arange(len(self.positions), dtype=np.uint32).reshape(-1, 3)


@dataclass
class Node:
    """One node: a name, a transform (TRS) and optionally a mesh with one base color."""

    name: str
    mesh: MeshData | None = None
    translation: FloatSeq = (0.0, 0.0, 0.0)
    rotation: FloatSeq = (0.0, 0.0, 0.0, 1.0)  # xyzw
    scale: FloatSeq = (1.0, 1.0, 1.0)
    base_color: FloatSeq | None = None  # rgba 0..1 (linear); None: no material
    metallic: float = 0.0
    roughness: float = 0.8
    extras: dict[str, Any] = field(default_factory=dict)

    def matrix(self) -> np.ndarray:
        return trs_matrix(self.translation, self.rotation, self.scale)

    def world_positions(self) -> np.ndarray:
        """The mesh's positions with this node's transform applied, (N, 3) float64."""
        if self.mesh is None:
            return np.zeros((0, 3))
        return apply_matrix(self.matrix(), self.mesh.positions)


def quat_matrix(q: FloatSeq) -> np.ndarray:
    """3x3 rotation of a unit quaternion (x, y, z, w)."""
    x, y, z, w = (float(v) for v in q)
    n = x * x + y * y + z * z + w * w
    if n < 1e-12:
        return np.eye(3)
    s = 2.0 / n
    return np.array(
        [
            [1 - s * (y * y + z * z), s * (x * y - z * w), s * (x * z + y * w)],
            [s * (x * y + z * w), 1 - s * (x * x + z * z), s * (y * z - x * w)],
            [s * (x * z - y * w), s * (y * z + x * w), 1 - s * (x * x + y * y)],
        ]
    )


def trs_matrix(translation: FloatSeq, rotation: FloatSeq, scale: FloatSeq) -> np.ndarray:
    m = np.eye(4)
    m[:3, :3] = quat_matrix(rotation) * np.asarray(scale, dtype=np.float64)[None, :]
    m[:3, 3] = np.asarray(translation, dtype=np.float64)
    return m


def apply_matrix(m: np.ndarray, points: np.ndarray) -> np.ndarray:
    p = np.asarray(points, dtype=np.float64).reshape(-1, 3)
    return p @ m[:3, :3].T + m[:3, 3]


def vertex_normals(positions: np.ndarray, triangles: np.ndarray) -> np.ndarray:
    """Area-weighted vertex normals, (N, 3) float32; a vertex without faces gets +y."""
    p = np.asarray(positions, dtype=np.float64)
    tri = np.asarray(triangles, dtype=np.int64).reshape(-1, 3)
    normals = np.zeros_like(p)
    if len(tri):
        face = np.cross(p[tri[:, 1]] - p[tri[:, 0]], p[tri[:, 2]] - p[tri[:, 0]])
        for k in range(3):
            np.add.at(normals, tri[:, k], face)
    length = np.linalg.norm(normals, axis=1)
    out = np.tile([0.0, 1.0, 0.0], (len(p), 1))
    ok = length > 1e-12
    out[ok] = normals[ok] / length[ok, None]
    return out.astype(np.float32)


# --- writing --------------------------------------------------------------------------------------


class _Buffer:
    def __init__(self) -> None:
        self.data = bytearray()
        self.views: list[dict[str, Any]] = []
        self.accessors: list[dict[str, Any]] = []

    def add(self, array: np.ndarray, component: int, kind: str, *, target: int | None) -> int:
        while len(self.data) % 4:
            self.data.append(0)
        raw = np.ascontiguousarray(array).tobytes()
        view: dict[str, Any] = {"buffer": 0, "byteOffset": len(self.data), "byteLength": len(raw)}
        if target is not None:
            view["target"] = target
        self.data.extend(raw)
        self.views.append(view)
        flat = np.asarray(array).reshape(len(array), -1)
        accessor: dict[str, Any] = {
            "bufferView": len(self.views) - 1,
            "componentType": component,
            "count": int(flat.shape[0]) if kind != "SCALAR" else int(flat.size),
            "type": kind,
        }
        if kind == "VEC3" and component == _FLOAT and len(flat):
            accessor["min"] = flat.min(axis=0).astype(float).tolist()
            accessor["max"] = flat.max(axis=0).astype(float).tolist()
        self.accessors.append(accessor)
        return len(self.accessors) - 1


def write_glb(
    nodes: Sequence[Node], path: Path | str | None = None, *, extras: dict[str, Any] | None = None
) -> bytes:
    """A GLB with one scene of `nodes` (all roots). Written to `path` when given; returns the
    bytes. `extras` go on the scene."""
    buf = _Buffer()
    gl_nodes: list[dict[str, Any]] = []
    meshes: list[dict[str, Any]] = []
    materials: list[dict[str, Any]] = []
    for node in nodes:
        gl: dict[str, Any] = {"name": node.name}
        if tuple(node.translation) != (0.0, 0.0, 0.0):
            gl["translation"] = [float(v) for v in node.translation]
        if tuple(node.rotation) != (0.0, 0.0, 0.0, 1.0):
            gl["rotation"] = [float(v) for v in node.rotation]
        if tuple(node.scale) != (1.0, 1.0, 1.0):
            gl["scale"] = [float(v) for v in node.scale]
        if node.extras:
            gl["extras"] = node.extras
        if node.mesh is not None and len(node.mesh.positions):
            gl["mesh"] = len(meshes)
            meshes.append({"name": node.name, "primitives": [_primitive(buf, node, materials)]})
        gl_nodes.append(gl)
    doc: dict[str, Any] = {
        "asset": {"version": "2.0", "generator": "clio_pipeline"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(gl_nodes))), **({"extras": extras} if extras else {})}],
        "nodes": gl_nodes,
    }
    if meshes:
        doc["meshes"] = meshes
    if materials:
        doc["materials"] = materials
    if buf.accessors:
        doc["accessors"] = buf.accessors
        doc["bufferViews"] = buf.views
        doc["buffers"] = [{"byteLength": len(buf.data)}]
    data = _pack(doc, bytes(buf.data))
    if path is not None:
        Path(path).write_bytes(data)
    return data


def _primitive(buf: _Buffer, node: Node, materials: list[dict[str, Any]]) -> dict[str, Any]:
    mesh = node.mesh
    assert mesh is not None
    positions = np.asarray(mesh.positions, dtype=np.float32).reshape(-1, 3)
    attributes = {"POSITION": buf.add(positions, _FLOAT, "VEC3", target=34962)}
    if mesh.normals is not None:
        normals = np.asarray(mesh.normals, dtype=np.float32).reshape(-1, 3)
        attributes["NORMAL"] = buf.add(normals, _FLOAT, "VEC3", target=34962)
    if mesh.colors is not None:
        colors = np.clip(np.asarray(mesh.colors, dtype=np.float32), 0.0, 1.0)
        colors = colors.reshape(len(positions), -1)
        kind = "VEC4" if colors.shape[1] == 4 else "VEC3"
        attributes["COLOR_0"] = buf.add(colors, _FLOAT, kind, target=34962)
    prim: dict[str, Any] = {"attributes": attributes, "mode": _TRIANGLES}
    if mesh.indices is not None:
        indices = np.asarray(mesh.indices, dtype=np.uint32).reshape(-1)
        prim["indices"] = buf.add(indices, _UINT, "SCALAR", target=34963)
    if node.base_color is not None:
        rgba = [float(v) for v in node.base_color] + [1.0] * (4 - len(node.base_color))
        material = {
            "name": node.name,
            "pbrMetallicRoughness": {
                "baseColorFactor": rgba[:4],
                "metallicFactor": float(node.metallic),
                "roughnessFactor": float(node.roughness),
            },
            "doubleSided": True,
        }
        if rgba[3] < 1.0:
            material["alphaMode"] = "BLEND"
        prim["material"] = len(materials)
        materials.append(material)
    return prim


def _pack(doc: dict[str, Any], binary: bytes) -> bytes:
    text = json.dumps(doc, separators=(",", ":"), allow_nan=False).encode("utf-8")
    text += b" " * (-len(text) % 4)
    chunks = struct.pack("<II", len(text), _JSON_CHUNK) + text
    if binary:
        binary += b"\0" * (-len(binary) % 4)
        chunks += struct.pack("<II", len(binary), _BIN_CHUNK) + binary
    return struct.pack("<III", GLB_MAGIC, 2, 12 + len(chunks)) + chunks


# --- reading --------------------------------------------------------------------------------------


def parse_glb(data: bytes) -> tuple[dict[str, Any], bytes]:
    """The JSON document and the binary chunk of a GLB; ValueError if it is not one."""
    if len(data) < 20:
        raise ValueError("not a GLB: too short")
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC or version != 2:
        raise ValueError("not a glTF 2.0 binary")
    length = min(length, len(data))
    doc: dict[str, Any] | None = None
    binary = b""
    offset = 12
    while offset + 8 <= length:
        size, kind = struct.unpack_from("<II", data, offset)
        chunk = data[offset + 8 : offset + 8 + size]
        if kind == _JSON_CHUNK:
            doc = json.loads(chunk.decode("utf-8"))
        elif kind == _BIN_CHUNK and not binary:
            binary = bytes(chunk)
        offset += 8 + size
    if doc is None:
        raise ValueError("GLB without a JSON chunk")
    return doc, binary


def _accessor(doc: dict[str, Any], binary: bytes, index: int) -> np.ndarray:
    acc = doc["accessors"][index]
    dtype = np.dtype(_COMPONENT_DTYPE[acc["componentType"]])
    width = _TYPE_SIZE[acc["type"]]
    count = int(acc["count"])
    if "bufferView" not in acc:
        return np.zeros((count, width), dtype=dtype)
    view = doc["bufferViews"][acc["bufferView"]]
    if view.get("buffer", 0) != 0:
        raise ValueError("GLB that refers to external buffers")
    start = int(view.get("byteOffset", 0)) + int(acc.get("byteOffset", 0))
    stride = int(view.get("byteStride", 0)) or dtype.itemsize * width
    if stride == dtype.itemsize * width:
        out = np.frombuffer(binary, dtype=dtype, count=count * width, offset=start)
        out = out.reshape(count, width)
    else:
        rows = [
            np.frombuffer(binary, dtype=dtype, count=width, offset=start + i * stride)
            for i in range(count)
        ]
        out = np.stack(rows) if rows else np.zeros((0, width), dtype=dtype)
    if acc.get("normalized") and dtype != np.float32:
        out = out.astype(np.float32) / float(np.iinfo(dtype).max)
    return out


def _node_matrix(gl: dict[str, Any]) -> np.ndarray:
    if "matrix" in gl:
        return np.asarray(gl["matrix"], dtype=np.float64).reshape(4, 4).T  # column-major
    return trs_matrix(
        gl.get("translation", (0.0, 0.0, 0.0)),
        gl.get("rotation", (0.0, 0.0, 0.0, 1.0)),
        gl.get("scale", (1.0, 1.0, 1.0)),
    )


def _walk(doc: dict[str, Any]):
    """(node index, world matrix) for every node reachable from the default scene."""
    nodes = doc.get("nodes", [])
    scenes = doc.get("scenes") or [{"nodes": list(range(len(nodes)))}]
    roots = scenes[int(doc.get("scene", 0))].get("nodes", [])
    stack = [(int(i), np.eye(4)) for i in reversed(roots)]
    seen: set[int] = set()
    while stack:
        i, parent = stack.pop()
        if i in seen or i >= len(nodes):
            continue
        seen.add(i)
        world = parent @ _node_matrix(nodes[i])
        yield i, world
        stack.extend((int(c), world) for c in reversed(nodes[i].get("children", [])))


def read_glb(data: bytes | Path | str) -> list[Node]:
    """Every triangle primitive of a GLB as a Node in the scene's root frame: a node that is a
    root keeps its own TRS and local positions (what `write_glb` wrote comes back unchanged);
    a nested node gets its positions moved into the root frame and an identity transform. A
    mesh with several primitives gives one Node per primitive (names get "#<n>")."""
    if not isinstance(data, bytes | bytearray):
        data = Path(data).read_bytes()
    doc, binary = parse_glb(bytes(data))
    nodes = doc.get("nodes", [])
    scenes = doc.get("scenes") or [{"nodes": list(range(len(nodes)))}]
    roots = set(scenes[int(doc.get("scene", 0))].get("nodes", []))
    out: list[Node] = []
    for i, world in _walk(doc):
        gl = nodes[i]
        name = gl.get("name", f"node-{i}")
        root_trs = i in roots and "matrix" not in gl
        if "mesh" not in gl:
            if root_trs:
                out_node = Node(name=name, extras=dict(gl.get("extras") or {}))
                _copy_trs(out_node, gl)
                out.append(out_node)
            continue
        primitives = doc["meshes"][gl["mesh"]].get("primitives", [])
        for k, prim in enumerate(primitives):
            if prim.get("mode", _TRIANGLES) != _TRIANGLES or "POSITION" not in prim["attributes"]:
                continue
            attrs = prim["attributes"]
            positions = _accessor(doc, binary, attrs["POSITION"]).astype(np.float32)
            normals = (
                _accessor(doc, binary, attrs["NORMAL"]).astype(np.float32)
                if "NORMAL" in attrs
                else None
            )
            colors = None
            if "COLOR_0" in attrs:
                colors = _accessor(doc, binary, attrs["COLOR_0"]).astype(np.float32)
            indices = None
            if "indices" in prim:
                indices = _accessor(doc, binary, prim["indices"]).astype(np.uint32).reshape(-1, 3)
            if not root_trs:
                positions = apply_matrix(world, positions).astype(np.float32)
                if normals is not None:
                    n = normals @ np.linalg.inv(world[:3, :3])
                    length = np.linalg.norm(n, axis=1, keepdims=True)
                    normals = (n / np.maximum(length, 1e-12)).astype(np.float32)
            node = Node(
                name=name if len(primitives) == 1 else f"{name}#{k}",
                mesh=MeshData(positions, indices, normals, colors),
                extras=dict(gl.get("extras") or {}),
            )
            if root_trs:
                _copy_trs(node, gl)
            material = _material(doc, prim)
            if material is not None:
                node.base_color, node.metallic, node.roughness = material
            out.append(node)
    return out


def _copy_trs(node: Node, gl: dict[str, Any]) -> None:
    node.translation = tuple(float(v) for v in gl.get("translation", (0.0, 0.0, 0.0)))
    node.rotation = tuple(float(v) for v in gl.get("rotation", (0.0, 0.0, 0.0, 1.0)))
    node.scale = tuple(float(v) for v in gl.get("scale", (1.0, 1.0, 1.0)))


def _material(doc: dict[str, Any], prim: dict[str, Any]) -> tuple[list[float], float, float] | None:
    if "material" not in prim:
        return None
    pbr = doc["materials"][prim["material"]].get("pbrMetallicRoughness", {})
    return (
        [float(v) for v in pbr.get("baseColorFactor", [1.0, 1.0, 1.0, 1.0])],
        float(pbr.get("metallicFactor", 1.0)),
        float(pbr.get("roughnessFactor", 1.0)),
    )


def glb_bounds(data: bytes | Path | str) -> tuple[np.ndarray, np.ndarray] | None:
    """Axis-aligned bounds (min, max) of every triangle primitive in the scene's root frame, from
    the actual positions; None for a GLB without any."""
    points = [n.world_positions() for n in read_glb(data) if n.mesh is not None]
    points = [p for p in points if len(p)]
    if not points:
        return None
    stacked = np.concatenate(points)
    return stacked.min(axis=0), stacked.max(axis=0)


def transform_glb(
    data: bytes,
    *,
    scale: float | FloatSeq = 1.0,
    translation: FloatSeq = (0.0, 0.0, 0.0),
    rotation: FloatSeq = (0.0, 0.0, 0.0, 1.0),
    name: str = "clio-fit",
) -> bytes:
    """The same GLB under one new root node with this transform (applied as T * R * S to the old
    scene). Meshes, materials and textures are left as they are."""
    doc, binary = parse_glb(data)
    nodes = doc.setdefault("nodes", [])
    scenes = doc.get("scenes") or [{"nodes": list(range(len(nodes)))}]
    index = int(doc.get("scene", 0))
    old_roots = scenes[index].get("nodes", [])
    s = [float(scale)] * 3 if isinstance(scale, int | float) else [float(v) for v in scale]
    nodes.append(
        {
            "name": name,
            "translation": [float(v) for v in translation],
            "rotation": [float(v) for v in rotation],
            "scale": s,
            "children": list(old_roots),
        }
    )
    scenes[index] = {**scenes[index], "nodes": [len(nodes) - 1]}
    doc["scenes"] = scenes
    doc["scene"] = index
    return _pack(doc, binary)
