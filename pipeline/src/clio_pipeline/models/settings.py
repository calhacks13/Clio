"""Where the model backends' settings come from: the environment (docs/room-scene.md), and for
tests the HTTP layer gemini-cad talks through and how it waits between retries."""

from __future__ import annotations

import os
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field

# (url, headers, body, timeout s) -> (HTTP status, response headers, response body)
Transport = Callable[[str, dict[str, str], bytes, float], tuple[int, dict[str, str], bytes]]

DEFAULT_CAD_MODEL = "gemini-pro-latest"
DEFAULT_COMMAND_TIMEOUT_S = 900.0


@dataclass(frozen=True)
class ModelSettings:
    env: Mapping[str, str] = field(default_factory=lambda: dict(os.environ))
    transport: Transport | None = None  # gemini-cad's HTTP layer; None: urllib
    sleep: Callable[[float], None] = time.sleep  # between gemini-cad retries
    gemini_timeout_s: float = 120.0
    gemini_retries: int = 2  # after the first try, on HTTP 429 and 5xx

    @property
    def cad_model(self) -> str:
        name = (self.env.get("CLIO_CAD_MODEL") or "").strip() or DEFAULT_CAD_MODEL
        return name.removeprefix("models/")

    @property
    def gemini_key(self) -> str | None:
        return (
            self.env.get("GEMINI_API_KEY") or self.env.get("GOOGLE_API_KEY") or ""
        ).strip() or None

    @property
    def model_command(self) -> str | None:
        return (self.env.get("CLIO_MODEL_COMMAND") or "").strip() or None

    @property
    def command_timeout_s(self) -> float:
        """CLIO_MODEL_COMMAND_TIMEOUT seconds, else DEFAULT_COMMAND_TIMEOUT_S."""
        try:
            value = float(self.env.get("CLIO_MODEL_COMMAND_TIMEOUT") or DEFAULT_COMMAND_TIMEOUT_S)
        except ValueError:
            return DEFAULT_COMMAND_TIMEOUT_S
        return value if value > 0 else DEFAULT_COMMAND_TIMEOUT_S
