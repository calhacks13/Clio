#!/usr/bin/env bash
# Starts the jev finder on 127.0.0.1:8790 with this folder's uv env (see README.md).
# The key comes from .env here (gitignored, see .env.example) or from the environment.
# Arguments are passed on, e.g. `./run.sh --fake-jev` or `./run.sh --port 8791`.
set -euo pipefail

cd "$(dirname "$0")"
PYTHON="${JEV_FINDER_PYTHON:-.venv/bin/python}"

if [[ ! -x "$PYTHON" ]]; then
  echo "No Python at $PYTHON. Run uv sync here first, or set JEV_FINDER_PYTHON." >&2
  exit 1
fi

exec "$PYTHON" -m jev_finder "$@"
