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


@dataclass
class ObjectTrack:
    """One object's estimates over time: its `meta.objects` placement (t = 0), then each
    objects.ndjson update. Sample k holds from t[k] until the next sample."""

    id: str
    label: str
    radius: float | None
    t: np.ndarray  # (K,) ms
    position: np.ndarray  # (K, 3) workspace frame
    orientation: np.ndarray  # (K, 4) [x, y, z, w]; NaN when unknown (non-marker estimates)
    confidence: np.ndarray  # (K,); NaN for the meta placement
    source: list[str]  # placement method / tracker source per sample

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
    any file breaks the protocol schemas."""
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
    events = _sorted_by_t(_read_ndjson(path / "events.ndjson"))
    object_updates = _sorted_by_t(_read_ndjson(path / "objects.ndjson", required=False))
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
        object_updates=object_updates,
        objects=_object_tracks(meta.get("objects", []), object_updates),
        finish=finish,
        media=media,
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


def _read_ndjson(path: Path, *, required: bool = True) -> list[dict[str, Any]]:
    if not path.is_file():
        if required:
            raise FileNotFoundError(f"{path} is missing")
        return []
    return [record for _, record in _iter_ndjson(path)]


def _sorted_by_t(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(records, key=lambda r: r["t"])  # stable: equal-t records keep file order


def _object_tracks(placed: list[dict], updates: list[dict]) -> dict[str, ObjectTrack]:
    rows: dict[str, list[tuple]] = {}
    info: dict[str, tuple[str, float | None]] = {}
    for obj in placed:
        info[obj["id"]] = (obj["label"], obj["radius"])
        rows.setdefault(obj["id"], []).append(
            (0.0, obj["position"], None, float("nan"), obj["method"])
        )
    for update in updates:
        for state in update["objects"]:
            info.setdefault(state["id"], (state["id"], None))
            rows.setdefault(state["id"], []).append(
                (
                    float(update["t"]),
                    state["position"],
                    state["orientation"],
                    float(state["confidence"]),
                    state["source"],
                )
            )
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
        )
    return tracks
