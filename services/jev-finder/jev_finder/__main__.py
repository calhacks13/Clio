"""Starts the finder: `python -m jev_finder [--port 8790] [--fake-jev]` (see README.md)."""

from __future__ import annotations

import argparse
import logging
import os
from time import perf_counter

import uvicorn
from dotenv import load_dotenv
from PIL import Image

from . import SERVICE_DIR
from .app import create_app
from .bench import valid_box
from .edgetam import KEEP_FRAMES
from .finder import Finder
from .jev import DEFAULT_ENDPOINT, DEFAULT_MODEL, DEFAULT_TIMEOUT_S, JevClient, fake_transport
from .websocket import WebSocketProtocol

HOST = "127.0.0.1"
DEFAULT_PORT = 8790

log = logging.getLogger("jev_finder")


def main() -> None:
    parser = argparse.ArgumentParser(prog="jev_finder", description=__doc__)
    parser.add_argument(
        "--port", type=int, default=int(os.environ.get("JEV_FINDER_PORT") or DEFAULT_PORT)
    )
    parser.add_argument("--device", default="auto", help="SAM device: auto, mps, cuda or cpu")
    parser.add_argument(
        "--segmenter",
        default="auto",
        choices=("auto", "edgetam", "sam2.1-small"),
        help="auto: EdgeTAM, or SAM 2.1 Small if EdgeTAM can't load",
    )
    parser.add_argument(
        "--track",
        default="memory",
        choices=("memory", "box"),
        help="how EdgeTAM follows the target on /track: its video memory, or the previous box",
    )
    parser.add_argument(
        "--jev-timeout",
        type=float,
        default=DEFAULT_TIMEOUT_S,
        help="seconds to wait for jev; Clio gives up on the finder after 15",
    )
    parser.add_argument(
        "--fake-jev",
        nargs="?",
        const="0.3,0.3,0.7,0.7",
        metavar="LEFT,TOP,RIGHT,BOTTOM",
        help="answer every object with this box instead of calling jev (no key, no cost)",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    # httpx logs every request line at INFO; jev's answers are logged by the finder instead.
    logging.getLogger("httpx").setLevel(logging.WARNING)

    # The key stays in this process and is never logged: it comes from the environment or from
    # .env next to run.sh (gitignored; see .env.example).
    load_dotenv(SERVICE_DIR / ".env")
    if args.fake_jev:
        box = [float(v) for v in args.fake_jev.split(",")]
        if not valid_box(box):
            parser.error("--fake-jev takes a box LEFT,TOP,RIGHT,BOTTOM in 0..1")
        jev = JevClient("fake", timeout_s=args.jev_timeout, transport=fake_transport(tuple(box)))
        jev_label = "fake-jev"
    else:
        model = os.environ.get("JEV_MODEL") or DEFAULT_MODEL
        jev = JevClient(
            os.environ.get("TYPESAFE_API_KEY", ""),
            model=model,
            endpoint=os.environ.get("JEV_ENDPOINT") or DEFAULT_ENDPOINT,
            timeout_s=args.jev_timeout,
        )
        jev_label = model

    from .segmenter import SharedSegmenter, load_segmenter  # imports torch, after the checks

    started = perf_counter()
    segmenter = SharedSegmenter(load_segmenter(args.segmenter, args.device, args.track))
    loaded = perf_counter()
    # The first passes on MPS compile their kernels; do them now rather than on the first frame:
    # locate requests (Quest frames reach it at 960x720) with one to three objects, each count
    # compiled separately (up to 0.8 s each), and a track at 640x480 until EdgeTAM's memory is
    # full, before and after a correction (each memory size compiles once, about 0.2 s).
    blank = Image.new("RGB", (960, 720), (128, 128, 128))
    encoded = segmenter.encode(blank)
    for count in (1, 2, 3):
        segmenter.masks(encoded, [[0.25, 0.25, 0.75, 0.75]] * count)
    session = segmenter.track_session()
    small = blank.resize((640, 480))
    box, point = [0.25, 0.25, 0.75, 0.75], [0.5, 0.5]
    session.start(small, box)
    for seed in (False, True):
        if seed:
            session.correct(small, box)
        for _ in range(KEEP_FRAMES + 2):
            session.follow(small, box, point)
    session.reset()
    log.info(
        "%s on %s: loaded in %.1f s, warmed up in %.1f s",
        segmenter.label,
        segmenter.device,
        loaded - started,
        perf_counter() - loaded,
    )

    finder = Finder(jev, segmenter, jev_label)
    log.info(
        "Model %s on http://%s:%d/locate and ws://%s:%d/track",
        finder.model,
        HOST,
        args.port,
        HOST,
        args.port,
    )
    try:
        # uvicorn's WebSocket support needs a package this service doesn't use; see websocket.py.
        uvicorn.run(
            create_app(finder, segmenter.device), host=HOST, port=args.port, ws=WebSocketProtocol
        )
    finally:
        finder.close()


if __name__ == "__main__":
    main()
