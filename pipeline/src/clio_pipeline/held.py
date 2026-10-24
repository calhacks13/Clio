"""Held spans: when a hand carried each object (docs/data-pipeline.md).

The best record decides, never a mix for one object:

- `"object.grasp"` in meta.features: every grasp and release was recorded as an `object.grasped`
  or `object.released` event (origin `recorded`, grip from the grasp). This decides for every
  object of the episode.
- `"object.flags"`: an object whose states record `heldBy` names the carrying hand in every state
  (null when no hand holds it), so each run of states held by one hand is a span (origin
  `recorded`, grip unknown). States without `heldBy` say nothing about holding: an object none of
  whose states records it is inferred instead, like an older episode's.
- Older episodes: inferred the way the viewer infers them (apps/headset/src/viewer/capture/
  from-clio.ts). A pinch that starts within reach of a movable object no hand holds picks it up
  until that hand's pinch ends, and a run of `pinch` estimates written at frame rate that no
  pinch explains is a carry by an unknown hand (a fist).

A span holds from `start_t` up to, not including, `end_t`; `end_t` is None when the object was
still held as the recording stopped.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .episode import Episode, ObjectTrack

GRASP_FEATURE = "object.grasp"
FLAGS_FEATURE = "object.flags"
# Pinch reach beyond an object's radius, the same as the headset's GraspTracker.
PINCH_REACH_M = 0.04
# A held object is written every XR frame: a longer gap between `pinch` estimates ends a carry.
CARRY_GAP_MS = 50.0
# The plan object kinds the headset's GraspTracker picks up (unless hidden).
MOVABLE_KINDS = frozenset({"item", "tool", "container"})
DEFAULT_RADIUS_M = 0.03


@dataclass(frozen=True)
class HeldSpan:
    object_id: str
    hand: str | None  # left | right; None for a carry inferred without a pinch
    start_t: float  # ms
    end_t: float | None  # ms; None while still held at the end of the episode
    origin: str  # recorded | inferred
    grip: str | None  # pinch | fist; None when not known

    def covers(self, t: float) -> bool:
        """Whether the object is held at `t` (the end itself is not held)."""
        return self.start_t <= t and (self.end_t is None or t < self.end_t)


def held_spans(episode: Episode) -> list[HeldSpan]:
    """Every object's held spans, by start time (ties keep object order, recorded spans first)."""
    features = episode.meta.get("features") or []
    if GRASP_FEATURE in features:
        return sorted(_recorded_grasps(episode), key=lambda span: span.start_t)
    recorded = [
        track
        for track in episode.objects.values()
        if FLAGS_FEATURE in features and track.held_by_known.any()
    ]
    spans = [span for track in recorded for span in _held_by_runs(track)]
    spans += _inferred(episode, skip={track.id for track in recorded})
    return sorted(spans, key=lambda span: span.start_t)


def _recorded_grasps(episode: Episode) -> list[HeldSpan]:
    """A grasp by the hand already holding the object changes nothing; a grasp by the other hand
    hands it over. A release ends the object's span, whatever the reason."""
    spans: list[dict] = []
    holding: dict[str, dict] = {}  # object id -> its open span
    for e in episode.events_of("object.grasped", "object.released"):
        obj_id = e["objectId"]
        current = holding.get(obj_id)
        if e["type"] == "object.released":
            if current is not None:
                current["end_t"] = float(e["t"])
                del holding[obj_id]
            continue
        if current is not None and current["hand"] == e["hand"]:
            continue
        if current is not None:
            current["end_t"] = float(e["t"])
        holding[obj_id] = _span(obj_id, e["hand"], e["t"], "recorded", e["grip"])
        spans.append(holding[obj_id])
    return [HeldSpan(**span) for span in spans]


