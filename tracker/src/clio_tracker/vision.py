"""YOLOE-26's vision half: candidate boxes, region features, masks and visual prompts per frame.

The text half (MobileCLIP2-B plus RepRTA) is never loaded. jev decides *which* object the learner
means; YOLOE turns jev's box on a frame into a 512-number prompt with its own visual prompt
encoder (SAVPE), then finds that prompt again in every later frame.

One frame costs one pass through the vision graph. It returns, for each of the 8,400 candidate
positions (80x80, 40x40 and 20x20 grids at a 640 input): a box, the region's features before
the classifier, and mask coefficients; plus the shared mask prototypes and SAVPE's two
prompt-independent maps. Everything that depends on the prompt is cheap and runs afterwards:

- **Scoring.** YOLOE scores a region feature h against a prompt e as
  `sigmoid(s * e·(P h + c) + o)`, where P and c are the last 1x1 conv folded with the
  contrastive head's batch norm, and s, o are its learned scale and bias. That is
  `sigmoid(w·h + b)` with `w = s Pᵀe` and `b = s e·c + o`, computed once per prompt instead of
  projecting every position into 512 dimensions. It is YOLOE's own scoring, rearranged; cosine
  similarity between raw region features would mean something else.
- **Visual prompts.** SAVPE's convolutions over the neck features don't depend on the prompt, so
  the graph emits their outputs; turning a box into a prompt is then two small convolutions and
  a masked softmax over an 80x80 grid.

The NMS-free one-to-one branch of YOLO26 is used throughout, so each object yields one strong
candidate rather than a cluster.
"""

from __future__ import annotations

import copy
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import numpy as np

os.environ.setdefault("YOLO_VERBOSE", "False")

import cv2  # noqa: E402
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from torch import nn  # noqa: E402

from .geometry import Letterbox, Shape, letterbox, mask_shape  # noqa: E402

INPUT_SIZE = 640
EMBED = 512
OUTPUT_NAMES = ("boxes", "features", "mask_coefficients", "protos", "savpe_x", "savpe_y")


@dataclass
class Encoding:
    """One frame through the vision graph. Boxes and grids are in model-input pixels."""

    letterbox: Letterbox
    boxes: np.ndarray  # (N, 4) xyxy
    features: np.ndarray  # (C3, N) region features, before the classifier
    mask_coefficients: np.ndarray  # (32, N)
    protos: np.ndarray  # (32, size/4, size/4)
    savpe_x: np.ndarray  # (512, size/8, size/8)
    savpe_y: np.ndarray  # (16, size/8, size/8)

    @property
    def anchors(self) -> int:
        return self.boxes.shape[0]


class Graph(Protocol):
    """A compiled vision graph: a (1, 3, S, S) RGB tensor in 0..1 to the six named outputs."""

    name: str

    def run(self, image: np.ndarray) -> dict[str, np.ndarray]: ...


# --- The graph ---------------------------------------------------------------------------------


def load_yoloe(weights: str | Path) -> nn.Module:
    """The YOLOEModel inside an Ultralytics checkpoint, on the CPU in float32, conv+BN fused.

    Downloads the official checkpoint by name (e.g. "yoloe-26l-seg.pt") when the file is missing.
    """
    from ultralytics import YOLOE

    net = YOLOE(str(weights)).model.float().eval().requires_grad_(False)
    head = net.model[-1]
    if not hasattr(head, "savpe") or getattr(head, "one2one_cv2", None) is None:
        raise ValueError(
            f"{weights} is not a YOLOE-26 text/visual-prompt segmentation checkpoint "
            "(expected yoloe-26{n,s,m,l,x}-seg.pt; the -pf prompt-free ones have no SAVPE)"
        )
    _fuse_conv_bn(net)
    return net


def _fuse_conv_bn(net: nn.Module) -> None:
    """Ultralytics' fuse(), minus the head's: that would drop a branch and the contrastive BN."""
    from ultralytics.nn.modules import Conv, ConvTranspose, DWConv
    from ultralytics.utils.torch_utils import fuse_conv_and_bn, fuse_deconv_and_bn

    for m in net.modules():
        if isinstance(m, (Conv, DWConv)) and hasattr(m, "bn"):
            m.conv = fuse_conv_and_bn(m.conv, m.bn).requires_grad_(False)
            delattr(m, "bn")
            m.forward = m.forward_fuse
        elif isinstance(m, ConvTranspose) and hasattr(m, "bn"):
            m.conv_transpose = fuse_deconv_and_bn(m.conv_transpose, m.bn).requires_grad_(False)
            delattr(m, "bn")
            m.forward = m.forward_fuse


