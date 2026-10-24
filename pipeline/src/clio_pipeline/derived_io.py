"""Writing compiled documents (clio.derived/1): rounding, null for missing values, strict JSON.

Positions and quaternions keep 4 decimals (0.1 mm, like the recorder), times 2 (10 us). A value
that is missing is null, never NaN: `json.dumps(allow_nan=False)` refuses any that slipped
through.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np

DERIVED_SCHEMA_ID = "clio.derived/1"
SPACE_DECIMALS = 4
TIME_DECIMALS = 2


def rounded(
    values: np.ndarray, decimals: int = SPACE_DECIMALS, valid: np.ndarray | None = None
) -> list:
    """Rows of `values` (shape (M,) or (M, D)) rounded, as lists. A row is None where `valid`
    ((M,) bool) is False or where it contains NaN. -0.0 becomes 0.0."""
    values = np.asarray(values, dtype=np.float64)
    if len(values) == 0:
        return []
    ok = ~np.isnan(values.reshape(len(values), -1)).any(axis=1)
    if valid is not None:
        ok &= np.asarray(valid, dtype=bool)
    out = (np.round(np.where(np.isnan(values), 0.0, values), decimals) + 0.0).tolist()
    return [row if keep else None for row, keep in zip(out, ok.tolist(), strict=True)]


def times(t: np.ndarray) -> list[float]:
    return (np.round(np.asarray(t, dtype=np.float64), TIME_DECIMALS) + 0.0).tolist()


def time_or_none(t: float | None) -> float | None:
    return None if t is None else round(float(t), TIME_DECIMALS) + 0.0


def dump_json(doc: Any, *, indent: int | None = None) -> bytes:
    """Strict JSON: compact without `indent`; numpy scalars and arrays become plain values."""
    separators = (",", ":") if indent is None else (",", ": ")
    text = json.dumps(doc, allow_nan=False, indent=indent, separators=separators, default=_plain)
    return (text + "\n").encode("utf-8")


def write_json(path: Path, doc: Any, *, indent: int | None = None) -> int:
    """Write `doc` to `path`; returns the bytes written."""
    data = dump_json(doc, indent=indent)
    path.write_bytes(data)
    return len(data)


def _plain(value: Any) -> Any:
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    raise TypeError(f"{type(value).__name__} is not JSON serializable")
