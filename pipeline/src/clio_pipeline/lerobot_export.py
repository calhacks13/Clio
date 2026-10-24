"""Export Clio episodes to a LeRobot dataset (format v3.0; tested with lerobot 0.6.1).

One LeRobot episode per Clio episode, resampled to a fixed fps. Per frame:

- `observation.state` float32 (16,): per hand, left then right: wrist position (3), wrist
  quaternion [x, y, z, w] (4) and pinch aperture in meters (1), in the z-up robot frame.
  A hand that is not tracked holds its last known value (or its first, before it is first seen).
- `action` float32 (16,): the next frame's state; the last frame repeats.
- `observation.hand_mask` float32 (2,): 1 where the hand is tracked.
- `observation.environment_state` float32 (3K,): positions of all objects (sorted ids), robot
  frame. Present only when the episodes have objects.
- `step.action_verb` string: the active step's action primitive verb from `meta.plan`, or "".
- `task`: the active step's instruction (language-conditioned), else the procedure title.

Clio-specific provenance (episode ids, segments, mistakes) goes to `meta/clio_episodes.jsonl`.
Needs the `lerobot` extra (Python >= 3.12).
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .episode import Episode, load_episode
from .frames import (
    HANDS,
    WRIST,
    make_quaternions_continuous,
    workspace_to_robot_position,
    workspace_to_robot_quaternion,
)
from .resample import EXACT_MS, Resampled, resample_episode, resample_objects
from .segments import mistakes, step_segments

ROBOT_TYPE = "human_hands"
ACTION_VERB_KEY = "step.action_verb"  # not "action.*": LeRobot treats those as policy actions
STATE_NAMES = [
    f"{side}_{name}"
    for side in HANDS
    for name in (
        "wrist_x",
        "wrist_y",
        "wrist_z",
        "wrist_qx",
        "wrist_qy",
        "wrist_qz",
        "wrist_qw",
        "pinch",
    )
]
_UNSEEN_HAND = np.array([0, 0, 0, 0, 0, 0, 1, 0], dtype=np.float64)  # never tracked at all


@dataclass
class EpisodeArrays:
    """Everything one LeRobot episode needs, aligned on the resampled grid."""

    resampled: Resampled
    state: np.ndarray  # (M, 16) float32
    action: np.ndarray  # (M, 16) float32
    hand_mask: np.ndarray  # (M, 2) float32
    environment_state: np.ndarray | None  # (M, 3K) float32
    task: list[str]
    action_verb: list[str]

    def __len__(self) -> int:
        return len(self.state)


@dataclass
class ExportedEpisode:
    source: Path
    episode_id: str
    episode_index: int
    frames: int
    skipped_media: list[str] = field(default_factory=list)


@dataclass
class ExportResult:
    root: Path
    repo_id: str
    fps: int
    codebase_version: str
    episodes: list[ExportedEpisode]
    skipped: list[tuple[Path, str]]  # (episode dir, reason)


def episode_arrays(
    episode: Episode, fps: int = 30, object_ids: Sequence[str] = ()
) -> EpisodeArrays:
    r = resample_episode(episode, fps=fps)
    wrist = r.hands[:, :, WRIST].astype(np.float64)  # (M, 2, 8)
    raw = np.concatenate(
        [
            workspace_to_robot_position(wrist[..., :3]),
            workspace_to_robot_quaternion(wrist[..., 3:7]),
            r.pinch[..., None].astype(np.float64),
        ],
        axis=-1,
    )  # (M, 2, 8); NaN where untracked
    held = _hold_last_known(raw, r.tracked)
    held[..., 3:7] = make_quaternions_continuous(held[..., 3:7])
    state = held.reshape(len(r), 16).astype(np.float32)
    action = np.concatenate([state[1:], state[-1:]]) if len(state) else state.copy()
    env = None
    if object_ids:
        positions = workspace_to_robot_position(resample_objects(episode, r.t, object_ids))
        env = np.nan_to_num(positions, nan=0.0).reshape(len(r), 3 * len(object_ids))
        env = env.astype(np.float32)
    return EpisodeArrays(
        resampled=r,
        state=state,
        action=action,
        hand_mask=r.tracked.astype(np.float32),
        environment_state=env,
        task=[str(x) for x in r.task],
        action_verb=[str(x) for x in r.action_verb],
    )


def _hold_last_known(values: np.ndarray, tracked: np.ndarray) -> np.ndarray:
    """Fill untracked frames (M, H, D) with the hand's previous tracked value; frames before the
    first tracked one take that first value; a hand never tracked gets `_UNSEEN_HAND`."""
    out = np.empty_like(values)
    frames = np.arange(len(values))
    for h in range(values.shape[1]):
        seen = tracked[:, h]
        if not seen.any():
            out[:, h] = _UNSEEN_HAND
            continue
        last = np.maximum.accumulate(np.where(seen, frames, -1))
        source = np.where(last >= 0, last, np.argmax(seen))
        out[:, h] = values[source, h]
    return out


def lerobot_features(object_ids: Sequence[str]) -> dict[str, dict]:
    features = {
        "observation.state": {"dtype": "float32", "shape": (16,), "names": list(STATE_NAMES)},
        "action": {"dtype": "float32", "shape": (16,), "names": list(STATE_NAMES)},
        "observation.hand_mask": {"dtype": "float32", "shape": (2,), "names": list(HANDS)},
        ACTION_VERB_KEY: {"dtype": "string", "shape": (1,), "names": None},
    }
    if object_ids:
        features["observation.environment_state"] = {
            "dtype": "float32",
            "shape": (3 * len(object_ids),),
            "names": [f"{obj}_{axis}" for obj in object_ids for axis in "xyz"],
        }
    return features


def export_lerobot(
    episode_dirs: Sequence[Path | str],
    out: Path | str,
    *,
    repo_id: str,
    fps: int = 30,
    validate: bool = True,
    overwrite: bool = False,
) -> ExportResult:
    """Write the episodes to a new LeRobot dataset at `out`. With `validate`, every episode is
    checked against the protocol schemas first (EpisodeValidationError on failure)."""
    try:
        from lerobot.datasets.lerobot_dataset import LeRobotDataset
    except ImportError as e:  # pragma: no cover - depends on the environment
        raise ImportError(
            "LeRobot export needs the `lerobot` extra (Python >= 3.12): uv sync --extra lerobot"
        ) from e

    if isinstance(fps, float) and not fps.is_integer():
        raise ValueError(f"LeRobot needs an integer fps, got {fps}")
    fps = int(fps)
    out = Path(out)
    episodes = [load_episode(d, validate=validate) for d in episode_dirs]
    if not any(ep.n_frames for ep in episodes):
        raise ValueError("nothing to export: the episodes have no frames")
    if out.exists():
        if not overwrite:
            raise FileExistsError(f"{out} already exists (pass overwrite=True to replace it)")
        shutil.rmtree(out)

    object_ids = sorted({obj_id for ep in episodes for obj_id in ep.objects})
    dataset = LeRobotDataset.create(
        repo_id=repo_id,
        fps=fps,
        features=lerobot_features(object_ids),
        root=out,
        robot_type=ROBOT_TYPE,
        use_videos=False,
    )
    exported: list[ExportedEpisode] = []
    skipped: list[tuple[Path, str]] = []
    sidecar: list[dict] = []
    try:
        for ep in episodes:
            arrays = episode_arrays(ep, fps=fps, object_ids=object_ids)
            if len(arrays) == 0:
                skipped.append((ep.path, "no frames"))
                continue
            for k in range(len(arrays)):
                frame = {
                    "observation.state": arrays.state[k],
                    "action": arrays.action[k],
                    "observation.hand_mask": arrays.hand_mask[k],
                    ACTION_VERB_KEY: arrays.action_verb[k],
                    "task": arrays.task[k],
                }
                if arrays.environment_state is not None:
                    frame["observation.environment_state"] = arrays.environment_state[k]
                dataset.add_frame(frame)
            dataset.save_episode()
            record = ExportedEpisode(
                source=ep.path,
                episode_id=ep.episode_id,
                episode_index=len(exported),
                frames=len(arrays),
                skipped_media=sorted(ep.media),  # video is not exported yet
            )
            exported.append(record)
            sidecar.append(_provenance(ep, arrays, record))
    finally:
        dataset.finalize()

    with (out / "meta" / "clio_episodes.jsonl").open("w") as f:
        for line in sidecar:
            f.write(json.dumps(line) + "\n")
    info = json.loads((out / "meta" / "info.json").read_text())
    return ExportResult(
        root=out,
        repo_id=repo_id,
        fps=fps,
        codebase_version=info["codebase_version"],
        episodes=exported,
        skipped=skipped,
    )


def _frame_at(grid: np.ndarray, t: float) -> int:
    """Index of the grid frame at or just before `t`."""
    return max(int(np.searchsorted(grid, t + EXACT_MS, side="right")) - 1, 0)


def _provenance(ep: Episode, arrays: EpisodeArrays, record: ExportedEpisode) -> dict:
    grid = arrays.resampled.t
    segments = []
    for k, s in enumerate(step_segments(ep)):
        frames = np.flatnonzero(arrays.resampled.segment == k)
        segments.append(
            {
                "step_id": s.step_id,
                "index": s.index,
                "instruction": s.instruction,
                "action_verb": s.action_verb,
                "start_frame": int(frames[0]) if len(frames) else None,
                "end_frame": int(frames[-1]) + 1 if len(frames) else None,
                "completed_by": s.completed_by,
                "forced": s.forced,
            }
        )
    plan = ep.plan or {}
    return {
        "episode_index": record.episode_index,
        "episode_id": ep.episode_id,
        "source": str(ep.path),
        "mode": ep.meta.get("mode"),
        "procedure": ep.meta.get("procedure"),
        "plan_origin": plan.get("origin"),
        "outcome": (ep.finish or {}).get("outcome"),
        "frames": record.frames,
        "start_t_ms": float(grid[0]),
        "segments": segments,
        "mistakes": [
            {
                "frame_index": _frame_at(grid, m.t),
                "t_ms": m.t,
                "step_id": m.step_id,
                "kind": m.kind,
                "message": m.message,
                "source": m.source,
            }
            for m in mistakes(ep)
        ],
        "skipped_media": record.skipped_media,
    }
