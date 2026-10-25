"""`clio compile`: turn an episode into data/derived/<id>/ (docs/data-pipeline.md).

    manifest.json            inputs (bytes, SHA-256), stages, artifacts, quality verdict
    tracks.json              head, wrists and every object on one grid (default 30 fps), each
                             object with its estimated metric extent
    shapes.json              every object's depth samples fused relative to its tracked position
                             (only when the headset recorded any)
    environment.json         table, floor and detected planes, and the room scan's summary
    room.glb                 the Quest room scan in W (only when the headset recorded one)
    retarget-<profile>.json  one per robot profile

Raw files are only read, and a compile refuses to write into the episode or beside it in its
episodes directory. Each stage runs on its own: a failure is recorded in the manifest (status
`failed`, with what went wrong) and the other stages still run. Everything is written to a hidden
directory inside the derived root first, then swapped in for the old compile, so readers never see
a mix (builddir.py). Only an earlier compile (or an empty directory) is ever replaced. Compiles of
one episode take turns: each holds a lock on `<derived root>/.<id>.lock` and first removes the
hidden directories a killed compile left behind.

A compile is stale when a raw input (the files in INPUT_FILES and the room scan GLBs in media/),
the compiler version, the fps or a robot profile (its file or its URDF) changed. With
`if_stale=True` an up-to-date compile is kept and nothing is written.
"""

from __future__ import annotations

import re
import shutil
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from . import __version__
from .builddir import (
    describe,
    episode_id_of,
    episode_lock,
    fingerprint_files,
    is_apart,
    make_work_dir,
    remove_leftovers,
    same_inputs,
    swap_in,
    utc_now,
)
from .derived_io import DERIVED_SCHEMA_ID, rounded, time_or_none, times, write_json
from .environment import environment_doc
from .episode import Episode, load_episode
from .extents import object_extents
from .frames import HANDS, WRIST
from .objects import (
    DEFAULT_MAX_INTERPOLATE_GAP_MS,
    DEFAULT_STALE_MS,
    ObjectSeries,
    object_series,
)
from .observations import observation_summaries
from .quality import quality
from .resample import MAX_FRAME_GAP_MS, Resampled, resample_episode
from .room import (
    ROOM_FILE,
    latest_room_scan,
    room_doc,
    room_scan_media,
    room_snapshots,
    write_room_glb,
)
from .schema import ValidationIssue, parse_json, validate_episode
from .shapes import (
    DEFAULT_MIN_HITS,
    DEFAULT_VOXEL_M,
    has_depth_samples,
    object_shapes,
    shapes_doc,
)

COMPILER_NAME = "clio_pipeline"
# Raw files a compile reads, in the episode directory. Any change makes the compile stale, and so
# does a change to the room scan GLBs (inputs "media/room-scan-<n>.glb", room.room_scan_media).
INPUT_FILES = (
    "meta.json",
    "frames.ndjson",
    "events.ndjson",
    "objects.ndjson",
    "observations.ndjson",
    "finish.json",
    "batches.json",
)
# File names the server serves from data/derived/<id>/ (derived.ts DERIVED_FILE_NAME).
DERIVED_FILE_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,95}\.(json|glb)$")


@dataclass
class CompileResult:
    episode_id: str
    out_dir: Path  # <out_root>/<episode id>
    skipped: bool  # the compile was up to date (if_stale) and was kept as it was
    manifest: dict[str, Any]

    @property
    def usable(self) -> bool:
        return bool(self.manifest["quality"]["usable"])


