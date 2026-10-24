"""Load a Clio episode directory (docs/data-format.md) into numpy arrays."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from .frames import HANDS, JOINT_STRIDE, NUM_JOINTS
from .schema import (
    EpisodeValidationError,
    SchemaSet,
    hand_layout_problems,
    parse_json,
    validate_episode,
)

# Bits of an object state's `locationFlags` (packages/protocol/src/episode.ts LOCATION_FLAG). A
# valid value can be used; a tracked value was measured just now rather than carried over.
ORIENTATION_VALID = 1
POSITION_VALID = 2
ORIENTATION_TRACKED = 4
POSITION_TRACKED = 8
# Sources whose estimates are measured; layout, pinch and manual placements are given.
MEASURED_SOURCES = frozenset({"marker", "detector"})


def location_flags(state: dict[str, Any]) -> int:
    """An object state's `locationFlags`, or for an older episode without them the flags its
    source implies (docs/data-format.md): position valid always, plus position tracked for
    `marker` and `detector`; with an orientation, also orientation valid, plus orientation
    tracked for `marker`."""
    recorded = state.get("locationFlags")
    if recorded is not None:
        return int(recorded)
    source = state["source"]
    flags = POSITION_VALID | (POSITION_TRACKED if source in MEASURED_SOURCES else 0)
    if state.get("orientation") is not None:
        flags |= ORIENTATION_VALID | (ORIENTATION_TRACKED if source == "marker" else 0)
    return flags


@dataclass
class ObjectTrack:
    """One object's estimates over time: its `meta.objects` placement (t = 0), then each
    objects.ndjson update. Sample k holds from t[k] until the next sample.

    `t` is each line's time. A position-valid estimate was measured at its `observedT` when the
    state records one, so `sample_t` (that observedT, else t) is when it describes the object; it
    need not be in order. A state without a valid position says what is true when it was written,
    so its sample_t is its line's t (like the viewer). `held_by_known` tells a state that says no
    hand holds it (heldBy null) from one that does not say (no heldBy). `flags`, `held_by`,
    `held_by_known` and `observed_t` are filled in from `source` and `orientation` (see
    `location_flags`) when not given."""

    id: str
    label: str
    radius: float | None
    t: np.ndarray  # (K,) ms
    position: np.ndarray  # (K, 3) workspace frame
    orientation: np.ndarray  # (K, 4) [x, y, z, w]; NaN when unknown (non-marker estimates)
    confidence: np.ndarray  # (K,); NaN for the meta placement
    source: list[str]  # placement method / tracker source per sample
    flags: np.ndarray | None = None  # (K,) uint8 location flags (POSITION_VALID, ...)
    held_by: list[str | None] | None = None  # the hand carrying it per sample, or None
    held_by_known: np.ndarray | None = None  # (K,) bool: the state recorded heldBy (maybe null)
    observed_t: np.ndarray | None = None  # (K,) float64 observedT; NaN when not recorded
    sample_t: np.ndarray | None = None  # (K,) float64 when each estimate describes the object

    def __post_init__(self) -> None:
        k = len(self.t)
        if self.flags is None:
            self.flags = np.array(
                [
                    location_flags({"source": s, "orientation": None if np.isnan(q).any() else q})
                    for s, q in zip(self.source, self.orientation, strict=True)
                ],
                dtype=np.uint8,
            )
        if self.held_by is None:
            self.held_by = [None] * k
        if self.held_by_known is None:
            self.held_by_known = np.array([h is not None for h in self.held_by], dtype=bool)
        if self.observed_t is None:
            self.observed_t = np.full(k, np.nan)
        if self.sample_t is None:
            measured_then = ~np.isnan(self.observed_t) & ((self.flags & POSITION_VALID) != 0)
            self.sample_t = np.where(measured_then, self.observed_t, self.t)

    def index_at(self, t: float | np.ndarray) -> np.ndarray | int:
        """Index of the sample in effect at `t` (the last one at or before it), -1 if none."""
        return np.searchsorted(self.t, t, side="right") - 1

    def position_at(self, t: float | np.ndarray) -> np.ndarray:
        """Position(s) in effect at `t`; NaN before the object's first sample."""
        idx = np.atleast_1d(self.index_at(t))
        out = np.full((idx.size, 3), np.nan)
        known = idx >= 0
        out[known] = self.position[idx[known]]
        return out[0] if np.ndim(t) == 0 else out


