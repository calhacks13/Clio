"""Step segments and per-frame language labels, from `step.entered` / `step.completed` events."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .episode import Episode


@dataclass(frozen=True)
class Segment:
    """One run of a step. `start_t <= t < end_t`, except that a step still running when the
    recording stops (`runs_to_end`) also covers the last frame (`end_t`)."""

    step_id: str
    index: int  # the step's index in the procedure
    instruction: str  # the language label of every frame in the segment
    start_t: float
    end_t: float
    completed_by: str | None  # check | coach | user | skip; None if it was never completed
    forced: bool  # completed before its success check passed
    targets: tuple[str, ...] = ()
    action: dict[str, Any] | None = field(default=None, hash=False)  # meta.plan step's action
    # Still running when the recording stopped, so it ends at (and includes) the last frame.
    runs_to_end: bool = field(default=False, compare=False)

    @property
    def duration_ms(self) -> float:
        return self.end_t - self.start_t

    @property
    def action_verb(self) -> str | None:
        return self.action["verb"] if self.action else None


@dataclass(frozen=True)
class Mistake:
    t: float
    step_id: str
    kind: str
    message: str
    source: str  # rule | coach


@dataclass
class FrameLabels:
    """Per-frame labels, aligned with `Episode.t`."""

    segment: np.ndarray  # (N,) int: index into the segment list, -1 outside any step
    step_index: np.ndarray  # (N,) int: the active step's procedure index, -1 outside any step
    task: np.ndarray  # (N,) str: active step instruction; else the procedure title, or ""
    action_verb: np.ndarray  # (N,) str: active step's action verb (meta.plan), or ""


def step_segments(episode: Episode) -> list[Segment]:
    """Segments in time order. A step that is entered but never completed ends at the next
    `step.entered`, at `procedure.completed` / `procedure.aborted`, or at the last frame."""
    actions = _plan_actions(episode)
    segments: list[Segment] = []
    active: dict[str, Any] | None = None

    def close(end_t: float, completed: dict[str, Any] | None, runs_to_end: bool = False) -> None:
        assert active is not None
        segments.append(
            Segment(
                step_id=active["stepId"],
                index=active["index"],
                instruction=active["instruction"],
                start_t=float(active["t"]),
                end_t=max(float(end_t), float(active["t"])),
                completed_by=completed["by"] if completed else None,
                forced=bool(completed["forced"]) if completed else False,
                targets=tuple(active.get("targets", ())),
                action=actions.get(active["stepId"]),
                runs_to_end=runs_to_end,
            )
        )

    for event in episode.events:
        if event["type"] == "step.entered":
            if active is not None:
                close(event["t"], None)
            active = event
        elif event["type"] == "step.completed":
            if active is not None and event["stepId"] == active["stepId"]:
                close(event["t"], event)
                active = None
        elif event["type"] in ("procedure.completed", "procedure.aborted"):
            if active is not None:
                close(event["t"], None)
                active = None
    if active is not None:
        close(episode.t[-1] if episode.n_frames else active["t"], None, runs_to_end=True)
    return segments


def frame_labels(episode: Episode, segments: list[Segment] | None = None) -> FrameLabels:
    if segments is None:
        segments = step_segments(episode)
    t = episode.t
    segment = np.full(len(t), -1, dtype=np.int64)
    for k, s in enumerate(segments):
        inside = (t >= s.start_t) & ((t <= s.end_t) if s.runs_to_end else (t < s.end_t))
        segment[inside] = k
    outside_task = episode.procedure_title or ""
    tasks = np.array([s.instruction for s in segments] + [outside_task], dtype=object)
    verbs = np.array([s.action_verb or "" for s in segments] + [""], dtype=object)
    indices = np.array([s.index for s in segments] + [-1], dtype=np.int64)
    # segment == -1 picks the trailing "outside any step" entry of each lookup table
    return FrameLabels(
        segment=segment,
        step_index=indices[segment],
        task=tasks[segment],
        action_verb=verbs[segment],
    )


def mistakes(episode: Episode) -> list[Mistake]:
    return [
        Mistake(
            t=float(e["t"]),
            step_id=e["stepId"],
            kind=e["kind"],
            message=e["message"],
            source=e["source"],
        )
        for e in episode.events_of("mistake.detected")
    ]


def _plan_actions(episode: Episode) -> dict[str, dict[str, Any]]:
    plan = episode.plan or {}
    return {step["id"]: step["action"] for step in plan.get("steps", []) if step.get("action")}
