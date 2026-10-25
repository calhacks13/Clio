"""Synthetic Clio episodes for tests.

`EpisodeBuilder` writes an episode directory (meta.json, frames.ndjson, events.ndjson, and
optionally objects.ndjson, observations.ndjson, finish.json, batches.json and media/) in the
on-disk layout of docs/data-format.md.
`test_synthetic_builder.py` validates its output against the real JSON Schemas in
packages/protocol/schema with plain jsonschema, so the builder can't drift from the contract.

The joint layout below mirrors packages/protocol/src/hand.ts on purpose instead of importing it
from clio_pipeline, so loader tests compare the package against an independent copy.
"""

from __future__ import annotations

import copy
import functools
import json
import math
import struct
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


_UNSET = object()


def object_state(
    id_: str,
    position,
    *,
    orientation=None,
    confidence=0.9,
    source="marker",
    flags: int | None = None,
    held_by=_UNSET,
    observed_t: float | None = None,
) -> dict:
    """An ObjectState. `flags`, `held_by` (None writes null) and `observed_t` add the optional
    `locationFlags`, `heldBy` and `observedT` fields ("object.flags" episodes)."""
    state = {
        "id": id_,
        "position": list(position),
        "orientation": orientation,
        "confidence": confidence,
        "source": source,
    }
    if flags is not None:
        state["locationFlags"] = flags
    if held_by is not _UNSET:
        state["heldBy"] = held_by
    if observed_t is not None:
        state["observedT"] = observed_t
    return state


def plane(
    id_: str,
    kind: str = "table",
    *,
    pose=(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0),
    polygon=((0.0, 0.0), (0.8, 0.0), (0.8, -0.6), (0.0, -0.6)),
    label: str | None = None,
    orientation: str = "horizontal",
) -> dict:
    """An EnvironmentPlane for `environment.planes` events."""
    return {
        "id": id_,
        "kind": kind,
        "label": label if label is not None else kind,
        "orientation": orientation,
        "pose": list(pose),
        "polygon": [list(point) for point in polygon],
    }


def room_mesh(
    id_: str,
    kind: str = "other",
    *,
    label: str | None = None,
    global_: bool = False,
    vertices: int = 8,
    triangles: int = 12,
) -> dict:
    """An EnvironmentMesh for `environment.meshes` events."""
    return {
        "id": id_,
        "kind": kind,
        "label": label,
        "global": global_,
        "vertices": vertices,
        "triangles": triangles,
    }


IDENTITY_POSE = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]