class VisionGraph(nn.Module):
    """Backbone, neck and the prompt-independent parts of YOLOE-26's head, one2one branch."""

    def __init__(self, net: nn.Module, size: int = INPUT_SIZE):
        super().__init__()
        from ultralytics.utils.tal import make_anchors

        head = net.model[-1]
        self.layers = net.model[:-1]
        self.save = sorted(net.save)
        self.f = list(head.f)
        self.box_head = head.one2one_cv2
        # Every layer of the classification branch except its final 1x1 conv to the embedding.
        self.cls_head = nn.ModuleList(
            nn.Sequential(*list(b.children())[:-1]) for b in head.one2one_cv3
        )
        self.mask_head = head.one2one_cv5
        self.proto = head.proto
        self.savpe = head.savpe
        with torch.no_grad():
            feats = self._neck(torch.zeros(1, 3, size, size))
        anchors, strides = make_anchors(feats, head.stride, 0.5)
        self.register_buffer("anchors", anchors.transpose(0, 1).unsqueeze(0))  # (1, 2, N)
        self.register_buffer("strides", strides.transpose(0, 1))  # (1, N)

    def _neck(self, x: torch.Tensor) -> list[torch.Tensor]:
        y: list[torch.Tensor | None] = []
        for m in self.layers:
            if m.f != -1:
                x = y[m.f] if isinstance(m.f, int) else [x if j == -1 else y[j] for j in m.f]
            x = m(x)
            y.append(x if m.i in self.save else None)
        return [y[j] for j in self.f]

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, ...]:
        from ultralytics.utils.tal import dist2bbox

        feats = self._neck(x)
        dist = torch.cat([b(f).flatten(2) for b, f in zip(self.box_head, feats, strict=True)], 2)
        boxes = dist2bbox(dist, self.anchors, xywh=False, dim=1) * self.strides
        features = torch.cat(
            [c(f).flatten(2) for c, f in zip(self.cls_head, feats, strict=True)], 2
        )
        coefficients = torch.cat(
            [m(f).flatten(2) for m, f in zip(self.mask_head, feats, strict=True)], 2
        )
        protos = self.proto(feats, return_semantic=False)
        sv = self.savpe
        savpe_x = sv.cv3(torch.cat([sv.cv1[i](f) for i, f in enumerate(feats)], 1))
        savpe_y = sv.cv4(torch.cat([sv.cv2[i](f) for i, f in enumerate(feats)], 1))
        return boxes, features, coefficients, protos, savpe_x, savpe_y


class TorchGraph:
    """The vision graph in PyTorch: MPS or CUDA in float16, else the CPU in float32."""

    def __init__(self, net: nn.Module, device: str = "auto", size: int = INPUT_SIZE):
        self.device = torch.device(_pick_device(device))
        self.half = self.device.type in ("mps", "cuda")
        graph = VisionGraph(net, size).eval()
        self.graph = (graph.half() if self.half else graph).to(self.device)
        self.name = f"torch-{self.device.type}{'-fp16' if self.half else ''}"

    @torch.inference_mode()
    def run(self, image: np.ndarray) -> dict[str, np.ndarray]:
        x = torch.from_numpy(image).to(self.device)
        x = x.half() if self.half else x.float()
        outputs = self.graph(x)
        return {n: t.float().cpu().numpy() for n, t in zip(OUTPUT_NAMES, outputs, strict=True)}


def _pick_device(device: str) -> str:
    if device != "auto":
        return device
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


# --- Prompt-dependent parts --------------------------------------------------------------------


