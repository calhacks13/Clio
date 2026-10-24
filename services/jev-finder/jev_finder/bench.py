"""The few helpers the finder takes from the Jev fun workbench (`jevbench`), a private local
benchmark that is not published: `valid_box` from `jevbench/core.py`, `probability` and
`choose_device` from `jevbench/providers.py`, and `mask_box` from `jevbench/sam2.py`, copied
unchanged apart from type hints. The jev client (`jev.py`), SAM loading (`segmenter.py`) and frame
fitting (`images.py`, after `jevbench.core.prepare_image`) are this service's own versions of the
workbench's code.
"""

from __future__ import annotations

import math

import numpy as np


def valid_box(box) -> bool:
    return (
        isinstance(box, list)
        and len(box) == 4
        and all(
            isinstance(x, (float, int)) and not isinstance(x, bool) and math.isfinite(x)
            for x in box
        )
        and 0 <= box[0] < box[2] <= 1
        and 0 <= box[1] < box[3] <= 1
    )


def probability(value, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not 0 <= value <= 1:
        raise ValueError("Invalid " + name + " in model response.")
    return float(value)


def choose_device(torch, requested: str) -> str:
    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def mask_box(mask: np.ndarray) -> list[float] | None:
    """Pixel-edge xyxy bounding box; empty masks have no valid extent."""
    y, x = np.where(mask)
    if len(x) == 0:
        return None
    h, w = mask.shape
    return [
        int(x.min()) / w,
        int(y.min()) / h,
        (int(x.max()) + 1) / w,
        (int(y.max()) + 1) / h,
    ]
