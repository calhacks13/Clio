"""Replay an episode in Rerun (https://rerun.io): hands, head, objects, steps, coach activity.

Everything is logged in the workspace frame W (y-up, RUB) on a `time` timeline in seconds since the
episode started. Requires the `viz` extra (rerun-sdk).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import rerun as rr
import rerun.blueprint as rrb

from .episode import Episode
from .frames import FINGER_CHAINS, HANDS, NUM_JOINTS
from .segments import step_segments

TIMELINE = "time"
HAND_COLORS = {"left": (80, 160, 255), "right": (255, 140, 60)}
OBJECT_COLOR = (90, 220, 120)
DEFAULT_OBJECT_RADIUS = 0.03  # the procedure default
# Quest 3 field of view is roughly 110 x 96 degrees.
HEAD_FOV_Y = np.radians(96.0)
HEAD_ASPECT = 110.0 / 96.0


def new_recording(episode: Episode) -> rr.RecordingStream:
    rec = rr.RecordingStream("clio", recording_id=episode.episode_id)
    rec.set_log_time_enabled(False)  # only the episode's own timeline
    rec.set_log_tick_enabled(False)
    return rec


def default_blueprint() -> rrb.Blueprint:
    return rrb.Blueprint(
        rrb.Horizontal(
            rrb.Spatial3DView(origin="world", name="Workspace"),
            rrb.Vertical(
                rrb.TextDocumentView(origin="steps/current", name="Current step"),
                rrb.TimeSeriesView(origin="pinch", name="Pinch aperture (m)"),
                rrb.TextLogView(origin="events", name="Events"),
                row_shares=[1, 2, 3],
            ),
            column_shares=[3, 2],
        ),
        collapse_panels=True,
    )


def save_rrd(episode: Episode, path: Path | str) -> Path:
    """Write the episode to an .rrd file (open it with `rerun out.rrd`)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    rec = new_recording(episode)
    rec.save(path, default_blueprint=default_blueprint())
    log_episode(rec, episode)
    rec.disconnect()  # flushes and writes the footer
    return path


def spawn_viewer(episode: Episode) -> None:
    """Start (or connect to) a Rerun viewer and stream the episode to it."""
    rec = new_recording(episode)
    rec.spawn(default_blueprint=default_blueprint())
    log_episode(rec, episode)
    rec.flush()
    rec.disconnect()


def log_episode(rec: rr.RecordingStream, episode: Episode) -> None:
    rec.log("world", rr.ViewCoordinates.RUB, static=True)
    rec.log(
        "world/workspace_axes",
        rr.Arrows3D(
            vectors=np.eye(3) * 0.1,
            colors=[(230, 60, 60), (60, 200, 60), (60, 100, 230)],
            labels=["+x", "+y (up)", "+z (to user)"],
        ),
        static=True,
    )
    seconds = episode.t / 1000.0
    if episode.n_frames:
        _log_head(rec, episode, seconds)
        for h, side in enumerate(HANDS):
            _log_hand(rec, episode, h, side, seconds)
    _log_objects(rec, episode)
    _log_steps(rec, episode)
    _log_events(rec, episode)


def _time(seconds: np.ndarray) -> list[rr.TimeColumn]:
    return [rr.TimeColumn(TIMELINE, duration=seconds)]


def _log_head(rec: rr.RecordingStream, episode: Episode, seconds: np.ndarray) -> None:
    rec.send_columns(
        "world/head",
        indexes=_time(seconds),
        columns=rr.Transform3D.columns(
            translation=episode.head[:, :3], quaternion=episode.head[:, 3:7]
        ),
    )
    rec.log("world/head", rr.TransformAxes3D(0.05), static=True)
    rec.log(
        "world/head/view",
        rr.Pinhole(
            fov_y=float(HEAD_FOV_Y),
            aspect_ratio=HEAD_ASPECT,
            camera_xyz=rr.ViewCoordinates.RUB,  # WebXR viewer space looks down -z
            image_plane_distance=0.08,
        ),
        static=True,
    )


def _log_hand(
    rec: rr.RecordingStream, episode: Episode, h: int, side: str, seconds: np.ndarray
) -> None:
    tracked = episode.tracked[:, h]
    n = int(tracked.sum())
    base = f"world/hands/{side}"
    color = HAND_COLORS[side]
    if n:
        joints = episode.hands[tracked, h]  # (n, 25, 8)
        rec.send_columns(
            f"{base}/joints",
            indexes=_time(seconds[tracked]),
            columns=[
                *rr.Points3D.columns(
                    positions=joints[..., :3].reshape(-1, 3), radii=joints[..., 7].reshape(-1)
                ).partition([NUM_JOINTS] * n),
                *rr.Points3D.columns(colors=[color] * n),
            ],
        )
        strips = [joints[k, list(chain), :3] for k in range(n) for chain in FINGER_CHAINS]
        rec.send_columns(
            f"{base}/bones",
            indexes=_time(seconds[tracked]),
            columns=[
                *rr.LineStrips3D.columns(strips=strips).partition([len(FINGER_CHAINS)] * n),
                *rr.LineStrips3D.columns(colors=[color] * n, radii=[0.002] * n),
            ],
        )
        pinch = episode.pinch[tracked, h].astype(np.float64)
        rec.send_columns(
            f"pinch/{side}",
            indexes=_time(seconds[tracked]),
            columns=rr.Scalars.columns(scalars=pinch),
        )
        rec.log(f"pinch/{side}", rr.SeriesLines(colors=[color], names=[side]), static=True)
    # Clear when tracking drops, so neither the skeleton nor the pinch curve bridges the gap.
    drops = np.flatnonzero(tracked[:-1] & ~tracked[1:]) + 1
    if len(drops):
        rec.send_columns(
            base,
            indexes=_time(seconds[drops]),
            columns=rr.Clear.columns(is_recursive=[True] * len(drops)),
        )
        rec.send_columns(
            f"pinch/{side}",
            indexes=_time(seconds[drops]),
            columns=rr.Clear.columns(is_recursive=[False] * len(drops)),
        )


