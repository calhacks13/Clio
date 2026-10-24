"""Synthetic Clio episodes for tests.

`EpisodeBuilder` writes an episode directory (meta.json, frames.ndjson, events.ndjson, and
optionally objects.ndjson, finish.json and media/) in the on-disk layout of docs/data-format.md.
`test_synthetic_builder.py` validates its output against the real JSON Schemas in
packages/protocol/schema with plain jsonschema, so the builder can't drift from the contract.

The joint layout below mirrors packages/protocol/src/hand.ts on purpose instead of importing it
from clio_pipeline, so loader tests compare the package against an independent copy.
"""

from __future__ import annotations

import copy
import json
import math
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_DIR = REPO_ROOT / "packages" / "protocol" / "schema"

HAND_JOINTS = [
    "wrist",
    "thumb-metacarpal",
    "thumb-phalanx-proximal",
    "thumb-phalanx-distal",
    "thumb-tip",
    "index-finger-metacarpal",
    "index-finger-phalanx-proximal",
    "index-finger-phalanx-intermediate",
    "index-finger-phalanx-distal",
    "index-finger-tip",
    "middle-finger-metacarpal",
    "middle-finger-phalanx-proximal",
    "middle-finger-phalanx-intermediate",
    "middle-finger-phalanx-distal",
    "middle-finger-tip",
    "ring-finger-metacarpal",
    "ring-finger-phalanx-proximal",
    "ring-finger-phalanx-intermediate",
    "ring-finger-phalanx-distal",
    "ring-finger-tip",
    "pinky-finger-metacarpal",
    "pinky-finger-phalanx-proximal",
    "pinky-finger-phalanx-intermediate",
    "pinky-finger-phalanx-distal",
    "pinky-finger-tip",
]
JOINT_FIELDS = ["px", "py", "pz", "qx", "qy", "qz", "qw", "radius"]

# Joint offsets from the wrist (meters, workspace frame): fingers point away from the user (-z).
_FINGER_X = {"thumb": 0.035, "index": 0.02, "middle": 0.0, "ring": -0.018, "pinky": -0.034}
_FINGER_LEN = {"thumb": 0.11, "index": 0.17, "middle": 0.18, "ring": 0.17, "pinky": 0.15}


def _joint_offsets() -> list[tuple[float, float, float]]:
    offsets = [(0.0, 0.0, 0.0)]
    for finger, n in [("thumb", 4), ("index", 5), ("middle", 5), ("ring", 5), ("pinky", 5)]:
        for k in range(1, n + 1):
            frac = k / n
            offsets.append((_FINGER_X[finger] * frac, 0.0, -_FINGER_LEN[finger] * frac))
    return offsets


JOINT_OFFSETS = _joint_offsets()

PROCEDURE = {"id": "shirt-fold", "version": 1, "title": "Fold a T-shirt in two seconds"}
SHIRT_STEPS = [
    ("lay-flat", "Lay the shirt flat in the outline, face up, collar on the left.", []),
    ("pinch-shoulder", "With your left hand, pinch the shirt at the shoulder dot.", ["shoulder"]),
    ("pinch-middle", "Keep holding. With your right hand, pinch the middle dot.", ["middle"]),
]
DEFAULT_HEAD = [0.3, 0.45, 0.35, 0.0, 0.0, 0.0, 1.0]
QUAT_Y90 = [0.0, 0.7071, 0.0, 0.7071]  # 90 degrees about +y, quantized to 1e-4 like the recorder


def _point(id_: str, label: str, x: float) -> dict:
    return {
        "id": id_,
        "label": label,
        "kind": "point",
        "radius": 0.025,
        "hidden": False,
        "placement": {"method": "layout", "position": [x, 0.0, -0.18]},
    }


def _pinch_near(obj: str, hand_: str) -> dict:
    return {"type": "pinch_near", "object": obj, "hand": hand_, "radius": 0.05, "dwellMs": 0}