def _held_by_runs(track: ObjectTrack) -> list[HeldSpan]:
    """Runs of states held by one hand, in the order the estimates were measured. A run ends at
    the first state not held by that hand; states that do not record heldBy are passed over."""
    spans: list[HeldSpan] = []
    hand: str | None = None
    start = 0.0
    for k in np.argsort(track.sample_t, kind="stable"):
        if not track.held_by_known[k]:
            continue
        t = float(track.sample_t[k])
        if hand is not None and track.held_by[k] != hand:
            spans.append(HeldSpan(track.id, hand, start, t, "recorded", None))
            hand = None
        if hand is None and track.held_by[k] is not None:
            hand, start = track.held_by[k], t
    if hand is not None:
        spans.append(HeldSpan(track.id, hand, start, None, "recorded", None))
    return spans


def _inferred(episode: Episode, skip: set[str] | frozenset[str] = frozenset()) -> list[HeldSpan]:
    """Spans inferred from pinches and pinch estimates, for every object not in `skip`."""
    radii = {k: r for k, r in grasp_radii(episode).items() if k not in skip}
    grasps: list[dict] = []
    holding: dict[str, list[dict]] = {"left": [], "right": []}
    for e in episode.events_of("hand.pinch"):
        hand = e["hand"]
        if e["phase"] == "end":
            for span in holding[hand]:
                span["end_t"] = float(e["t"])
            holding[hand] = []
            continue
        near = e["nearest"]
        radius = radii.get(near["objectId"]) if near else None
        if radius is None or near["distance"] > radius + PINCH_REACH_M:
            continue
        held = {span["object_id"] for spans in holding.values() for span in spans}
        if near["objectId"] in held:  # by this hand already, or by the other one
            continue
        holding[hand].append(_span(near["objectId"], hand, e["t"], "inferred", "pinch"))
        grasps.append(holding[hand][-1])
    spans = [HeldSpan(**span) for span in grasps]
    for obj_id, track in episode.objects.items():
        if obj_id in radii:
            spans += _carries(track, [span for span in spans if span.object_id == obj_id])
    return spans


def _carries(track: ObjectTrack, grasps: list[HeldSpan]) -> list[HeldSpan]:
    """Runs of at least two `pinch` estimates no more than CARRY_GAP_MS apart. A stretch that no
    pinch grasp covers is a carry, even right after a grasp in the same run: GraspTracker releases
    on pinch end and the closed hand picks the object up again."""
    pinch = np.array([source == "pinch" for source in track.source], dtype=bool)
    times = np.sort(track.sample_t[pinch], kind="stable")
    carries: list[HeldSpan] = []
    run: list[float] = []

    def close() -> None:
        if len(run) >= 2:
            carries.append(HeldSpan(track.id, None, run[0], run[-1], "inferred", None))
        run.clear()

    for t in map(float, times):
        if run and t - run[-1] > CARRY_GAP_MS:
            close()
        # A grasp's own release estimate is written at the release, so its end counts here.
        if any(g.start_t <= t and (g.end_t is None or t <= g.end_t) for g in grasps):
            close()
            continue
        run.append(t)
    close()
    return carries


def grasp_radii(episode: Episode) -> dict[str, float]:
    """The radius of every object a hand can pick up: movable plan objects that are not hidden,
    and objects the plan does not list. meta.objects' radius wins over the plan's."""
    plan = {o["id"]: o for o in (episode.plan or {}).get("objects", [])}
    placed = {o["id"]: o["radius"] for o in episode.meta.get("objects", [])}
    radii: dict[str, float] = {}
    for obj_id in [*plan, *episode.objects]:
        spec = plan.get(obj_id)
        if spec is not None and (
            spec.get("hidden", False) or spec.get("kind", "item") not in MOVABLE_KINDS
        ):
            continue
        radii[obj_id] = float(placed.get(obj_id) or (spec or {}).get("radius") or DEFAULT_RADIUS_M)
    return radii


def _span(object_id: str, hand: str, t: float, origin: str, grip: str | None) -> dict:
    return {
        "object_id": object_id,
        "hand": hand,
        "start_t": float(t),
        "end_t": None,
        "origin": origin,
        "grip": grip,
    }
