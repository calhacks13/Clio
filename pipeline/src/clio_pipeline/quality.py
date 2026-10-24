"""The quality verdict in manifest.json: is an episode safe to train on by default?

Usable only when it finished as `completed`, every batch the headset sent arrived, no two frames
are more than a second apart, at least one hand was tracked in half of the frames or more, and
every file passed validation. `reasons` says, in a few words each, why not otherwise.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from .episode import Episode
from .objects import ObjectSeries
from .schema import ValidationIssue, read_bookkeeping

MIN_HAND_FRACTION = 0.5
# Frames missing for longer than this (the XR loop paused, the headset off) make an episode
# unusable even when every batch arrived.
MAX_MISSING_FRAMES_MS = 1000.0


def quality(
    episode_dir: Path | str,
    episode: Episode,
    series: dict[str, ObjectSeries] | None,
    issues: list[ValidationIssue],
) -> dict[str, Any]:
    """EpisodeQuality (packages/protocol/src/derived.ts). `series` may be None when the objects
    could not be compiled; `issues` are the episode's validation issues."""
    finish = episode.finish
    reasons: list[str] = []
    outcome = finish["outcome"] if finish else None
    if finish is None:
        reasons.append("not finished")
    elif outcome != "completed":
        reasons.append(f"outcome {outcome}")
    batches = _batches(Path(episode_dir), finish, reasons)
    dt = np.diff(episode.t)
    if len(dt) and dt.max() > MAX_MISSING_FRAMES_MS:
        reasons.append(f"frames missing for {dt.max() / 1000.0:.1f} s")

    n = episode.n_frames
    hands = episode.tracked.mean(axis=0) if n else np.zeros(2)
    if hands.max() < MIN_HAND_FRACTION:
        reasons.append(f"hands tracked in {int(hands.max() * 100)}% of frames")
    if issues:
        reasons.append(_count(len(issues), "validation issue"))

    rates = 1000.0 / dt[dt > 0]
    return {
        "usable": not reasons,
        "reasons": reasons,
        "finished": finish is not None,
        "outcome": outcome,
        "batches": batches,
        "durationMs": round(float(finish["durationMs"] if finish else episode.duration_ms), 2),
        "frames": n,
        "frameRateHz": round(float(np.median(rates)), 2) if len(rates) else None,
        "maxFrameGapMs": round(float(dt.max()), 2) if len(dt) else None,
        "hands": {"left": _fraction(hands[0]), "right": _fraction(hands[1])},
        "objects": [
            {
                "id": s.id,
                "validFraction": _fraction(s.valid_fraction),
                "trackedFraction": _fraction(s.tracked_fraction),
            }
            for s in (series or {}).values()
        ],
        "validationIssues": len(issues),
    }


def _batches(
    episode_dir: Path, finish: dict[str, Any] | None, reasons: list[str]
) -> dict[str, Any] | None:
    """What arrived, from batches.json. A batch is missing when the server saw it skipped, or
    when finish.json counts more batches than arrived."""
    try:
        book = read_bookkeeping(episode_dir)
    except (ValueError, KeyError, TypeError, UnicodeDecodeError):
        reasons.append("unreadable batch record")
        return None
    if book is None:
        reasons.append("no batch record")
        return None
    received = set(book["received"])
    sent = finish.get("batches") if finish else None
    missing = set(book["gaps"]) - received
    if sent is not None:
        missing |= set(range(sent)) - received
    if missing:
        reasons.append(_count(len(missing), "batch", "batches") + " missing")
    elif sent is not None and sent != len(received):
        reasons.append(f"{len(received)} batches received, {sent} sent")
    return {"sent": sent, "received": len(received), "missing": sorted(missing)}


def _count(n: int, noun: str, plural: str | None = None) -> str:
    return f"{n} {noun if n == 1 else plural or noun + 's'}"


def _fraction(x: float) -> float:
    return round(float(x), 4)
