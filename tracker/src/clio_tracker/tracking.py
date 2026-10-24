"""Follow one requested object from frame to frame between jev answers.

YOLOE scores every candidate position against the object's visual prompt; ByteTrack links the
strong candidates into tracks; one track is the *target*. jev's answers (a box on an older
frame) pick which track that is, and its box becomes the prompt's anchor. Between answers:

- **Everything moves with the camera.** The camera's motion since the last frame (motion.py,
  when the caller measures it) is applied to every track's Kalman state before ByteTrack
  matches, as BoT-SORT does, so a glance doesn't break the tracks: each one's prediction is
  where its object now is in the picture. jev's box, measured a second or two ago, is carried
  the same way to where its object is now.
- **The target keeps its identity** through ByteTrack, even when a look-alike scores higher.
  ByteTrack's second stage lets a weak candidate (down to 0.10) continue an existing track, and
  the target alone may continue on a weaker one still (down to 0.03) that overlaps its predicted
  box by IoU 0.5: YOLOE's prompt score for an object swings from frame to frame (motion blur, a
  glare), while its box stays put.
- **jev's box takes effect at once.** When no track was where jev looked, the best candidate
  in jev's box (carried to now) becomes the target on the next frame, as a new track if need
  be, rather than waiting for ByteTrack to confirm one and for it to look like jev's view.
- **The appearance adapts.** Each confident sighting's own visual prompt is blended into a
  running appearance, gated on still resembling what jev confirmed, so the object can turn or
  be seen from another side without drifting onto a hand or a neighbor.
- **A missed target coasts** at its predicted box (carried by the camera) for 0.5 s, or holds
  for 1 s when it was at a frame edge or filled the view, unless the prediction has left the
  view. Its track survives 3 s, so it is picked up again as the same object after a glance
  away.
- **A target with no track is re-acquired by appearance**: the visual prompt of each confirmed
  track is compared with the running appearance, which separates instances of one kind (two
  people at 0.77 to 0.86 cosine, the same person across views at 0.95 to 0.97 on bus.jpg).
- **What is returned is steadied** (smooth.py): the box, outline and points are filtered in
  the scene's frame of reference, so the camera's motion is never smoothed or delayed.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from types import SimpleNamespace

import numpy as np

from .geometry import Shape, iou, nms, touches_edge, valid_box
from .motion import warp_box
from .smooth import SmoothParams, Stabilizer
from .vision import Encoding, MaskCrop, YoloeVision


@dataclass(frozen=True)
class TrackerParams:
    candidate_min: float = 0.10  # weaker candidates never reach ByteTrack...
    rescue_min: float = 0.03  # ...but may continue the target where it is predicted to be
    rescue_iou: float = 0.5  # a weak candidate's IoU with the target's predicted box
    max_candidates: int = 30
    nms_iou: float = 0.7
    track_high: float = 0.25  # ByteTrack's first association stage
    new_track: float = 0.45  # a track starts only from a candidate this strong
    match_thresh: float = 0.8
    fuse_score: bool = True
    lost_s: float = 3.0  # ByteTrack keeps a lost track this long
    lost_velocity_keep: float = 0.8  # a lost track's own velocity decays by this each frame
    coast_s: float = 0.5  # a missed target is drawn at its predicted box this long...
    hold_s: float = 1.0  # ...or this long when it was at an edge or filled the view
    in_view: float = 0.25  # ...while at least this share of the predicted box is in the frame
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
    # jev's last few views of the object are scored too, each frame (the best score counts):
    # one view taken half out of the frame, blurred or from an odd side may hardly find it.
    views: int = 4
    doubt_similarity: float = 0.75  # below this the target may have swapped: ask jev early
    doubt_frames: int = 3
    match_iou: float = 0.3  # jev's box against a track on jev's frame...
    match_inside: float = 0.8  # ...or the smaller of the two this much inside the other
    place_iou: float = 0.3  # a candidate overlapping jev's box (carried to now) this much
    pending_s: float = 3.0  # how long a jev box with no track waits for one to appear
    history_s: float = 15.0  # longer than jev's slowest answer
    # A part of an object (part.py): jev's box is one when it covers less than this share of
    # what it would be matched or placed onto, and lies mostly (this share) inside it.
    part_cover: float = 0.5
    part_inside: float = 0.8
    parent_min: float = 0.4  # a containing candidate's score against its own view to be a parent
    parent_reps: int = 16  # containing candidates looked at for one (after NMS)
    parent_max_area: float = 0.9  # share of the frame: larger is the table or the background
    part_fill: float = 0.3  # the parent's mask must fill this share of the part box to be used
    part_hold_s: float = 6.0  # a part with no parent in sight is carried this long after jev
    smooth: SmoothParams = field(default_factory=SmoothParams)


@dataclass
class Sighting:
    """What the tracker says about one object on this frame."""

    found: bool
    box: np.ndarray | None = None  # frame pixels
    shape: Shape | None = None
    confidence: float = 0.0
    state: str = "unknown"  # tracking | coasting | lost | absent | unknown
    track_id: int | None = None
    measured: np.ndarray | None = None  # the tracked box, unsmoothed (predicted when coasting)
    crop: MaskCrop | None = None  # its mask on this frame, when sighted


@dataclass
class _Fresh:
    t: float
    box: np.ndarray  # as measured, carried by the camera since
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
        p = self.params
        self._tracks = _ByteTrack(
            SimpleNamespace(
                track_high_thresh=p.track_high,
                track_low_thresh=p.candidate_min,
                new_track_thresh=p.new_track,
                track_buffer=30,
                match_thresh=p.match_thresh,
                fuse_score=p.fuse_score,
            ),
            p.lost_velocity_keep,
        )
        self._history: deque[tuple[int, float, dict[int, np.ndarray]]] = deque()
        self._pending: tuple[np.ndarray, float] | None = None  # jev's box, carried to now
        self._fresh: _Fresh | None = None
        self._last_t: float | None = None
        self._fps = 15.0
        self._applied_seq = -1
        self._views: deque[np.ndarray] = deque(maxlen=self.params.views)  # jev's, newest last
        self._smooth = Stabilizer(p.smooth)
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

    def step(
        self,
        enc: Encoding,
        seq: int,
        t: float,
        vision: YoloeVision,
        camera: np.ndarray | None = None,
    ) -> Sighting:
        """Follow the object on frame `seq`. `camera` is how the picture moved since the frame
        before (a 2x3 transform, motion.py), when known."""
        self._tick_fps(t)
        self._moved(camera)
        prompt = self.prompt
        if prompt is None:
            self._remember(seq, t)
            return Sighting(False, state="unknown")

        boxes, scores, anchors = self._candidates(enc, self._scores(enc, vision, prompt))
        rows = self._tracks.update(_Detections(boxes, scores))
        active = {int(r[4]): (int(r[7]), float(r[5])) for r in rows}  # id -> (candidate, score)

        tid = self.target_id
        if tid is not None and tid not in active and not self._alive(tid):
            self.target_id = tid = None
            self.target_by = None
        if tid is not None and tid not in active:
            tid = self._rescue(tid, active, boxes, scores) or tid
        if tid is None and self._pending is not None:
            tid = self._place(active, boxes, scores, t)
        if tid is not None and tid not in active:
            # Missed on this frame: a track that just started where it was may be it.
            tid = self._continue_nearby(enc, vision, active, boxes, t) or tid
        if tid is None:
            tid = self._reacquire(enc, vision, active, boxes, t)
        self._remember(seq, t)

        if tid is not None and tid in active:
            i, score = active[tid]
            return self._sighted(enc, vision, tid, anchors[i], boxes[i], score, t)
        if tid is not None:
            return self._coast(tid, t)
        return Sighting(False, state="absent" if self.absent else "lost")

    def _scores(self, enc: Encoding, vision: YoloeVision, prompt: np.ndarray) -> np.ndarray:
        """Each candidate's score: the best against the prompt and jev's recent views."""
        if not self._views:
            return vision.scores(enc, prompt)[0]
        return vision.scores(enc, np.stack([prompt, *self._views])).max(axis=0)

    def _moved(self, camera: np.ndarray | None) -> None:
        """Carry the tracks, the last sighting, jev's pending box and the smoothing along."""
        self._tracks.camera = camera
        if camera is None:
            return
        if self._fresh is not None:
            self._fresh.box = warp_box(self._fresh.box, camera)
        if self._pending is not None:
            self._pending = (warp_box(self._pending[0], camera), self._pending[1])
        self._smooth.moved(camera)

    def _candidates(
        self, enc: Encoding, scores: np.ndarray
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        p = self.params
        idx = np.flatnonzero(scores >= p.rescue_min)
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
        size = (lb.width, lb.height)
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
        crop = vision.mask(enc, int(anchor), box)
        shown, shape = self._smooth.sighted(t, box, crop, size)
        if shape is None:
            shape = vision.shape(enc, int(anchor), box)
        self._fresh = _Fresh(
            t,
            box.copy(),
            confidence,
            at_edge,
            area > 0.6,
            size,
            self._tracks.frame_id,
            self.target_by,
        )
        return Sighting(True, shown, shape, confidence, "tracking", tid, box.copy(), crop)

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
        if _inside(box, fresh.size) < self.params.in_view:
            return Sighting(False, state="lost", track_id=tid)  # it left the view
        shown, shape = self._smooth.coasting(t, box, fresh.size)
        confidence = round(fresh.confidence * (1 - 0.5 * age / window), 3)
        return Sighting(True, shown, shape, confidence, "coasting", tid, box.copy())

    def _rescue(
        self,
        tid: int,
        active: dict[int, tuple[int, float]],
        boxes: np.ndarray,
        scores: np.ndarray,
    ) -> int | None:
        """The target missed by ByteTrack, but a weaker candidate sits on its predicted box:
        continue its track on that one."""
        p = self.params
        lost = next((s for s in self._tracks.lost_stracks if s.track_id == tid), None)
        if lost is None or not len(boxes):
            return None
        taken = {i for i, _ in active.values()}
        free = np.array([i not in taken for i in range(len(boxes))], dtype=bool)
        overlap = iou(boxes, np.asarray(lost.xyxy, dtype=np.float32))[:, 0]
        fit = np.where(free & (overlap >= p.rescue_iou), overlap * scores, 0.0)
        if not fit.any():
            return None
        i = int(np.argmax(fit))
        self._tracks.resume(lost, boxes[i], float(scores[i]), i)
        active[tid] = (i, float(scores[i]))
        return tid

    def _place(
        self,
        active: dict[int, tuple[int, float]],
        boxes: np.ndarray,
        scores: np.ndarray,
        t: float,
    ) -> int | None:
        """jev's box had no track: the candidate best filling it (carried to now) is the target,
        a new track if it isn't one yet."""
        p = self.params
        assert self._pending is not None
        box, since = self._pending
        if t - since > p.pending_s or not len(boxes):
            return None
        overlap = iou(boxes, box)[:, 0]
        fit = np.where(overlap >= p.place_iou, overlap * scores, 0.0)
        if not fit.any():
            return None
        i = int(np.argmax(fit))
        owner = next((tid for tid, (k, _) in active.items() if k == i), None)
        if owner is None:
            owner = self._tracks.start(boxes[i], float(scores[i]), i)
            active[owner] = (i, float(scores[i]))
        self.target_id, self.target_by = owner, "jev"
        self._pending = None
        self.doubt = 0
        return owner

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
        carry: np.ndarray | None = None,
    ) -> str:
        """Apply jev's answer about frame `seq`: a box in frame pixels and its visual prompt.
        `carry` is how the camera moved from that frame to the newest one (motion.py), if known.

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
        p = self.params
        snapshot = self._snapshot(seq)
        previous = self.target_id
        view = _unit(appearance)
        self._views.append(view)
        if not snapshot and previous is not None and self.running is not None:
            # jev looked at a frame from before any track existed (e.g. while its first answer
            # was still on the way), so there is nothing to match its box to. Keep a target
            # that looks like what jev saw instead of dropping it.
            if float(view @ self.running) >= p.reacquire_similarity:
                self.anchor = view
                return "kept: looks like it"
        best_id = self._match(snapshot, box)
        if best_id is None:
            # No track there on jev's frame: is one there now, with jev's box carried to now?
            now = self._history[-1][2] if self._history else None
            best_id = self._match(now, warp_box(box, carry))
        if best_id is not None:
            if previous == best_id:
                self.anchor = view
                self.target_by = "jev"
                self._pending = None
                return "confirmed"
            self.anchor = self.running = view
            self.target_id, self.target_by = best_id, "jev"
            self._pending = None
            return "found" if previous is None else f"moved from track {previous} to {best_id}"
        # Not a candidate on that frame: the new prompt will make it one, near where jev saw it.
        self.anchor = self.running = view
        self.target_id = self.target_by = None
        self._pending = (warp_box(box, carry), t)
        return "placed" if previous is None else f"placed away from track {previous}"

    def _match(self, tracks: dict[int, np.ndarray] | None, box: np.ndarray) -> int | None:
        """The track jev's box means: the one it overlaps most, if by `match_iou`, or one of the
        two inside the other (a part and its whole)."""
        best_id = self._best(tracks, box)
        if best_id is None:
            return None
        seen: set[int] = set()
        while best_id in self._successor and best_id not in seen:
            seen.add(best_id)
            best_id = self._successor[best_id]
        return best_id if self._alive(best_id) else None

    def _best(self, tracks: dict[int, np.ndarray] | None, box: np.ndarray) -> int | None:
        """_match before following successors: the id of the track on that frame."""
        if not tracks:
            return None
        p = self.params
        ids = list(tracks)
        stacked = np.stack([tracks[i] for i in ids])
        overlaps = iou(stacked, box)[:, 0]
        inside = _overlap(stacked, box)
        ok = (overlaps >= p.match_iou) | (
            (inside >= p.match_inside) & (overlaps >= p.match_iou / 2)
        )
        if not ok.any():
            return None
        return ids[int(np.argmax(np.where(ok, overlaps, -1.0)))]

    def container(
        self,
        seq: int,
        box: np.ndarray,
        carry: np.ndarray | None,
        enc: Encoding,
        vision: YoloeVision,
        appearance: np.ndarray,
    ) -> np.ndarray | None:
        """What `identified` would match or place jev's box onto, when jev's box is only a part
        of it (part.is_part): that track's or candidate's box. `enc` is jev's frame and
        `appearance` jev's view on it. None when jev's box is the whole of what it lands on, and
        when it is cut by the frame's edge: that is an object partly out of view."""
        from .part import is_part

        p = self.params
        if touches_edge(box, enc.letterbox.width, enc.letterbox.height):
            return None
        found = self._best(self._snapshot(seq), box)
        if found is not None:
            snapshot = self._snapshot(seq)
            assert snapshot is not None
            whole = snapshot[found]
            return whole if is_part(box, whole, p) else None
        carried = warp_box(box, carry)
        now = self._history[-1][2] if self._history else None
        found = self._best(now, carried)
        if found is not None:
            assert now is not None
            return now[found] if is_part(carried, now[found], p) else None
        # The candidate _place would take, scored as it will be: against jev's view; else the
        # strongest one holding jev's box, which _reacquire would take (a part's view resembles
        # its whole's).
        boxes, scores, _ = self._candidates(enc, vision.scores(enc, appearance)[0])
        if not len(boxes):
            return None
        overlap = iou(boxes, box)[:, 0]
        fit = np.where(overlap >= p.place_iou, overlap * scores, 0.0)
        if fit.any():
            whole = boxes[int(np.argmax(fit))]
        else:
            area = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
            holds = (_overlap(boxes, box) >= p.part_inside) & (scores >= p.track_high)
            holds &= area > (box[2] - box[0]) * (box[3] - box[1])
            if not holds.any():
                return None
            whole = boxes[int(np.argmax(np.where(holds, scores, -1.0)))]
        return whole if is_part(box, whole, p) else None

    def box_on(self, seq: int) -> np.ndarray | None:
        """The target's tracked box on frame `seq`, if it was a track then."""
        snapshot = self._snapshot(seq)
        if not snapshot or self.target_id is None:
            return None
        return snapshot.get(self.target_id)

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