def camera_model(
    *,
    width: int = 1280,
    height: int = 960,
    fx: float = 800.0,
    fy: float | None = None,
    cx: float | None = None,
    cy: float | None = None,
    head_from_camera=IDENTITY_POSE,
    source: str = "default",
) -> dict:
    """A CameraModel for meta.camera: a pinhole whose principal point is the image center unless
    given, mounted at `head_from_camera` (the camera pose in the head frame; at the head, looking
    the way the head looks, by default)."""
    return {
        "intrinsics": {
            "width": width,
            "height": height,
            "fx": fx,
            "fy": fx if fy is None else fy,
            "cx": width / 2 if cx is None else cx,
            "cy": height / 2 if cy is None else cy,
        },
        "headFromCamera": list(head_from_camera),
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
        self.observation_lines: list[dict] | None = None
        self.finish: dict | None = None
        self.batches: dict | None = None  # batches.json: {"received": [seq...], "gaps": [...]}
        self.media: dict[str, bytes] = {}

    hand = staticmethod(hand)
    object_state = staticmethod(object_state)
    plane = staticmethod(plane)
    room_mesh = staticmethod(room_mesh)

    def features(self, *names: str) -> EpisodeBuilder:
        """List optional recording features in meta.features ("object.flags", ...)."""
        self.meta["features"] = list(names)
        return self

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

    def observation(
        self,
        t: float,
        object_id: str,
        *,
        observed_t: float | None = None,
        status: str = "measured",
        role: str = "tracker",
        source: str = "yoloe-26l-seg",
        box=(0.4, 0.3, 0.5, 0.45),
        score: float | None = 0.8,
        seq: int | None = None,
        frame_size: tuple[int, int] = (480, 360),
        surface=None,
    ) -> EpisodeBuilder:
        """One ObjectObservation line (observations.ndjson). `seq` adds the camera `frame`
        (`frame_size` pixels); `surface` adds depth samples ([x, y, z] in W, "object.surface")."""
        if self.observation_lines is None:
            self.observation_lines = []
        box = list(box) if box is not None else None
        width, height = frame_size
        line = {
            "t": t,
            "observedT": t if observed_t is None else observed_t,
            "objectId": object_id,
            "status": status,
            "role": role,
            "source": source,
            "box": box,
            "outline": None,
            "point": [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2] if box else None,
            "contact": [(box[0] + box[2]) / 2, box[3]] if box else None,
            "score": score,
            "frame": {"seq": seq, "width": width, "height": height} if seq is not None else None,
            "trackId": "7" if role == "tracker" else None,
        }
        if surface is not None:
            line["surface"] = [list(point) for point in surface]
        self.observation_lines.append(line)
        return self

    def camera(self, **model) -> EpisodeBuilder:
        """Record the passthrough camera model in meta.camera (see `camera_model`)."""
        self.meta["camera"] = camera_model(**model)
        return self

    def planes(self, t: float, *planes: dict) -> EpisodeBuilder:
        """An `environment.planes` snapshot: every plane detected at `t`."""
        return self.event(t, "environment.planes", planes=list(planes))

    def room_scan(
        self, t: float, n: int, glb: bytes | None, meshes: list[dict] | None = None
    ) -> EpisodeBuilder:
        """An `environment.meshes` snapshot at `t` and its geometry, media/room-scan-<n>.glb
        (`glb` None: the upload never arrived). `meshes` are the event's EnvironmentMesh
        entries (see `room_mesh`)."""
        name = f"room-scan-{n}.glb"
        if glb is not None:
            self.media[name] = glb
        return self.event(t, "environment.meshes", media=name, meshes=list(meshes or []))

    def write(self) -> Path:
        self.dir.mkdir(parents=True, exist_ok=False)
        (self.dir / "meta.json").write_text(json.dumps(self.meta, indent=2) + "\n")
        _write_ndjson(self.dir / "frames.ndjson", self.frames)
        _write_ndjson(self.dir / "events.ndjson", self.events)
        if self.object_lines is not None:
            _write_ndjson(self.dir / "objects.ndjson", self.object_lines)
        if self.observation_lines is not None:
            _write_ndjson(self.dir / "observations.ndjson", self.observation_lines)
        if self.finish is not None:
            (self.dir / "finish.json").write_text(json.dumps(self.finish) + "\n")
        if self.batches is not None:
            (self.dir / "batches.json").write_text(json.dumps(self.batches))
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


# --- an episode from a newer headset --------------------------------------------------------------
#
# The default frames, steps and events, recorded with every optional feature:
# - meta.features: object.flags, object.grasp, object.observations, environment.planes
# - syringe (not in meta.objects): detected at t = 200 in a frame taken at 150 (flags 10),
#   marker-tracked with an orientation at 400 (flags 15), grasped by the right hand at 1600,
#   carried every frame (flags 2, heldBy right), released at 2000 (heldBy null), lost at 2500
#   (flags 0)
# - 2D observations: measured at 200 (frame at 150) and 400, lost at 2500
# - planes: a table and the floor at 0; at 1500 the table grows and the floor is gone
# - finished as completed, every batch received (3 of 3)

SYRINGE_CARRY = range(96, 120)  # frames 96..119: t = 1600 .. 1983.333


def build_featured(root: Path, episode_id: str = "ep-20261024-031502-feat") -> EpisodeBuilder:
    b = build_default(root, episode_id)
    b.features("object.flags", "object.grasp", "object.observations", "environment.planes")
    b.object_lines = None
    b.track(
        0.0,
        *(
            object_state(o["id"], o["position"], source="layout", confidence=1.0, flags=2)
            for o in b.meta["objects"]
        ),
    )
    syringe = functools.partial(object_state, "syringe", held_by=None)
    at = [0.31, 0.02, -0.2]
    b.track(200.0, syringe([0.3, 0.02, -0.2], source="detector", flags=10, observed_t=150.0))
    b.track(400.0, syringe(at, orientation=[0.0, 0.0, 0.0, 1.0], confidence=0.95, flags=15))
    b.event(1600.0, "object.grasped", objectId="syringe", hand="right", grip="pinch", position=at)
    for k in SYRINGE_CARRY:
        lifted = [0.31, round(0.02 + 0.0004 * (k - SYRINGE_CARRY[0]), 4), -0.2]
        b.track(frame_time(k), syringe(lifted, source="pinch", flags=2, held_by="right"))
    dropped = [0.31, 0.03, -0.2]
    b.event(
        2000.0,
        "object.released",
        objectId="syringe",
        hand="right",
        reason="opened",
        position=dropped,
    )
    b.track(2000.0, syringe(dropped, source="pinch", flags=2))
    b.track(2500.0, syringe(dropped, source="detector", confidence=0.2, flags=0))

    b.observation(200.0, "syringe", observed_t=150.0, seq=4)
    b.observation(400.0, "syringe", seq=12, score=0.9)
    b.observation(2500.0, "syringe", status="lost", box=None, score=None, seq=75)
    floor = plane(
        "plane-2",
        "floor",
        pose=[0.4, -0.75, 0.5, 0.0, 0.0, 0.0, 1.0],
        polygon=[[-2, -2], [2, -2], [2, 2], [-2, 2]],
    )
    b.planes(0.0, plane("plane-1"), floor)
    grown = [[-0.1, 0.1], [1.0, 0.1], [1.0, -0.7], [-0.1, -0.7]]
    b.planes(1500.0, plane("plane-1", polygon=grown))
    b.events.sort(key=lambda e: e["t"])

    b.finish = {
        "durationMs": 2983.333,
        "outcome": "completed",
        "stepsCompleted": 3,
        "stepsTotal": 3,
        "batches": 3,
    }
    b.batches = {"received": [0, 1, 2], "gaps": []}
    return b


# --- an episode from a headset with a depth source ------------------------------------------------
#
# The featured episode, plus what the measured 3D path records ("object.surface"): meta.camera (a
# 480 x 360 pinhole at the head, matching the observations' frame size) and depth samples on the
# syringe's measured observations. The syringe is seen three more times while it rests at
# SYRINGE_AT (t = 400 .. 1600): at 400, 600 and 800, each frame sampling the same 24 surface
# points (SYRINGE_SURFACE_OFFSETS, each at the center of its own 1 cm voxel) 1.5 cm above it.

SYRINGE_AT = [0.31, 0.02, -0.2]
SYRINGE_SURFACE_OFFSETS = [
    [round(0.005 + 0.02 * i, 4), 0.015, round(0.005 + 0.01 * j, 4)]
    for i in range(-3, 3)
    for j in range(-2, 2)
]


def build_measured(root: Path, episode_id: str = "ep-20261024-031502-meas") -> EpisodeBuilder:
    b = build_featured(root, episode_id)
    b.features(*b.meta["features"], "object.surface")
    b.camera(width=480, height=360, fx=400.0)
    surface = [
        [round(p + o, 4) for p, o in zip(SYRINGE_AT, offset, strict=True)]
        for offset in SYRINGE_SURFACE_OFFSETS
    ]
    b.observation_lines = [line for line in b.observation_lines if line["t"] != 400.0]
    for t, seq in ((400.0, 12), (600.0, 18), (800.0, 24)):
        b.observation(t, "syringe", seq=seq, score=0.9, surface=surface)
    b.observation_lines.sort(key=lambda line: line["t"])
    return b


# --- an episode with a hole in its frames ---------------------------------------------------------
#
# Both hands and the head at 60 Hz from 0 to 1000 ms and again from 3000 to 4000 ms, with nothing
# in between (the XR loop paused while the headset was off): every batch arrived and it finished as
# completed, so only the hole is wrong with it. The hands reach forward and down within the example
# arms' reach; the left wrist is at x = 0.25 before the hole and 0.30 after it, the head at x = 0.3
# and then 0.9.

FRAME_GAP = (1000.0, 3000.0)
REACH_DOWN = (-0.4226, 0.0, 0.0, 0.9063)  # wrist turned 50 degrees about +x


def build_frame_gap(root: Path, episode_id: str = "ep-20261024-031502-gap") -> EpisodeBuilder:
    b = EpisodeBuilder(root, episode_id)
    for start, left_x, head_x in ((0.0, 0.25, 0.3), (FRAME_GAP[1], 0.30, 0.9)):
        for k in range(61):
            b.frame(
                round(start + k * 1000.0 / 60.0, 3),
                head=[head_x, 0.45, 0.35, 0.0, 0.0, 0.0, 1.0],
                left=hand((left_x, 0.22, -0.02), REACH_DOWN, pinch=0.05),
                right=hand((0.53, 0.22, -0.02), REACH_DOWN, pinch=0.05),
            )
    b.event(0.0, "coach.status", state="ready")
    b.finish = {
        "durationMs": 4000.0,
        "outcome": "completed",
        "stepsCompleted": 0,
        "stepsTotal": 0,
        "batches": 4,
    }
    b.batches = {"received": [0, 1, 2, 3], "gaps": []}
    return b


# --- an episode with the Quest room scan ---------------------------------------------------------
#
# The featured episode recorded on a headset with mesh detection ("environment.meshes"): one
# snapshot at t = 0, media/room-scan-1.glb, written here by hand (not by clio_pipeline.glb, so the
# reader is tested against an independent writer) the way the headset writes it: one root node per
# mesh named by its id, the mesh pose as translation and rotation, local positions, uint32 indices.
# - mesh-1, the global mesh: a 4 x 4 m floor and a 2.5 m wall at local z = -2, posed at the floor
#   plane's origin (0.4, -0.75, 0.5): in W from (-1.6, -0.75, -1.5) to (2.4, 1.75, 2.5)
# - mesh-2, the table volume: a 0.6 x 0.74 x 0.8 m box (local x, y, z) hanging below its top,
#   posed at (0.4, 0, -0.3) and turned a quarter about +y: in W from (0, -0.74, -0.6) to (0.8, 0, 0)

QUARTER_TURN_Y = [0.0, math.sqrt(0.5), 0.0, math.sqrt(0.5)]
GLOBAL_MESH_POSE = ([0.4, -0.75, 0.5], [0.0, 0.0, 0.0, 1.0])
TABLE_MESH_POSE = ([0.4, 0.0, -0.3], QUARTER_TURN_Y)


def box_mesh(lo, hi) -> tuple[list[list[float]], list[list[int]]]:
    """The 8 corners and 12 triangles of an axis-aligned box from `lo` to `hi`."""
    corners = [[(lo, hi)[(k >> a) & 1][a] for a in range(3)] for k in range(8)]
    faces = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
    return corners, [list(t) for a, b, c, d in faces for t in ((a, b, c), (a, c, d))]


def global_mesh() -> tuple[list[list[float]], list[list[int]]]:
    floor = [[-2.0, 0.0, -2.0], [2.0, 0.0, -2.0], [2.0, 0.0, 2.0], [-2.0, 0.0, 2.0]]
    wall = [[-2.0, 0.0, -2.0], [2.0, 0.0, -2.0], [2.0, 2.5, -2.0], [-2.0, 2.5, -2.0]]
    return floor + wall, [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]]


