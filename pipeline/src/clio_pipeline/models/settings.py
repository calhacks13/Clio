"""Where the model backends' settings come from: the environment (docs/room-scene.md)."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_COMMAND_TIMEOUT_S = 900.0
DEFAULT_TRIPOSR_RESOLUTION = 128
DEFAULT_TRIPOSR_TIMEOUT_S = 300.0
# pipeline/tools/triposr, beside this package's project
DEFAULT_TRIPOSR_DIR = Path(__file__).resolve().parents[3] / "tools" / "triposr"


@dataclass(frozen=True)
class ModelSettings:
    env: Mapping[str, str] = field(default_factory=lambda: dict(os.environ))

    @property
    def model_command(self) -> str | None:
        return (self.env.get("CLIO_MODEL_COMMAND") or "").strip() or None

    @property
    def command_timeout_s(self) -> float:
        """CLIO_MODEL_COMMAND_TIMEOUT seconds, else DEFAULT_COMMAND_TIMEOUT_S."""
        return self._positive("CLIO_MODEL_COMMAND_TIMEOUT", DEFAULT_COMMAND_TIMEOUT_S)

    @property
    def triposr_dir(self) -> Path:
        value = (self.env.get("CLIO_TRIPOSR_DIR") or "").strip()
        return Path(value).expanduser() if value else DEFAULT_TRIPOSR_DIR

    @property
    def triposr_resolution(self) -> int:
        """CLIO_TRIPOSR_RESOLUTION, the marching cubes grid, between 32 and 512 (default 128)."""
        value = self._positive("CLIO_TRIPOSR_RESOLUTION", DEFAULT_TRIPOSR_RESOLUTION)
        return int(min(max(round(value), 32), 512))

    @property
    def triposr_device(self) -> str:
        return (self.env.get("CLIO_TRIPOSR_DEVICE") or "").strip() or "auto"

    @property
    def triposr_timeout_s(self) -> float:
        """CLIO_TRIPOSR_TIMEOUT seconds an object, else DEFAULT_TRIPOSR_TIMEOUT_S."""
        return self._positive("CLIO_TRIPOSR_TIMEOUT", DEFAULT_TRIPOSR_TIMEOUT_S)

    def _positive(self, name: str, default: float) -> float:
        try:
            value = float(self.env.get(name) or default)
        except ValueError:
            return default
        return value if value > 0 else default