@dataclass
class Episode:
    path: Path
    meta: dict[str, Any]
    t: np.ndarray  # (N,) float64, ms since episode start
    head: np.ndarray  # (N, 7) [px, py, pz, qx, qy, qz, qw], workspace frame
    hands: (
        np.ndarray
    )  # (N, 2, 25, 8) float32, [left, right] x WebXR joints x JOINT_FIELDS; NaN if untracked
    pinch: np.ndarray  # (N, 2) float32 thumb-index distance (m); NaN if untracked
    tracked: np.ndarray  # (N, 2) bool
    events: list[dict[str, Any]]  # time order (stable for equal t)
    object_updates: list[dict[str, Any]]  # objects.ndjson lines, time order
    objects: dict[str, ObjectTrack]
    finish: dict[str, Any] | None
    media: dict[str, Path] = field(default_factory=dict)
    # observations.ndjson, time order; lines without an object and a numeric t are skipped
    observations: list[dict[str, Any]] = field(default_factory=list)

    @property
    def episode_id(self) -> str:
        return self.meta["episodeId"]

    @property
    def n_frames(self) -> int:
        return len(self.t)

    @property
    def duration_ms(self) -> float:
        """Time of the last frame (t is relative to the episode start)."""
        return float(self.t[-1]) if len(self.t) else 0.0

    @property
    def procedure_title(self) -> str | None:
        procedure = self.meta.get("procedure")
        return procedure["title"] if procedure else None

    @property
    def plan(self) -> dict[str, Any] | None:
        """`meta.plan`: the full procedure the lesson ran (optional)."""
        return self.meta.get("plan")

    def events_of(self, *types: str) -> list[dict[str, Any]]:
        return [e for e in self.events if e["type"] in types]


def load_episode(
    path: Path | str, *, validate: bool = False, schemas: SchemaSet | None = None
) -> Episode:
    """Load an episode directory. With `validate=True`, raise EpisodeValidationError first if
    any file breaks the protocol schemas. Without it, a line of frames.ndjson, events.ndjson or
    objects.ndjson that cannot be read raises ValueError naming the file and line, while
    observations.ndjson (which nothing here needs) is read leniently."""
    path = Path(path)
    if not (path / "meta.json").is_file():
        raise FileNotFoundError(f"{path} is not a Clio episode: no meta.json")
    if validate:
        issues = validate_episode(path, schemas=schemas)
        if issues:
            raise EpisodeValidationError(path, issues)

    meta = parse_json((path / "meta.json").read_text(encoding="utf-8"))
    layout = hand_layout_problems(meta)
    if layout:
        raise ValueError(f"{path / 'meta.json'}: {'; '.join(f'{p}: {m}' for p, m in layout)}")

    t, head, hands, pinch, tracked = _load_frames(path / "frames.ndjson")
    events = [r for _, r in _timed(path / "events.ndjson")]
    object_lines = _timed(path / "objects.ndjson", required=False)
    observations = _lenient_timed(path / "observations.ndjson")
    finish_path = path / "finish.json"
    finish = parse_json(finish_path.read_text(encoding="utf-8")) if finish_path.is_file() else None
    media_dir = path / "media"
    media = (
        {p.name: p for p in sorted(media_dir.iterdir()) if p.is_file()}
        if media_dir.is_dir()
        else {}
    )
    return Episode(
        path=path,
        meta=meta,
        t=t,
        head=head,
        hands=hands,
        pinch=pinch,
        tracked=tracked,
        events=events,
        object_updates=[r for _, r in object_lines],
        objects=_object_tracks(meta.get("objects", []), object_lines),
        finish=finish,
        media=media,
        observations=observations,
    )


def _load_frames(path: Path):
    if not path.is_file():
        raise FileNotFoundError(f"{path} is missing")
    ts: list[float] = []
    heads: list[list[float]] = []
    samples: list[list[tuple[np.ndarray, float] | None]] = [[], []]
    for lineno, record in _iter_ndjson(path):
        try:
            ts.append(float(record["t"]))
            head = record["head"]
            if len(head) != 7:
                raise ValueError(f"head has {len(head)} values, expected 7")
            heads.append(head)
            for h, side in enumerate(HANDS):
                sample = record[side]
                if sample is None:
                    samples[h].append(None)
                    continue
                joints = np.asarray(sample["joints"], dtype=np.float32)
                if joints.shape != (NUM_JOINTS * JOINT_STRIDE,):
                    raise ValueError(f"{side}.joints has shape {joints.shape}")
                samples[h].append((joints.reshape(NUM_JOINTS, JOINT_STRIDE), sample["pinch"]))
        except (KeyError, TypeError, ValueError) as e:
            raise ValueError(
                f"{path.name}:{lineno}: cannot read frame ({type(e).__name__}: {e}); "
                "run `clio validate` for details"
            ) from e

    n = len(ts)
    hands = np.full((n, 2, NUM_JOINTS, JOINT_STRIDE), np.nan, dtype=np.float32)
    pinch = np.full((n, 2), np.nan, dtype=np.float32)
    tracked = np.zeros((n, 2), dtype=bool)
    for h in range(2):
        for i, sample in enumerate(samples[h]):
            if sample is not None:
                hands[i, h], pinch[i, h] = sample
                tracked[i, h] = True
    t = np.asarray(ts, dtype=np.float64)
    head = np.asarray(heads, dtype=np.float64).reshape(n, 7)
    return t, head, hands, pinch, tracked


