"""SAM 2.1 as the outline of a tracked object: a box in, a clean mask out.

YOLOE-26's mask comes from 32 coarse prototypes (160x160 for the whole frame), good enough to
find and follow an object but ragged as an outline. SAM 2.1 cuts the object out of its box far
more cleanly, at the price of an image encoder pass (the expensive half, once per frame) and a
light mask decoder pass (once per box). The two halves are separate here, `encode` and
`mask_in_box`, so a frame is encoded once however many boxes are cut out of it.

A segmenter is optional: `load_segmenter("none")` is None and callers keep YOLOE's mask.
torch, transformers, cv2, numpy and `vision` load on first use, so reading the setting stays cheap.
"""

from __future__ import annotations

import math
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    import numpy as np

    from .vision import MaskCrop

SEGMENTERS = {
    "sam2.1-small": "facebook/sam2.1-hiera-small",
    "sam2.1-large": "facebook/sam2.1-hiera-large",
}
SEGMENTER_CHOICES = ("auto", "none", *SEGMENTERS)  # what the setting and --segmenter accept

GROW = 0.10  # the crop is the prompt box grown by this much on every side
CROP_PIXELS = 256  # the crop's longer side, in mask pixels, at most
MIN_PIXELS = 16  # a mask smaller than this, in frame pixels, is no object
INSIDE = 10.0  # the logits clean_mask returns: +INSIDE in the mask, -INSIDE outside it


@dataclass
class SegEncoding:
    """One frame through the segmenter's image encoder."""

    width: int
    height: int
    embeddings: object  # the model's image embeddings, opaque to callers


class Segmenter(Protocol):
    name: str

    def encode(self, rgb: np.ndarray) -> SegEncoding:
        """An HxWx3 uint8 RGB frame through the image encoder."""
        ...

    def mask_in_box(self, enc: SegEncoding, box: np.ndarray) -> MaskCrop | None:
        """The object inside a frame-pixel box (x1, y1, x2, y2), as mask logits over the box grown
        by 10% and clipped to the frame; None when there is no object worth drawing."""
        ...


