"""Output directories that are built aside and swapped in whole: `clio compile`'s
data/derived/<id>/ and `clio scene`'s data/scenes/<id>/.

A build writes into a hidden directory inside its root (`.<id>.<8 random characters>`: the leading
"." keeps it from being mistaken for an episode), then two renames replace the old build with it,
so a reader may find none for an instant, never a half-written one. Only an earlier build of the
same kind (or an empty directory) is ever replaced. Builds of one episode take turns through an
exclusive lock on `<root>/.<id>.lock` (where fcntl exists), and each first removes the hidden
directories a killed build left behind.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import tempfile
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

try:
    import fcntl
except ImportError:  # pragma: no cover - not on Windows
    fcntl = None

from .schema import parse_json

_EPISODE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def episode_id_of(episode_dir: Path) -> str:
    """meta.json's episodeId, checked to be safe as a directory name."""
    meta_path = episode_dir / "meta.json"
    if not meta_path.is_file():
        raise FileNotFoundError(f"{episode_dir} is not a Clio episode: no meta.json")
    meta = parse_json(meta_path.read_text(encoding="utf-8"))
    episode_id = meta.get("episodeId") if isinstance(meta, dict) else None
    if not isinstance(episode_id, str) or not _EPISODE_ID.match(episode_id):
        raise ValueError(f"{meta_path}: episodeId {episode_id!r} cannot name a directory")
    return episode_id


def is_apart(episode_dir: Path, out_root: Path, out_dir: Path) -> bool:
    """Whether a build at `out_dir` (in `out_root`) leaves the raw episode alone: it is not the
    episode, inside it or around it, and `out_root` is not the episode's own episodes directory
    (where `<out>/<id>` is the episode or a sibling of it)."""
    episode, root, out = episode_dir.resolve(), out_root.resolve(), out_dir.resolve()
    return not (
        root == episode.parent or out.is_relative_to(episode) or episode.is_relative_to(out)
    )


def make_work_dir(out_root: Path, episode_id: str) -> Path:
    """A new hidden directory `out_root/.<id>.<8 random characters>` to build in."""
    work = Path(tempfile.mkdtemp(prefix=f".{episode_id}.", dir=out_root))
    work.chmod(0o755)  # mkdtemp's 0700 would keep other readers of data/ out
    return work


@contextmanager
def episode_lock(out_root: Path, episode_id: str) -> Iterator[bool]:
    """Hold an exclusive lock on `out_root/.<id>.lock` (kept, never deleted, so every build
    locks the same file); yields whether it is held. Without fcntl, builds are not serialized."""
    if fcntl is None:  # pragma: no cover - not on Windows
        yield False
        return
    fd = os.open(out_root / f".{episode_id}.lock", os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield True
    finally:
        os.close(fd)  # releases the lock


def remove_leftovers(out_root: Path, episode_id: str) -> None:
    """Remove the hidden work and backup directories (`.<id>.<8 random characters>`,
    `.<id>.old-<8 hex digits>`) of builds that were killed. Call it holding the lock: no other
    build of the episode is running then. The lock file is not a directory and stays."""
    leftover = re.compile(rf"^\.{re.escape(episode_id)}\.(old-[0-9a-f]{{8}}|[a-z0-9_]{{8}})$")
    for path in out_root.iterdir():
        if leftover.match(path.name) and path.is_dir() and not path.is_symlink():
            shutil.rmtree(path, ignore_errors=True)


def swap_in(
    work: Path, out_dir: Path, *, replaceable: Callable[[Path], bool], refusal: str
) -> None:
    """Replace `out_dir` with `work` by two renames. Only a directory `replaceable` accepts (an
    earlier build), an empty one or nothing is replaced; anything else raises FileExistsError
    with `refusal` and is left as it was."""
    backup = None
    if out_dir.exists() or out_dir.is_symlink():
        _check_replaceable(out_dir, replaceable, refusal)
        backup = out_dir.with_name(f".{out_dir.name}.old-{uuid.uuid4().hex[:8]}")
    try:
        if backup is not None:
            try:
                out_dir.rename(backup)
            except FileNotFoundError:  # removed meanwhile: nothing to back up
                backup = None
        work.rename(out_dir)
    except BaseException:  # SystemExit from SIGTERM included: put the old build back
        if backup is not None and backup.exists() and not out_dir.exists():
            backup.rename(out_dir)
        raise
    if backup is not None:
        shutil.rmtree(backup, ignore_errors=True)


def _check_replaceable(out_dir: Path, replaceable: Callable[[Path], bool], refusal: str) -> None:
    try:
        if out_dir.is_dir() and not out_dir.is_symlink():
            if not any(out_dir.iterdir()) or replaceable(out_dir):
                return
        elif not out_dir.exists() and not out_dir.is_symlink():
            return
    except FileNotFoundError:
        return
    raise FileExistsError(refusal)


def utc_now() -> str:
    """ISO 8601 in UTC with milliseconds, e.g. 2026-10-24T03:15:02.123Z."""
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def digest(path: Path) -> tuple[int, str]:
    """(bytes, SHA-256) of the bytes actually read, consistent even while a file grows."""
    sha, size = hashlib.sha256(), 0
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            sha.update(chunk)
            size += len(chunk)
    return size, sha.hexdigest()


def fingerprint_files(files: dict[str, Path]) -> list[dict]:
    """{name, bytes, sha256} of each file that exists, in the order given."""
    inputs = []
    for name, path in files.items():
        if path.is_file():
            size, sha256 = digest(path)
            inputs.append({"name": name, "bytes": size, "sha256": sha256})
    return inputs


def same_inputs(recorded: list[dict], files: dict[str, Path]) -> bool:
    """Whether the files that exist now are exactly `recorded` ({name, bytes, sha256}): sizes
    are compared first, and files are hashed only when every size matches."""
    by_name = {i["name"]: i for i in recorded}
    present = {name: path for name, path in files.items() if path.is_file()}
    if set(by_name) != set(present):
        return False
    if any(path.stat().st_size != by_name[name]["bytes"] for name, path in present.items()):
        return False
    return all(digest(path)[1] == by_name[name]["sha256"] for name, path in present.items())


def describe(e: BaseException) -> str:
    text = f"{type(e).__name__}: {e}"
    return text if len(text) <= 300 else text[:297] + "..."