def _iter_ndjson(path: Path):
    with path.open("rb") as f:
        for lineno, raw in enumerate(f, start=1):
            if not raw.strip():
                continue
            try:
                yield lineno, parse_json(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError) as e:
                raise ValueError(f"{path.name}:{lineno}: invalid JSON ({e})") from e


def _is_time(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and np.isfinite(value)


def _timed(path: Path, *, required: bool = True) -> list[tuple[int, dict[str, Any]]]:
    """(line number, record) of an NDJSON file in time order (stable: equal t keep file order).
    A line that is not an object with a numeric `t` raises ValueError naming it."""
    if not path.is_file():
        if required:
            raise FileNotFoundError(f"{path} is missing")
        return []
    records = []
    for lineno, record in _iter_ndjson(path):
        if not isinstance(record, dict) or not _is_time(record.get("t")):
            raise ValueError(
                f"{path.name}:{lineno}: not a record with a numeric t; "
                "run `clio validate` for details"
            )
        records.append((lineno, record))
    return sorted(records, key=lambda line: line[1]["t"])


def _lenient_timed(path: Path) -> list[dict[str, Any]]:
    """The records of an optional NDJSON file in time order, skipping lines that are not JSON
    objects with a numeric `t`."""
    if not path.is_file():
        return []
    records = []
    with path.open("rb") as f:
        for raw in f:
            try:
                record = parse_json(raw.decode("utf-8")) if raw.strip() else None
            except (ValueError, UnicodeDecodeError):
                continue
            if isinstance(record, dict) and _is_time(record.get("t")):
                records.append(record)
    return sorted(records, key=lambda r: r["t"])


def _object_tracks(
    placed: list[dict], lines: list[tuple[int, dict[str, Any]]]
) -> dict[str, ObjectTrack]:
    rows: dict[str, list[tuple]] = {}
    info: dict[str, tuple[str, float | None]] = {}
    for k, obj in enumerate(placed):
        try:
            info[obj["id"]] = (obj["label"], obj["radius"])
            position = _vector(obj["position"], 3, "position")
            source = obj["method"]
        except (KeyError, TypeError, ValueError) as e:
            raise ValueError(
                f"meta.json: cannot read objects[{k}] ({type(e).__name__}: {e})"
            ) from e
        # Placed when the episode was created, measured at a time nobody recorded: never counted
        # as tracked, whatever its method.
        rows.setdefault(obj["id"], []).append(
            (0.0, position, None, np.nan, source, POSITION_VALID, None, False, np.nan)
        )
    for lineno, update in lines:
        try:
            for state in update["objects"]:
                orientation = state["orientation"]
                info.setdefault(state["id"], (state["id"], None))
                row = (
                    float(update["t"]),
                    _vector(state["position"], 3, "position"),
                    None if orientation is None else _vector(orientation, 4, "orientation"),
                    float(state["confidence"]),
                    state["source"],
                    location_flags(state),
                    state.get("heldBy"),
                    "heldBy" in state,
                    np.nan if state.get("observedT") is None else float(state["observedT"]),
                )
                rows.setdefault(state["id"], []).append(row)
        except (KeyError, TypeError, ValueError) as e:
            raise ValueError(
                f"objects.ndjson:{lineno}: cannot read object state ({type(e).__name__}: {e}); "
                "run `clio validate` for details"
            ) from e
    tracks = {}
    for obj_id, samples in rows.items():
        label, radius = info[obj_id]
        tracks[obj_id] = ObjectTrack(
            id=obj_id,
            label=label,
            radius=radius,
            t=np.array([s[0] for s in samples], dtype=np.float64),
            position=np.array([s[1] for s in samples], dtype=np.float64).reshape(-1, 3),
            orientation=np.array(
                [s[2] if s[2] is not None else [np.nan] * 4 for s in samples], dtype=np.float64
            ).reshape(-1, 4),
            confidence=np.array([s[3] for s in samples], dtype=np.float64),
            source=[s[4] for s in samples],
            flags=np.array([s[5] for s in samples], dtype=np.uint8),
            held_by=[s[6] for s in samples],
            held_by_known=np.array([s[7] for s in samples], dtype=bool),
            observed_t=np.array([s[8] for s in samples], dtype=np.float64),
        )
    return tracks


def _vector(value: Any, n: int, name: str) -> list[float]:
    if not isinstance(value, list) or len(value) != n:
        raise ValueError(f"{name} must be a list of {n} numbers")
    return [float(x) for x in value]