def _log_objects(rec: rr.RecordingStream, episode: Episode) -> None:
    for obj_id, track in episode.objects.items():
        path = f"world/objects/{rr.escape_entity_path_part(obj_id)}"
        r = track.radius or DEFAULT_OBJECT_RADIUS
        for k in range(len(track.t)):
            rec.set_time(TIMELINE, duration=float(track.t[k]) / 1000.0)
            label = track.label
            if not np.isnan(track.confidence[k]):
                label = f"{label} ({track.source[k]} {track.confidence[k]:.2f})"
            box: dict[str, Any] = {
                "centers": [track.position[k]],
                "half_sizes": [[r, r, r]],
                "labels": [label],
                "colors": [OBJECT_COLOR],
            }
            if not np.isnan(track.orientation[k]).any():
                box["quaternions"] = [rr.Quaternion(xyzw=track.orientation[k])]
            # clear_unset: an update without an orientation must not inherit the previous one
            rec.log(path, rr.Boxes3D.from_fields(clear_unset=True, **box))


def _log_steps(rec: rr.RecordingStream, episode: Episode) -> None:
    """The current instruction as a document that follows the time cursor."""
    outside = episode.procedure_title or ""
    rec.set_time(TIMELINE, duration=float(episode.t[0]) / 1000.0 if episode.n_frames else 0.0)
    rec.log("steps/current", rr.TextDocument(outside))
    for s in step_segments(episode):
        rec.set_time(TIMELINE, duration=s.start_t / 1000.0)
        rec.log("steps/current", rr.TextDocument(f"Step {s.index}: {s.instruction}"))
        if s.completed_by is not None:
            rec.set_time(TIMELINE, duration=s.end_t / 1000.0)
            rec.log("steps/current", rr.TextDocument(outside))


def _action_text(action: dict[str, Any] | None) -> str:
    if not action:
        return ""
    words = [
        action["verb"],
        action.get("object"),
        action.get("target") and f"-> {action['target']}",
    ]
    return f"  [action: {' '.join(w for w in words if w)}]"


def _log_events(rec: rr.RecordingStream, episode: Episode) -> None:
    plan_steps = {s["id"]: s for s in (episode.plan or {}).get("steps", [])}
    for e in episode.events:
        rec.set_time(TIMELINE, duration=float(e["t"]) / 1000.0)
        kind = e["type"]
        if kind == "step.entered":
            action = plan_steps.get(e["stepId"], {}).get("action")
            text = f"Step {e['index']} ({e['stepId']}): {e['instruction']}{_action_text(action)}"
            _text(rec, "events/steps", text, "INFO")
        elif kind == "step.completed":
            forced = " (forced)" if e["forced"] else ""
            _text(rec, "events/steps", f"Completed {e['stepId']} by {e['by']}{forced}", "INFO")
        elif kind == "mistake.detected":
            _text(rec, "events/mistakes", f"{e['kind']} ({e['source']}): {e['message']}", "WARN")
        elif kind == "coach.tool_call":
            _text(rec, "events/coach/tool_calls", f"{e['name']}({json.dumps(e['args'])})", "INFO")
        elif kind == "coach.tool_result":
            status = "ok" if e["ok"] else "failed"
            text = f"{e['name']} -> {status}: {json.dumps(e['result'])}"
            _text(rec, "events/coach/tool_results", text, "DEBUG" if e["ok"] else "WARN")
        elif kind == "transcript":
            level = "INFO" if e["final"] else "DEBUG"
            _text(rec, "events/transcript", f"{e['role']}: {e['text']}", level)
        elif kind == "coach.narration":
            _text(rec, "events/coach/narration", f"[{e['kind']}] {e['text']}", "DEBUG")
        elif kind == "coach.status":
            detail = f": {e['detail']}" if e.get("detail") else ""
            level = "ERROR" if e["state"] == "error" else "INFO"
            _text(rec, "events/coach/status", f"{e['state']}{detail}", level)
        elif kind == "hand.pinch":
            _log_pinch(rec, e)
        elif kind.startswith("procedure."):
            payload = {k: v for k, v in e.items() if k not in ("t", "type")}
            _text(rec, "events/procedure", f"{kind} {json.dumps(payload)}", "INFO")
        else:
            payload = {k: v for k, v in e.items() if k not in ("t", "type")}
            _text(rec, f"events/{kind.replace('.', '_')}", f"{kind} {json.dumps(payload)}", "DEBUG")


def _log_pinch(rec: rr.RecordingStream, e: dict[str, Any]) -> None:
    nearest = e.get("nearest")
    near = f" near {nearest['objectId']} ({nearest['distance'] * 100:.1f} cm)" if nearest else ""
    _text(rec, f"events/pinch/{e['hand']}", f"{e['hand']} pinch {e['phase']}{near}", "DEBUG")
    path = f"world/pinches/{e['hand']}"
    if e["phase"] == "start":
        rec.log(path, rr.Points3D([e["point"]], radii=[0.008], colors=[HAND_COLORS[e["hand"]]]))
    else:
        rec.log(path, rr.Clear(recursive=False))


def _text(rec: rr.RecordingStream, path: str, text: str, level: str) -> None:
    rec.log(path, rr.TextLog(text, level=level))
