"""`clio`: validate, inspect, compile, model, replay and export Clio episodes."""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
from collections import Counter
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

import numpy as np

from . import __version__
from .episode import Episode, load_episode
from .schema import (
    EpisodeValidationError,
    read_bookkeeping,
    transfer_warnings,
    validate_episode,
)
from .segments import mistakes, step_segments


class CliError(Exception):
    """A user-facing error: printed to stderr, exit code 1."""


# packages/protocol/src/scene.ts ModelBackendSchema (scene.MODEL_BACKENDS, kept here so the
# parser does not import the scene build)
SCENE_MODEL_BACKENDS = ("primitive", "gemini-cad", "command")


def main(argv: Sequence[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    try:
        return args.run(args)
    except CliError as e:
        print(f"clio: {e}", file=sys.stderr)
        return 1


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="clio", description=__doc__)
    parser.add_argument("--version", action="version", version=f"clio-pipeline {__version__}")
    sub = parser.add_subparsers(dest="command", required=True, metavar="COMMAND")
    episodes_help = "episode directories, or directories that contain episode directories"

    p = sub.add_parser("validate", help="check episode files against the protocol JSON Schemas")
    p.add_argument("episodes", nargs="+", help=episodes_help)
    p.add_argument("--max-issues", type=int, default=20, help="issues shown per file (20)")
    p.set_defaults(run=_validate)

    p = sub.add_parser("info", help="summarize episodes: duration, steps, mistakes, coach calls")
    p.add_argument("episodes", nargs="+", help=episodes_help)
    p.set_defaults(run=_info)

    p = sub.add_parser(
        "compile", help="compile episodes into derived/<id>/: tracks, environment, robot, quality"
    )
    p.add_argument("episodes", nargs="+", help=episodes_help)
    p.add_argument(
        "--out", metavar="DIR", help="derived root (default: derived/ beside an episodes/ dir)"
    )
    p.add_argument("--fps", type=int, default=30, help="grid rate (30)")
    p.add_argument(
        "--retarget",
        action="append",
        default=[],
        metavar="PROFILE",
        help="robot profile file to retarget to; repeat for several",
    )
    p.add_argument(
        "--if-stale", action="store_true", help="skip episodes whose compile is up to date"
    )
    p.add_argument("--finished-only", action="store_true", help="skip episodes without finish.json")
    p.add_argument("--json", action="store_true", help="print one JSON line per episode")
    p.set_defaults(run=_compile)

    p = sub.add_parser(
        "scene",
        help="build a generated model of each object of compiled episodes into scenes/<id>/",
    )
    p.add_argument("episodes", nargs="+", help=episodes_help)
    p.add_argument(
        "--derived",
        metavar="DIR",
        help="derived root with the compiles (default: derived/ beside an episodes/ dir)",
    )
    p.add_argument(
        "--out", metavar="DIR", help="scenes root (default: scenes/ beside an episodes/ dir)"
    )
    p.add_argument(
        "--models",
        choices=SCENE_MODEL_BACKENDS,
        default="primitive",
        help="how object models are made (primitive: offline; gemini-cad sends crops to Google)",
    )
    p.add_argument("--if-stale", action="store_true", help="keep scenes that are up to date")
    p.add_argument("--json", action="store_true", help="print one JSON line per episode")
    p.set_defaults(run=_scene)

    p = sub.add_parser("view", help="replay an episode in Rerun (needs the viz extra)")
    p.add_argument("episode", help="an episode directory")
    p.add_argument(
        "--save", metavar="OUT.rrd", help="write an .rrd file instead of opening a viewer"
    )
    p.set_defaults(run=_view)

    p = sub.add_parser(
        "export-lerobot", help="export episodes to a LeRobot dataset (lerobot extra)"
    )
    p.add_argument("episodes", nargs="+", help=episodes_help)
    p.add_argument("--out", required=True, help="dataset root directory (must not exist)")
    p.add_argument("--repo-id", required=True, help='dataset name, e.g. "clio/shirt-fold"')
    p.add_argument("--fps", type=int, default=30, help="resampling rate (30)")
    p.add_argument("--overwrite", action="store_true", help="replace --out if it exists")
    p.add_argument("--no-validate", action="store_true", help="skip schema validation")
    p.add_argument(
        "--robot-profile",
        metavar="PROFILE",
        help="export the joint trajectory retargeted to this robot instead of the hands",
    )
    p.set_defaults(run=_export)
    return parser


def episode_dirs(paths: Sequence[str]) -> list[Path]:
    """Episode directories (with a meta.json), expanding parents such as data/episodes."""
    found: list[Path] = []
    for path in map(Path, paths):
        if (path / "meta.json").is_file():
            found.append(path)
            continue
        children = (
            sorted(c for c in path.iterdir() if (c / "meta.json").is_file())
            if path.is_dir()
            else []
        )
        if not children:
            raise CliError(f"{path}: not an episode directory (no meta.json)")
        found.extend(children)
    return found


def _load(path: Path, *, validate: bool = False) -> Episode:
    try:
        return load_episode(path, validate=validate)
    except EpisodeValidationError as e:
        raise CliError(str(e)) from e
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise CliError(f"cannot read {path}: {e}") from e


# --- validate ------------------------------------------------------------------------------------


def _validate(args: argparse.Namespace) -> int:
    failed = 0
    for path in episode_dirs(args.episodes):
        issues = validate_episode(path, max_issues_per_file=args.max_issues)
        if not issues:
            print(f"ok    {path}")
            for warning in transfer_warnings(path):
                print(f"      warn  {warning}")
            continue
        failed += 1
        print(f"FAIL  {path}  ({len(issues)} issue{'s' if len(issues) != 1 else ''})")
        for issue in issues:
            print(f"      {issue}")
    return 1 if failed else 0


# --- info -----------------------------------------------------------------------------------------


def _info(args: argparse.Namespace) -> int:
    for k, path in enumerate(episode_dirs(args.episodes)):
        if k:
            print()
        print(describe_episode(_load(path)))
    return 0


def _seconds(ms: float) -> str:
    return f"{ms / 1000.0:.2f} s"


def describe_episode(ep: Episode) -> str:
    meta = ep.meta
    procedure = meta.get("procedure")
    what = (
        f'{procedure["id"]} v{procedure["version"]} "{procedure["title"]}"'
        if procedure
        else "no procedure"
    )
    lines = [f"{ep.episode_id}  {meta['mode']}  {what}", f"  {'path':<10}  {ep.path}"]
    lines += _plan_lines(ep)

    n = ep.n_frames
    if n >= 2:
        fps = 1000.0 / float(np.median(np.diff(ep.t)))
        lines.append(
            f"  {'frames':<10}  {n} frames over {_seconds(ep.duration_ms)}, ~{fps:.1f} fps"
        )
        share = 100.0 * ep.tracked.mean(axis=0)
        lines.append(f"  {'tracking':<10}  left {share[0]:.0f}%, right {share[1]:.0f}%")
    else:
        lines.append(f"  {'frames':<10}  {n} frame{'s' if n != 1 else ''}")

    finish = ep.finish
    outcome = (
        f"{finish['outcome']}, {finish['stepsCompleted']}/{finish['stepsTotal']} steps, "
        f"{finish['batches']} batches"
        if finish
        else "unknown (no finish.json)"
    )
    lines.append(f"  {'outcome':<10}  {outcome}")
    lines += _batch_lines(ep)
    lines.append(
        f"  {'objects':<10}  {len(meta.get('objects', []))} placed, "
        f"{len(ep.object_updates)} tracker updates"
    )

    segments = step_segments(ep)
    lines.append(f"  {'steps':<10}  {len(segments)}")
    names = [s.step_id + (f" [{s.action_verb}]" if s.action_verb else "") for s in segments]
    width = max((len(name) for name in names), default=0)
    if segments:
        lines.append(
            f"    {'#':>3}  {'step':<{width}}  {'start':>9}  {'duration':>9}  completed by"
        )
    for s, name in zip(segments, names, strict=True):
        by = (
            s.completed_by + (" (forced)" if s.forced else "")
            if s.completed_by
            else "not completed"
        )
        lines.append(
            f"    {s.index:>3}  {name:<{width}}  {_seconds(s.start_t):>9}  "
            f"{_seconds(s.duration_ms):>9}  {by}"
        )

    found = mistakes(ep)
    lines.append(f"  {'mistakes':<10}  {len(found)}")
    for m in found:
        lines.append(f"    {_seconds(m.t)}  {m.step_id}  {m.kind} ({m.source}): {m.message}")

    calls = Counter(e["name"] for e in ep.events_of("coach.tool_call"))
    failures = sum(1 for e in ep.events_of("coach.tool_result") if not e["ok"])
    detail = ", ".join(f"{name} {count}" for name, count in sorted(calls.items()))
    summary = f"{sum(calls.values())} tool calls" + (f": {detail}" if detail else "")
    if failures:
        summary += f" ({failures} failed)"
    lines.append(f"  {'coach':<10}  {meta['coach']['kind']}; {summary}")

    starts = {e["name"]: e["t"] for e in ep.events_of("media.started")}
    for name in sorted(set(ep.media) | set(starts)):
        where = (
            f"starts at {_seconds(starts[name])}" if name in starts else "no media.started event"
        )
        missing = "" if name in ep.media else " (file missing)"
        lines.append(f"  {'media':<10}  {name}, {where}{missing}")
    return "\n".join(lines)


def _batch_lines(ep: Episode) -> list[str]:
    try:
        book = read_bookkeeping(ep.path)
    except (ValueError, KeyError, TypeError, UnicodeDecodeError):
        return [f"  {'batches':<10}  batches.json is unreadable"]
    if book is None:
        return []
    received = len(book["received"])
    sent = (ep.finish or {}).get("batches")
    line = f"{received} of {sent} received" if sent is not None else f"{received} received"
    if book["gaps"]:
        line += f"; missing seq {', '.join(map(str, book['gaps']))}"
    return [f"  {'batches':<10}  {line}"]


def _plan_lines(ep: Episode) -> list[str]:
    plan = ep.plan
    if not plan:
        return []
    origin = plan.get("origin", {"kind": "curated"})
    if origin["kind"] != "generated":
        return [f"  {'plan':<10}  {origin['kind']}"]
    lines = [f"  {'plan':<10}  generated by {origin['model']} at {origin['createdAt']}"]
    if origin.get("revisionOf"):
        lines[0] += f" (revises {origin['revisionOf']})"
    lines.append(f"  {'goal':<10}  {origin['goal']}")
    return lines


# --- compile --------------------------------------------------------------------------------------


def default_derived_root(episode_dir: Path) -> Path | None:
    """<data>/derived for an episode in <data>/episodes/, else None."""
    return default_data_root(episode_dir, "derived")


def _compile(args: argparse.Namespace) -> int:
    from .compile import compile_episode

    if args.fps <= 0:
        raise CliError(f"--fps must be positive, got {args.fps}")
    dirs = episode_dirs(args.episodes)
    roots: dict[Path, Path] = {}
    for path in dirs:
        root = Path(args.out) if args.out else default_derived_root(path)
        if root is None:
            raise CliError(
                f"{path} is not in an episodes/ directory: give a derived root of its own "
                "with --out (not the directory holding the episode)"
            )
        roots[path] = root

    failed = 0
    with _sigterm_exits():
        for path in dirs:
            if args.finished_only and not (path / "finish.json").is_file():
                unfinished = _no_compile(path.name, skipped=True, reason="not finished")
                print(json.dumps(unfinished) if args.json else f"skip  {path}  not finished")
                continue
            try:
                result = compile_episode(
                    path,
                    roots[path],
                    fps=args.fps,
                    retarget_profiles=args.retarget,
                    if_stale=args.if_stale,
                )
            except Exception as e:  # anything that stops a compile before its manifest is written
                failed += 1
                print(f"clio: cannot compile {path}: {e}", file=sys.stderr)
                if args.json:
                    print(json.dumps(_no_compile(path.name, skipped=False, error=str(e))))
                continue
            print(json.dumps(compile_summary(result)) if args.json else _describe_compile(result))
    return 1 if failed else 0


@contextmanager
def _sigterm_exits() -> Iterator[None]:
    """Turn SIGTERM (the server's compile timeout and shutdown) into SystemExit(143), so a
    compile cleans up its hidden work directory and puts back the compile it was replacing."""
    try:
        previous = signal.signal(signal.SIGTERM, _exit_on_signal)
    except ValueError:  # not the main thread: leave signals alone
        yield
        return
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, previous if previous is not None else signal.SIG_DFL)


