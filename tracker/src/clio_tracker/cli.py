"""`clio-tracker`: serve the tracker, export its Core ML graph, or time it."""

from __future__ import annotations

import argparse
import logging
import sys
import time
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import __version__
from .bench import valid_box
from .config import HOST, MODELS, ConfigError, Settings, load_settings, model_name
from .segment import SEGMENTER_CHOICES


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="clio-tracker", description=__doc__)
    parser.add_argument("--version", action="version", version=f"clio-tracker {__version__}")
    sub = parser.add_subparsers(dest="command", metavar="COMMAND")
    serve = sub.add_parser("serve", help="answer /locate and /track (the default)")
    serve.set_defaults(run=_serve)
    p = sub.add_parser("export", help="export Core ML vision graphs now, not on first serve")
    p.add_argument(
        "models", nargs="*", metavar="MODEL", help="s, m, l, ... (default: the configured one)"
    )
    p.set_defaults(run=_export)
    p = sub.add_parser("bench", help="time the vision graph and the per-object work")
    p.add_argument("--frames", type=int, default=50)
    p.set_defaults(run=_bench)
    p = sub.add_parser("jitter", help="measure how steady /track's answers are (jitter.py)")
    p.add_argument("--seconds", type=float, default=12.0, help="length of each sequence")
    p.add_argument("--scene", action="append", help="only this scene (repeatable)")
    p.add_argument("--baseline", type=Path, help="another clio_tracker package to compare")
    p.add_argument("--json", type=Path, help="write every number here")
    p.add_argument(
        "--no-part-flag",
        dest="flag_parts",
        action="store_false",
        help="part scenes leave out the target's part flag (it is told apart by itself)",
    )
    p.add_argument(
        "--set",
        action="append",
        metavar="NAME=VALUE",
        help="try a TrackerParams setting (smooth.NAME for SmoothParams)",
    )
    p.add_argument(
        "--pace",
        action="store_true",
        help="play each frame for at least 1/25 s, as the headset's stream does (use with "
        "--segmenter: the refresher spaces its calls by wall clock)",
    )
    p.set_defaults(run=_jitter)
    for p in (parser, *sub.choices.values()):
        p.add_argument(
            "--model",
            type=model_name,
            help=f"YOLOE-26 size or checkpoint: {', '.join(MODELS)} (default l), or yoloe-26s-seg",
        )
        p.add_argument("--backend", choices=["auto", "coreml", "torch"])
        p.add_argument("--device", help="torch device: auto, mps, cuda or cpu")
        p.add_argument(
            "--segmenter",
            choices=SEGMENTER_CHOICES,
            help="what cuts the outline: SAM 2.1 small or large, or none for YOLOE's own mask"
            " (default auto)",
        )
    for p in (parser, serve):
        p.add_argument("--port", type=int, help="8790 by default, which Clio's server expects")
        p.add_argument(
            "--fake-jev",
            nargs="?",
            const="0.3,0.3,0.7,0.7",
            metavar="LEFT,TOP,RIGHT,BOTTOM",
            help="answer every object with this box instead of calling jev (no key, no cost)",
        )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    try:
        settings = load_settings()
    except ConfigError as e:
        print(f"clio-tracker: {e}", file=sys.stderr)
        return 1
    overrides = {
        k: getattr(args, k, None) for k in ("model", "backend", "device", "segmenter", "port")
    }
    settings = Settings(**{**settings.__dict__, **{k: v for k, v in overrides.items() if v}})
    return getattr(args, "run", _serve)(settings, args)


def _vision(settings: Settings):
    from .vision import load_vision

    return load_vision(settings.model, settings.backend, settings.device)


def _identifier(settings: Settings, fake_box: str | None):
    """jev (or a fake one), else any finder at CLIO_TRACKER_IDENTIFIER_URL; None when neither."""
    from .identify import HttpIdentifier, JevIdentifier
    from .jev import JevClient, fake_transport

    if fake_box:
        box = [float(v) for v in fake_box.split(",")]
        if not valid_box(box):
            raise ConfigError("--fake-jev takes a box LEFT,TOP,RIGHT,BOTTOM in 0..1")
        client = JevClient("fake", transport=fake_transport(tuple(box)))
        return JevIdentifier(client, "fake-jev")
    if settings.jev_key:
        client = JevClient(
            settings.jev_key, settings.jev_model, settings.jev_url, settings.jev_timeout_s
        )
        return JevIdentifier(client)
    if settings.identifier_url:
        return HttpIdentifier(settings.identifier_url, settings.identifier_token)
    return None


