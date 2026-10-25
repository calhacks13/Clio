"""The Quest room scan the compile keeps (room.glb and environment.json `room`, docs/room-scene.md).

The headset records the room scan (Space Setup, read through WebXR mesh detection) as
`environment.meshes` events, each a full snapshot whose geometry is a GLB in media/
(`room-scan-<n>.glb`): one root node per mesh, named by its id, its translation and rotation the
mesh pose in W, POSITION in mesh-local meters. The compile keeps the last snapshot whose GLB
arrived and can be read: an upload that was dropped leaves an event without its file, and a GLB
that cannot be read is passed over for the one before it (the stage says so).

It is rewritten to room.glb in the same node layout: each mesh keeps its pose and local positions,
gets vertex normals where the scan had none, and carries `extras: {kind, label, global}` as
environment.json reports them, so the two files agree. environment.json's `room` sums it up: the
file, the snapshot, its time, how many snapshots there were, and every mesh with its vertex and
triangle counts and its bounds in W (the node transform applied to its positions). Kind, label and
global come from the event; a mesh the event does not list falls back to its node's extras.

The headset measured the room when it was set up, not during the episode: furniture may have
moved since. Nothing here is an object measurement.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from .derived_io import rounded, time_or_none
from .episode import Episode
from .glb import MeshData, Node, read_glb, vertex_normals, write_glb

ROOM_FILE = "room.glb"
MESHES_EVENT = "environment.meshes"
# packages/protocol/src/episode.ts ROOM_SCAN_MEDIA
ROOM_SCAN_MEDIA = re.compile(r"^room-scan-([0-9]{1,4})\.glb$")
# packages/protocol/src/episode.ts SurfaceKindSchema
SURFACE_KINDS = frozenset({"table", "floor", "wall", "ceiling", "couch", "other"})
# glb.read_glb names the primitives of a mesh with several "<node name>#<n>".
_PRIMITIVE = re.compile(r"^(.*)#[0-9]+$")


@dataclass
class RoomScan:
    media: str  # the snapshot's GLB in media/
    snapshot_t: float  # when the snapshot was recorded (ms)
    snapshots: int  # environment.meshes events in the episode
    nodes: list[Node]  # the GLB's root nodes: pose in W, local positions
    meshes: list[dict[str, Any]]  # the event's mesh list (EnvironmentMesh), as recorded
    passed_over: list[str] = field(default_factory=list)  # later snapshots that were unreadable


def room_scan_media(episode_dir: Path) -> list[str]:
    """The room scan GLBs in the episode's media/, in snapshot order. They are compile inputs:
    one that arrives late makes the compile stale."""
    media = episode_dir / "media"
    if not media.is_dir():
        return []
    found = []
    for path in media.iterdir():
        if (m := ROOM_SCAN_MEDIA.match(path.name)) and path.is_file():
            found.append((int(m.group(1)), path.name))
    return [name for _, name in sorted(found)]


def room_snapshots(episode: Episode) -> list[dict[str, Any]]:
    """The episode's `environment.meshes` events that name a GLB, in time order."""
    return [
        e
        for e in episode.events_of(MESHES_EVENT)
        if isinstance(e.get("media"), str) and ROOM_SCAN_MEDIA.match(e["media"])
    ]


def latest_room_scan(episode: Episode) -> RoomScan | None:
    """The last snapshot whose GLB arrived and can be read; None when no GLB arrived. Raises
    ValueError, naming each, when every GLB that arrived is unreadable."""
    snapshots = room_snapshots(episode)
    passed_over: list[str] = []
    for event in reversed(snapshots):
        path = episode.media.get(event["media"])
        if path is None:
            continue
        try:
            nodes = read_glb(path)
            _check_geometry(nodes)
        except (OSError, ValueError, KeyError, IndexError, TypeError, UnicodeDecodeError) as e:
            passed_over.append(f"{event['media']} is unreadable ({type(e).__name__}: {e})")
            continue
        meshes = event.get("meshes")
        return RoomScan(
            media=event["media"],
            snapshot_t=float(event["t"]),
            snapshots=len(snapshots),
            nodes=nodes,
            meshes=[m for m in meshes if isinstance(m, dict)] if isinstance(meshes, list) else [],
            passed_over=passed_over,
        )
    if passed_over:
        raise ValueError("; ".join(passed_over))
    return None


