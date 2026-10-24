"""Follow one part of an object: a label, a button, a wheel (TRACK.md, `"part": true`).

Followed like an object, a part ends up as its whole: YOLOE proposes whole objects far more
often than their parts (a micrometer's thimble has no candidate of its own), and the part's
visual prompt resembles its whole's, so jev's box around the part was placed on, confirmed as,
or re-acquired as the whole object's track, and the whole object's mask came back. A part is
therefore never matched to a track; it is a box carried by motion:

- **A parent.** The object holding the part is followed as an object of its own (an
  ObjectTracker prompted by its own box on jev's frame). It is the candidate holding the part
  box whose box scores best against its own view: an object's own box scores 0.9 or more (a
  caliper, a micrometer, a rotary switch), a box over pieces of several things or background
  next to nothing. It may be the part itself when YOLOE proposes it (a name plate).
- **The part rides on it.** The part box is kept in the parent box's coordinates (translation and
  scale on each axis), so it moves and scales with the parent's tracked box. Along an axis where
  the parent's box is cut by the frame's edge, its free side's motion carries the part; with no
  parent in sight the camera's motion (motion.py) does.
- **Its outline** is the parent's mask inside the part box, so the shape follows the object's
  real edges where the part meets them; when the parent's mask hardly covers the part box, the
  part box itself as a rounded rectangle. `point` and `contact` are the part's. It is steadied
  like any outline (smooth.py).
- **jev re-seeds it.** Each answer puts the part box where jev put it (carried to now by the
  camera) and measures it against the parent again; nothing is snapped to the parent's box.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .geometry import iou, nms, valid_box
from .motion import warp_box
from .smooth import Stabilizer, _sample
from .tracking import ObjectTracker, Sighting, TrackerParams, _inside
from .vision import Encoding, MaskCrop, YoloeVision

EDGE = 0.01  # a box side within this share of the frame of its edge is cut by it


def is_part(box: np.ndarray, whole: np.ndarray, params: TrackerParams) -> bool:
    """`box` is a part of `whole`: it covers less than `part_cover` of it and lies mostly inside."""
    return (
        _area(box) < params.part_cover * _area(whole)
        and _held(box, whole[None])[0] >= params.part_inside
    )


def find_parent(
    enc: Encoding, vision: YoloeVision, box: np.ndarray, params: TrackerParams
) -> np.ndarray | None:
    """The candidate box on this frame of the object holding the part box `box`, or None."""
    p = params
    lb = enc.letterbox
    boxes = lb.to_frame(enc.boxes)
    area = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
    ok = (_held(box, boxes) >= p.part_inside) & (area >= p.part_inside * _area(box))
    ok &= area <= p.parent_max_area * lb.width * lb.height
    idx = np.flatnonzero(ok)
    idx = idx[[valid_box(b) for b in boxes[idx]]] if idx.size else idx
    if not idx.size:
        return None
    # One box per object, smallest first; each prompts with its own view, and every holding
    # candidate it overlaps is scored against that view: an object's best candidate wins.
    reps = idx[nms(boxes[idx], -area[idx], 0.5)][: p.parent_reps]
    scores = vision.scores(enc, vision.prompts(enc, boxes[reps]))[:, idx]  # (R, holding)
    near = iou(boxes[reps], boxes[idx]) >= 0.5
    scores = np.where(near, scores, 0.0)
    r, i = np.unravel_index(int(np.argmax(scores)), scores.shape)
    if scores[r, i] < p.parent_min:
        return None
    return boxes[idx[i]].copy()


@dataclass
class PartTracker:
    """Follows one part of an object between jev's answers; `step` and `identified` like an
    ObjectTracker's, except that jev's frame (`enc`) comes with each answer."""

    object_id: str
    phrase: str | None
    params: TrackerParams = field(default_factory=TrackerParams)
    parent: ObjectTracker | None = None
    absent: bool = False  # jev's last answer: not in view

    def __post_init__(self) -> None:
        self._box: np.ndarray | None = None  # the part on the last frame, frame pixels
        # Per axis (x, y): the part's two sides in units of the parent box's, from its low side.
        self._rel: list[tuple[float, float] | None] = [None, None]
        self._held_by: np.ndarray | None = None  # the parent's tracked box on the last frame
        self._seen_t = 0.0  # jev's last answer, or the parent's last sighting
        self._applied_seq = -1
        self._smooth = Stabilizer(self.params.smooth)

    @property
    def box(self) -> np.ndarray | None:
        """The part on the newest frame, frame pixels (unsmoothed)."""
        return None if self._box is None else self._box.copy()

    # --- jev -------------------------------------------------------------------------------

    def identified(
        self,
        seq: int,
        t: float,
        present: bool,
        box: np.ndarray | None,
        enc: Encoding,
        vision: YoloeVision,
        carry: np.ndarray | None = None,
    ) -> str:
        """jev's box around the part on frame `seq` (encoded as `enc`); `carry` is how the
        camera moved from that frame to the newest. Returns what changed, for the log."""
        if seq < self._applied_seq:
            return "stale"
        self._applied_seq = seq
        if not present or box is None:
            self.absent = True
            self._box = None
            return "part absent"
        self.absent = False
        box = np.asarray(box, dtype=np.float32)
        held_by, change = self._parent_on(seq, t, box, enc, vision, carry)
        size = (enc.letterbox.width, enc.letterbox.height)
        self._rel = [_axis_rel(box, held_by, k, size) for k in (0, 1)]
        self._box = warp_box(box, carry)
        self._held_by = None
        self._seen_t = t
        return change

    def _parent_on(
        self,
        seq: int,
        t: float,
        box: np.ndarray,
        enc: Encoding,
        vision: YoloeVision,
        carry: np.ndarray | None,
    ) -> tuple[np.ndarray | None, str]:
        """The parent's box on jev's frame, after telling the parent where it is."""
        p = self.params
        if self.parent is not None:
            held = self.parent.box_on(seq)
            if held is not None and _held(box, held[None])[0] >= p.part_inside:
                view = vision.prompts(enc, held)[0]
                change = self.parent.identified(seq, t, True, held, view, carry)
                return held, f"part, on the object holding it ({change})"
        found = find_parent(enc, vision, box, p)
        if found is None:
            self.parent = None
            return None, "part, carried by the camera (no object holds it)"
        if self.parent is None:
            self.parent = ObjectTracker(f"{self.object_id}/parent", None, p)
        view = vision.prompts(enc, found)[0]
        change = self.parent.identified(seq, t, True, found, view, carry)
        held = self.parent.box_on(seq)
        if held is None or float(iou(held, found)[0, 0]) < 0.5:
            held = found
        return held, f"part, on an object holding it ({change})"

    # --- per frame -------------------------------------------------------------------------

    def step(
        self,
        enc: Encoding,
        seq: int,
        t: float,
        vision: YoloeVision,
        camera: np.ndarray | None = None,
    ) -> Sighting:
        p = self.params
        size = (enc.letterbox.width, enc.letterbox.height)
        self._smooth.moved(camera)
        parent = self.parent.step(enc, seq, t, vision, camera) if self.parent else None
        if self._box is None:
            return Sighting(False, state="absent" if self.absent else "unknown")
        box = warp_box(self._box, camera)
        held = parent is not None and parent.found and parent.measured is not None
        if held:
            assert parent is not None and parent.measured is not None
            last = warp_box(self._held_by, camera) if self._held_by is not None else None
            box = self._ride(box, last, parent.measured, size)
            self._held_by = parent.measured.copy()
            self._seen_t = t
        else:
            self._held_by = None
        self._box = box
        age = t - self._seen_t
        if _inside(box, size) < p.in_view or age > p.part_hold_s:
            return Sighting(False, state="lost")
        if held:
            assert parent is not None
            crop = parent.crop
            if crop is not None and _fill(crop, box) >= p.part_fill:
                shown, shape = self._smooth.sighted(t, box, crop, size)
                return Sighting(True, shown, shape, parent.confidence, parent.state,
                                parent.track_id, box.copy(), crop)  # fmt: skip
            if parent.state == "coasting":
                shown, shape = self._smooth.coasting(t, box, size)
                if shape is not None:
                    return Sighting(True, shown, shape, parent.confidence, "coasting",
                                    parent.track_id, box.copy())  # fmt: skip
        crop = rounded_crop(box)
        shown, shape = self._smooth.sighted(t, box, crop, size)
        if held:
            assert parent is not None
            return Sighting(True, shown, shape, parent.confidence, parent.state,
                            parent.track_id, box.copy(), crop)  # fmt: skip
        confidence = round(0.5 * (1 - 0.5 * age / p.part_hold_s), 3)
        return Sighting(True, shown, shape, confidence, "coasting", None, box.copy(), crop)

    def _ride(
        self,
        box: np.ndarray,
        last: np.ndarray | None,
        now: np.ndarray,
        size: tuple[int, int],
    ) -> np.ndarray:
        """The part box (already carried by the camera) moved with the parent, now at `now` and
        on the last frame at `last` (carried by the camera too), axis by axis."""
        out = box.astype(np.float32).copy()
        for k, limit in ((0, size[0]), (1, size[1])):
            lo, hi = k, k + 2
            free = _free(now, k, limit)
            rel = self._rel[k]
            if all(free) and rel is not None:
                span = float(now[hi] - now[lo])
                out[lo], out[hi] = now[lo] + rel[0] * span, now[lo] + rel[1] * span
                continue
            if last is not None:
                was = _free(last, k, limit)
                lo_ok, hi_ok = free[0] and was[0], free[1] and was[1]
                if lo_ok and hi_ok:
                    s = float(now[hi] - now[lo]) / max(float(last[hi] - last[lo]), 1e-3)
                    out[lo] = now[lo] + (box[lo] - last[lo]) * s
                    out[hi] = now[lo] + (box[hi] - last[lo]) * s
                elif lo_ok or hi_ok:
                    side = lo if lo_ok else hi
                    shift = float(now[side] - last[side])
                    out[lo] += shift
                    out[hi] += shift
            if all(free) and rel is None:
                span = max(float(now[hi] - now[lo]), 1e-3)
                self._rel[k] = (float(out[lo] - now[lo]) / span, float(out[hi] - now[lo]) / span)
        return out


def rounded_crop(box: np.ndarray, radius: float = 0.25, cells: int = 48) -> MaskCrop:
    """The box as a rounded rectangle (corners of `radius` times its shorter side), as mask
    logits over it."""
    b = np.asarray(box, dtype=np.float64)
    w, h = max(b[2] - b[0], 1.0), max(b[3] - b[1], 1.0)
    scale = max(w, h) / cells  # frame pixels per crop pixel
    cols, rows = max(2, math.ceil(w / scale)), max(2, math.ceil(h / scale))
    xs = b[0] + (np.arange(cols) + 0.5) * scale
    ys = b[1] + (np.arange(rows) + 0.5) * scale
    r = radius * min(w, h)
    dx = np.maximum(np.abs(xs - (b[0] + b[2]) / 2) - (w / 2 - r), 0.0)
    dy = np.maximum(np.abs(ys - (b[1] + b[3]) / 2) - (h / 2 - r), 0.0)
    d = np.hypot(dx[None, :], dy[:, None]) - r  # signed distance to the edge, < 0 inside
    logits = np.clip(-4.0 * d / scale, -20, 20).astype(np.float32)
    return MaskCrop(logits, (float(b[0]), float(b[1])), float(scale))


def _fill(crop: MaskCrop, box: np.ndarray) -> float:
    """The share of `box` the crop's mask covers."""
    return float((_sample(crop, np.asarray(box, dtype=np.float32), (24, 24)) > 0.5).mean())


