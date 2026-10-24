"""Settings from the environment, and from the repo's .env (the real environment wins)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from .identify import JEV_MODEL, JEV_URL

REPO_ROOT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    model: str
    backend: str
    device: str
    jev_key: str | None
    jev_model: str
    jev_url: str
    identifier_url: str | None
    identifier_token: str | None
    identify_interval_ms: int
    identify_max_in_flight: int
    refresh_ms: int


class ConfigError(Exception):
    pass


def load_settings(env: dict[str, str] | None = None) -> Settings:
    if env is None:
        env = {**read_dotenv(REPO_ROOT / ".env"), **os.environ}

    def text(key: str) -> str | None:
        return env.get(key, "").strip() or None

    def text_or(key: str, default: str) -> str:
        return text(key) or default

    def number(key: str, default: int, lo: int, hi: int) -> int:
        raw = text(key)
        if raw is None:
            return default
        try:
            value = int(raw)
        except ValueError:
            raise ConfigError(f"{key}={raw!r} is not a whole number") from None
        if not lo <= value <= hi:
            raise ConfigError(f"{key}={value} is outside {lo}..{hi}")
        return value

    backend = text_or("CLIO_TRACKER_BACKEND", "auto")
    if backend not in ("auto", "coreml", "torch"):
        raise ConfigError(f"CLIO_TRACKER_BACKEND={backend!r}: expected auto, coreml or torch")
    identifier_url = text("CLIO_TRACKER_IDENTIFIER_URL")
    if identifier_url and not identifier_url.startswith(("http://", "https://")):
        raise ConfigError(f"CLIO_TRACKER_IDENTIFIER_URL={identifier_url!r} is not an http(s) URL")
    return Settings(
        host=text_or("CLIO_TRACKER_HOST", "127.0.0.1"),
        port=number("CLIO_TRACKER_PORT", 8790, 1, 65535),
        model=text_or("CLIO_TRACKER_MODEL", "yoloe-26l-seg").removesuffix(".pt"),
        backend=backend,
        device=text_or("CLIO_TRACKER_DEVICE", "auto"),
        jev_key=text("TYPESAFE_API_KEY"),
        jev_model=text_or("CLIO_TRACKER_JEV_MODEL", JEV_MODEL),
        jev_url=text_or("CLIO_TRACKER_JEV_URL", JEV_URL),
        identifier_url=identifier_url,
        identifier_token=text("CLIO_TRACKER_IDENTIFIER_TOKEN"),
        identify_interval_ms=number("CLIO_TRACKER_IDENTIFY_INTERVAL_MS", 1000, 100, 600_000),
        identify_max_in_flight=number("CLIO_TRACKER_IDENTIFY_MAX_IN_FLIGHT", 2, 1, 8),
        refresh_ms=number("CLIO_TRACKER_REFRESH_MS", 50, 0, 10_000),
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