def compile_episode(
    episode_dir: Path | str,
    out_root: Path | str,
    *,
    fps: int = 30,
    retarget_profiles: Sequence[Path | str] = (),
    if_stale: bool = False,
) -> CompileResult:
    """Compile one episode into `out_root/<episode id>/`; everything that goes wrong in a stage
    lands in the manifest. Raises, leaving an earlier compile as it was, when the episode cannot
    be read at all (meta.json, frames.ndjson, events.ndjson and objects.ndjson must be readable),
    when `out_root/<episode id>` would be the episode, inside it or beside it in its episodes
    directory (ValueError, before anything is written), and when that directory exists but holds
    no earlier compile (FileExistsError, and it is left alone)."""
    episode_dir, out_root = Path(episode_dir), Path(out_root)
    if isinstance(fps, bool) or not isinstance(fps, int | np.integer) or fps <= 0:
        raise ValueError(f"fps must be a positive integer, got {fps!r}")
    fps = int(fps)
    if isinstance(retarget_profiles, str | Path):
        retarget_profiles = [retarget_profiles]
    episode_id = episode_id_of(episode_dir)
    out_dir = out_root / episode_id
    if not is_apart(episode_dir, out_root, out_dir):
        raise ValueError(
            f"will not compile {episode_dir} into {out_root}: compiled files never go into an "
            "episode or its episodes directory (use a derived root such as data/derived)"
        )
    profiles = _load_profiles(retarget_profiles)

    def kept() -> CompileResult | None:
        previous = _read_manifest(out_dir)
        if previous is not None and _up_to_date(previous, episode_dir, out_dir, fps, profiles):
            return CompileResult(episode_id, out_dir, True, previous)
        return None

    if if_stale and (result := kept()) is not None:
        return result
    out_root.mkdir(parents=True, exist_ok=True)
    with episode_lock(out_root, episode_id) as locked:
        if if_stale and (result := kept()) is not None:  # compiled while this one waited
            return result
        if locked:  # no other compile of this episode is running
            remove_leftovers(out_root, episode_id)

        inputs = fingerprint(episode_dir)  # before reading, so a late append makes it stale
        issues = validate_episode(episode_dir, max_issues_per_file=sys.maxsize)  # count them all
        episode = load_episode(episode_dir)

        work = make_work_dir(out_root, episode_id)
        try:
            stages, artifacts, verdict = _run_stages(
                episode, episode_dir, work, fps, profiles, issues
            )
            manifest = {
                "schema": DERIVED_SCHEMA_ID,
                "episodeId": episode.episode_id,
                "compiledAt": utc_now(),
                "compiler": {"name": COMPILER_NAME, "version": __version__},
                "fps": fps,
                "inputs": inputs,
                "retarget": _profile_refs(profiles),
                "stages": stages,
                "artifacts": artifacts,
                "quality": verdict,
            }
            write_json(work / "manifest.json", manifest, indent=2)
            swap_in(work, out_dir, replaceable=_is_compile, refusal=_not_a_compile(out_dir))
        except BaseException:
            shutil.rmtree(work, ignore_errors=True)
            raise
    return CompileResult(episode_id, out_dir, False, manifest)


# --- stages ---------------------------------------------------------------------------------------


@dataclass
class _Profile:
    path: str
    profile: Any | None  # clio_pipeline.retarget's profile, once loaded
    error: str | None  # why it could not be loaded

    @property
    def stage(self) -> str:
        return f"retarget-{self.profile.id}" if self.profile is not None else "retarget"


def _run_stages(
    episode: Episode,
    episode_dir: Path,
    work: Path,
    fps: int,
    profiles: list[_Profile],
    issues: list[ValidationIssue],
) -> tuple[list[dict], list[dict], dict]:
    stages: list[dict[str, Any]] = []
    artifacts: list[dict[str, Any]] = []

    def stage(name: str, run: Callable[[], Any], ok_detail: str | None = None) -> Any:
        try:
            result = run()
        except Exception as e:  # one stage's failure must not stop the others
            detail = describe(e) if ok_detail is None else f"{ok_detail}: {describe(e)}"
            stages.append({"name": name, "status": "failed", "detail": detail})
            return None
        stages.append(
            {"name": name, "status": "ok", **({"detail": ok_detail} if ok_detail else {})}
        )
        return result

    def write(name: str, kind: str, doc: dict[str, Any]) -> None:
        artifacts.append({"name": name, "kind": kind, "bytes": write_json(work / name, doc)})

    def tracks() -> tuple[np.ndarray, dict[str, ObjectSeries]]:
        resampled = resample_episode(episode, fps, max_gap_ms=MAX_FRAME_GAP_MS)
        series = object_series(episode, resampled.t)
        extents = object_extents(episode, series)
        write("tracks.json", "tracks", tracks_doc(episode, resampled, series, extents, fps=fps))
        return resampled.t, series

    def shapes() -> None:
        fused = object_shapes(episode, series, voxel_m=DEFAULT_VOXEL_M, min_hits=DEFAULT_MIN_HITS)
        doc = shapes_doc(
            episode, grid, fused, fps=fps, voxel_m=DEFAULT_VOXEL_M, min_hits=DEFAULT_MIN_HITS
        )
        write("shapes.json", "shapes", doc)

    compiled = stage("tracks", tracks)
    grid, series = compiled if compiled is not None else (None, None)
    if series is None:
        stages.append({"name": "shapes", "status": "skipped", "detail": "no tracks"})
    elif not has_depth_samples(episode):
        stages.append({"name": "shapes", "status": "skipped", "detail": "no depth samples"})
    else:
        stage("shapes", shapes)
    room = _room_stage(episode, work, stages, artifacts)

    def environment() -> None:
        doc = environment_doc(episode)
        doc["room"] = room
        write("environment.json", "environment", doc)

    stage("environment", environment)

    if not profiles:
        stages.append({"name": "retarget", "status": "skipped", "detail": "no profile"})
    used: set[str] = set()
    for p in profiles:
        if p.profile is None:
            stages.append({"name": p.stage, "status": "failed", "detail": p.error})
            continue
        name = f"{p.stage}.json"
        if not DERIVED_FILE_NAME.match(name) or p.profile.id in used:
            problem = "used twice" if p.profile.id in used else "not a valid file name"
            detail = f"profile id {p.profile.id!r} is {problem}"
            stages.append({"name": p.stage, "status": "failed", "detail": detail})
            continue
        used.add(p.profile.id)
        stage(
            p.stage,
            lambda p=p, name=name: _retarget(episode, p.profile, fps, write, name),
            ok_detail=f"version {p.profile.version}",
        )

    verdict = stage("quality", lambda: quality(episode_dir, episode, series, issues))
    if verdict is None:
        verdict = _unknown_quality(episode, issues)
    return stages, artifacts, verdict