def _exit_on_signal(signum: int, frame) -> None:
    sys.exit(128 + signum)


def compile_summary(result) -> dict:
    """The --json line for a compiled (or up-to-date) episode."""
    return {
        "episodeId": result.episode_id,
        "skipped": result.skipped,
        "outDir": str(result.out_dir),
        "usable": result.usable,
        "stages": result.manifest["stages"],
    }


def _no_compile(episode_id: str, *, skipped: bool, **extra: str) -> dict:
    """The --json line for an episode without a compile to show: not finished, or failed."""
    line = {"episodeId": episode_id, "skipped": skipped, "outDir": None, "usable": None}
    return {**line, "stages": [], **extra}


def _describe_compile(result) -> str:
    if result.skipped:
        return f"skip  {result.episode_id}  up to date"
    quality = result.manifest["quality"]
    verdict = "usable" if quality["usable"] else "not usable: " + "; ".join(quality["reasons"])
    lines = [f"ok    {result.episode_id}  {result.out_dir}", f"      {verdict}"]
    lines += [
        f"      failed  {stage['name']}: {stage.get('detail', '')}"
        for stage in result.manifest["stages"]
        if stage["status"] == "failed"
    ]
    return "\n".join(lines)


# --- scene ----------------------------------------------------------------------------------------


