"""Fetches the models into `models/` (gitignored): `python -m jev_finder.setup_models`.

- EdgeTAM: Meta's repository at a pinned commit, from GitHub. The checkpoint is part of the
  repository (`checkpoints/edgetam.pt`, 56 MB) and is checked against its SHA-256.
- SAM 2.1 Small: `facebook/sam2.1-hiera-small` at a pinned revision, from Hugging Face, in
  transformers format (config and `model.safetensors`, 150 MB). The fallback when EdgeTAM can't
  load.

Both are Apache 2.0 (THIRD_PARTY.md). Whatever is already in place is kept, so running it again
only fills in what is missing.
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
from pathlib import Path

from .edgetam import CHECKPOINT, REPO
from .segmenter import SAM_DIR, SAM_ID

EDGETAM_URL = "https://github.com/facebookresearch/EdgeTAM.git"
EDGETAM_COMMIT = "7711e012a30a2402c4eaab637bdb00a521302c91"
EDGETAM_SHA256 = "ed2d4850b8792c239689b043c47046ec239b6e808a3d9b6ae676c803fd8780df"
SAM_REVISION = "ee5bba1d82bb8749febdf90f45e84b687142ba03"
SAM_FILES = ["*.json", "model.safetensors"]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git(*args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(REPO), *args], check=True, capture_output=True, text=True
    ).stdout.strip()


def edgetam() -> None:
    fetched = (REPO / ".git").exists() and CHECKPOINT.exists()
    if fetched and git("rev-parse", "HEAD") == EDGETAM_COMMIT:
        print(f"EdgeTAM {EDGETAM_COMMIT[:7]} is in {REPO}")
    else:
        if REPO.exists():
            shutil.rmtree(REPO)
        REPO.mkdir(parents=True)
        print(f"Fetching EdgeTAM {EDGETAM_COMMIT[:7]} from {EDGETAM_URL}")
        git("init", "--quiet")
        git("remote", "add", "origin", EDGETAM_URL)
        git("fetch", "--quiet", "--depth", "1", "origin", EDGETAM_COMMIT)
        git("checkout", "--quiet", "--detach", "FETCH_HEAD")
    if sha256(CHECKPOINT) != EDGETAM_SHA256:
        raise SystemExit(f"{CHECKPOINT} does not match its SHA-256; delete {REPO} and retry.")


def sam() -> None:
    from huggingface_hub import snapshot_download

    if (SAM_DIR / "model.safetensors").exists():
        print(f"{SAM_ID} is in {SAM_DIR}")
        return
    print(f"Downloading {SAM_ID} from Hugging Face")
    snapshot_download(SAM_ID, revision=SAM_REVISION, local_dir=SAM_DIR, allow_patterns=SAM_FILES)


def main() -> None:
    parser = argparse.ArgumentParser(prog="jev_finder.setup_models", description=__doc__)
    parser.add_argument("--skip-sam", action="store_true", help="only fetch EdgeTAM")
    args = parser.parse_args()
    edgetam()
    if not args.skip_sam:
        sam()
    print("Models ready.")


if __name__ == "__main__":
    main()
