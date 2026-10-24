"""What object finders saw of each object in the camera image (observations.ndjson), summed up
for tracks.json (`CompiledObjectTrack.observations`, packages/protocol/src/derived.ts).

The 2D answers stay in the raw file. A summary counts the lines about one object by status, lists
who answered (roles and models) and the trackers' own ids in first-seen order, and gives the
capture times of the first and last frame observed. It changes nothing on the grid: the 3D state
of a predicted answer (location flags 2) is valid there but never tracked (objects.py).

The file is read leniently (episode.py). A line without a string `objectId`, a known `status` or
a numeric `observedT` is not counted; an unknown role, a missing model or track id is left out of
the lists but the line still counts.
"""

from __future__ import annotations

import math
from typing import Any

from .derived_io import time_or_none
from .episode import Episode

STATUSES = ("measured", "predicted", "lost", "absent", "unknown")
ROLES = frozenset({"tracker", "identifier", "detector"})


def observation_summaries(episode: Episode) -> dict[str, dict[str, Any]]:
    """One ObservationSummary per object the episode's observations are about."""
    out: dict[str, dict[str, Any]] = {}
    for obs in episode.observations:
        obj_id, status, observed_t = obs.get("objectId"), obs.get("status"), obs.get("observedT")
        if not isinstance(obj_id, str) or status not in STATUSES or not _is_number(observed_t):
            continue
        summary = out.get(obj_id)
        if summary is None:
            summary = out[obj_id] = {
                "count": 0,
                "statuses": dict.fromkeys(STATUSES, 0),
                "roles": [],
                "sources": [],
                "trackIds": [],
                "firstObservedT": observed_t,
                "lastObservedT": observed_t,
            }
        summary["count"] += 1
        summary["statuses"][status] += 1
        role, source, track_id = obs.get("role"), obs.get("source"), obs.get("trackId")
        _add(summary["roles"], role if role in ROLES else None)
        _add(summary["sources"], source if isinstance(source, str) else None)
        _add(summary["trackIds"], track_id if isinstance(track_id, str) else None)
        summary["firstObservedT"] = min(summary["firstObservedT"], observed_t)
        summary["lastObservedT"] = max(summary["lastObservedT"], observed_t)
    for summary in out.values():
        summary["firstObservedT"] = time_or_none(summary["firstObservedT"])
        summary["lastObservedT"] = time_or_none(summary["lastObservedT"])
    return out


def _add(seen: list[str], value: str | None) -> None:
    if value is not None and value not in seen:
        seen.append(value)


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)
