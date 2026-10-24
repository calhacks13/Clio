"""A locate request end to end: fit the frame, ask jev once, refine its boxes with SAM, outline."""

from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from time import perf_counter
from typing import Protocol

import numpy as np
from PIL import Image

from .bench import valid_box
from .images import decode_frame
from .jev import Answer, JevClient, Target
from .outline import mask_shape

log = logging.getLogger("jev_finder")


class MaskSegmenter(Protocol):
    label: str
    device: str

    def encode(self, image: Image.Image) -> object: ...

    def masks(self, encoded: object, boxes: list[list[float]]) -> list[np.ndarray]: ...


class Busy(Exception):
    """An earlier request is still being answered. Waiting would only stack billed jev calls."""

    status = 503

    def __init__(self):
        super().__init__("The jev finder is still answering an earlier request.")


@dataclass
class Timings:
    decode_ms: float = 0
    jev_ms: float = 0
    encode_ms: float = 0
    """Runs while jev answers, so it adds to the total only when it is slower than jev."""
    segment_ms: float = 0
    outline_ms: float = 0
    total_ms: float = 0

    def header(self) -> str:
        """A Server-Timing header value."""
        stages = ("decode", "jev", "encode", "segment", "outline", "total")
        return ", ".join(f"{name};dur={getattr(self, name + '_ms'):.1f}" for name in stages)


class Finder:
    def __init__(self, jev: JevClient, segmenter: MaskSegmenter, jev_label: str):
        self.jev = jev
        self.segmenter = segmenter
        self.model = f"{jev_label}+{segmenter.label}"
        # SAM runs on one thread: requests never share the model, and each frame is encoded
        # while jev is still answering.
        self.sam = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sam")
        self.busy = threading.Lock()

    def locate(self, mime_type: str, data: str, targets: list[Target]) -> tuple[dict, Timings]:
        """One request at a time: a second one is refused with `Busy` rather than queued."""
        if not self.busy.acquire(blocking=False):
            raise Busy()
        try:
            return self._locate(mime_type, data, targets)
        finally:
            self.busy.release()

    def _locate(self, mime_type: str, data: str, targets: list[Target]) -> tuple[dict, Timings]:
        timings = Timings()
        started = perf_counter()
        frame = decode_frame(mime_type, data)
        timings.decode_ms = _ms(started)

        encoding = self.sam.submit(self._encode, frame.image)
        asked = perf_counter()
        try:
            reply = self.jev.ask(frame.jpeg, targets)
        finally:
            timings.jev_ms = _ms(asked)
        boxes = [
            frame.from_jev(answer.box) if answer.present and answer.box else None
            for answer in reply.answers
        ]
        boxes = [box if box and valid_box(box) else None for box in boxes]
        found = [box for box in boxes if box]

        encoded, timings.encode_ms = encoding.result()
        masks: list[np.ndarray] = []
        if found:
            segmenting = perf_counter()
            masks = self.sam.submit(self.segmenter.masks, encoded, found).result()
            timings.segment_ms = _ms(segmenting)

        outlining = perf_counter()
        detections = []
        mask_iter = iter(masks)
        for target, answer, box in zip(targets, reply.answers, boxes, strict=True):
            detections.append(detection(target, answer, box, next(mask_iter) if box else None))
        timings.outline_ms = _ms(outlining)
        timings.total_ms = _ms(started)
        self._log(targets, reply, detections, timings)
        return {"model": self.model, "detections": detections}, timings

    def _encode(self, image: Image.Image) -> tuple[object, float]:
        started = perf_counter()
        return self.segmenter.encode(image), _ms(started)

    def _log(self, targets: list[Target], reply, detections: list[dict], t: Timings) -> None:
        for target, answer in zip(targets, reply.answers, strict=True):
            if answer.problem:
                log.warning("%s: %s", target.id, answer.problem)
        found = sum(d["found"] for d in detections)
        tokens = f"{reply.usage.get('input_tokens', '?')}/{reply.usage.get('output_tokens', '?')}"
        log.info(
            "%d of %d found: decode %.0f ms, jev %.0f ms, encode %.0f ms, segment %.0f ms, "
            "outline %.0f ms, total %.0f ms; jev tokens in/out %s",
            found,
            len(detections),
            t.decode_ms,
            t.jev_ms,
            t.encode_ms,
            t.segment_ms,
            t.outline_ms,
            t.total_ms,
            tokens,
        )

    def close(self) -> None:
        self.sam.shutdown(wait=True)
        self.jev.close()


def detection(
    target: Target, answer: Answer, box: list[float] | None, mask: np.ndarray | None
) -> dict:
    """One detection in the object-finder contract. Confidence is jev's Noul probability."""
    if box is None:
        return {
            "id": target.id,
            "found": False,
            "point": None,
            "box": None,
            "outline": None,
            "confidence": answer.presence,
        }
    shape = mask_shape(mask) if mask is not None else None
    if shape is None:
        # SAM found nothing inside jev's box: keep the box, Clio draws corner brackets.
        log.warning("%s: SAM returned an empty mask; sending jev's box", target.id)
        return {
            "id": target.id,
            "found": True,
            "point": None,
            "box": [round(v, 4) for v in box],
            "outline": None,
            "confidence": answer.presence,
        }
    return {
        "id": target.id,
        "found": True,
        "point": shape.point,
        "box": shape.box,
        "outline": shape.outline,
        "confidence": answer.presence,
    }


def _ms(since: float) -> float:
    return (perf_counter() - since) * 1000