def _axis_rel(
    box: np.ndarray, held_by: np.ndarray | None, k: int, size: tuple[int, int]
) -> tuple[float, float] | None:
    """The part's sides along axis k in units of the parent box's, when that box is whole
    along it."""
    if held_by is None or not all(_free(held_by, k, size[k])):
        return None
    lo, hi = k, k + 2
    span = max(float(held_by[hi] - held_by[lo]), 1e-3)
    return (float(box[lo] - held_by[lo]) / span, float(box[hi] - held_by[lo]) / span)


def _free(box: np.ndarray, k: int, limit: float) -> tuple[bool, bool]:
    """Whether the box's low and high sides along axis k are clear of the frame's edges."""
    m = EDGE * limit
    return bool(box[k] > m), bool(box[k + 2] < limit - m)


def _held(box: np.ndarray, holders: np.ndarray) -> np.ndarray:
    """For each of (N, 4) `holders`, the share of `box` inside it."""
    h = np.asarray(holders, dtype=np.float32).reshape(-1, 4)
    w = (np.minimum(h[:, 2], box[2]) - np.maximum(h[:, 0], box[0])).clip(0)
    v = (np.minimum(h[:, 3], box[3]) - np.maximum(h[:, 1], box[1])).clip(0)
    return w * v / max(_area(box), 1e-9)


def _area(box: np.ndarray) -> float:
    return float(max(box[2] - box[0], 0) * max(box[3] - box[1], 0))