class PromptClassifier:
    """YOLOE's one2one contrastive scoring, folded per prompt (see the module docstring)."""

    def __init__(self, net: nn.Module, scale_sizes: list[int]):
        from ultralytics.utils.torch_utils import fuse_conv_and_bn

        head = net.model[-1]
        self.scales = []
        start = 0
        for size, branch, contrast in zip(
            scale_sizes, head.one2one_cv3, head.one2one_cv4, strict=True
        ):
            conv = fuse_conv_and_bn(copy.deepcopy(branch[-1]), copy.deepcopy(contrast.norm))
            P = conv.weight.detach().squeeze(-1).squeeze(-1).double().numpy()  # (512, C3)
            c = conv.bias.detach().double().numpy()  # (512,)
            s = float(contrast.logit_scale.detach().exp())
            o = float(contrast.bias.detach())
            self.scales.append((slice(start, start + size), P, c, s, o))
            start += size
        self.anchors = start

    def __call__(self, features: np.ndarray, prompts: np.ndarray) -> np.ndarray:
        """Scores in 0..1, (Q, N), for (C3, N) features and (Q, 512) prompts."""
        e = np.asarray(prompts, dtype=np.float64)
        e = e / np.maximum(np.linalg.norm(e, axis=1, keepdims=True), 1e-12)
        out = np.empty((e.shape[0], features.shape[1]), dtype=np.float32)
        for where, P, c, s, o in self.scales:
            w = s * (e @ P)  # (Q, C3)
            b = s * (e @ c) + o  # (Q,)
            out[:, where] = (w @ features[:, where] + b[:, None]).astype(np.float32)
        return _sigmoid(out)


class SavpePrompt(nn.Module):
    """SAVPE's prompt-dependent tail: boxes on SAVPE's two frame maps to unit 512-d prompts."""

    def __init__(self, net: nn.Module):
        super().__init__()
        savpe = net.model[-1].savpe
        self.c = savpe.c
        self.cv5 = copy.deepcopy(savpe.cv5).float().cpu().eval()
        self.cv6 = copy.deepcopy(savpe.cv6).float().cpu().eval()

    @torch.inference_mode()
    def forward(self, x: np.ndarray, y: np.ndarray, masks: np.ndarray) -> np.ndarray:
        """(512, H, W) and (16, H, W) maps, (K, H, W) prompt masks: (K, 512)."""
        c = self.c
        k, h, w = masks.shape
        xt = torch.from_numpy(np.ascontiguousarray(x, dtype=np.float32)).view(
            -1, c, x.shape[0] // c, h * w
        )
        yt = torch.from_numpy(np.ascontiguousarray(y, dtype=np.float32))[None].expand(k, -1, -1, -1)
        vp = torch.from_numpy(np.ascontiguousarray(masks, dtype=np.float32))[:, None]
        yt = self.cv6(torch.cat((yt, self.cv5(vp)), 1)).reshape(k, c, h * w)
        inside = vp.reshape(k, 1, h * w) > 0
        logits = yt.masked_fill(~inside, torch.finfo(yt.dtype).min)
        weights = F.softmax(logits, dim=-1)  # (K, 16, HW): where in the box each group looks
        pooled = torch.einsum("kcn,cdn->kcd", weights, xt[0])  # (K, 16, 32)
        return F.normalize(pooled.reshape(k, -1), dim=-1).numpy()


def prompt_masks(boxes: np.ndarray, grid: tuple[int, int], stride: int = 8) -> np.ndarray:
    """Model-input boxes to (K, H, W) masks on the stride-8 grid, never empty."""
    h, w = grid
    b = np.asarray(boxes, dtype=np.float32).reshape(-1, 4) / stride
    cols = np.arange(w)[None, None, :]
    rows = np.arange(h)[None, :, None]
    masks = (
        (cols >= b[:, 0, None, None])
        & (cols < b[:, 2, None, None])
        & (rows >= b[:, 1, None, None])
        & (rows < b[:, 3, None, None])
    )
    for i, box in enumerate(b):  # a box smaller than one cell still prompts its center cell
        if not masks[i].any():
            cx = int(np.clip((box[0] + box[2]) / 2, 0, w - 1))
            cy = int(np.clip((box[1] + box[3]) / 2, 0, h - 1))
            masks[i, cy, cx] = True
    return masks.astype(np.float32)


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(x, -60, 60)))


# --- The facade --------------------------------------------------------------------------------


