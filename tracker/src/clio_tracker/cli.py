"""`clio-tracker`: serve the tracker, export its Core ML graph, or time it."""

from __future__ import annotations

import argparse
import logging
import sys
import time
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor

from . import __version__
from .config import ConfigError, Settings, load_settings


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="clio-tracker", description=__doc__)
    parser.add_argument("--version", action="version", version=f"clio-tracker {__version__}")
    sub = parser.add_subparsers(dest="command", metavar="COMMAND")
    p = sub.add_parser("serve", help="answer Clio's object finder requests (the default)")
    p.set_defaults(run=_serve)
    p = sub.add_parser("export", help="export the Core ML vision graph now, not on first serve")
    p.set_defaults(run=_export)
    p = sub.add_parser("bench", help="time the vision graph and the per-object work")
    p.add_argument("--frames", type=int, default=50)
    p.set_defaults(run=_bench)
    for p in sub.choices.values():
        p.add_argument("--model", help="YOLOE-26 seg checkpoint, e.g. yoloe-26s-seg")
        p.add_argument("--backend", choices=["auto", "coreml", "torch"])
        p.add_argument("--device", help="torch device: auto, mps, cuda or cpu")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    try:
        settings = load_settings()
    except ConfigError as e:
        print(f"clio-tracker: {e}", file=sys.stderr)
        return 1
    overrides = {k: getattr(args, k, None) for k in ("model", "backend", "device")}
    settings = Settings(**{**settings.__dict__, **{k: v for k, v in overrides.items() if v}})
    return getattr(args, "run", _serve)(settings, args)


def _vision(settings: Settings):
    from .vision import load_vision

    return load_vision(settings.model, settings.backend, settings.device)


def _identifier(settings: Settings):
    from .identify import HttpIdentifier, JevIdentifier

    if settings.identifier_url:
        return HttpIdentifier(settings.identifier_url, settings.identifier_token)
    if settings.jev_key:
        return JevIdentifier(settings.jev_key, settings.jev_model, settings.jev_url)
    return None


def _serve(settings: Settings, _args: argparse.Namespace) -> int:
    import uvicorn

    from .server import create_app
    from .session import Sessions, SessionSettings, TrackerSession

    identifier = _identifier(settings)
    if identifier is None:
        print(
            "clio-tracker: nothing can name the target. Set TYPESAFE_API_KEY (jev) in .env, or "
            "CLIO_TRACKER_IDENTIFIER_URL to an object finder such as Clio's "
            "http://127.0.0.1:8787/api/vision/locate (Gemini; only while Clio's CLIO_VISION_URL "
            "does not point back here).",
            file=sys.stderr,
        )
        return 1
    vision = _vision(settings)
    session_settings = SessionSettings(
        identify_interval_s=settings.identify_interval_ms / 1000,
        identify_max_in_flight=settings.identify_max_in_flight,
    )
    executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="identify")
    sessions = Sessions(lambda: TrackerSession(vision, identifier, executor, session_settings))

    def health() -> dict:
        return {
            "model": vision.model,
            "backend": vision.backend,
            "identifier": identifier.name,
            "identifyIntervalMs": settings.identify_interval_ms,
        }

    app = create_app(sessions, vision.model, settings.refresh_ms, health)
    log = logging.getLogger("clio_tracker")
    log.info(
        "\n".join(
            [
                f"Clio tracker {__version__}",
                f"  http://{settings.host}:{settings.port}/locate",
                f"  Vision: {vision.model} on {vision.backend}",
                f"  Names the target: {identifier.name}, every "
                f"{settings.identify_interval_ms} ms per object, at most "
                f"{settings.identify_max_in_flight} in flight",
            ]
        )
    )
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="warning")
    return 0


def _export(settings: Settings, _args: argparse.Namespace) -> int:
    from .coreml import CoreMLGraph, coreml_available
    from .vision import default_models_dir, load_yoloe

    if not coreml_available():
        print(
            "clio-tracker: Core ML needs an Apple silicon Mac and the coreml extra", file=sys.stderr
        )
        return 1
    models = default_models_dir()
    models.mkdir(parents=True, exist_ok=True)
    graph = CoreMLGraph.load_or_export(
        load_yoloe(models / f"{settings.model}.pt"), models / settings.model
    )
    print(f"{graph.path}")
    return 0


def _bench(settings: Settings, args: argparse.Namespace) -> int:
    from pathlib import Path

    import cv2
    import numpy as np
    import ultralytics

    from .tracking import ObjectTracker

    vision = _vision(settings)
    bgr = cv2.imread(str(Path(ultralytics.__file__).parent / "assets" / "bus.jpg"))
    rgb = np.ascontiguousarray(cv2.resize(bgr, (960, 720))[..., ::-1])
    box = np.array([60, 300, 400, 690], dtype=np.float32)
    enc = vision.encode(rgb)
    tracker = ObjectTracker("bus", "bus")
    tracker.anchor = vision.prompts(enc, box)[0]
    for i in range(5):
        vision.encode(rgb)
        tracker.step(enc, i, i / 30, vision)
    encode, step = [], []
    for i in range(args.frames):
        t0 = time.perf_counter()
        enc = vision.encode(rgb)
        t1 = time.perf_counter()
        tracker.step(enc, 10 + i, (10 + i) / 30, vision)
        t2 = time.perf_counter()
        encode.append((t1 - t0) * 1000)
        step.append((t2 - t1) * 1000)
    print(f"{vision.model} on {vision.backend}, 960x720 frames:")
    print(f"  encode p50 {np.median(encode):.1f} ms, p95 {np.percentile(encode, 95):.1f} ms")
    print(f"  track one object p50 {np.median(step):.1f} ms, p95 {np.percentile(step, 95):.1f} ms")
    return 0
