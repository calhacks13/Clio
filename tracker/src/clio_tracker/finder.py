"""One locate request without tracking state: fit the frame, ask jev once, outline its boxes.

This is the jev finder's /locate with YOLOE where SAM was. The primary-object demo's route asks
it about once a second; the headset forwards each answer's box to /track, which follows the
object between asks. The frame goes through YOLOE while jev answers, then each box jev found
becomes a visual prompt and the candidate that fills it is outlined.
"""

from __future__ import annotations

import base64
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from time import perf_counter

import numpy as np

from .identify import FrameImage, Identification, Identifier, Query
from .images import decode_frame
from .vision import Encoding, YoloeVision

log = logging.getLogger("clio_tracker")


class Busy(Exception):
    """An earlier request is still being answered. Waiting would only stack billed jev calls."""

    status = 503

    def __init__(self):
        super().__init__("The tracker is still answering an earlier locate request.")


@dataclass
class Timings:
    decode_ms: float = 0
    jev_ms: float = 0
    encode_ms: float = 0
    """Runs while jev answers, so it adds to the total only when it is slower than jev."""
    outline_ms: float = 0
    total_ms: float = 0

    def header(self) -> str:
        """A Server-Timing header value."""
        stages = ("decode", "jev", "encode", "outline", "total")
        return ", ".join(f"{name};dur={getattr(self, name + '_ms'):.1f}" for name in stages)


class Finder:
    def __init__(self, identifier: Identifier, vision: YoloeVision):
        self.identifier = identifier
        self.vision = vision
        self.encoder = ThreadPoolExecutor(max_workers=1, thread_name_prefix="encode")
        self.busy = threading.Lock()

    @property
    def model(self) -> str:
        return f"{self.identifier.name}+{self.vision.model}"

    def locate(self, mime_type: str, data: str, queries: list[Query]) -> tuple[dict, Timings]:
        """One request at a time: a second one is refused with `Busy` rather than queued."""
        if not self.busy.acquire(blocking=False):
            raise Busy()
        try:
            return self._locate(mime_type, data, queries)
        finally:
            self.busy.release()

    def _locate(self, mime_type: str, data: str, queries: list[Query]) -> tuple[dict, Timings]:
        timings = Timings()
        started = perf_counter()
        frame = decode_frame(mime_type, data)  # checks the image; 422 when it can't be used
        rgb = np.asarray(frame.image)
        # The identifier gets the frame as sent and fits it for jev itself; its boxes come back in
        # 0..1 of the fitted, unpadded frame, which is `rgb`.
        image = FrameImage(base64.b64decode(data), mime_type, rgb)
        timings.decode_ms = _ms(started)

        encoding = self.encoder.submit(self._encode, rgb)
        asked = perf_counter()
        try:
            answers = self.identifier.identify(image, queries)
        finally:
            timings.jev_ms = _ms(asked)
        enc, timings.encode_ms = encoding.result()

        outlining = perf_counter()
        detections = [self._detection(q, a, enc) for q, a in zip(queries, answers, strict=True)]
        timings.outline_ms = _ms(outlining)
        timings.total_ms = _ms(started)
        found = sum(d["found"] for d in detections)
        log.info(
            "locate: %d of %d found: decode %.0f ms, %s %.0f ms, encode %.0f ms, outline %.0f ms",
            found,
            len(detections),
            timings.decode_ms,
            self.identifier.name,
            timings.jev_ms,
            timings.encode_ms,
            timings.outline_ms,
        )
        return {"model": self.model, "detections": detections}, timings

    def _encode(self, rgb: np.ndarray) -> tuple[Encoding, float]:
        started = perf_counter()
        return self.vision.encode(rgb), _ms(started)

    def _detection(self, query: Query, answer: Identification, enc: Encoding) -> dict:
        """One detection in the object-finder contract. Confidence is jev's Noul probability."""
        present = round(answer.present, 3)
        if answer.box is None:
            return {"id": query.id, "found": False, "point": None, "box": None, "outline": None,
                    "confidence": present}  # fmt: skip
        lb = enc.letterbox
        size = np.array([lb.width, lb.height, lb.width, lb.height], dtype=np.float32)
        jev_box = np.asarray(answer.box, dtype=np.float32) * size
        outlined = self.vision.outline_in_box(enc, jev_box)
        if outlined is None or outlined[1].outline is None:
            # YOLOE has nothing that fills jev's box: keep the box, Clio draws corner brackets.
            log.info("%s: no YOLOE candidate fills jev's box; sending the box", query.id)
            return {"id": query.id, "found": True, "point": None,
                    "box": [round(float(v), 4) for v in answer.box], "outline": None,
                    "confidence": present}  # fmt: skip
        box, shape = outlined
        return {
            "id": query.id,
            "found": True,
            "point": shape.point,
            "box": [round(float(v), 4) for v in (box / size).clip(0, 1)],
            "outline": shape.outline,
            "confidence": present,
        }

    def close(self) -> None:
        self.encoder.shutdown(wait=True)


def _ms(since: float) -> float:
    return (perf_counter() - since) * 1000
