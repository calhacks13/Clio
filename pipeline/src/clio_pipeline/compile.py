"""`clio compile`: turn an episode into data/derived/<id>/ (docs/data-pipeline.md).

    manifest.json            inputs (bytes, SHA-256), stages, artifacts, quality verdict
    tracks.json              head, wrists and every object on one grid (default 30 fps)
    environment.json         table, floor and detected planes
    retarget-<profile>.json  one per robot profile

Raw files are only read, and a compile refuses to write into the episode or beside it in its
episodes directory. Each stage runs on its own: a failure is recorded in the manifest (status
`failed`, with what went wrong) and the other stages still run. Everything is written to a hidden
directory inside the derived root first (its name starts with ".", so it is never mistaken for an
episode), then swapped in for the old compile, so readers never see a mix. Only an earlier compile
(or an empty directory) is ever replaced.

Compiles of one episode take turns: each holds an exclusive lock on `<derived root>/.<id>.lock`
(where fcntl exists) and first removes the hidden directories a killed compile left behind.

A compile is stale when a raw input, the compiler version, the fps or a robot profile (its file
or its URDF) changed. With `if_stale=True` an up-to-date compile is kept and nothing is written.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import sys
import tempfile
import uuid
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np

try:
    import fcntl
except ImportError:  # pragma: no cover - not on Windows
    fcntl = None

from . import __version__
from .derived_io import DERIVED_SCHEMA_ID, rounded, time_or_none, times, write_json
from .environment import environment_doc
from .episode import Episode, load_episode
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
from .schema import ValidationIssue, parse_json, validate_episode

COMPILER_NAME = "clio_pipeline"
# Raw files a compile reads, in the episode directory. Any change makes the compile stale.
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
DERIVED_FILE_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,95}\.json$")
_EPISODE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


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
    episode_id = _episode_id(episode_dir)
    out_dir = out_root / episode_id
    _check_apart(episode_dir, out_root, out_dir)
    profiles = _load_profiles(retarget_profiles)

    def kept() -> CompileResult | None:
        previous = _read_manifest(out_dir)
        if previous is not None and _up_to_date(previous, episode_dir, out_dir, fps, profiles):
            return CompileResult(episode_id, out_dir, True, previous)
        return None

    if if_stale and (result := kept()) is not None:
        return result
    out_root.mkdir(parents=True, exist_ok=True)
    with _episode_lock(out_root, episode_id) as locked:
        if if_stale and (result := kept()) is not None:  # compiled while this one waited
            return result
        if locked:  # no other compile of this episode is running
            _remove_leftovers(out_root, episode_id)

        inputs = fingerprint(episode_dir)  # before reading, so a late append makes it stale
        issues = validate_episode(episode_dir, max_issues_per_file=sys.maxsize)  # count them all
        episode = load_episode(episode_dir)

        work = Path(tempfile.mkdtemp(prefix=f".{episode_id}.", dir=out_root))
        try:
            work.chmod(0o755)  # mkdtemp's 0700 would keep other readers of data/ out
            stages, artifacts, verdict = _run_stages(
                episode, episode_dir, work, fps, profiles, issues
            )
            manifest = {
                "schema": DERIVED_SCHEMA_ID,
                "episodeId": episode.episode_id,
                "compiledAt": _utc_now(),
                "compiler": {"name": COMPILER_NAME, "version": __version__},
                "fps": fps,
                "inputs": inputs,
                "retarget": _profile_refs(profiles),
                "stages": stages,
                "artifacts": artifacts,
                "quality": verdict,
            }
            write_json(work / "manifest.json", manifest, indent=2)
            _swap_in(work, out_dir)
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
            detail = _describe(e) if ok_detail is None else f"{ok_detail}: {_describe(e)}"
            stages.append({"name": name, "status": "failed", "detail": detail})
            return None
        stages.append(
            {"name": name, "status": "ok", **({"detail": ok_detail} if ok_detail else {})}
        )
        return result

    def write(name: str, kind: str, doc: dict[str, Any]) -> None:
        artifacts.append({"name": name, "kind": kind, "bytes": write_json(work / name, doc)})

    def tracks() -> dict[str, ObjectSeries]:
        resampled = resample_episode(episode, fps, max_gap_ms=MAX_FRAME_GAP_MS)
        series = object_series(episode, resampled.t)
        write("tracks.json", "tracks", tracks_doc(episode, resampled, series, fps=fps))
        return series

    series = stage("tracks", tracks)
    stage("environment", lambda: write("environment.json", "environment", environment_doc(episode)))

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


def _retarget(episode: Episode, profile: Any, fps: int, write, name: str) -> None:
    from .retarget import retarget_doc, retarget_episode

    result = retarget_episode(episode, profile, fps=fps)
    write(name, "retarget", retarget_doc(result, episode))


def tracks_doc(
    episode: Episode,
    resampled: Resampled,
    series: dict[str, ObjectSeries],
    *,
    fps: int,
    max_interpolate_gap_ms: float = DEFAULT_MAX_INTERPOLATE_GAP_MS,
    stale_ms: float = DEFAULT_STALE_MS,
) -> dict[str, Any]:
    """TracksDoc (packages/protocol/src/derived.ts) from the resampled frames and the object
    series on the same grid, each object with a summary of its 2D observations when there are
    any (observations.py). The frames must be resampled with a `max_gap_ms` (see
    MAX_FRAME_GAP_MS): head and wrists are null across longer frame gaps, never filled in."""
    if resampled.max_gap_ms is None:
        raise ValueError("tracks need frames resampled with max_gap_ms: gaps must not be filled")
    wrist = resampled.hands[:, :, WRIST, :7]
    observed = observation_summaries(episode)
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
        "objects": [_object_doc(s, observed.get(s.id)) for s in series.values()],
    }


def _object_doc(s: ObjectSeries, observations: dict[str, Any] | None) -> dict[str, Any]:
    return {
        "id": s.id,
        "label": s.label,
        "kind": s.kind,
        "radius": s.radius,
        "hidden": s.hidden,
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
    """{name, bytes, sha256} of each raw input that exists."""
    episode_dir = Path(episode_dir)
    inputs = []
    for name in INPUT_FILES:
        if (path := episode_dir / name).is_file():
            size, sha256 = _digest(path)
            inputs.append({"name": name, "bytes": size, "sha256": sha256})
    return inputs


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
        recorded = {i["name"]: i for i in manifest["inputs"]}
        present = {n: p for n in INPUT_FILES if (p := episode_dir / n).is_file()}
        if set(recorded) != set(present):
            return False
        if any(p.stat().st_size != recorded[n]["bytes"] for n, p in present.items()):
            return False
        return all(_digest(p)[1] == recorded[n]["sha256"] for n, p in present.items())
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
            loaded.append(_Profile(str(path), None, f"cannot load {path}: {_describe(e)}"))
    return loaded


def _read_manifest(out_dir: Path) -> dict[str, Any] | None:
    try:
        manifest = parse_json((out_dir / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    return manifest if isinstance(manifest, dict) else None


def _check_apart(episode_dir: Path, out_root: Path, out_dir: Path) -> None:
    """Raw files are never touched: refuse an output that is the episode, inside it or around it,
    or the episode's own episodes directory (where `<out>/<id>` is the episode or a sibling)."""
    episode, root, out = episode_dir.resolve(), out_root.resolve(), out_dir.resolve()
    if root == episode.parent or out.is_relative_to(episode) or episode.is_relative_to(out):
        raise ValueError(
            f"will not compile {episode_dir} into {out_root}: compiled files never go into an "
            "episode or its episodes directory (use a derived root such as data/derived)"
        )


