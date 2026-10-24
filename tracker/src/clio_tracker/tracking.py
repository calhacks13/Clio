"""Follow one requested object from frame to frame between jev answers.

YOLOE scores every candidate position against the object's visual prompt; ByteTrack links the
strong candidates into tracks; one track is the *target*. jev's answers (a box on an older
frame) pick which track that is, and its box becomes the prompt's anchor. Between answers:

- **The target keeps its identity** through ByteTrack, even when a look-alike scores higher.
  ByteTrack's second stage lets a weak candidate (down to 0.10) continue an existing track.
- **The appearance adapts.** Each confident sighting's own visual prompt is blended into a
  running appearance, gated on still resembling what jev confirmed, so the object can turn or
  be seen from another side without drifting onto a hand or a neighbor.
- **A lost target coasts** at its predicted box for 0.35 s, or holds for 1 s when it left by a
  frame edge or filled the view, then reads as not found. Its track survives 1 s more, so it
  is picked up again as the same object.
- **A target with no track is re-acquired by appearance**: the visual prompt of each confirmed
  track is compared with the running appearance, which separates instances of one kind (two
  people at 0.77 to 0.86 cosine, the same person across views at 0.95 to 0.97 on bus.jpg).
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from types import SimpleNamespace

import numpy as np

from .geometry import Shape, iou, nms, touches_edge, valid_box
from .vision import Encoding, YoloeVision


@dataclass(frozen=True)
class TrackerParams:
    candidate_min: float = 0.10  # weaker candidates never reach ByteTrack
    max_candidates: int = 30
    nms_iou: float = 0.7
    track_high: float = 0.25  # ByteTrack's first association stage
    new_track: float = 0.45  # a track starts only from a candidate this strong
    match_thresh: float = 0.8
    lost_s: float = 1.0  # ByteTrack keeps a lost track this long
    coast_s: float = 0.35  # a lost target is drawn at its predicted box this long...
    hold_s: float = 1.0  # ...or this long when it left by an edge or filled the view
    reacquire_similarity: float = 0.88  # appearance cosine to take over a track
    reacquire_after_jev: float = 0.80  # right after jev placed it, but no track was there
    reacquire_when_absent: float = 0.93  # jev last said it is not in view
    reacquire_margin: float = 0.03  # over the next most similar track
    # A track that started where the target was just lost (ByteTrack split it, e.g. a part and
    # the whole swapping scores in a close-up) takes over at this lower appearance bar.
    reacquire_nearby: float = 0.75
    nearby_overlap: float = 0.6  # share of the smaller box inside the other
    learn_min_score: float = 0.35  # appearance learns only from confident sightings...
    learn_min_similarity: float = 0.80  # ...that still resemble jev's view
    learn_rate: float = 0.15
    anchor_weight: float = 0.5  # the prompt blends jev's view with the running appearance
    doubt_similarity: float = 0.75  # below this the target may have swapped: ask jev early
    doubt_frames: int = 3
    match_iou: float = 0.3  # jev's box against a track on jev's frame
    pending_s: float = 3.0  # how long a jev box with no track waits for one to appear
    history_s: float = 15.0  # longer than jev's slowest answer


@dataclass
class Sighting:
    """What the tracker says about one object on this frame."""

    found: bool
    box: np.ndarray | None = None  # frame pixels
    shape: Shape | None = None
    confidence: float = 0.0
    state: str = "unknown"  # tracking | coasting | lost | absent | unknown
    track_id: int | None = None


@dataclass
class _Fresh:
    t: float
    box: np.ndarray
    shape: Shape
    confidence: float
    at_edge: bool
    fills_view: bool
    size: tuple[int, int]  # the frame's width and height
    frame_id: int  # ByteTrack's frame count at this sighting
    by: str | None  # how the target had been picked: "jev" or "appearance"


@dataclass
class ObjectTracker:
    object_id: str
    phrase: str | None
    params: TrackerParams = field(default_factory=TrackerParams)

    anchor: np.ndarray | None = None  # jev-confirmed appearance (unit 512-d)
    running: np.ndarray | None = None  # adapted between answers
    target_id: int | None = None
    target_by: str | None = None  # "jev" or "appearance"
    absent: bool = False  # jev's last answer: not in view
    doubt: int = 0  # consecutive frames the target looked unlike itself
    confirmed_t: float | None = None

    def __post_init__(self) -> None:
        from ultralytics.trackers.byte_tracker import BYTETracker

        p = self.params
        self._tracks = BYTETracker(
            SimpleNamespace(
                track_high_thresh=p.track_high,
                track_low_thresh=p.candidate_min,
                new_track_thresh=p.new_track,
                track_buffer=30,
                match_thresh=p.match_thresh,
                fuse_score=True,
            )
        )
        self._history: deque[tuple[int, float, dict[int, np.ndarray]]] = deque()
        self._pending: tuple[np.ndarray, float] | None = None
        self._fresh: _Fresh | None = None
        self._last_t: float | None = None
        self._fps = 15.0
        self._applied_seq = -1
        # Track ids that continued another's object (_continue_nearby): a late jev answer about
        # the old id means the new one.
        self._successor: dict[int, int] = {}

    # --- prompt ----------------------------------------------------------------------------

    @property
    def prompt(self) -> np.ndarray | None:
        if self.anchor is None:
            return None
        if self.running is None:
            return self.anchor
        w = self.params.anchor_weight
        return _unit(w * self.anchor + (1 - w) * self.running)

    @property
    def wants_jev_now(self) -> bool:
        """jev should look sooner than its usual interval: nothing to follow, or a possible swap."""
        return (
            self.anchor is None or self.target_id is None or self.doubt >= self.params.doubt_frames
        )

    # --- per frame -------------------------------------------------------------------------

    def step(self, enc: Encoding, seq: int, t: float, vision: YoloeVision) -> Sighting:
        self._tick_fps(t)
        prompt = self.prompt
        if prompt is None:
            self._remember(seq, t)
            return Sighting(False, state="unknown")

        boxes, scores, anchors = self._candidates(enc, vision.scores(enc, prompt)[0])
        rows = self._tracks.update(_Detections(boxes, scores))
        active = {int(r[4]): (int(r[7]), float(r[5])) for r in rows}  # id -> (candidate, score)
        self._remember(seq, t)

        tid = self.target_id
        if tid is not None and tid not in active and not self._alive(tid):
            self.target_id = tid = None
            self.target_by = None
        if tid not in active:
            # Missed on this frame: a track that just started where it was may be it.
            tid = self._continue_nearby(enc, vision, active, boxes, t) or tid
        if tid is None:
            tid = self._reacquire(enc, vision, active, boxes, t)

        if tid is not None and tid in active:
            i, score = active[tid]
            return self._sighted(enc, vision, tid, anchors[i], boxes[i], score, t)
        if tid is not None:
            return self._coast(tid, t)
        return Sighting(False, state="absent" if self.absent else "lost")

    def _candidates(
        self, enc: Encoding, scores: np.ndarray
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        p = self.params
        idx = np.flatnonzero(scores >= p.candidate_min)
        if idx.size > p.max_candidates:
            idx = idx[np.argsort(-scores[idx])[: p.max_candidates]]
        boxes = enc.letterbox.to_frame(enc.boxes[idx]) if idx.size else np.zeros((0, 4), np.float32)
        ok = np.array([valid_box(b) for b in boxes], dtype=bool)
        idx, boxes = idx[ok], boxes[ok]
        keep = nms(boxes, scores[idx], p.nms_iou) if idx.size else np.zeros(0, np.int64)
        return boxes[keep], scores[idx][keep], idx[keep]

    def _sighted(
        self,
        enc: Encoding,
        vision: YoloeVision,
        tid: int,
        anchor: int,
        box: np.ndarray,
        score: float,
        t: float,
    ) -> Sighting:
        p = self.params
        lb = enc.letterbox
        shape = vision.shape(enc, int(anchor), box)
        at_edge = touches_edge(box, lb.width, lb.height)
        area = (box[2] - box[0]) * (box[3] - box[1]) / (lb.width * lb.height)
        appearance = vision.prompts(enc, box)[0]
        similarity = float(appearance @ self.running) if self.running is not None else 1.0
        self.doubt = self.doubt + 1 if similarity < p.doubt_similarity else 0
        if (
            score >= p.learn_min_score
            and not at_edge
            and self.anchor is not None
            and float(appearance @ self.anchor) >= p.learn_min_similarity
        ):
            base = self.running if self.running is not None else self.anchor
            self.running = _unit((1 - p.learn_rate) * base + p.learn_rate * appearance)
        floor = 0.5 if self.target_by == "jev" else 0.35
        confidence = round(max(score, floor), 3)
        self._fresh = _Fresh(
            t,
            box.copy(),
            shape,
            confidence,
            at_edge,
            area > 0.6,
            (lb.width, lb.height),
            self._tracks.frame_id,
            self.target_by,
        )
        return Sighting(True, box, shape, confidence, "tracking", tid)

    def _coast(self, tid: int, t: float) -> Sighting:
        fresh = self._fresh
        if fresh is None:
            return Sighting(False, state="lost", track_id=tid)
        window = self.params.hold_s if fresh.at_edge or fresh.fills_view else self.params.coast_s
        age = t - fresh.t
        if age > window:
            return Sighting(False, state="lost", track_id=tid)
        lost = next((s for s in self._tracks.lost_stracks if s.track_id == tid), None)
        box = np.asarray(lost.xyxy, dtype=np.float32) if lost is not None else fresh.box
        shape = _moved(fresh.shape, fresh.box, box, fresh.size)
        confidence = round(fresh.confidence * (1 - 0.5 * age / window), 3)
        return Sighting(True, box, shape, confidence, "coasting", tid)

    def _continue_nearby(
        self,
        enc: Encoding,
        vision: YoloeVision,
        active: dict[int, tuple[int, float]],
        boxes: np.ndarray,
        t: float,
    ) -> int | None:
        p, fresh = self.params, self._fresh
        if fresh is None or self.absent or t - fresh.t > p.lost_s or self.prompt is None:
            return None
        born = {s.track_id: s.start_frame for s in self._tracks.tracked_stracks}
        ids = [i for i in active if i != self.target_id and born.get(i, -1) >= fresh.frame_id]
        if not ids:
            return None
        track_boxes = np.stack([boxes[active[i][0]] for i in ids])
        near = _overlap(track_boxes, fresh.box) >= p.nearby_overlap
        if not near.any():
            return None
        reference = self.running if self.running is not None else self.prompt
        similarity = np.where(near, vision.prompts(enc, track_boxes) @ reference, -1.0)
        best = int(np.argmax(similarity))
        if similarity[best] < p.reacquire_nearby:
            return None
        if self.target_id is not None:
            self._successor[self.target_id] = ids[best]
        self.target_id, self.target_by = ids[best], fresh.by
        return self.target_id

    def _reacquire(
        self,
        enc: Encoding,
        vision: YoloeVision,
        active: dict[int, tuple[int, float]],
        boxes: np.ndarray,
        t: float,
    ) -> int | None:
        p = self.params
        if not active or self.prompt is None:
            return None
        pending = self._pending if self._pending and t - self._pending[1] <= p.pending_s else None
        self._pending = pending
        ids = list(active)
        track_boxes = np.stack([boxes[active[i][0]] for i in ids])
        reference = self.running if self.running is not None else self.prompt
        similarity = vision.prompts(enc, track_boxes) @ reference
        if pending is not None:
            similarity = similarity + 0.05 * iou(track_boxes, pending[0])[:, 0]
            threshold = p.reacquire_after_jev
        elif self.absent:
            threshold = p.reacquire_when_absent
        else:
            threshold = p.reacquire_similarity
        order = np.argsort(-similarity)
        best = int(order[0])
        margin = similarity[best] - (similarity[order[1]] if len(order) > 1 else -1.0)
        if similarity[best] < threshold or margin < p.reacquire_margin:
            return None
        self.target_id = ids[best]
        self.target_by = "jev" if pending is not None else "appearance"
        self._pending = None
        self.doubt = 0
        return self.target_id

    # --- jev -------------------------------------------------------------------------------

    def identified(
        self,
        seq: int,
        t: float,
        present: bool,
        box: np.ndarray | None,
        appearance: np.ndarray | None,
    ) -> str:
        """Apply jev's answer about frame `seq`: a box in frame pixels and its visual prompt.

        Returns what changed, for the log. Answers older than one already applied are ignored.
        """
        if seq < self._applied_seq:
            return "stale"
        self._applied_seq = seq
        if not present or box is None or appearance is None:
            self.absent = True
            self.target_id = self.target_by = None
            self._pending = None
            return "absent"
        self.absent = False
        self.confirmed_t = t
        self.doubt = 0
        snapshot = self._snapshot(seq)
        previous = self.target_id
        if not snapshot and previous is not None and self.running is not None:
            # jev looked at a frame from before any track existed (e.g. while its first answer
            # was still on the way), so there is nothing to match its box to. Keep a target
            # that looks like what jev saw instead of dropping it.
            if float(_unit(appearance) @ self.running) >= self.params.reacquire_similarity:
                self.anchor = _unit(appearance)
                return "kept: looks like it"
        self.anchor = _unit(appearance)
        best_id, best_iou = None, 0.0
        if snapshot:
            ids = list(snapshot)
            overlaps = iou(np.stack([snapshot[i] for i in ids]), box)[:, 0]
            k = int(np.argmax(overlaps))
            best_id, best_iou = ids[k], float(overlaps[k])
            seen: set[int] = set()
            while best_id in self._successor and best_id not in seen:
                seen.add(best_id)
                best_id = self._successor[best_id]
        if best_id is not None and best_iou >= self.params.match_iou and self._alive(best_id):
            self.target_id, self.target_by = best_id, "jev"
            self._pending = None
            if previous == best_id:
                return "confirmed"
            self.running = self.anchor
            return "found" if previous is None else f"moved from track {previous} to {best_id}"
        # Not a candidate on that frame: the new prompt will make it one, near where jev saw it.
        self.target_id = self.target_by = None
        self.running = self.anchor
        self._pending = (box.astype(np.float32), t)
        return "placed" if previous is None else f"placed away from track {previous}"

    # --- bookkeeping -----------------------------------------------------------------------

    def _remember(self, seq: int, t: float) -> None:
        tracks = {
            s.track_id: np.asarray(s.xyxy, dtype=np.float32) for s in self._tracks.tracked_stracks
        }
        self._history.append((seq, t, tracks))
        while self._history and t - self._history[0][1] > self.params.history_s:
            self._history.popleft()

    def _snapshot(self, seq: int) -> dict[int, np.ndarray] | None:
        for s, _, tracks in reversed(self._history):
            if s == seq:
                return tracks
            if s < seq:
                return None
        return None

    def _alive(self, tid: int) -> bool:
        return any(s.track_id == tid for s in self._tracks.tracked_stracks) or any(
            s.track_id == tid for s in self._tracks.lost_stracks
        )

    def _tick_fps(self, t: float) -> None:
        if self._last_t is not None and t > self._last_t:
            self._fps = 0.9 * self._fps + 0.1 * (1.0 / (t - self._last_t))
        self._last_t = t
        self._tracks.max_frames_lost = max(3, math.ceil(self.params.lost_s * self._fps))


class _Detections:
    """The Results-like view ByteTrack reads: conf, cls, xywh, and boolean indexing."""

    def __init__(self, xyxy: np.ndarray, conf: np.ndarray):
        self.xyxy = np.asarray(xyxy, dtype=np.float32).reshape(-1, 4)
        self.conf = np.asarray(conf, dtype=np.float32).reshape(-1)
        self.cls = np.zeros(len(self.conf), dtype=np.float32)

    @property
    def xywh(self) -> np.ndarray:
        b = self.xyxy
        return np.stack(
            [
                (b[:, 0] + b[:, 2]) / 2,
                (b[:, 1] + b[:, 3]) / 2,
                b[:, 2] - b[:, 0],
                b[:, 3] - b[:, 1],
            ],
            1,
        )

    def __len__(self) -> int:
        return len(self.conf)

    def __getitem__(self, mask: np.ndarray) -> _Detections:
        return _Detections(self.xyxy[mask], self.conf[mask])


def _overlap(boxes: np.ndarray, box: np.ndarray) -> np.ndarray:
    """For each of (N, 4) boxes, the share of the smaller of it and `box` inside the other."""
    b = np.asarray(boxes, dtype=np.float32).reshape(-1, 4)
    w = (np.minimum(b[:, 2], box[2]) - np.maximum(b[:, 0], box[0])).clip(0)
    h = (np.minimum(b[:, 3], box[3]) - np.maximum(b[:, 1], box[1])).clip(0)
    area = (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
    smaller = np.minimum(area, (box[2] - box[0]) * (box[3] - box[1]))
    return np.where(smaller > 0, w * h / np.maximum(smaller, 1e-9), 0.0)


def _unit(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, dtype=np.float32)
    return v / max(float(np.linalg.norm(v)), 1e-12)


def _moved(shape: Shape, old: np.ndarray, new: np.ndarray, size: tuple[int, int]) -> Shape:
    """The last outline carried along with the box: same offset and scale about its center."""
    w, h = size
    oc = np.array([(old[0] + old[2]) / 2 / w, (old[1] + old[3]) / 2 / h])
    nc = np.array([(new[0] + new[2]) / 2 / w, (new[1] + new[3]) / 2 / h])
    scale = np.array(
        [
            (new[2] - new[0]) / max(old[2] - old[0], 1e-6),
            (new[3] - new[1]) / max(old[3] - old[1], 1e-6),
        ]
    )

    def move(p: list[float]) -> list[float]:
        q = (nc + (np.asarray(p) - oc) * scale).clip(0, 1)
        return [round(float(q[0]), 4), round(float(q[1]), 4)]

    outline = [move(p) for p in shape.outline] if shape.outline else None
    contact = move(shape.contact) if shape.contact else None
    return Shape(outline, move(shape.point), contact)