# meta.plan: the full Procedure snapshot (output shape, every default filled in) of an
# LLM-generated lesson. Steps carry `action` primitives.
PLAN = {
    "schema": "clio.procedure/1",
    "id": "shirt-fold",
    "version": 1,
    "origin": {
        "kind": "generated",
        "goal": "fold my t-shirt fast",
        "model": "gemini-test",
        "createdAt": "2026-10-24T03:14:00.000Z",
    },
    "title": "Fold a T-shirt in two seconds",
    "summary": "Three pinch points on one line, one crossover, one lift.",
    "workspace": {"size": [0.8, 0.6]},
    "objects": [
        _point("shoulder", "shoulder dot", 0.14),
        _point("middle", "middle dot", 0.4),
        _point("hem", "hem dot", 0.68),
        {
            "id": "hanger",
            "label": "coat hanger",
            "kind": "tool",
            "radius": 0.1,
            "hidden": False,
            "placement": {"method": "detect", "hint": "left of the shirt"},
        },
    ],
    "steps": [
        {
            "id": "lay-flat",
            "instruction": SHIRT_STEPS[0][1],
            "targets": [],
            "hand": "either",
            "action": {"verb": "other", "hand": "both", "note": "smooth the shirt flat"},
            "show": [],
            "success": {"type": "confirm", "by": "either"},
            "mistakes": [],
        },
        {
            "id": "pinch-shoulder",
            "instruction": SHIRT_STEPS[1][1],
            "targets": ["shoulder"],
            "hand": "left",
            "action": {"verb": "pinch", "object": "shoulder", "hand": "left"},
            "show": [
                {
                    "object": "shoulder",
                    "phrase": "shoulder dot",
                    "description": "Small blue sticker dot on the shirt's left shoulder seam, "
                    "nearest the collar",
                }
            ],
            "success": _pinch_near("shoulder", "left"),
            "mistakes": [
                {
                    "kind": "wrong_hand",
                    "message": "Use your left hand.",
                    "when": _pinch_near("shoulder", "right"),
                    "cooldownMs": 4000,
                }
            ],
        },
        {
            "id": "pinch-middle",
            "instruction": SHIRT_STEPS[2][1],
            "targets": ["middle"],
            "hand": "right",
            "show": [],
            "success": _pinch_near("middle", "right"),
            "mistakes": [],
        },
    ],  # pinch-middle deliberately has no action
    "coach": {},
}


def _q(x: float, step: float) -> float:
    """Quantize like the recorder (0.1 mm positions, 1e-4 quaternions)."""
    return round(round(x / step) * step, 6)


def hand(
    wrist: tuple[float, float, float] | list[float],
    quat: tuple[float, ...] | list[float] = (0.0, 0.0, 0.0, 1.0),
    pinch: float = 0.03,
    radius: float = 0.01,
) -> dict:
    """A HandSample: every joint at wrist + a fixed offset, all with the same orientation."""
    joints: list[float] = []
    for i, (ox, oy, oz) in enumerate(JOINT_OFFSETS):
        pos = [_q(wrist[0] + ox, 1e-4), _q(wrist[1] + oy, 1e-4), _q(wrist[2] + oz, 1e-4)]
        r = radius if i == 0 else round(radius * 0.8, 4)
        joints.extend(pos + [_q(c, 1e-4) for c in quat] + [r])
    return {"joints": joints, "pinch": _q(pinch, 1e-4)}


def make_meta(episode_id: str, procedure: dict | None = PROCEDURE, objects=None) -> dict:
    if objects is None:
        objects = [
            {
                "id": "shoulder",
                "label": "shoulder dot",
                "position": [0.14, 0.0, -0.18],
                "radius": 0.025,
                "method": "layout",
            },
            {
                "id": "middle",
                "label": "middle dot",
                "position": [0.4, 0.0, -0.18],
                "radius": 0.025,
                "method": "layout",
            },
            {
                "id": "hem",
                "label": "hem dot",
                "position": [0.68, 0.0, -0.18],
                "radius": 0.025,
                "method": "layout",
            },
        ]
    return {
        "schema": "clio.episode/1",
        "episodeId": episode_id,
        "createdAt": "2026-10-24T03:15:02.000Z",
        "mode": "learn",
        "procedure": copy.deepcopy(procedure),
        "operator": {"role": "learner"},
        "clock": {"timeline": "performance.now", "startEpochMs": 1792811702000.0},
        "space": {
            "frame": "workspace",
            "units": "m",
            "upAxis": "+y",
            "worldFromWorkspace": [-0.4, 0.75, -0.5, 0.0, 0.0, 0.0, 1.0],
            "calibration": "pinch_two_corners",
            "anchored": False,
        },
        "hands": {"joints": list(HAND_JOINTS), "jointFields": list(JOINT_FIELDS)},
        "objects": objects,
        "coach": {"kind": "scripted"},
        "device": {"userAgent": "synthetic", "emulated": True, "xrFeatures": ["hand-tracking"]},
        "app": {"version": "0.0.0-test"},
    }


def object_state(id_: str, position, *, orientation=None, confidence=0.9, source="marker") -> dict:
    return {
        "id": id_,
        "position": list(position),
        "orientation": orientation,
        "confidence": confidence,
        "source": source,
    }