def _serve(settings: Settings, args: argparse.Namespace) -> int:
    import uvicorn

    from .finder import Finder
    from .refresh import Refresher
    from .server import create_app
    from .session import Sessions, SessionSettings, TrackerSession
    from .track import StreamTracker

    try:
        identifier = _identifier(settings, getattr(args, "fake_jev", None))
    except ConfigError as e:
        print(f"clio-tracker: {e}", file=sys.stderr)
        return 1
    if identifier is None:
        print(
            "clio-tracker: nothing can name the target. Set TYPESAFE_API_KEY (jev) in .env, run "
            "with --fake-jev, or set CLIO_TRACKER_IDENTIFIER_URL to an object finder such as "
            "Clio's http://127.0.0.1:8787/api/vision/locate (Gemini; only while Clio's "
            "CLIO_VISION_URL does not point back here).",
            file=sys.stderr,
        )
        return 1
    log = logging.getLogger("clio_tracker")
    started = time.perf_counter()
    vision = _vision(settings)
    loaded = time.perf_counter()
    _warm_up(vision)
    log.info(
        "%s on %s: loaded in %.1f s, warmed up in %.1f s",
        vision.model,
        vision.backend,
        loaded - started,
        time.perf_counter() - loaded,
    )
    segmenter = _segmenter(settings)
    session_settings = SessionSettings(
        identify_interval_s=settings.identify_interval_ms / 1000,
        identify_max_in_flight=settings.identify_max_in_flight,
    )
    executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="identify")
    # One segmenter for the service, called one at a time (each stream's and session's
    # Refresher keeps one call of its own in flight at most).
    segmenting = ThreadPoolExecutor(max_workers=1, thread_name_prefix="segment")

    def refresher() -> Refresher | None:
        return None if segmenter is None else Refresher(segmenter, segmenting)

    def session() -> TrackerSession:
        return TrackerSession(
            vision,
            identifier,
            executor,
            session_settings,
            segmenter=segmenter,
            refresher=refresher(),
        )

    def stream() -> StreamTracker:
        return StreamTracker(vision, segmenter=segmenter, refresher=refresher())

    sessions = Sessions(session)
    finder = Finder(identifier, vision, segmenter)
    app = create_app(
        sessions, finder, stream, settings.refresh_ms, lambda: _health(finder, vision, segmenter)
    )
    outline = (
        "YOLOE's mask (no segmenter)"
        if segmenter is None
        else f"{segmenter.name}'s mask, carried to every frame by the object's own pixels"
    )
    log.info(
        "\n".join(
            [
                f"Clio tracker {__version__}: {finder.model}",
                f"  http://{HOST}:{settings.port}/locate and ws://{HOST}:{settings.port}/track",
                f"  Vision: {vision.model} on {vision.backend}",
                f"  Outline: {outline}",
                f"  Names the target: {identifier.name}; with a session or in objects mode, "
                f"every {settings.identify_interval_ms} ms per object",
            ]
        )
    )
    try:
        uvicorn.run(app, host=HOST, port=settings.port, log_level="warning")
    finally:
        finder.close()
        executor.shutdown(wait=False, cancel_futures=True)
        segmenting.shutdown(wait=False, cancel_futures=True)
        getattr(identifier, "close", lambda: None)()
    return 0


def _health(finder, vision, segmenter) -> dict:
    """What /health adds to its own fields: the models answering, and the segmenter (or null)."""
    return {
        "model": finder.model,
        "backend": vision.backend,
        "segmenter": segmenter.name if segmenter is not None else None,
    }


def _segmenter(settings: Settings):
    """The configured segmenter, loaded and warmed up with one encode, or None."""
    import numpy as np

    from .segment import load_segmenter

    log = logging.getLogger("clio_tracker")
    started = time.perf_counter()
    segmenter = load_segmenter(settings.segmenter, settings.device)
    if segmenter is None:
        return None
    loaded = time.perf_counter()
    segmenter.encode(np.full((480, 640, 3), 128, dtype=np.uint8))
    log.info(
        "%s on %s: loaded in %.1f s, warmed up in %.1f s",
        segmenter.name,
        getattr(segmenter, "device", "its device"),
        loaded - started,
        time.perf_counter() - loaded,
    )
    return segmenter


def _warm_up(vision) -> None:
    """The first passes compile (Core ML) or pick kernels (MPS): do them before the first frame."""
    import numpy as np

    for size in ((720, 960), (480, 640)):
        frame = np.full((*size, 3), 128, dtype=np.uint8)
        enc = vision.encode(frame)
        box = np.array([size[1] * 0.25, size[0] * 0.25, size[1] * 0.75, size[0] * 0.75])
        vision.outline_in_box(enc, box)


def _export(settings: Settings, args: argparse.Namespace) -> int:
    from .coreml import CoreMLGraph, coreml_available
    from .vision import default_models_dir, load_yoloe

    if not coreml_available():
        print(
            "clio-tracker: Core ML needs an Apple silicon Mac and the coreml extra", file=sys.stderr
        )
        return 1
    models = default_models_dir()
    models.mkdir(parents=True, exist_ok=True)
    for name in [model_name(m) for m in args.models] or [settings.model]:
        graph = CoreMLGraph.load_or_export(load_yoloe(models / f"{name}.pt"), models / name)
        print(f"{graph.path}")
    return 0


def _bench(settings: Settings, args: argparse.Namespace) -> int:

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


def _jitter(settings: Settings, args: argparse.Namespace) -> int:
    from .jitter import run

    return run(
        settings.model,
        settings.backend,
        args.seconds,
        args.baseline,
        args.scene,
        args.json,
        args.set,
        args.flag_parts,
        segmenter=settings.segmenter,
        pace=args.pace,
    )
