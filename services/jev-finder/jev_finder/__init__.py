"""Clio object finder: jev boxes refined by SAM 2.1 into outlines (docs/object-finder.md).

The models live in `models/` next to this package (gitignored), where
`python -m jev_finder.setup_models` puts them; `JEV_FINDER_MODELS` points somewhere else.
"""

from __future__ import annotations

import os
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent
MODELS_DIR = Path(os.environ.get("JEV_FINDER_MODELS") or SERVICE_DIR / "models")