class EpisodeBuilder:
    """Accumulates an episode in memory and writes it in the server's on-disk layout."""

    def __init__(
        self, root: Path, episode_id: str, procedure: dict | None = PROCEDURE, objects=None
    ) -> None:
        self.dir = root / episode_id
        self.meta = make_meta(episode_id, procedure, objects)
        self.frames: list[dict] = []
        self.events: list[dict] = []
        self.object_lines: list[dict] | None = None
        self.finish: dict | None = None
        self.media: dict[str, bytes] = {}

    hand = staticmethod(hand)
    object_state = staticmethod(object_state)

    def frame(
        self,
        t: float,
        *,
        left: dict | None = None,
        right: dict | None = None,
        head: list[float] | None = None,
    ) -> EpisodeBuilder:
        head = list(DEFAULT_HEAD if head is None else head)
        self.frames.append({"t": t, "head": head, "left": left, "right": right})
        return self

    def event(self, t: float, type_: str, **payload) -> EpisodeBuilder:
        self.events.append({"t": t, "type": type_, **payload})
        return self

    def step_entered(
        self, t: float, step_id: str, index: int, instruction: str, targets=()
    ) -> EpisodeBuilder:
        return self.event(
            t,
            "step.entered",
            stepId=step_id,
            index=index,
            instruction=instruction,
            targets=list(targets),
        )

    def step_completed(
        self,
        t: float,
        step_id: str,
        index: int,
        *,
        by: str = "check",
        forced: bool = False,
        duration_ms: float = 0.0,
    ) -> EpisodeBuilder:
        return self.event(
            t,
            "step.completed",
            stepId=step_id,
            index=index,
            by=by,
            forced=forced,
            durationMs=duration_ms,
        )

    def track(self, t: float, *objects: dict) -> EpisodeBuilder:
        if self.object_lines is None:
            self.object_lines = []
        self.object_lines.append({"t": t, "objects": list(objects)})
        return self

    def write(self) -> Path:
        self.dir.mkdir(parents=True, exist_ok=False)
        (self.dir / "meta.json").write_text(json.dumps(self.meta, indent=2) + "\n")
        _write_ndjson(self.dir / "frames.ndjson", self.frames)
        _write_ndjson(self.dir / "events.ndjson", self.events)
        if self.object_lines is not None:
            _write_ndjson(self.dir / "objects.ndjson", self.object_lines)
        if self.finish is not None:
            (self.dir / "finish.json").write_text(json.dumps(self.finish) + "\n")
        for name, data in self.media.items():
            (self.dir / "media").mkdir(exist_ok=True)
            (self.dir / "media" / name).write_bytes(data)
        return self.dir


def _write_ndjson(path: Path, records: list[dict]) -> None:
    with path.open("w") as f:
        for r in records:
            f.write(json.dumps(r, separators=(",", ":")) + "\n")


# --- the default synthetic episode ---------------------------------------------------------------
#
# 180 frames at 60 Hz: t_k = k * 1000/60 ms (rounded to 1 us), so t_6 = 100, t_60 = 1000,
# t_120 = 2000 and the last frame t_179 = 2983.333.
# - left hand: always tracked; wrist (0.1 + 0.0005 k, 0.08, -0.18), identity orientation,
#   pinch 0.05 - 0.0002 k
# - right hand: wrist (0.4, 0.08, -0.18) rotated 90 degrees about +y, pinch 0.04; NOT tracked for
#   frames 60..89 (t = 1000 .. 1483.333)
# - steps: lay-flat [100, 1000) by coach, pinch-shoulder [1000, 2000) by check,
#   pinch-middle entered at 2000 and never completed (runs to the last frame)
# - one mistake (wrong_hand at 1500), three coach tool calls (advance_step, flag_mistake,
#   highlight), two object track lines, finish.json, and a media file announced at t = 50

DEFAULT_FRAMES = 180
RIGHT_MISSING = range(60, 90)


def frame_time(k: int) -> float:
    return round(k * 1000.0 / 60.0, 3)