def _room_stage(
    episode: Episode, work: Path, stages: list[dict[str, Any]], artifacts: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """The `room` stage: room.glb from the last room scan snapshot whose GLB arrived and can be
    read (room.py), and its summary for environment.json (None when there is none). Skipped
    without a snapshot or when no GLB arrived; failed, with room.glb left out, when none that
    arrived can be read. What was passed over or left out on the way is said in the detail."""
    snapshots = room_snapshots(episode)
    if not snapshots:
        stages.append({"name": "room", "status": "skipped", "detail": "no room scan"})
        return None
    try:
        scan = latest_room_scan(episode)
        if scan is None:
            missing = ", ".join(sorted({e["media"] for e in snapshots}))
            detail = f"no room scan arrived ({missing} not in media/)"
            stages.append({"name": "room", "status": "skipped", "detail": detail})
            return None
        doc = room_doc(scan)
        size = write_room_glb(scan, doc, work / ROOM_FILE)
    except Exception as e:  # one stage's failure must not stop the others
        (work / ROOM_FILE).unlink(missing_ok=True)
        stages.append({"name": "room", "status": "failed", "detail": describe(e)})
        return None
    artifacts.append({"name": ROOM_FILE, "kind": "room", "bytes": size})
    note = scan.note
    stages.append({"name": "room", "status": "ok", **({"detail": note} if note else {})})
    return doc


def _retarget(episode: Episode, profile: Any, fps: int, write, name: str) -> None:
    from .retarget import retarget_doc, retarget_episode

    result = retarget_episode(episode, profile, fps=fps)
    write(name, "retarget", retarget_doc(result, episode))


def tracks_doc(
    episode: Episode,
    resampled: Resampled,
    series: dict[str, ObjectSeries],
    extents: dict[str, dict[str, Any] | None] | None = None,
    *,
    fps: int,
    max_interpolate_gap_ms: float = DEFAULT_MAX_INTERPOLATE_GAP_MS,
    stale_ms: float = DEFAULT_STALE_MS,
) -> dict[str, Any]:
    """TracksDoc (packages/protocol/src/derived.ts) from the resampled frames and the object
    series on the same grid, each object with a summary of its 2D observations when there are
    any (observations.py) and its estimated metric extent (`extents`, keyed like `series`, from
    extents.py; null when not estimated). The frames must be resampled with a `max_gap_ms` (see
    MAX_FRAME_GAP_MS): head and wrists are null across longer frame gaps, never filled in."""
    if resampled.max_gap_ms is None:
        raise ValueError("tracks need frames resampled with max_gap_ms: gaps must not be filled")
    wrist = resampled.hands[:, :, WRIST, :7]
    observed = observation_summaries(episode)
    extents = extents or {}
    return {
        "schema": DERIVED_SCHEMA_ID,
        "episodeId": episode.episode_id,
        "frame": "workspace",
        "fps": fps,
        "t": times(resampled.t),
        "kind": "tracks",
        "policy": {
            "maxInterpolateGapMs": max_interpolate_gap_ms,
            "staleMs": stale_ms,
            "maxFrameGapMs": resampled.max_gap_ms,
        },
        "head": rounded(resampled.head.reshape(-1, 7), valid=resampled.head_valid),
        "hands": [
            {
                "hand": side,
                "wrist": rounded(wrist[:, h].reshape(-1, 7), valid=resampled.tracked[:, h]),
                "pinch": rounded(resampled.pinch[:, h], valid=resampled.tracked[:, h]),
            }
            for h, side in enumerate(HANDS)
        ],
        "objects": [_object_doc(s, observed.get(s.id), extents.get(s.id)) for s in series.values()],
    }


def _object_doc(
    s: ObjectSeries, observations: dict[str, Any] | None, extent: dict[str, Any] | None
) -> dict[str, Any]:
    return {
        "id": s.id,
        "label": s.label,
        "kind": s.kind,
        "radius": s.radius,
        "hidden": s.hidden,
        "partOf": s.part_of,
        "extent": extent,
        "position": rounded(s.position.reshape(-1, 3), valid=s.valid),
        "orientation": rounded(s.orientation.reshape(-1, 4)),
        "tracked": s.tracked.tolist(),
        "interpolated": s.interpolated.tolist(),
        "held": s.held.tolist(),
        "heldBy": list(s.held_by),
        "confidence": rounded(s.confidence),
        "source": list(s.source),
        "heldSpans": [
            {
                "hand": span.hand,
                "startT": time_or_none(span.start_t),
                "endT": time_or_none(span.end_t),
                "origin": span.origin,
                "grip": span.grip,
            }
            for span in s.held_spans
        ],
        **({"observations": observations} if observations else {}),
    }


def _unknown_quality(episode: Episode, issues: list[ValidationIssue]) -> dict[str, Any]:
    """The verdict when the quality stage itself failed: not usable, nothing else claimed."""
    outcome = (episode.finish or {}).get("outcome")
    return {
        "usable": False,
        "reasons": ["quality check failed"],
        "finished": episode.finish is not None,
        "outcome": outcome if outcome in ("completed", "aborted", "interrupted") else None,
        "batches": None,
        "durationMs": max(0.0, episode.duration_ms),
        "frames": episode.n_frames,
        "frameRateHz": None,
        "maxFrameGapMs": None,
        "hands": {"left": 0.0, "right": 0.0},
        "objects": [],
        "validationIssues": len(issues),
    }


# --- inputs and staleness -----------------------------------------------------------------------


def fingerprint(episode_dir: Path | str) -> list[dict[str, Any]]:
    """{name, bytes, sha256} of each raw input that exists: INPUT_FILES, then the room scan GLBs
    as "media/<name>"."""
    return fingerprint_files(input_paths(Path(episode_dir)))


def input_paths(episode_dir: Path) -> dict[str, Path]:
    """Every raw input a compile may read, by its name in manifest.inputs, whether it exists or
    not (keyframe JPEGs and other media are not compile inputs)."""
    paths = {name: episode_dir / name for name in INPUT_FILES}
    for name in room_scan_media(episode_dir):
        paths[f"media/{name}"] = episode_dir / "media" / name
    return paths


def _up_to_date(
    manifest: dict[str, Any],
    episode_dir: Path,
    out_dir: Path,
    fps: int,
    profiles: list[_Profile],
) -> bool:
    """Same compiler version, fps and profiles, every artifact still there, and identical raw
    inputs (sizes compared first; files are hashed only when every size matches)."""
    try:
        compiler = manifest["compiler"]
        if (compiler["name"], compiler["version"], manifest["fps"]) != (
            COMPILER_NAME,
            __version__,
            fps,
        ):
            return False
        if any(p.profile is None for p in profiles):
            return False
        recorded = {tuple(sorted(r.items())) for r in manifest["retarget"]}
        if recorded != {tuple(sorted(r.items())) for r in _profile_refs(profiles)}:
            return False
        for artifact in manifest["artifacts"]:
            path = out_dir / artifact["name"]
            if not path.is_file() or path.stat().st_size != artifact["bytes"]:
                return False
        return same_inputs(manifest["inputs"], input_paths(episode_dir))
    except (KeyError, TypeError, ValueError, OSError):
        return False


def _profile_refs(profiles: list[_Profile]) -> list[dict[str, Any]]:
    """What the manifest records about each profile that loaded: editing the profile file or
    its URDF changes a hash, so the compile goes stale."""
    return [
        {
            "id": p.profile.id,
            "version": int(p.profile.version),
            "profileSha256": p.profile.profile_sha256,
            "urdfSha256": p.profile.urdf_sha256,
        }
        for p in profiles
        if p.profile is not None
    ]


def _load_profiles(paths: Sequence[Path | str]) -> list[_Profile]:
    if not paths:
        return []
    try:
        from .retarget import load_profile
    except ImportError as e:
        return [_Profile(str(p), None, f"retargeting is unavailable ({e})") for p in paths]
    loaded = []
    for path in paths:
        try:
            loaded.append(_Profile(str(path), load_profile(path), None))
        except Exception as e:  # a bad profile fails its stage, not the compile
            loaded.append(_Profile(str(path), None, f"cannot load {path}: {describe(e)}"))
    return loaded


def _read_manifest(out_dir: Path) -> dict[str, Any] | None:
    try:
        manifest = parse_json((out_dir / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    return manifest if isinstance(manifest, dict) else None


def _is_compile(out_dir: Path) -> bool:
    """Whether `out_dir` holds an earlier compile (a clio.derived/1 manifest.json)."""
    manifest = _read_manifest(out_dir)
    return manifest is not None and manifest.get("schema") == DERIVED_SCHEMA_ID


def _not_a_compile(out_dir: Path) -> str:
    return (
        f"{out_dir} exists and is not a compile (no {DERIVED_SCHEMA_ID} manifest.json): "
        "not replacing it"
    )