def _episode_id(episode_dir: Path) -> str:
    meta_path = episode_dir / "meta.json"
    if not meta_path.is_file():
        raise FileNotFoundError(f"{episode_dir} is not a Clio episode: no meta.json")
    meta = parse_json(meta_path.read_text(encoding="utf-8"))
    episode_id = meta.get("episodeId") if isinstance(meta, dict) else None
    if not isinstance(episode_id, str) or not _EPISODE_ID.match(episode_id):
        raise ValueError(f"{meta_path}: episodeId {episode_id!r} cannot name a directory")
    return episode_id


# --- files ----------------------------------------------------------------------------------------


@contextmanager
def _episode_lock(out_root: Path, episode_id: str) -> Iterator[bool]:
    """Hold an exclusive lock on `out_root/.<id>.lock` (kept, never deleted, so every compile
    locks the same file); yields whether it is held. Without fcntl, compiles are not serialized."""
    if fcntl is None:  # pragma: no cover - not on Windows
        yield False
        return
    fd = os.open(out_root / f".{episode_id}.lock", os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield True
    finally:
        os.close(fd)  # releases the lock


def _remove_leftovers(out_root: Path, episode_id: str) -> None:
    """Remove the hidden work and backup directories (`.<id>.<8 random characters>`,
    `.<id>.old-<8 hex digits>`) of compiles that were killed. Call it holding the lock: no other
    compile of the episode is running then. The lock file is not a directory and stays."""
    leftover = re.compile(rf"^\.{re.escape(episode_id)}\.(old-[0-9a-f]{{8}}|[a-z0-9_]{{8}})$")
    for path in out_root.iterdir():
        if leftover.match(path.name) and path.is_dir() and not path.is_symlink():
            shutil.rmtree(path, ignore_errors=True)


def _swap_in(work: Path, out_dir: Path) -> None:
    """Replace `out_dir` with `work` by two renames: a reader may find no compile for an instant,
    never a half-written one. Only an earlier compile or an empty directory is replaced; anything
    else at `out_dir` raises FileExistsError and is left as it was."""
    backup = None
    if out_dir.exists() or out_dir.is_symlink():
        _check_replaceable(out_dir)
        backup = out_dir.with_name(f".{out_dir.name}.old-{uuid.uuid4().hex[:8]}")
    try:
        if backup is not None:
            try:
                out_dir.rename(backup)
            except FileNotFoundError:  # removed meanwhile: nothing to back up
                backup = None
        work.rename(out_dir)
    except BaseException:  # SystemExit from SIGTERM included: put the old compile back
        if backup is not None and backup.exists() and not out_dir.exists():
            backup.rename(out_dir)
        raise
    if backup is not None:
        shutil.rmtree(backup, ignore_errors=True)


def _check_replaceable(out_dir: Path) -> None:
    """Raise FileExistsError unless `out_dir` is gone, empty, or an earlier compile (it holds a
    clio.derived/1 manifest.json)."""
    try:
        if out_dir.is_dir() and not out_dir.is_symlink():
            if not any(out_dir.iterdir()):
                return
            manifest = _read_manifest(out_dir)
            if manifest is not None and manifest.get("schema") == DERIVED_SCHEMA_ID:
                return
        elif not out_dir.exists() and not out_dir.is_symlink():
            return
    except FileNotFoundError:
        return
    raise FileExistsError(
        f"{out_dir} exists and is not a compile (no {DERIVED_SCHEMA_ID} manifest.json): "
        "not replacing it"
    )


def _utc_now() -> str:
    """ISO 8601 in UTC with milliseconds, e.g. 2026-10-24T03:15:02.123Z."""
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _digest(path: Path) -> tuple[int, str]:
    """(bytes, SHA-256) of the bytes actually read, consistent even while a file grows."""
    digest, size = hashlib.sha256(), 0
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def _describe(e: BaseException) -> str:
    text = f"{type(e).__name__}: {e}"
    return text if len(text) <= 300 else text[:297] + "..."