def _check_geometry(nodes: list[Node]) -> None:
    """Raise ValueError for a mesh no viewer could draw: positions that are not finite, or
    triangles that point past its vertices."""
    for node in nodes:
        mesh = node.mesh
        if mesh is None:
            continue
        if not np.isfinite(mesh.positions).all():
            raise ValueError(f"{node.name}: positions that are not finite")
        if mesh.indices is None and len(mesh.positions) % 3:
            raise ValueError(f"{node.name}: {len(mesh.positions)} positions are not triangles")
        if (
            mesh.indices is not None
            and len(mesh.indices)
            and mesh.indices.max() >= len(mesh.positions)
        ):
            raise ValueError(f"{node.name}: triangles refer to vertices it does not have")


def room_doc(scan: RoomScan) -> dict[str, Any]:
    """environment.json's `room` (RoomScanSchema, packages/protocol/src/derived.ts): the meshes
    the event lists, in its order, then any mesh in the GLB it does not list."""
    groups = _mesh_nodes(scan)
    listed = {m["id"]: m for m in scan.meshes if isinstance(m.get("id"), str)}
    return {
        "file": ROOM_FILE,
        "source": "quest-scene",
        "media": scan.media,
        "snapshotT": time_or_none(scan.snapshot_t),
        "snapshots": scan.snapshots,
        "meshes": [
            _mesh_entry(mesh_id, listed.get(mesh_id, {}), nodes)
            for mesh_id, nodes in groups.items()
        ],
    }


def write_room_glb(scan: RoomScan, doc: dict[str, Any], path: Path) -> int:
    """room.glb: the snapshot's nodes as they are (pose in W, local positions), each mesh with
    vertex normals and its node's extras saying what `doc` (room_doc) says of it. Returns the
    bytes written."""
    described = {m["id"]: m for m in doc["meshes"]}
    owner = {id(node): mesh_id for mesh_id, nodes in _mesh_nodes(scan).items() for node in nodes}
    out = []
    for node in scan.nodes:
        mesh = node.mesh
        if mesh is not None and mesh.normals is None and len(mesh.positions):
            normals = vertex_normals(mesh.positions, mesh.triangles())
            mesh = MeshData(mesh.positions, mesh.indices, normals, mesh.colors)
        extras = dict(node.extras)
        entry = described.get(owner.get(id(node), ""))
        if entry is not None:
            extras.update(kind=entry["kind"], label=entry["label"], **{"global": entry["global"]})
        out.append(
            Node(
                name=node.name,
                mesh=mesh,
                translation=node.translation,
                rotation=node.rotation,
                scale=node.scale,
                base_color=node.base_color,
                metallic=node.metallic,
                roughness=node.roughness,
                extras=extras,
            )
        )
    extras = {"source": "quest-scene", "media": scan.media, "snapshotT": doc["snapshotT"]}
    return len(write_glb(out, path, extras=extras))


def _mesh_nodes(scan: RoomScan) -> dict[str, list[Node]]:
    """Mesh id -> its nodes, the event's meshes first. A node is its mesh's when named by its id
    (or "<id>#<n>", a primitive of it); one the event does not list is a mesh of its own."""
    listed = [m["id"] for m in scan.meshes if isinstance(m.get("id"), str)]
    groups: dict[str, list[Node]] = {mesh_id: [] for mesh_id in listed}
    for node in scan.nodes:
        name = node.name
        if name not in groups and (m := _PRIMITIVE.match(name)) and m.group(1) in groups:
            name = m.group(1)
        groups.setdefault(name, []).append(node)
    return groups


def _mesh_entry(mesh_id: str, recorded: dict[str, Any], nodes: list[Node]) -> dict[str, Any]:
    extras: dict[str, Any] = {}
    for node in reversed(nodes):
        extras.update(node.extras)
    kind = recorded.get("kind", extras.get("kind"))
    label = recorded.get("label", extras.get("label"))
    is_global = recorded.get("global", extras.get("global"))
    meshes = [node for node in nodes if node.mesh is not None]
    # numpy's BLAS on macOS can report floating-point errors for large matmuls whose results are
    # fine; the positions were checked to be finite when the scan was read.
    with np.errstate(divide="ignore", over="ignore", invalid="ignore"):
        points = [node.world_positions() for node in meshes]
    world = np.concatenate(points) if points else np.zeros((0, 3))
    bounds = None
    if len(world):
        lo, hi = rounded(np.stack([world.min(axis=0), world.max(axis=0)]))
        bounds = {"min": lo, "max": hi}
    return {
        "id": mesh_id,
        "kind": kind if kind in SURFACE_KINDS else "other",
        "label": label if isinstance(label, str) else None,
        "global": is_global if isinstance(is_global, bool) else False,
        "vertices": sum(len(node.mesh.positions) for node in meshes),
        "triangles": sum(len(node.mesh.triangles()) for node in meshes),
        "bounds": bounds,
    }
