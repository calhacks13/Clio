"""The segmenter /locate and /track share: EdgeTAM when it loads, else SAM 2.1 Small.

SAM 2.1 Small is Hugging Face's `facebook/sam2.1-hiera-small` in transformers format, which
`python -m jev_finder.setup_models` puts under `models/`. The frame is encoded once per request,
and all of its boxes are decoded in one call with the Jev fun benchmark's mask choice: of SAM's
three candidates, the one with the highest predicted IoU.
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from typing import Any, Protocol

import numpy as np
from PIL import Image

from . import MODELS_DIR
from .bench import choose_device
from .tracker import BoxChain, TrackSession

LABEL = "sam2.1-small"
SAM_ID = "facebook/sam2.1-hiera-small"
SAM_DIR = MODELS_DIR / "sam2.1-hiera-small"
CHOICES = ("auto", "edgetam", LABEL)

log = logging.getLogger("jev_finder")


class FrameSegmenter(Protocol):
    label: str
    device: str

    def encode(self, image: Image.Image) -> object: ...

    def masks(self, encoded: object, boxes: list[list[float]]) -> list[np.ndarray]: ...

    def segment(
        self, image: Image.Image, box: list[float], point: list[float] | None = None
    ) -> tuple[np.ndarray, float]: ...

    def track_session(self) -> TrackSession: ...


def load_segmenter(
    choice: str = "auto", device: str = "auto", track: str = "memory"
) -> FrameSegmenter:
    """EdgeTAM for `edgetam`, SAM 2.1 Small for `sam2.1-small`; `auto` tries EdgeTAM first and
    falls back to SAM 2.1 Small if it can't load. EdgeTAM tracks with its video memory, or
    with `track="box"` the way SAM 2.1 Small does (`BoxChain`)."""
    if choice not in CHOICES:
        raise ValueError(f"Choose a segmenter from {', '.join(CHOICES)}.")
    if choice != LABEL:
        from .edgetam import EdgeTam

        try:
            return EdgeTam(device, track)
        except Exception as e:
            if choice == "edgetam":
                raise
            log.warning("EdgeTAM did not load (%s); using SAM 2.1 Small", e)
    return Segmenter(device)


class SharedSegmenter:
    """One segmenter for /locate and /track: the GPU runs one model call at a time, so a tracking
    frame waits for a locate request's encode and the other way around. Each call stands alone
    (a frame's encoding travels with its `Encoded`), so calls from both may interleave."""

    def __init__(self, segmenter: FrameSegmenter):
        self.segmenter = segmenter
        self.label = segmenter.label
        self.device = segmenter.device
        self.lock = threading.Lock()

    def encode(self, image: Image.Image) -> object:
        with self.lock:
            return self.segmenter.encode(image)

    def masks(self, encoded: object, boxes: list[list[float]]) -> list[np.ndarray]:
        with self.lock:
            return self.segmenter.masks(encoded, boxes)

    def segment(
        self, image: Image.Image, box: list[float], point: list[float] | None = None
    ) -> tuple[np.ndarray, float]:
        with self.lock:
            return self.segmenter.segment(image, box, point)

    def track_session(self) -> TrackSession:
        return LockedSession(self.segmenter.track_session(), self.lock)


class LockedSession:
    """A track session whose calls take the shared segmenter's lock."""

    def __init__(self, session: TrackSession, lock: threading.Lock):
        self.session = session
        self.lock = lock

    def start(self, image: Image.Image, box: list[float]) -> tuple[np.ndarray, float]:
        with self.lock:
            return self.session.start(image, box)

    def correct(self, image: Image.Image, box: list[float]) -> tuple[np.ndarray, float]:
        with self.lock:
            return self.session.correct(image, box)

    def follow(
        self, image: Image.Image, box: list[float], point: list[float]
    ) -> tuple[np.ndarray, float]:
        with self.lock:
            return self.session.follow(image, box, point)

    def reset(self) -> None:
        # Only drops what the session keeps, and a stream never resets while it segments: no
        # lock, so a `clear` doesn't hold up the stream's event loop behind a locate request.
        self.session.reset()


@dataclass
class Encoded:
    embeddings: Any
    size: tuple[int, int]
    """(height, width) of the encoded frame."""


class Segmenter:
    def __init__(self, device: str = "auto"):
        if not (SAM_DIR / "model.safetensors").exists():
            raise FileNotFoundError(
                f"No {SAM_ID} at {SAM_DIR}. Run python -m jev_finder.setup_models."
            )
        os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        import torch
        from transformers import Sam2Model, Sam2Processor

        self.torch = torch
        self.device = choose_device(torch, device)
        self.model = Sam2Model.from_pretrained(SAM_DIR, local_files_only=True).eval()
        self.model.to(self.device)
        self.processor = Sam2Processor.from_pretrained(SAM_DIR, local_files_only=True)
        self.label = LABEL

    def sync(self) -> None:
        if self.device == "mps":
            self.torch.mps.synchronize()
        elif self.device.startswith("cuda"):
            self.torch.cuda.synchronize()

    def encode(self, image: Image.Image) -> Encoded:
        inputs = self.processor(images=image, return_tensors="pt").to(self.device)
        with self.torch.inference_mode():
            embeddings = self.model.get_image_embeddings(inputs["pixel_values"])
        self.sync()
        return Encoded(embeddings, (image.height, image.width))

    def masks(self, encoded: Encoded, boxes: list[list[float]]) -> list[np.ndarray]:
        """One HxW bool mask per box, boxes as [left, top, right, bottom] in 0..1."""
        if not boxes:
            return []
        h, w = encoded.size
        pixels = [[x0 * w, y0 * h, x1 * w, y1 * h] for x0, y0, x1, y1 in boxes]
        prompts = self.processor(
            input_boxes=[pixels], original_sizes=[[h, w]], return_tensors="pt"
        ).to(self.device)
        with self.torch.inference_mode():
            output = self.model(
                image_embeddings=encoded.embeddings,
                input_boxes=prompts["input_boxes"],
                multimask_output=True,
            )
            scores = output.iou_scores[0]  # boxes x 3 candidates
            best = scores.argmax(dim=-1)
            logits = output.pred_masks[0, self.torch.arange(len(boxes), device=best.device), best]
            masks = self.processor.post_process_masks([logits[:, None]], [(h, w)])[0]
        return list(masks[:, 0].detach().cpu().numpy().astype(bool))

    def track_session(self) -> TrackSession:
        return BoxChain(self)

    def segment(
        self, image: Image.Image, box: list[float], point: list[float] | None = None
    ) -> tuple[np.ndarray, float]:
        """Encodes the frame and decodes one box, with an optional foreground point inside it,
        both in 0..1. Returns the best of SAM's three candidate masks and its predicted IoU."""
        encoded = self.encode(image)
        h, w = encoded.size
        x0, y0, x1, y1 = box
        prompt: dict[str, Any] = {"input_boxes": [[[x0 * w, y0 * h, x1 * w, y1 * h]]]}
        if point is not None:
            prompt["input_points"] = [[[[point[0] * w, point[1] * h]]]]
            prompt["input_labels"] = [[[1]]]
        inputs = self.processor(**prompt, original_sizes=[[h, w]], return_tensors="pt").to(
            self.device
        )
        with self.torch.inference_mode():
            output = self.model(
                image_embeddings=encoded.embeddings,
                input_boxes=inputs["input_boxes"],
                input_points=inputs.get("input_points"),
                input_labels=inputs.get("input_labels"),
                multimask_output=True,
            )
            scores = output.iou_scores[0, 0]  # 3 candidates
            best = int(scores.argmax())
            logits = output.pred_masks[0, 0, best]
            mask = self.processor.post_process_masks([logits[None, None]], [(h, w)])[0][0, 0]
        return mask.detach().cpu().numpy().astype(bool), float(scores[best])
