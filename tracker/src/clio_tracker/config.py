"""Settings from the environment, then tracker/.env, then the repo's .env (the first one wins)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from .jev import DEFAULT_ENDPOINT, DEFAULT_MODEL, DEFAULT_TIMEOUT_S
from .segment import SEGMENTER_CHOICES

TRACKER_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = TRACKER_DIR.parent
HOST = "127.0.0.1"  # never anything else: see server.py
# Short names for the YOLOE-26 text/visual-prompt segmentation checkpoints, smallest first.
MODELS = {size: f"yoloe-26{size}-seg" for size in "nsmlx"}


def model_name(name: str) -> str:
    """`s`, `yoloe-26s-seg` or `yoloe-26s-seg.pt`: the checkpoint's name, `yoloe-26s-seg`."""
    name = name.strip().removesuffix(".pt")
    return MODELS.get(name.lower(), name)


@dataclass(frozen=True)
class Settings:
    port: int
    model: str
    backend: str
    device: str
    segmenter: str
    jev_key: str | None
    jev_model: str
    jev_url: str
    jev_timeout_s: float
    identifier_url: str | None
    identifier_token: str | None
    identify_interval_ms: int
    identify_steady_ms: int
    identify_max_in_flight: int
    refresh_ms: int
    jev_dump: str | None


class ConfigError(Exception):
    pass


def load_settings(env: dict[str, str] | None = None) -> Settings:
    if env is None:
        env = {
            **read_dotenv(REPO_ROOT / ".env"),
            **read_dotenv(TRACKER_DIR / ".env"),
            **os.environ,
        }

    def text(key: str) -> str | None:
        return env.get(key, "").strip() or None

    def text_or(key: str, default: str) -> str:
        return text(key) or default

    def number(key: str, default: float, lo: float, hi: float) -> float:
        raw = text(key)
        if raw is None:
            return default
        try:
            value = float(raw)
        except ValueError:
            raise ConfigError(f"{key}={raw!r} is not a number") from None
        if not lo <= value <= hi:
            raise ConfigError(f"{key}={raw} is outside {lo:g}..{hi:g}")
        return value

    def whole(key: str, default: int, lo: int, hi: int) -> int:
        value = number(key, default, lo, hi)
        if value != int(value):
            raise ConfigError(f"{key}={value} is not a whole number")
        return int(value)

    backend = text_or("CLIO_TRACKER_BACKEND", "auto")
    if backend not in ("auto", "coreml", "torch"):
        raise ConfigError(f"CLIO_TRACKER_BACKEND={backend!r}: expected auto, coreml or torch")
    segmenter = text_or("CLIO_TRACKER_SEGMENTER", "auto")
    if segmenter not in SEGMENTER_CHOICES:
        expected = f"{', '.join(SEGMENTER_CHOICES[:-1])} or {SEGMENTER_CHOICES[-1]}"
        raise ConfigError(f"CLIO_TRACKER_SEGMENTER={segmenter!r}: expected {expected}")
    identifier_url = text("CLIO_TRACKER_IDENTIFIER_URL")
    if identifier_url and not identifier_url.startswith(("http://", "https://")):
        raise ConfigError(f"CLIO_TRACKER_IDENTIFIER_URL={identifier_url!r} is not an http(s) URL")
    return Settings(
        port=whole("CLIO_TRACKER_PORT", 8790, 1, 65535),
        model=model_name(text_or("CLIO_TRACKER_MODEL", "l")),
        backend=backend,
        device=text_or("CLIO_TRACKER_DEVICE", "auto"),
        segmenter=segmenter,
        jev_key=text("TYPESAFE_API_KEY"),
        jev_model=text_or("JEV_MODEL", DEFAULT_MODEL),
        jev_url=text_or("JEV_ENDPOINT", DEFAULT_ENDPOINT),
        jev_timeout_s=number("CLIO_TRACKER_JEV_TIMEOUT_S", DEFAULT_TIMEOUT_S, 1, 60),
        identifier_url=identifier_url,
        identifier_token=text("CLIO_TRACKER_IDENTIFIER_TOKEN"),
        identify_interval_ms=whole("CLIO_TRACKER_IDENTIFY_INTERVAL_MS", 150, 100, 600_000),
        identify_steady_ms=whole("CLIO_TRACKER_IDENTIFY_STEADY_MS", 1000, 100, 600_000),
        identify_max_in_flight=whole("CLIO_TRACKER_IDENTIFY_MAX_IN_FLIGHT", 1, 1, 8),
        refresh_ms=whole("CLIO_TRACKER_REFRESH_MS", 50, 0, 10_000),
        jev_dump=text("CLIO_TRACKER_JEV_DUMP"),
    )


def read_dotenv(path: Path) -> dict[str, str]:
    """KEY=VALUE lines; blank values, comments and malformed lines are skipped."""
    if not path.is_file():
        return {}
    out: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip().strip("'\"")
        if key.strip() and value:
            out[key.strip()] = value
    return out