def build_default(root: Path, episode_id: str = "ep-20261024-031502-test") -> EpisodeBuilder:
    b = EpisodeBuilder(root, episode_id)
    for k in range(DEFAULT_FRAMES):
        head = [round(0.3 + 0.05 * math.sin(k / 30.0), 4), 0.45, 0.35, 0.0, 0.0, 0.0, 1.0]
        left = hand((0.1 + 0.0005 * k, 0.08, -0.18), pinch=0.05 - 0.0002 * k)
        right = None if k in RIGHT_MISSING else hand((0.4, 0.08, -0.18), QUAT_Y90, pinch=0.04)
        b.frame(frame_time(k), head=head, left=left, right=right)

    instr = {s: text for s, text, _ in SHIRT_STEPS}
    b.event(0.0, "procedure.started", procedureId="shirt-fold", version=1, stepCount=5)
    b.event(0.0, "coach.status", state="ready")
    b.event(50.0, "media.started", name="egocentric.webm", mimeType="video/webm")
    b.step_entered(100.0, "lay-flat", 0, instr["lay-flat"])
    b.event(150.0, "transcript", role="coach", text="Lay the shirt flat.", final=True)
    b.event(900.0, "transcript", role="user", text="Ready", final=True)
    b.event(
        950.0,
        "coach.tool_call",
        callId="c1",
        name="advance_step",
        args={"reason": "user said ready"},
    )
    b.step_completed(1000.0, "lay-flat", 0, by="coach", duration_ms=900.0)
    b.event(1000.0, "coach.tool_result", callId="c1", name="advance_step", ok=True, result={})
    b.step_entered(1000.0, "pinch-shoulder", 1, instr["pinch-shoulder"], ["shoulder"])
    b.event(
        1500.0,
        "mistake.detected",
        stepId="pinch-shoulder",
        kind="wrong_hand",
        message="Use your left hand for the shoulder dot.",
        source="rule",
    )
    b.event(
        1550.0,
        "coach.tool_call",
        callId="c2",
        name="flag_mistake",
        args={"kind": "wrong_hand", "message": "Use your left hand."},
    )
    b.event(1560.0, "coach.tool_result", callId="c2", name="flag_mistake", ok=True, result=None)
    b.event(
        1700.0,
        "hand.pinch",
        hand="left",
        phase="start",
        point=[0.14, 0.0, -0.18],
        nearest={"objectId": "shoulder", "distance": 0.004},
    )
    b.step_completed(2000.0, "pinch-shoulder", 1, by="check", duration_ms=1000.0)
    b.step_entered(2000.0, "pinch-middle", 2, instr["pinch-middle"], ["middle"])
    b.event(2100.0, "coach.tool_call", callId="c3", name="highlight", args={"object_id": "middle"})
    b.event(2101.0, "coach.tool_result", callId="c3", name="highlight", ok=True, result={})
    b.event(2500.0, "hand.pinch", hand="left", phase="end", point=[0.4, 0.01, -0.18], nearest=None)

    b.track(500.0, object_state("shoulder", [0.141, 0.0, -0.181], confidence=0.8, source="pinch"))
    b.track(
        2000.0,
        object_state(
            "middle", [0.402, 0.001, -0.179], orientation=[0.0, 0.0, 0.0, 1.0], confidence=0.95
        ),
        object_state("shoulder", [0.15, 0.02, -0.18], confidence=0.85, source="pinch"),
    )
    b.finish = {
        "durationMs": 2983.333,
        "outcome": "interrupted",
        "stepsCompleted": 2,
        "stepsTotal": 5,
        "batches": 3,
    }
    b.media["egocentric.webm"] = b"\x1a\x45\xdf\xa3 not really a video"
    return b


@pytest.fixture
def new_episode(tmp_path):
    """Factory for custom episodes: `b = new_episode("ep-x"); b.frame(...); path = b.write()`."""

    def make(episode_id: str = "ep-custom", **kwargs) -> EpisodeBuilder:
        return EpisodeBuilder(tmp_path, episode_id, **kwargs)

    return make


@pytest.fixture
def default_episode(tmp_path) -> EpisodeBuilder:
    """The default synthetic episode as an unwritten builder, for tests that tweak it first."""
    return build_default(tmp_path)


@pytest.fixture
def episode_dir(default_episode) -> Path:
    """The default synthetic episode (see `build_default`), written to tmp_path."""
    return default_episode.write()


@pytest.fixture
def make_default_episode(tmp_path):
    """Factory writing fresh copies of the default episode: `make_default_episode("ep-b",
    plan=True)` (each needs its own id)."""

    def make(episode_id: str, *, plan: bool = False) -> Path:
        b = build_default(tmp_path, episode_id)
        if plan:
            b.meta["plan"] = copy.deepcopy(PLAN)
        return b.write()

    return make


@pytest.fixture
def plan() -> dict:
    """A fresh copy of PLAN, safe to modify."""
    return copy.deepcopy(PLAN)


@pytest.fixture
def planned_episode_dir(default_episode) -> Path:
    """The default episode with `meta.plan` (an LLM-generated plan with step actions)."""
    default_episode.meta["plan"] = copy.deepcopy(PLAN)
    return default_episode.write()