def default_data_root(episode_dir: Path, name: str) -> Path | None:
    """<data>/<name> for an episode in <data>/episodes/, else None."""
    parent = Path(os.path.normpath(episode_dir.absolute())).parent
    return parent.parent / name if parent.name == "episodes" else None


def _scene(args: argparse.Namespace) -> int:
    from .scene import build_scene

    dirs = episode_dirs(args.episodes)
    roots: dict[Path, tuple[Path, Path]] = {}
    for path in dirs:
        derived = Path(args.derived) if args.derived else default_data_root(path, "derived")
        out = Path(args.out) if args.out else default_data_root(path, "scenes")
        if derived is None or out is None:
            raise CliError(
                f"{path} is not in an episodes/ directory: give its derived root with --derived "
                "and a scenes root of its own with --out"
            )
        roots[path] = (derived, out)

    failed = 0
    with _sigterm_exits():
        for path in dirs:
            derived, out = roots[path]
            try:
                result = build_scene(
                    path,
                    derived,
                    out,
                    models=args.models,
                    if_stale=args.if_stale,
                    log=lambda message: print(f"clio scene: {message}", file=sys.stderr),
                )
            except Exception as e:  # anything that stops a build before scene.json is written
                failed += 1
                if args.json:
                    print(json.dumps(_no_scene(path.name, str(e))))
                # Last on stderr: the server shows the tail of stderr as the reason.
                print(f"clio: cannot build the scene of {path.name}: {e}", file=sys.stderr)
                continue
            print(json.dumps(scene_summary(result)) if args.json else _describe_scene(result))
    return 1 if failed else 0


