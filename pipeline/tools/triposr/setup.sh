#!/usr/bin/env bash
# Sets up TripoSR for `clio scene --models triposr` (docs/room-scene.md): fetches TripoSR's source
# at the pinned commit into .vendor/, creates this folder's environment with uv, then loads the
# model once, which downloads its weights (stabilityai/TripoSR, about 1.7 GB, into the Hugging Face
# cache) and the background remover's (rembg's isnet-general-use, about 170 MB, into ~/.rembg).
# Run it again after changing the commit.
set -euo pipefail
cd "$(dirname "$0")"

COMMIT=107cefdc244c39106fa830359024f6a2f1c78871 # VAST-AI-Research/TripoSR, MIT

if [ ! -f .vendor/TripoSR/.commit ] || [ "$(cat .vendor/TripoSR/.commit)" != "$COMMIT" ]; then
  rm -rf .vendor/TripoSR
  mkdir -p .vendor
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  echo "Fetching TripoSR at ${COMMIT:0:7}"
  curl -fsSL "https://codeload.github.com/VAST-AI-Research/TripoSR/tar.gz/$COMMIT" | tar -xz -C "$tmp"
  mv "$tmp/TripoSR-$COMMIT" .vendor/TripoSR
  echo "$COMMIT" >.vendor/TripoSR/.commit
fi

uv sync --frozen
uv run --frozen python clio_triposr.py --warm
