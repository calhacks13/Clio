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
- **The part rides on it.** The camera's motion (motion.py) carries the part box, and the
  parent's own motion on top of it, as far as its box's sides agree (YOLOE's box for an object
  also changes its extent, taking in a neighbor or cut by the frame's edge): along each axis
  the smaller shift of its two sides when they agree, and a scale when the parent, wholly in
  view, grows alike in width and height. While the parent coasts, or none is in sight, the
  camera alone carries the part. jev's next answer puts it right again.
- **Its outline** is the parent's mask inside the part box, so the shape follows the object's
  real edges where the part meets them; when the parent's mask hardly covers the part box, the
  part box itself as a rounded rectangle. `point` and `contact` are the part's. It is steadied
  like any outline (smooth.py).
- **jev re-seeds it.** Each answer puts the part box where jev put it (carried to now by the
  camera) and measures it against the parent again; nothing is snapped to the parent's box.

With a segmenter (segment.py) the part gets a mask of its own: cut out on jev's frame, and again
whenever asked, then carried to every frame by a RegionFollower (follow.py) on the part's own
pixels. While the follower is confident, its box is the part box and its mask the outline, also
where the parent's motion would never take it (a door swinging out of the fridge's box, a jaw
sliding off the caliper's). The parent is still followed on every frame, since it is what finds
the whole object again, and the part's confidence and state are still the parent's (with none
in sight, a coasting part's). Otherwise the part rides and is outlined as above, and after two
frames of doubt, or while there is no mask yet, it asks to be cut out again (`wants_refresh`):
around the follower's box when the follower is unsure, else the part box (`refresh_box`). An
answer from jev that puts the part box more than its own size away (another part), or says the
part is not in view, drops the old part's mask.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .follow import Followed, RegionFollower
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
    best = scores.argmax(axis=1)  # each object's best candidate
    good = scores[np.arange(len(reps)), best] >= p.parent_min
    if not good.any():
        return None
    # The smallest object holding the part rides closest with it: the part itself when YOLOE
    # proposes it, else e.g. a sliding jaw before the whole caliper.
    sizes = np.where(good, area[idx[best]], np.inf)
    return boxes[idx[best[int(np.argmin(sizes))]]].copy()


@dataclass
class PartTracker:
    """Follows one part of an object between jev's answers; `step`, `identified`, `refreshed`,
    `wants_refresh` and `refresh_box` like an ObjectTracker's, except that jev's frame (`enc`)
    comes with each answer."""

    object_id: str
    phrase: str | None
    params: TrackerParams = field(default_factory=TrackerParams)
    follower: RegionFollower | None = None  # carries the segmenter's mask of the part
    parent: ObjectTracker | None = None  # followed without a follower: it keeps the identity
    absent: bool = False  # jev's last answer: not in view

    def __post_init__(self) -> None:
        self._box: np.ndarray | None = None  # the part on the last frame, frame pixels
        self._held_by: np.ndarray | None = None  # the parent's tracked box on the last frame
        self._seen_t = 0.0  # jev's last answer, or the parent's last sighting
        self._applied_seq = -1
        self._smooth = Stabilizer(self.params.smooth)
        self._followed: Followed | None = None  # the follower's answer on the last frame
        self._shown = False  # the part was shown on the last frame
        self._follow_doubt = 0  # consecutive frames the follower could not stand for the part

    @property
    def box(self) -> np.ndarray | None:
        """The part on the newest frame, frame pixels (unsmoothed)."""
        return None if self._box is None else self._box.copy()

    @property
    def wants_refresh(self) -> bool:
        """The segmenter should cut the part out again: while it is shown, the follower has no
        mask yet, or has been in doubt for `refresh_after_frames` frames."""
        if self.follower is None or not self._shown:
            return False
        return not self.follower.active or self._follow_doubt >= self.params.refresh_after_frames

    @property
    def refresh_box(self) -> np.ndarray | None:
        """The box to prompt the segmenter with: the follower's on the last frame when it was
        unsure of itself, else the part box (which is the follower's when it was sure)."""
        f = self._followed
        box = f.box if f is not None and not f.confident else self._box
        return None if box is None else box.copy()

    # --- jev and the segmenter -------------------------------------------------------------

    def identified(
        self,
        seq: int,
        t: float,
        present: bool,
        box: np.ndarray | None,
        enc: Encoding,
        vision: YoloeVision,
        carry: np.ndarray | None = None,
        mask: MaskCrop | None = None,
    ) -> str:
        """jev's box around the part on frame `seq` (encoded as `enc`); `carry` is how the
        camera moved from that frame to the newest. `mask` is the segmenter's cut of jev's box
        on that frame, for the follower. Returns what changed, for the log."""
        before = self._box
        change = self._identify(seq, t, present, box, enc, vision, carry)
        if self.follower is None or change == "stale":
            return change
        if before is None or self._box is None or _moved_off(before, self._box):
            # Another part, or none: forget the old one's mask. The cut of jev's box comes from
            # jev's older frame, and must not lose to a refresh of the old part. Until the next
            # frame nothing is asked, around the old part's box least of all.
            self.follower.clear()
            self._followed, self._shown, self._follow_doubt = None, False, 0
        if mask is not None and self._box is not None:
            self.follower.set_reference(seq, mask)
        return change

    def refreshed(self, seq: int, crop: MaskCrop | None) -> None:
        """The segmenter's answer to a refresh asked on frame `seq`: its mask of the part, or
        None when it found nothing (a frame of doubt). A mask ends the doubt; the follower
        ignores one from before the mask it has."""
        if self.follower is None:
            return
        if crop is None:
            self._follow_doubt += 1
        else:
            self.follower.set_reference(seq, crop)
            self._follow_doubt = 0

    def _identify(
        self,
        seq: int,
        t: float,
        present: bool,
        box: np.ndarray | None,
        enc: Encoding,
        vision: YoloeVision,
        carry: np.ndarray | None,
    ) -> str:
        """`identified`, apart from the follower."""
        if seq < self._applied_seq:
            return "stale"
        self._applied_seq = seq
        if not present or box is None:
            self.absent = True
            self._box = None
            return "part absent"
        self.absent = False
        box = np.asarray(box, dtype=np.float32)
        _, change = self._parent_on(seq, t, box, enc, vision, carry)
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
        gray: np.ndarray | None = None,
    ) -> Sighting:
        """Follow the part on frame `seq`. `camera` is how the picture moved since the frame
        before (a 2x3 transform, motion.py), when known. `gray` is the frame in 8-bit gray for
        the follower, which steps on every frame it is given."""
        p = self.params
        size = (enc.letterbox.width, enc.letterbox.height)
        self._smooth.moved(camera)
        self._followed, self._shown = None, False
        if self.follower is not None and gray is not None:
            self._followed = self.follower.step(seq, gray, camera, t)
        parent = self.parent.step(enc, seq, t, vision, camera) if self.parent else None
        if self._box is None:
            return Sighting(False, state="absent" if self.absent else "unknown")
        box = warp_box(self._box, camera)
        held = parent is not None and parent.found and parent.measured is not None
        if held:
            assert parent is not None and parent.measured is not None
            self._seen_t = t
        # The part rides on the parent's sightings only: while it coasts, its predicted box says
        # no more than the camera's motion does.
        if held and parent is not None and parent.state == "tracking":
            now = parent.measured
            assert now is not None
            last = warp_box(self._held_by, camera) if self._held_by is not None else None
            if last is not None and float(iou(last, now)[0, 0]) < p.part_jump_iou:
                # YOLOE's box for the parent changed its extent (a jaw, then the whole caliper),
                # it did not move.
                last = None
            box = self._ride(box, last, now, size)
            self._held_by = now.copy()
        else:
            self._held_by = None
        f = self._followed
        followed = f if f is not None and f.confident else None
        if followed is not None:
            # The part's own pixels say where it is, also where the parent's motion would never
            # take it (a door swinging out of the fridge's box).
            box = followed.box.astype(np.float32)
        self._box = box
        age = t - self._seen_t
        if _inside(box, size) < p.in_view or age > p.part_hold_s:
            return Sighting(False, state="lost")
        self._shown = True
        if f is not None:
            self._follow_doubt = 0 if followed is not None else self._follow_doubt + 1
        coasting = round(0.5 * (1 - 0.5 * age / p.part_hold_s), 3)
        if followed is not None:
            crop = followed.crop
            shown, shape = self._smooth.sighted(t, box, crop, size)
            if held:
                assert parent is not None
                return Sighting(True, shown, shape, parent.confidence, parent.state,
                                parent.track_id, box.copy(), crop)  # fmt: skip
            return Sighting(True, shown, shape, coasting, "coasting", None, box.copy(), crop)
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
        return Sighting(True, shown, shape, coasting, "coasting", None, box.copy(), crop)

    def _ride(
        self,
        box: np.ndarray,
        last: np.ndarray | None,
        now: np.ndarray,
        size: tuple[int, int],
    ) -> np.ndarray:
        """The part box (already carried by the camera) moved as the parent moved since the last
        frame (`last`, carried by the camera too, to `now`). YOLOE's box for an object also
        changes its extent (it takes in a neighbor, or is cut by the frame's edge), so the part
        moves only as far as the parent's free sides agree: along each axis, the smaller of
        their two shifts when they shift the same way, none when they don't. It scales only when
        the parent is wholly in view and grows alike in width and height."""
        if last is None:
            return box
        free = [_free(now, k, size[k]) and _free(last, k, size[k]) for k in (0, 1)]
        sx = float(now[2] - now[0]) / max(float(last[2] - last[0]), 1e-3)
        sy = float(now[3] - now[1]) / max(float(last[3] - last[1]), 1e-3)
        if all(all(f) for f in free) and abs(sx - sy) <= 0.03 * max(sx, sy):
            s = math.sqrt(sx * sy)
            c_last, c_now = _centre(last), _centre(now)
            centre = c_now + s * (_centre(box) - c_last)
            half = s * (box[2:] - box[:2]) / 2
            return np.concatenate([centre - half, centre + half]).astype(np.float32)
        out = box.astype(np.float32).copy()
        for k in (0, 1):
            shifts = [
                float(now[i] - last[i]) for i, ok in ((k, free[k][0]), (k + 2, free[k][1])) if ok
            ]
            if len(shifts) == 2:
                shift = min(shifts, key=abs) if shifts[0] * shifts[1] > 0 else 0.0
            elif shifts:
                shift = shifts[0]
            else:
                continue
            out[k] += shift
            out[k + 2] += shift
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


def _moved_off(before: np.ndarray, after: np.ndarray) -> bool:
    """`after` lies more than `before`'s own size away from it: its centre moved farther than
    `before`'s width along x, or its height along y."""
    shift = np.abs(_centre(after) - _centre(before))
    return bool(shift[0] > before[2] - before[0] or shift[1] > before[3] - before[1])


def _centre(box: np.ndarray) -> np.ndarray:
    return np.array([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], dtype=np.float64)


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
