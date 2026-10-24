"""The episode's surroundings: table, floor and detected planes (environment.json).

- table: the calibration defines W with its origin at the table corner and +y up, so with the
  plan's workspace size the table surface is the identity pose in W. Without one, the largest
  detected table plane gives it: the plane's pose moved to the plane-local corner (min x, max z)
  of its outline, sized by the outline's plane-local extent, so +x and -z from that corner span
  the plane. Otherwise the size is unknown.
- floor: the local-floor plane expressed in W, inverse(meta.space.worldFromWorkspace), always.
  The table height above it is the workspace's height when a calibration measured the workspace
  on the table (pinch_two_corners, workspace_marker, persisted_anchor); otherwise the detected
  table plane's height, when there is one; otherwise unknown (a guessed workspace such as
  default_in_front says nothing about the table).
- planes: every `environment.planes` snapshot merged: each plane as last reported, first seen at
  the first snapshot that included it and last seen when a later snapshot first left it out, or
  at the end of the episode.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from .derived_io import DERIVED_SCHEMA_ID, rounded, time_or_none
from .episode import Episode
from .frames import quat_rotate

IDENTITY_POSE = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]
# Calibrations that put the workspace origin on the table surface.
TABLE_CALIBRATIONS = frozenset({"pinch_two_corners", "workspace_marker", "persisted_anchor"})


def environment_doc(episode: Episode) -> dict[str, Any]:
    planes = merged_planes(episode)
    table_plane = _largest_table(planes)
    return {
        "schema": DERIVED_SCHEMA_ID,
        "episodeId": episode.episode_id,
        "frame": "workspace",
        "kind": "environment",
        "table": _table(episode, table_plane),
        "floor": _floor(episode, table_plane),
        "planes": [
            {
                **plane,
                "pose": _pose(plane["pose"]),
                "polygon": rounded(np.asarray(plane["polygon"], dtype=np.float64)),
            }
            for plane in planes
        ],
    }


def merged_planes(episode: Episode) -> list[dict[str, Any]]:
    """Each plane id as its latest snapshot reports it, plus firstSeenT and lastSeenT, in the
    order the planes were first seen. lastSeenT is the first snapshot after the plane's latest
    one (it left the plane out), or the end of the episode when none followed."""
    merged: dict[str, dict[str, Any]] = {}
    gone: dict[str, float | None] = {}  # plane id -> the snapshot that first left it out
    latest: dict[str, float] = {}  # plane id -> its latest snapshot
    for e in episode.events_of("environment.planes"):
        t = float(e["t"])
        present = set()
        for plane in e["planes"]:
            first = merged.get(plane["id"], {}).get("firstSeenT", t)
            merged[plane["id"]] = {**plane, "firstSeenT": first}
            latest[plane["id"]], gone[plane["id"]] = t, None
            present.add(plane["id"])
        for plane_id in merged:
            if plane_id not in present and gone[plane_id] is None:
                gone[plane_id] = t
    end = _episode_end(episode)
    for plane_id, plane in merged.items():
        last = gone[plane_id] if gone[plane_id] is not None else max(end, latest[plane_id])
        plane["firstSeenT"] = time_or_none(plane["firstSeenT"])
        plane["lastSeenT"] = time_or_none(last)
    return list(merged.values())


def _episode_end(episode: Episode) -> float:
    """The later of the last frame and finish.durationMs."""
    duration = (episode.finish or {}).get("durationMs")
    return max(episode.duration_ms, float(duration) if duration is not None else 0.0)


def _largest_table(planes: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The detected table plane with the largest outline that has an extent, if any."""
    tables = [p for p in planes if p["kind"] == "table" and _local_size(p) is not None]
    return max(tables, key=_area, default=None)


def _table(episode: Episode, table_plane: dict[str, Any] | None) -> dict[str, Any]:
    workspace = (episode.plan or {}).get("workspace") or {}
    if workspace.get("size"):
        width, depth = workspace["size"]
        return {"pose": IDENTITY_POSE, "size": [float(width), float(depth)], "source": "plan"}
    if table_plane is not None:
        return {
            "pose": _pose(_corner_pose(table_plane)),
            "size": _local_size(table_plane),
            "source": "planes",
        }
    return {"pose": IDENTITY_POSE, "size": None, "source": "calibration"}


def _outline(plane: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    local = np.asarray(plane["polygon"], dtype=np.float64)
    return local[:, 0], local[:, 1]


def _local_size(plane: dict[str, Any]) -> list[float] | None:
    """The outline's extent along the plane's own x and z, or None for a degenerate outline."""
    x, z = _outline(plane)
    size = [round(float(np.ptp(x)), 4) + 0.0, round(float(np.ptp(z)), 4) + 0.0]
    return size if min(size) > 0 else None


def _area(plane: dict[str, Any]) -> float:
    x, z = _outline(plane)
    return 0.5 * abs(float(np.dot(x, np.roll(z, -1)) - np.dot(z, np.roll(x, -1))))


def _corner_pose(plane: dict[str, Any]) -> np.ndarray:
    """The plane's pose moved to the outline's plane-local corner (min x, max z): from there the
    outline spans +x and -z, as EnvironmentDoc's table size reads."""
    x, z = _outline(plane)
    pose = np.asarray(plane["pose"], dtype=np.float64)
    q = pose[3:7] / np.linalg.norm(pose[3:7])
    corner = pose[:3] + quat_rotate(q, np.array([x.min(), 0.0, z.max()]))
    return np.concatenate([corner, q])


def _floor(episode: Episode, table_plane: dict[str, Any] | None) -> dict[str, Any]:
    space = episode.meta["space"]
    world_from_workspace = np.asarray(space["worldFromWorkspace"], dtype=np.float64)
    p, q = (
        world_from_workspace[:3],
        world_from_workspace[3:7] / np.linalg.norm(world_from_workspace[3:7]),
    )
    q_inv = q * [-1.0, -1.0, -1.0, 1.0]
    workspace_from_world = np.concatenate([-quat_rotate(q_inv, p), q_inv])
    if space.get("calibration") in TABLE_CALIBRATIONS:
        height: float | None = float(p[1])
    elif table_plane is not None:  # the plane's origin in local-floor
        origin = np.asarray(table_plane["pose"][:3], dtype=np.float64)
        height = float((quat_rotate(q, origin) + p)[1])
    else:
        height = None
    return {
        "pose": _pose(workspace_from_world),
        "tableHeightM": None if height is None else round(height, 4) + 0.0,
    }


def _pose(pose) -> list[float]:
    return rounded(np.asarray(pose, dtype=np.float64)[None])[0]
