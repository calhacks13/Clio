"""EdgeTAM, Meta's on-device SAM 2, from its repository checked out under `models/EdgeTAM` by
`python -m jev_finder.setup_models` (code and checkpoint, Apache 2.0). About 42 ms per new
640x480 frame on MPS, against 130 to 200 ms for SAM 2.1 Small, with the same box quality in the
Jev fun benchmark.

/locate uses it as a still-image segmenter. /track uses its video memory (`MemoryTrack`), the
way EdgeTAM tracks objects through a video, but fed one live frame at a time.

The repository is not installed: it goes at the end of the import path, so it never shadows
installed modules. Its dependencies (hydra, omegaconf, timm, einops, iopath) are in
pyproject.toml.
"""

from __future__ import annotations

import os
import sys
from contextlib import nullcontext
from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image

from . import MODELS_DIR
from .bench import choose_device
from .tracker import BoxChain, TrackSession

LABEL = "edgetam"
REPO = MODELS_DIR / "EdgeTAM"
CHECKPOINT = REPO / "checkpoints/edgetam.pt"
CONFIG = "configs/edgetam.yaml"
TRACK_MODES = ("memory", "box")
# Tracking frames kept: EdgeTAM reads the last 6 frames' memories and 15 frames' object
# pointers, plus the latest jev boxes (conditioning frames).
KEEP_FRAMES = 16
KEEP_SEEDS = 2


@dataclass
class Encoded:
    features: dict[str, Any]
    size: tuple[int, int]
    """(height, width) of the encoded frame."""


class EdgeTam:
    """The finder's segmenter interface (`encode`, `masks`) plus `segment` for tracking."""

    def __init__(self, device: str = "auto", track: str = "memory"):
        if track not in TRACK_MODES:
            raise ValueError(f"Track with {' or '.join(TRACK_MODES)}.")
        self.track = track
        if not CHECKPOINT.exists():
            raise FileNotFoundError(
                f"No EdgeTAM checkpoint at {CHECKPOINT}. Run python -m jev_finder.setup_models."
            )
        if str(REPO) not in sys.path:
            sys.path.append(str(REPO))
        # A few EdgeTAM ops have no MPS kernel; let them fall back to the CPU.
        os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

        import sam2.modeling.backbones.timm as backbone
        import torch
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor

        self.torch = torch
        self.device = choose_device(torch, device)
        # The full checkpoint supplies every weight; don't download an ImageNet backbone first.
        original = backbone.create_model

        def full_checkpoint_backbone(*args, **kwargs):
            kwargs["pretrained"] = False
            return original(*args, **kwargs)

        backbone.create_model = full_checkpoint_backbone
        try:
            model = build_sam2(
                CONFIG, str(CHECKPOINT), device=self.device, apply_postprocessing=False
            )
        finally:
            backbone.create_model = original
        self.predictor = SAM2ImagePredictor(model, max_hole_area=0, max_sprinkle_area=0)
        self.label = LABEL

    def sync(self) -> None:
        if self.device == "mps":
            self.torch.mps.synchronize()
        elif self.device.startswith("cuda"):
            self.torch.cuda.synchronize()

    def encode(self, image: Image.Image) -> Encoded:
        with self.torch.inference_mode():
            # A copy: torch warns about the read-only array np.asarray gives for a PIL image.
            self.predictor.set_image(np.array(image.convert("RGB")))
        self.sync()
        return Encoded(self.predictor._features, (image.height, image.width))

    def masks(self, encoded: Encoded, boxes: list[list[float]]) -> list[np.ndarray]:
        """One HxW bool mask per box, boxes as [left, top, right, bottom] in 0..1. Of SAM's
        three candidates, each box keeps the one with the highest predicted IoU."""
        if not boxes:
            return []
        self._restore(encoded)
        h, w = encoded.size
        pixels = np.array(boxes, dtype=float) * [w, h, w, h]
        with self.torch.inference_mode():
            masks, scores, _ = self.predictor.predict(box=pixels, multimask_output=True)
        if len(boxes) == 1:  # predict drops the box axis for a single box
            masks, scores = masks[None], scores[None]
        best = scores.argmax(axis=-1)
        return [masks[i, best[i]].astype(bool) for i in range(len(boxes))]

    def segment(
        self, image: Image.Image, box: list[float], point: list[float] | None = None
    ) -> tuple[np.ndarray, float]:
        """Encodes the frame and decodes one box, with an optional foreground point inside it,
        both in 0..1. Returns the best of SAM's three candidate masks and its predicted IoU."""
        encoded = self.encode(image)
        h, w = encoded.size
        prompt: dict[str, np.ndarray] = {"box": np.array(box, dtype=float) * [w, h, w, h]}
        if point is not None:
            prompt["point_coords"] = np.array([point], dtype=float) * [w, h]
            prompt["point_labels"] = np.array([1])
        with self.torch.inference_mode():
            masks, scores, _ = self.predictor.predict(**prompt, multimask_output=True)
        best = int(scores.argmax())
        return masks[best].astype(bool), float(scores[best])

    def track_session(self) -> TrackSession:
        return MemoryTrack(self) if self.track == "memory" else BoxChain(self)

    def _restore(self, encoded: Encoded) -> None:
        """Puts a frame's features back: a tracking frame may have been encoded since."""
        self.predictor._features = encoded.features
        self.predictor._orig_hw = [encoded.size]
        self.predictor._is_image_set = True
        self.predictor._is_batch = False


