"""Helpers from the Jev fun workbench (`jevbench`), a private local benchmark that is not
published: `valid_box` from `jevbench/core.py` and `probability` from `jevbench/providers.py`,
copied unchanged apart from type hints (by way of the jev finder).
"""

from __future__ import annotations

import math


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