def _byte_tracker():
    from ultralytics.trackers.basetrack import TrackState
    from ultralytics.trackers.byte_tracker import BYTETracker, STrack

    class ByteTrack(BYTETracker):
        """Ultralytics' ByteTrack, plus the camera's motion and a way to place a track by hand."""

        def __init__(self, args, lost_velocity_keep: float):
            super().__init__(args)
            self.camera: np.ndarray | None = None
            self.lost_velocity_keep = lost_velocity_keep

        def _pre_first_associate(self, strack_pool, unconfirmed, img, results_high) -> None:
            # After the Kalman prediction, before matching: move every track with the camera.
            # (Ultralytics' multi_gmc assumes an XYWH state; ByteTrack's is XYAH.)
            for track in strack_pool:
                if track.state != TrackState.Tracked:
                    track.mean[4:6] *= self.lost_velocity_keep
            if self.camera is None:
                return
            a, shift = self.camera[:, :2], self.camera[:, 2]
            s = float(np.sqrt(abs(np.linalg.det(a))))
            warp = np.eye(8)
            warp[:2, :2] = a
            warp[4:6, 4:6] = a
            warp[3, 3] = warp[7, 7] = s
            for track in [*strack_pool, *unconfirmed]:
                mean = warp @ track.mean
                mean[:2] += shift
                track.mean = mean
                track.covariance = warp @ track.covariance @ warp.T

        def resume(self, track, box: np.ndarray, score: float, idx: int) -> None:
            """Continue a track missed on this frame on candidate `idx` after all."""
            track.re_activate(self._detection(box, score, idx), self.frame_id)
            if track in self.lost_stracks:
                self.lost_stracks.remove(track)
            if track not in self.tracked_stracks:
                self.tracked_stracks.append(track)

        def start(self, box: np.ndarray, score: float, idx: int) -> int:
            """A new confirmed track on candidate `idx` (jev named it, so it needs no second
            sighting). Returns its id."""
            track = self._detection(box, score, idx)
            track.activate(self.kalman_filter, self.frame_id)
            track.is_activated = True
            self.tracked_stracks.append(track)
            return track.track_id

        def _detection(self, box: np.ndarray, score: float, idx: int):
            b = np.asarray(box, dtype=np.float32)
            xywh = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, b[2] - b[0], b[3] - b[1], idx]
            track = STrack(np.asarray(xywh, dtype=np.float32), score, 0.0)
            track.next_id = self._ids.__next__
            return track

    return ByteTrack


_ByteTrackClass = None


def _ByteTrack(args, lost_velocity_keep: float):  # noqa: N802 - built on first use
    global _ByteTrackClass
    if _ByteTrackClass is None:
        _ByteTrackClass = _byte_tracker()
    return _ByteTrackClass(args, lost_velocity_keep)


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


def _inside(box: np.ndarray, size: tuple[int, int]) -> float:
    """The share of `box` inside a frame of this width and height."""
    w, h = size
    area = max(float((box[2] - box[0]) * (box[3] - box[1])), 1e-9)
    iw = max(0.0, min(float(box[2]), w) - max(float(box[0]), 0.0))
    ih = max(0.0, min(float(box[3]), h) - max(float(box[1]), 0.0))
    return iw * ih / area


def _unit(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, dtype=np.float32)
    return v / max(float(np.linalg.norm(v)), 1e-12)