def room_glb(nodes: list[dict]) -> bytes:
    """A GLB with one root node per entry {name, translation, rotation, positions, indices,
    extras}: float32 POSITION, uint32 indices, no normals, no materials."""
    binary, views, accessors, gl_nodes, meshes = bytearray(), [], [], [], []
    for node in nodes:
        positions = struct.pack(f"<{3 * len(node['positions'])}f", *sum(node["positions"], []))
        indices = struct.pack(f"<{3 * len(node['indices'])}I", *sum(node["indices"], []))
        for data, kind, count in (
            (positions, "VEC3", len(node["positions"])),
            (indices, "SCALAR", 3 * len(node["indices"])),
        ):
            views.append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(data)})
            component = 5126 if kind == "VEC3" else 5125
            accessors.append(
                {
                    "bufferView": len(views) - 1,
                    "componentType": component,
                    "count": count,
                    "type": kind,
                }
            )
            binary += data
        attributes = {"POSITION": len(accessors) - 2}
        meshes.append({"primitives": [{"attributes": attributes, "indices": len(accessors) - 1}]})
        gl_nodes.append(
            {
                "name": node["name"],
                "mesh": len(meshes) - 1,
                "translation": node["translation"],
                "rotation": node["rotation"],
                "extras": node["extras"],
            }
        )
    doc = {
        "asset": {"version": "2.0", "generator": "clio-test"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(gl_nodes)))}],
        "nodes": gl_nodes,
        "meshes": meshes,
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(binary)}],
    }
    text = json.dumps(doc).encode()
    text += b" " * (-len(text) % 4)
    body = struct.pack("<II", len(text), 0x4E4F534A) + text
    body += struct.pack("<II", len(binary), 0x004E4942) + bytes(binary)
    return struct.pack("<III", 0x46546C67, 2, 12 + len(body)) + body