class YoloeVision:
    """Encode frames, score prompts, turn boxes into prompts, and cut masks into outlines."""

    def __init__(self, net: nn.Module, graph: Graph, model: str, size: int = INPUT_SIZE):
        self.model = model
        self.size = size
        self.graph = graph
        grids = [(size // s) ** 2 for s in (8, 16, 32)]
        self.classifier = PromptClassifier(net, grids)
        self.savpe = SavpePrompt(net)
        # One graph instance; predictions reuse its buffers.
        self._lock = threading.Lock()

    @property
    def backend(self) -> str:
        return self.graph.name

    def encode(self, rgb: np.ndarray) -> Encoding:
        """An HxWx3 uint8 RGB frame through the vision graph."""
        square, lb = letterbox(rgb, self.size)
        x = np.ascontiguousarray(square.transpose(2, 0, 1)[None], dtype=np.float32) / 255.0
        with self._lock:
            out = self.graph.run(x)
        g8 = self.size // 8
        return Encoding(
            letterbox=lb,
            boxes=np.ascontiguousarray(out["boxes"][0].T, dtype=np.float32),
            features=np.ascontiguousarray(out["features"][0], dtype=np.float32),
            mask_coefficients=np.ascontiguousarray(out["mask_coefficients"][0], dtype=np.float32),
            protos=np.ascontiguousarray(out["protos"][0], dtype=np.float32),
            savpe_x=out["savpe_x"][0].reshape(-1, g8, g8).astype(np.float32, copy=False),
            savpe_y=out["savpe_y"][0].reshape(-1, g8, g8).astype(np.float32, copy=False),
        )

    def scores(self, enc: Encoding, prompts: np.ndarray) -> np.ndarray:
        """(Q, N) scores of every candidate position against each prompt."""
        return self.classifier(enc.features, np.atleast_2d(prompts))

    def prompts(self, enc: Encoding, boxes: np.ndarray) -> np.ndarray:
        """(K, 512) unit visual prompts for frame-pixel boxes on this frame."""
        boxes = enc.letterbox.to_input(np.atleast_2d(boxes))
        masks = prompt_masks(boxes, enc.savpe_x.shape[1:])
        return self.savpe(enc.savpe_x, enc.savpe_y, masks)

    def shape(self, enc: Encoding, anchor: int, box: np.ndarray) -> Shape:
        """The outline and point of candidate `anchor`, whose frame-pixel box is `box`."""
        lb = enc.letterbox
        stride = self.size / enc.protos.shape[1]  # model-input pixels per prototype pixel
        b = lb.to_input(box)
        x1 = int(np.clip(np.floor(b[0] / stride), 0, enc.protos.shape[2] - 1))
        y1 = int(np.clip(np.floor(b[1] / stride), 0, enc.protos.shape[1] - 1))
        x2 = int(np.clip(np.ceil(b[2] / stride), x1 + 1, enc.protos.shape[2]))
        y2 = int(np.clip(np.ceil(b[3] / stride), y1 + 1, enc.protos.shape[1]))
        protos = enc.protos[:, y1:y2, x1:x2]
        logits = np.tensordot(enc.mask_coefficients[:, anchor], protos, axes=1)
        # Upsample the logits (not the thresholded mask) to model-input pixels for smooth edges.
        up = int(round(stride))
        logits = cv2.resize(
            logits, ((x2 - x1) * up, (y2 - y1) * up), interpolation=cv2.INTER_LINEAR
        )
        mask = logits > 0
        # Like Ultralytics' crop_mask: nothing outside the box.
        ox, oy = x1 * up, y1 * up
        cols = np.arange(mask.shape[1]) + ox + 0.5
        rows = np.arange(mask.shape[0]) + oy + 0.5
        mask &= (cols[None, :] >= b[0]) & (cols[None, :] <= b[2])
        mask &= (rows[:, None] >= b[1]) & (rows[:, None] <= b[3])
        origin = ((ox - lb.left) / lb.gain, (oy - lb.top) / lb.gain)
        return mask_shape(mask, origin, 1.0 / lb.gain, lb.width, lb.height, box)


def load_vision(
    model: str = "yoloe-26l-seg",
    backend: str = "auto",
    device: str = "auto",
    models_dir: Path | None = None,
) -> YoloeVision:
    """Load a YOLOE-26 checkpoint and compile its vision graph.

    backend "coreml" runs the graph on the Apple Neural Engine (exported and cached on first
    use), "torch" on MPS/CUDA/CPU; "auto" prefers Core ML on a Mac that has coremltools.
    """
    models_dir = models_dir or default_models_dir()
    models_dir.mkdir(parents=True, exist_ok=True)
    weights = models_dir / f"{model}.pt"
    net = load_yoloe(weights)
    if backend == "auto":
        from .coreml import coreml_available

        backend = "coreml" if coreml_available() else "torch"
    if backend == "coreml":
        from .coreml import CoreMLGraph

        graph: Graph = CoreMLGraph.load_or_export(net, models_dir / model)
    elif backend == "torch":
        graph = TorchGraph(net, device)
    else:
        raise ValueError(f"Unknown backend {backend!r}: expected auto, coreml or torch")
    return YoloeVision(net, graph, model)


def default_models_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "models"