def clean_mask(logits: np.ndarray) -> np.ndarray:
    """Logits > 0 with specks removed (a 3x3 morphological opening), as +10 inside, -10 outside."""
    import cv2
    import numpy as np

    inside = (logits > 0).astype(np.uint8)
    opened = cv2.morphologyEx(inside, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    return np.where(opened > 0, INSIDE, -INSIDE).astype(np.float32)


def candidate_bounds(rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
    """(N, 4) bounding boxes (x1, y1, x2, y2) of N masks, in pixel edges, from which rows (N, H)
    and columns (N, W) hold any mask pixel; an empty mask is (0, 0, 0, 0)."""
    import numpy as np

    bounds = np.zeros((len(rows), 4), np.float32)
    for i, (hit_rows, hit_cols) in enumerate(zip(rows, cols, strict=True)):
        ys, xs = np.flatnonzero(hit_rows), np.flatnonzero(hit_cols)
        if ys.size and xs.size:
            bounds[i] = (xs[0], ys[0], xs[-1] + 1, ys[-1] + 1)
    return bounds


def pick_candidate(scores: np.ndarray, bounds: np.ndarray, box: np.ndarray) -> int:
    """Which of SAM's candidate masks to draw for a prompt box: the highest predicted IoU times
    the IoU between the candidate's bounding box and the prompt box. On its own the predicted IoU
    often prefers one clean piece of a loosely boxed object (a caliper's jaw), a different one on
    each frame; a box around the whole object then gets the whole, and a box around a part the part.
    """
    import numpy as np

    from .geometry import iou

    return int(np.argmax(scores * iou(bounds, box)[:, 0]))


def crop_mask(logits: np.ndarray, box: np.ndarray) -> MaskCrop | None:
    """Frame-sized mask logits cut to the box grown by 10%, cleaned, and shrunk to at most 256
    pixels on the longer side (each mask pixel is then `scale` >= 1 frame pixels).

    None when fewer than 16 frame pixels are inside the cleaned mask.
    """
    import cv2

    from .vision import MaskCrop

    height, width = logits.shape
    x1, y1, x2, y2 = (float(v) for v in box)
    grow_x, grow_y = GROW * (x2 - x1), GROW * (y2 - y1)
    left, top = max(0, math.floor(x1 - grow_x)), max(0, math.floor(y1 - grow_y))
    right, bottom = min(width, math.ceil(x2 + grow_x)), min(height, math.ceil(y2 + grow_y))
    if right <= left or bottom <= top:
        return None
    patch = clean_mask(logits[top:bottom, left:right])
    if (patch > 0).sum() < MIN_PIXELS:
        return None
    scale = max(1.0, max(patch.shape) / CROP_PIXELS)
    if scale > 1.0:
        size = (max(1, round(patch.shape[1] / scale)), max(1, round(patch.shape[0] / scale)))
        patch = cv2.resize(patch, size, interpolation=cv2.INTER_LINEAR)
    return MaskCrop(patch, (float(left), float(top)), scale)


@contextmanager
def _quiet_transformers() -> Iterator[None]:
    """transformers logs errors only inside the block. The SAM 2.1 checkpoints are sam2_video
    models that Sam2Model loads as sam2 on purpose, and it warns about that on every load."""
    from transformers.utils import logging as hf_logging

    level = hf_logging.get_verbosity()
    hf_logging.set_verbosity_error()
    try:
        yield
    finally:
        hf_logging.set_verbosity(level)


class Sam2Segmenter:
    """SAM 2.1 (Hugging Face transformers) on MPS, CUDA or CPU, in float32."""

    def __init__(self, model_id: str = SEGMENTERS["sam2.1-small"], device: str = "auto"):
        import torch
        from transformers import Sam2Model, Sam2Processor

        from .vision import _pick_device

        self._torch = torch
        self.device = _pick_device(device)
        names = {repo: name for name, repo in SEGMENTERS.items()}
        self.name = names.get(model_id, model_id)
        with _quiet_transformers():
            self.model = Sam2Model.from_pretrained(model_id, dtype=torch.float32)
        self.model.eval().to(self.device)
        with _quiet_transformers():
            self.processor = Sam2Processor.from_pretrained(model_id)
        # One model instance; the encoder and decoder are not safe to run from two threads.
        self._lock = threading.Lock()

    def encode(self, rgb: np.ndarray) -> SegEncoding:
        height, width = rgb.shape[:2]
        with self._lock, self._torch.inference_mode():
            pixels = self.processor(images=rgb, return_tensors="pt")["pixel_values"]
            embeddings = self.model.get_image_embeddings(pixels.to(self.device))
            self._wait()  # MPS and CUDA queue the work; the cost belongs to this call
            if self.device == "mps":
                # Without this, back-to-back calls swing from 120 ms to 2 s.
                self._torch.mps.empty_cache()
        return SegEncoding(width, height, embeddings)

    def _wait(self) -> None:
        if self.device == "mps":
            self._torch.mps.synchronize()
        elif self.device.startswith("cuda"):
            self._torch.cuda.synchronize()

    def mask_in_box(self, enc: SegEncoding, box: np.ndarray) -> MaskCrop | None:
        import numpy as np

        x1, y1, x2, y2 = (float(v) for v in box)
        prompt_box = [max(0.0, x1), max(0.0, y1), min(enc.width, x2), min(enc.height, y2)]
        if prompt_box[2] <= prompt_box[0] or prompt_box[3] <= prompt_box[1]:
            return None
        with self._lock, self._torch.inference_mode():
            # The processor maps frame pixels to the model's 1024 x 1024 input; no image needed.
            prompt = self.processor(
                original_sizes=[[enc.height, enc.width]],
                input_boxes=[[prompt_box]],
                return_tensors="pt",
            )["input_boxes"]
            out = self.model(
                image_embeddings=enc.embeddings,
                input_boxes=prompt.to(self.device),
                multimask_output=True,
            )
            # All three candidates at frame size; only their extent and the winner reach the CPU.
            candidates = self.processor.post_process_masks(
                [out.pred_masks[0, 0][None]], [(enc.height, enc.width)], binarize=False
            )[0][0]
            inside = candidates > 0
            bounds = candidate_bounds(
                inside.any(dim=2).cpu().numpy(), inside.any(dim=1).cpu().numpy()
            )
            scores = out.iou_scores[0, 0].float().cpu().numpy()
            best = pick_candidate(scores, bounds, np.array(prompt_box))
            logits = candidates[best].float().cpu().numpy()
            if self.device == "mps":  # .cpu() has waited for the device; see encode
                self._torch.mps.empty_cache()
        return crop_mask(logits, np.array([x1, y1, x2, y2]))


def load_segmenter(name: str, device: str = "auto") -> Segmenter | None:
    """`sam2.1-small` or `sam2.1-large`; `none` for no segmenter. `auto` is SAM 2.1 small
    (transformers is a dependency); the service starts without a segmenter when `auto` fails
    to load (cli.py)."""
    if name == "none":
        return None
    if name == "auto":
        name = "sam2.1-small"
    if name not in SEGMENTERS:
        raise ValueError(
            f"Unknown segmenter {name!r}: expected auto, none or one of {', '.join(SEGMENTERS)}"
        )
    return Sam2Segmenter(SEGMENTERS[name], device)