def room_scan_glb() -> bytes:
    """media/room-scan-1.glb of the room scan episode (see above)."""
    floor_and_wall, walls = global_mesh()
    table, sides = box_mesh([-0.3, -0.74, -0.4], [0.3, 0.0, 0.4])
    return room_glb(
        [
            {
                "name": "mesh-1",
                "translation": GLOBAL_MESH_POSE[0],
                "rotation": GLOBAL_MESH_POSE[1],
                "positions": floor_and_wall,
                "indices": walls,
                "extras": {"kind": "other", "label": "global mesh", "global": True},
            },
            {
                "name": "mesh-2",
                "translation": TABLE_MESH_POSE[0],
                "rotation": TABLE_MESH_POSE[1],
                "positions": table,
                "indices": sides,
                "extras": {"kind": "table", "label": "table", "global": False},
            },
        ]
    )


ROOM_MESHES = [
    room_mesh("mesh-1", "other", label="global mesh", global_=True, vertices=8, triangles=4),
    room_mesh("mesh-2", "table", label="table", vertices=8, triangles=12),
]


def build_room_scan(root: Path, episode_id: str = "ep-20261024-031502-room") -> EpisodeBuilder:
    b = build_featured(root, episode_id)
    b.features(*b.meta["features"], "environment.meshes")
    b.room_scan(0.0, 1, room_scan_glb(), copy.deepcopy(ROOM_MESHES))
    b.events.sort(key=lambda e: e["t"])
    return b


@pytest.fixture
def room_scan_episode_dir(tmp_path) -> Path:
    """The featured episode with a room scan (see `build_room_scan`)."""
    return build_room_scan(tmp_path).write()


@pytest.fixture
def featured_episode_dir(tmp_path) -> Path:
    """The default episode recorded with every optional feature (see `build_featured`)."""
    return build_featured(tmp_path).write()


@pytest.fixture
def measured_episode_dir(tmp_path) -> Path:
    """The featured episode with a camera model and depth samples (see `build_measured`)."""
    return build_measured(tmp_path).write()


@pytest.fixture
def frame_gap_episode_dir(tmp_path) -> Path:
    """An episode without frames from 1000 to 3000 ms (see `build_frame_gap`)."""
    return build_frame_gap(tmp_path).write()


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