def scene_summary(result) -> dict:
    """The --json line for a built (or up-to-date) scene."""
    return {
        "episodeId": result.episode_id,
        "skipped": result.skipped,
        "outDir": str(result.out_dir),
        "stages": result.scene["stages"],
        "objects": len(result.scene["objects"]),
    }


def _no_scene(episode_id: str, error: str) -> dict:
    return {"episodeId": episode_id, "skipped": False, "outDir": None, "stages": [], "error": error}


def _describe_scene(result) -> str:
    if result.skipped:
        return f"skip  {result.episode_id}  up to date"
    count, backend = len(result.scene["objects"]), result.scene["options"]["models"]
    lines = [
        f"ok    {result.episode_id}  {result.out_dir}",
        f"      {count} object model{'s' if count != 1 else ''} ({backend})",
    ]
    lines += [
        f"      {stage['status']}  {stage['name']}: {stage.get('detail', '')}"
        for stage in result.scene["stages"]
        if stage["status"] != "ok"
    ]
    return "\n".join(lines)


# --- view -----------------------------------------------------------------------------------------


def _view(args: argparse.Namespace) -> int:
    try:
        from .rerun_view import save_rrd, spawn_viewer
    except ImportError as e:
        raise CliError(f"`clio view` needs rerun-sdk: uv sync --extra viz ({e})") from e
    episode = _load(Path(args.episode))
    if args.save:
        print(f"wrote {save_rrd(episode, args.save)}")
    else:
        spawn_viewer(episode)
    return 0


# --- export-lerobot -------------------------------------------------------------------------------


def _export(args: argparse.Namespace) -> int:
    from .lerobot_export import export_lerobot

    try:
        import datasets

        datasets.disable_progress_bars()
    except ImportError:
        pass
    dirs = episode_dirs(args.episodes)
    robot = {"robot_profile": _robot_profile(args.robot_profile)} if args.robot_profile else {}
    try:
        result = export_lerobot(
            dirs,
            args.out,
            repo_id=args.repo_id,
            fps=args.fps,
            validate=not args.no_validate,
            overwrite=args.overwrite,
            **robot,
        )
    except (EpisodeValidationError, FileExistsError, ImportError, ValueError) as e:
        raise CliError(str(e)) from e

    frames = sum(e.frames for e in result.episodes)
    count = len(result.episodes)
    print(
        f"exported {count} episode{'s' if count != 1 else ''} ({frames} frames at {result.fps} fps)"
        f" to {result.root}: LeRobot dataset {result.codebase_version}, repo id {result.repo_id}"
    )
    for e in result.episodes:
        print(f"  {e.episode_index:>3}  {e.episode_id}  {e.frames} frames")
        if e.skipped_media:
            print(f"       media not exported (no video support yet): {', '.join(e.skipped_media)}")
    for path, reason in result.skipped:
        print(f"  skipped {path}: {reason}")
    return 0


def _robot_profile(path: str):
    try:
        from .retarget import load_profile
    except ImportError as e:
        raise CliError(f"--robot-profile needs clio_pipeline.retarget ({e})") from e
    try:
        return load_profile(path)
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise CliError(f"cannot load robot profile {path}: {e}") from e


if __name__ == "__main__":
    sys.exit(main())