class MemoryTrack:
    """EdgeTAM's video tracking on a live stream: each frame is encoded once and attends to the
    memories of the last few frames and of jev's boxes, so the object is followed by what it
    looks like, not by where the last box was. Runs under bfloat16 autocast on the GPU, which
    halves the time of the memory attention on MPS (about 50 ms a frame instead of 100 to 120)
    with the same masks in the Jev fun pan test."""

    def __init__(self, edgetam: EdgeTam):
        self.torch = edgetam.torch
        self.device = edgetam.device
        self.model = edgetam.predictor.model
        self.transforms = edgetam.predictor._transforms
        # A box prompt's mask goes into memory as the mask that was shown, as EdgeTAM's video
        # predictor does. Only the memory encoder reads this; /locate's decoding doesn't.
        self.model.binarize_mask_from_pts_for_mem_enc = True
        self.memory: dict[str, dict[int, dict]] | None = None
        self.frame = 0

    def start(self, image: Image.Image, box: list[float]) -> tuple[np.ndarray, float]:
        self.memory = None
        return self._step(image, box)

    def correct(self, image: Image.Image, box: list[float]) -> tuple[np.ndarray, float]:
        return self._step(image, box)

    def follow(
        self, image: Image.Image, box: list[float], point: list[float]
    ) -> tuple[np.ndarray, float]:
        return self._step(image, None)

    def reset(self) -> None:
        self.memory = None

    def _step(self, image: Image.Image, box: list[float] | None) -> tuple[np.ndarray, float]:
        """One frame; `box` makes it a conditioning frame. The mask is empty when EdgeTAM says
        the object isn't visible; the score is its confidence that it is."""
        torch = self.torch
        frame = np.array(image.convert("RGB"))
        h, w = frame.shape[:2]
        first = self.memory is None
        if first:
            self.memory = {"cond_frame_outputs": {}, "non_cond_frame_outputs": {}}
            self.frame = 0
        else:
            self.frame += 1
        with torch.inference_mode(), self._autocast():
            backbone = self.model.forward_image(self.transforms(frame)[None].to(self.device))
            _, features, positions, sizes = self.model._prepare_backbone_features(backbone)
            points = None
            if box is not None:
                corners = torch.tensor(box, dtype=torch.float, device=self.device).reshape(1, 2, 2)
                points = {
                    "point_coords": corners * self.model.image_size,
                    "point_labels": torch.tensor([[2, 3]], dtype=torch.int, device=self.device),
                }
            out = self.model.track_step(
                frame_idx=self.frame,
                is_init_cond_frame=first,
                current_vision_feats=features,
                current_vision_pos_embeds=positions,
                feat_sizes=sizes,
                point_inputs=points,
                mask_inputs=None,
                output_dict=self.memory,
                num_frames=self.frame + 1,
            )
            logits = torch.nn.functional.interpolate(
                out["pred_masks_high_res"].float(), size=(h, w), mode="bilinear"
            )[0, 0]
            present = float(out["object_score_logits"].float().sigmoid())
            mask = (logits > 0).cpu().numpy()
        self._remember(out, seeded=box is not None)
        if present < 0.5:
            mask[:] = False
        return mask, present

    def _remember(self, out: dict, seeded: bool) -> None:
        assert self.memory is not None
        kept = ("maskmem_features", "maskmem_pos_enc", "pred_masks", "obj_ptr")
        compact = {key: out[key] for key in kept}
        compact["object_score_logits"] = out["object_score_logits"]
        seeds = self.memory["cond_frame_outputs"]
        frames = self.memory["non_cond_frame_outputs"]
        (seeds if seeded else frames)[self.frame] = compact
        for old in [i for i in frames if i <= self.frame - KEEP_FRAMES]:
            del frames[old]
        for old in sorted(seeds)[:-KEEP_SEEDS]:
            del seeds[old]

    def _autocast(self):
        if self.device == "mps" or self.device.startswith("cuda"):
            return self.torch.autocast(self.device.split(":")[0], dtype=self.torch.bfloat16)
        return nullcontext()
