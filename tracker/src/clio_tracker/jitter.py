"""An offline steadiness benchmark for the /track stream: `clio-tracker jitter`.

It plays what the headset sends: 480x360 JPEGs at 25 frames a second from a camera that pans,
zooms and shakes across still photos (with motion blur, a hand passing in front of the object
and a glance away), through `StreamTracker.step` exactly as `/track` does. About once a second a
"look" is answered 1 to 2 seconds later, as Gemini, jev and Clio's `/locate` do: jev's box is the
true box with jev-sized noise, outlined by YOLOE like `finder.py` does, and sent as the target
for the frame it was measured on.

Because the camera is known, every frame has a true box and a true motion, so the report can
separate the tracker's own wobble from real movement:

- `lost`: share of frames, from the first target on, where the object is in view but the
  answer has no outline (`found: false`). `coast`: share drawn at a predicted place.
- `wrong`: share of found frames whose box is on something else.
- `on whole` (part scenes): share of found frames whose box is nearer the whole object's than
  the part's (by IoU): the part mistaken for its whole.
- `IoU`: the box against the true box (accuracy, including any lag smoothing adds).
- `jitter`: the second difference of a point from frame to frame, |e(t) - 2 e(t-1) + e(t-2)|,
  in frame pixels, where e is the point's offset from the true box's centre: the true motion
  cancels out, so a still camera and a panning one with the same tracker wobble score alike.
  For the box centre, the outline's centroid, `point` and `contact`.
- `box f2f` / `mask f2f`: IoU of each frame's box / outline with the previous frame's moved by
  the true camera motion: 1.0 is perfectly steady. `swaps`: frames where the outline changed
  so much (IoU under 0.5) that it reads as a different mask.
- `refreshes`: segmenter calls over the sequence (0 without a segmenter).
- `ms`: time in `step`, per frame (`p95` too), and the part of it after YOLOE's pass.

Part scenes (`PART_SCENES`) follow one part of an object, as the primary demo's `?focus=part`
does: the camera frames the part, jev's box is the part's and the target says `"part": true`
(`--no-part-flag` leaves it out, to try telling a part from the whole by itself). Their numbers
are summed up apart from the whole objects'. Two of them move the part on its own (`Scene.motion`):
`jaw-slide` slides it along the object and `plate-swing` swings it narrow and back, while the
whole object stays put and the true box follows the part. The photo's own part is erased where
the moved one leaves it, so no copy of it stays behind. These two have a `moving` row of their
own and are left out of `parts`, which stays comparable with earlier runs.

`--segmenter` (`auto`, `none` or a SAM 2.1 size; `run` also takes `fake`, a segmenter that fills
each box, for tests) gives the tracker a segmenter and a refresher as `/track` has them, and has
the look outlined by the segmenter, and by YOLOE where it cuts nothing. A `--baseline` copy
gets neither.

`--baseline DIR` loads another copy of the package (a directory holding a `clio_tracker`
package, e.g. `git archive HEAD tracker/src | tar -x -C /tmp/base`) and runs it on the same
frames and the same looks, for a before/after table.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import math
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, fields
from pathlib import Path
from time import perf_counter

import cv2
import numpy as np

from .geometry import iou
from .segment import SegEncoding, load_segmenter

OUT_W, OUT_H = 480, 360
FPS = 25.0
JPEG_QUALITY = 70  # the page's 0.7
REPO = Path(__file__).resolve().parents[3]
JEV_FUN = Path.home() / "Desktop" / "Jev fun" / "data" / "images"
# Photo pixels beside a moving part that tile over the place it leaves. One column smears the
# photo's edge across it; a wider strip tiles into a comb of vertical edges (8 px read as a scale
# of its own on the caliper), a texture the real scene does not have.
ERASE_STRIP = 1


@dataclass(frozen=True)
class Scene:
    name: str
    path: Path
    box: tuple[float, float, float, float]  # the object, in photo pixels
    label: str
    part: tuple[float, float, float, float] | None = None  # the part followed, if one
    share: float = 0.4  # with a part: the share of the view's width it spans
    motion: str | None = None  # with a part: "slide" or "swing", it moves on its own


SCENES = [
    Scene("caliper", REPO / "apps/headset/public/demo/caliper.jpg", (222, 185, 1280, 745),
          "silver metal caliper"),
    Scene("micrometer", REPO / "apps/headset/public/demo/micrometer.jpg", (115, 60, 1230, 875),
          "micrometer"),
    Scene("condenser", JEV_FUN / "glassware.jpg", (233, 304, 400, 771),
          "glass condenser with bulbs"),
    Scene("test-tube", JEV_FUN / "tubes.jpg", (587, 333, 673, 853), "test tube"),
    Scene("transistor", JEV_FUN / "pcb.jpg", (737, 616, 907, 800), "black transistor"),
    Scene("battery", JEV_FUN / "components.jpg", (244, 631, 357, 804), "9 V battery"),
    Scene("speaker", JEV_FUN / "components.jpg", (469, 349, 600, 476), "round speaker"),
]  # fmt: skip

DEMO = REPO / "apps/headset/public/demo"
PART_SCENES = [
    Scene("vernier", DEMO / "caliper.jpg", (222, 185, 1280, 745), "vernier scale of caliper",
          (445, 410, 865, 463), 0.45),
    Scene("thimble", DEMO / "micrometer.jpg", (115, 60, 1230, 875), "thimble of micrometer",
          (695, 75, 1105, 385), 0.45),
    Scene("name-plate", DEMO / "micrometer.jpg", (115, 60, 1230, 875),
          "name plate of micrometer", (400, 712, 588, 842), 0.3),
    Scene("shaft", JEV_FUN / "components.jpg", (632, 540, 862, 668), "shaft of rotary switch",
          (720, 600, 862, 668), 0.35),
    Scene("terminals", JEV_FUN / "components.jpg", (244, 625, 357, 804),
          "terminals of 9 V battery", (262, 628, 340, 648), 0.3),
    Scene("jaw-slide", DEMO / "caliper.jpg", (222, 185, 1280, 745), "sliding jaw of caliper",
          (445, 410, 865, 463), 0.45, motion="slide"),
    Scene("plate-swing", DEMO / "micrometer.jpg", (115, 60, 1230, 875),
          "name plate of micrometer", (400, 712, 588, 842), 0.3, motion="swing"),
]  # fmt: skip
ALL_SCENES = SCENES + PART_SCENES


@dataclass
class Frame:
    jpeg: bytes
    truth: np.ndarray | None  # the target's box in frame pixels, None when out of view
    affine: np.ndarray  # photo pixels to frame pixels, 2x3
    whole: np.ndarray | None = None  # with a part: the whole object's box


@dataclass
class Sequence:
    scene: Scene
    frames: list[Frame]
    looks: list[tuple[int, int, np.ndarray | None]]  # (asked on frame, answered before frame, box)


# --- the camera --------------------------------------------------------------------------------


def _ramp(t: float, start: float, rise: float, hold: float, fall: float) -> float:
    """0 before start, up to 1 over `rise`, held, back to 0 over `fall` (smoothstep)."""
    if t < start or t > start + rise + hold + fall:
        return 0.0
    if t < start + rise:
        x = (t - start) / rise
    elif t < start + rise + hold:
        return 1.0
    else:
        x = 1 - (t - start - rise - hold) / fall
    return x * x * (3 - 2 * x)


def _move_part(
    bgr: np.ndarray, part: tuple[float, float, float, float], t: float, motion: str
) -> tuple[np.ndarray, np.ndarray]:
    """The photo with its part moved on its own at `t` seconds, and the part's box now.

    Both are in photo pixels, before the camera. The part's old place is first painted over with
    the strip of photo beside it (`ERASE_STRIP` wide, tiled across the place) on the side the
    part moves away from, so no copy of the part stays behind, and then the patch is pasted.
    `slide` shifts it along x by up to a quarter of its width, back and forth every 2 seconds;
    `swing` pivots it on its right edge, its width going from full to half and back every 3
    seconds.
    """
    x1, y1, x2, y2 = (int(round(v)) for v in part)
    w = x2 - x1
    patch = bgr[y1:y2, x1:x2]
    out = bgr.copy()
    if motion == "slide":
        dx = int(round(0.25 * w * math.sin(2 * np.pi * 0.5 * t)))
        _erase(out, bgr, (x1, y1, x2, y2), "left" if dx >= 0 else "right")
        out[y1:y2, x1 + dx : x2 + dx] = patch
        return out, np.array([x1 + dx, y1, x2 + dx, y2], dtype=np.float64)
    if motion == "swing":
        _erase(out, bgr, (x1, y1, x2, y2), "right")  # the hinge is the right edge
        narrow = max(1, int(round(w * (0.75 + 0.25 * math.cos(2 * np.pi * t / 3)))))
        k = narrow / w  # scale x about the right edge (the hinge), as pixel centres see it
        to_hinge = np.array([[k, 0, w - narrow + 0.5 * (k - 1)], [0, 1, 0], [0, 0, 1]])
        warped = cv2.warpPerspective(patch, to_hinge, (w, y2 - y1), flags=cv2.INTER_LINEAR,
                                     borderMode=cv2.BORDER_REPLICATE)  # fmt: skip
        out[y1:y2, x2 - narrow : x2] = warped[:, w - narrow :]
        return out, np.array([x2 - narrow, y1, x2, y2], dtype=np.float64)
    raise ValueError(f"unknown motion {motion!r}")


def _erase(out: np.ndarray, bgr: np.ndarray, place: tuple[int, int, int, int], side: str) -> None:
    """Paint `place` in `out` with the strip of `bgr` just outside it on `side` ("left" or
    "right"), tiled across the place's width. The tiles line up with the strip, so the fill
    carries on the photo beside it."""
    x1, y1, x2, y2 = place
    w, sw = x2 - x1, ERASE_STRIP
    if side == "left" and x1 >= sw:
        out[y1:y2, x1:x2] = np.tile(bgr[y1:y2, x1 - sw : x1], (1, -(-w // sw), 1))[:, :w]
    elif side == "right" and x2 + sw <= bgr.shape[1]:
        out[y1:y2, x1:x2] = np.tile(bgr[y1:y2, x2 : x2 + sw], (1, -(-w // sw), 1))[:, -w:]
    else:
        raise ValueError(f"no photo on the {side} of {place} to erase it with")


def render(scene: Scene, seconds: float, seed: int) -> list[Frame]:
    """The frames a hand-held, head-mounted camera sees of `scene`, with the true box."""
    bgr = cv2.imread(str(scene.path))
    if bgr is None:
        raise FileNotFoundError(scene.path)
    if scene.motion is not None and scene.part is None:
        raise ValueError(f"scene {scene.name!r} has a motion but no part to move")
    half = cv2.resize(bgr, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
    ph, pw = bgr.shape[:2]
    rng = np.random.default_rng(seed)
    whole = np.array(scene.box, dtype=np.float64)
    box = np.array(scene.part or scene.box, dtype=np.float64)  # what is followed, and framed
    ow, oh = box[2] - box[0], box[3] - box[1]
    ocx, ocy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    aspect = OUT_H / OUT_W
    cw_max = min(pw, ph / aspect)
    if scene.part is None:
        cw0 = float(np.clip(max(ow / 0.38, oh / 0.6 / aspect), ow * 1.3, cw_max))
    else:
        cw0 = float(np.clip(max(ow / scene.share, oh / 0.6 / aspect), ow * 1.3, cw_max))
    phase = rng.uniform(0, 2 * np.pi, 6)
    away_dir = 1 if ocx < pw / 2 else -1
    frames: list[Frame] = []
    prev_affine: np.ndarray | None = None
    n = int(seconds * FPS)
    for i in range(n):
        t = i / FPS
        cw = float(np.clip(cw0 * (1 + 0.28 * math.sin(2 * np.pi * 0.09 * t + phase[0])),
                           ow * 1.15, cw_max))  # fmt: skip
        ch = cw * aspect
        cx = ocx + 0.22 * cw * math.sin(2 * np.pi * 0.13 * t + phase[1])
        cy = ocy + 0.16 * ch * math.sin(2 * np.pi * 0.17 * t + phase[2])
        # Head tremor and hand shake: a few Hz, about 1% of the view, plus per-frame noise.
        cx += 0.006 * cw * (
            math.sin(2 * np.pi * 5.3 * t + phase[3]) + 0.6 * math.sin(2 * np.pi * 7.9 * t + 1)
        ) + rng.normal(0, 0.002 * cw)
        cy += 0.006 * ch * (
            math.sin(2 * np.pi * 4.7 * t + phase[4]) + 0.6 * math.sin(2 * np.pi * 8.3 * t + 2)
        ) + rng.normal(0, 0.002 * ch)
        # Quick glances (saccades) and one look away that takes the object out of view.
        cx += 0.3 * cw * (_ramp(t, 2.6, 0.12, 0.5, 0.25) - _ramp(t, 7.4, 0.15, 0.4, 0.3))
        cx += away_dir * 1.3 * cw * _ramp(t, 4.6, 0.3, 1.0, 0.3)
        cx = float(np.clip(cx, cw / 2, pw - cw / 2))
        cy = float(np.clip(cy, ch / 2, ph - ch / 2))
        s = OUT_W / cw
        x0, y0 = cx - cw / 2, cy - ch / 2
        affine = np.array([[s, 0, -s * x0], [0, s, -s * y0]], dtype=np.float64)
        photo, held_box = bgr, box
        if scene.motion is not None:
            photo, held_box = _move_part(bgr, scene.part, t, scene.motion)
        if s < 0.5:
            src, a = half, np.array([[2 * s, 0, -s * x0], [0, 2 * s, -s * y0]])
            if scene.motion is not None:
                src = cv2.resize(photo, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
        else:
            src, a = photo, affine
        frame = cv2.warpAffine(src, a, (OUT_W, OUT_H), flags=cv2.INTER_LINEAR,
                               borderMode=cv2.BORDER_REPLICATE)  # fmt: skip
        # Motion blur over half the frame interval, along the motion of the object's centre.
        if prev_affine is not None:
            p = np.array([ocx, ocy])
            d = (_apply(affine, p) - _apply(prev_affine, p)) * 0.5
            length = float(np.hypot(*d))
            if length >= 1.5:
                k = int(math.ceil(length)) | 1
                kernel = np.zeros((k, k), np.float32)
                c = k // 2
                u = d / max(length, 1e-6)
                cv2.line(kernel, (int(round(c - u[0] * c)), int(round(c - u[1] * c))),
                         (int(round(c + u[0] * c)), int(round(c + u[1] * c))), 1.0, 1)  # fmt: skip
                frame = cv2.filter2D(frame, -1, kernel / kernel.sum())
        prev_affine = affine
        truth = _project(held_box, affine)
        # A hand passes in front of the object.
        hand = _ramp(t, 8.6, 0.25, 0.35, 0.25)
        if hand > 0 and truth is not None:
            tcx, tcy = (truth[0] + truth[2]) / 2, (truth[1] + truth[3]) / 2
            hw, hh = 0.3 * (truth[2] - truth[0]) + 8, 0.35 * (truth[3] - truth[1]) + 8
            hx = tcx - 1.6 * hw + 1.6 * hw * hand
            cv2.ellipse(frame, (int(hx), int(tcy)), (int(hw), int(hh)), 20, 0, 360,
                        (120, 150, 205), -1)  # fmt: skip
            cv2.ellipse(frame, (int(hx), int(tcy)), (int(hw), int(hh)), 20, 0, 360,
                        (80, 105, 150), 3)  # fmt: skip
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        assert ok
        held = _project(whole, affine) if scene.part is not None else None
        frames.append(Frame(buf.tobytes(), truth, affine, held))
    return frames


def _project(box: np.ndarray, affine: np.ndarray) -> np.ndarray | None:
    s, tx, ty = affine[0, 0], affine[0, 2], affine[1, 2]
    b = np.array([box[0] * s + tx, box[1] * s + ty, box[2] * s + tx, box[3] * s + ty])
    full = (b[2] - b[0]) * (b[3] - b[1])
    c = b.clip([0, 0, 0, 0], [OUT_W, OUT_H, OUT_W, OUT_H])
    inside = max(0.0, c[2] - c[0]) * max(0.0, c[3] - c[1])
    return c.astype(np.float32) if inside >= 0.3 * full and inside > 64 else None


def looks(frames: list[Frame], seed: int) -> list[tuple[int, int, np.ndarray | None]]:
    """When each look is asked and answered, and jev's box (noisy truth) or None (not in view).

    A look starts on the frame its answer arrives (the page asks again at once), takes 1 to 2
    seconds, and is about the frame it started on.
    """
    rng = np.random.default_rng(seed + 1000)
    out = []
    asked = 0
    while asked < len(frames):
        answered = asked + int(rng.uniform(1.0, 2.0) * FPS)
        truth = frames[asked].truth
        box = None
        if truth is not None:
            w, h = truth[2] - truth[0], truth[3] - truth[1]
            box = truth + rng.normal(0, 0.03, 4) * [w, h, w, h]
            box = box.clip([0, 0, 0, 0], [OUT_W, OUT_H, OUT_W, OUT_H]).astype(np.float32)
        out.append((asked, answered, box))
        asked = answered
    return out


def build(scenes: list[Scene], seconds: float, seed: int = 7) -> list[Sequence]:
    out = []
    for scene in scenes:
        if not scene.path.exists():
            continue
        k = ALL_SCENES.index(scene) if scene in ALL_SCENES else 0  # the same with --scene
        frames = render(scene, seconds, seed + k)
        out.append(Sequence(scene, frames, looks(frames, seed + k)))
    return out


# --- playing it ------------------------------------------------------------------------------


@dataclass
class Played:
    answers: list[dict] = field(default_factory=list)
    step_ms: list[float] = field(default_factory=list)
    encode_ms: list[float] = field(default_factory=list)
    first: int | None = None  # the first frame after a target was sent
    refreshes: int = 0  # segmenter calls the tracker's refresher made


class _TimedVision:
    """The vision facade, timing each encode (so tracker time can be told from YOLOE's)."""

    def __init__(self, vision):
        self._vision = vision
        self.last_ms = 0.0

    def encode(self, rgb):
        t0 = perf_counter()
        enc = self._vision.encode(rgb)
        self.last_ms = (perf_counter() - t0) * 1000
        return enc

    def __getattr__(self, name):
        return getattr(self._vision, name)


class _CountedSegmenter:
    """A segmenter that counts the boxes it is asked to cut out. Only the refresher's worker
    calls it, one at a time (refresh.py), and the count is read after the worker has stopped."""

    def __init__(self, segmenter):
        self._segmenter = segmenter
        self.name = segmenter.name
        self.calls = 0

    def encode(self, rgb):
        return self._segmenter.encode(rgb)

    def mask_in_box(self, enc, box):
        self.calls += 1
        return self._segmenter.mask_in_box(enc, box)

    def __getattr__(self, name):
        return getattr(self._segmenter, name)


class _FakeSegmenter:
    """Stands in for SAM 2.1 (`--segmenter fake`): every box is its own mask, filled, at one
    frame pixel per mask pixel. Same as the tests' FakeSegmenter, so the harness runs without
    weights."""

    name = "fake-segmenter"

    def encode(self, rgb: np.ndarray) -> SegEncoding:
        return SegEncoding(rgb.shape[1], rgb.shape[0], None)

    def mask_in_box(self, enc: SegEncoding, box: np.ndarray):
        from .vision import MaskCrop

        x1, y1, x2, y2 = (float(v) for v in box)
        rows, cols = max(1, math.ceil(y2 - y1)), max(1, math.ceil(x2 - x1))
        return MaskCrop(np.full((rows, cols), 10.0, np.float32), (x1, y1), 1.0)


def load_jitter_segmenter(name: str):
    """`fake`, else a name `load_segmenter` knows (`none` is None, `auto` the default one)."""
    return _FakeSegmenter() if name == "fake" else load_segmenter(name)


def play(
    seq: Sequence,
    track_module,
    vision,
    finder_vision,
    params=None,
    flag_parts: bool = True,
    segmenter=None,
    make_tracker=None,
) -> Played:
    """Stream the sequence through a fresh StreamTracker of `track_module` (track.py).

    With a `segmenter` the tracker gets it and a Refresher over a one-thread executor, as `/track`
    does, and the look is outlined by it; `Played.refreshes` counts its calls. `make_tracker(vision,
    params, **kwargs)` builds the tracker, `StreamTracker` by default; `kwargs` is `segmenter=` and
    `refresher=` with a segmenter, else empty.
    """
    timed = _TimedVision(vision)
    kwargs: dict = {}
    counted = executor = None
    if segmenter is not None:
        from .refresh import Refresher

        counted = _CountedSegmenter(segmenter)
        executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="segment")
        kwargs = {"segmenter": counted, "refresher": Refresher(counted, executor)}
    out = Played()
    try:
        tracker = (make_tracker or track_module.StreamTracker)(timed, params, **kwargs)
        by_frame = {answered: (asked, box) for asked, answered, box in seq.looks}
        flags = {}
        if seq.scene.part is not None and flag_parts:
            if "part" in {f.name for f in fields(track_module.TargetBox)}:  # not in older copies
                flags = {"part": True}
        for i, frame in enumerate(seq.frames):
            if i in by_frame:
                asked, box = by_frame[i]
                target = _target(seq, asked, box, finder_vision, segmenter)
                if target is not None:
                    tracker.command(track_module.TargetBox(asked, target, seq.scene.label, **flags))
                    out.first = i if out.first is None else out.first
            header = track_module.FrameHeader(i, 1000.0 + i * 1000 / FPS, OUT_W, OUT_H)
            timed.last_ms = 0.0
            t0 = perf_counter()
            answer = tracker.step(header, frame.jpeg)
            out.step_ms.append((perf_counter() - t0) * 1000)
            out.encode_ms.append(timed.last_ms)
            out.answers.append(answer)
    finally:
        if executor is not None:
            executor.shutdown(wait=True)  # the call in flight finishes, so it is counted
    if counted is not None:
        out.refreshes = counted.calls
    return out


_finder_cache: dict[tuple[str, int, str | None], list[float] | None] = {}


def _target(
    seq: Sequence, asked: int, box: np.ndarray | None, vision, segmenter=None
) -> list[float] | None:
    """What the page sends: jev's box outlined as Clio's /locate does it. By the segmenter when
    there is one (its mask's box); by YOLOE (finder.py) when there is none or it cuts nothing;
    jev's own box when YOLOE has nothing either."""
    if box is None:
        return None
    key = (seq.scene.name, asked, segmenter.name if segmenter is not None else None)
    if key not in _finder_cache:
        rgb = cv2.cvtColor(
            cv2.imdecode(np.frombuffer(seq.frames[asked].jpeg, np.uint8), cv2.IMREAD_COLOR),
            cv2.COLOR_BGR2RGB,
        )
        b = None
        if segmenter is not None:
            crop = segmenter.mask_in_box(segmenter.encode(rgb), box)
            b = None if crop is None else _mask_box(crop)
        if b is None:
            outlined = vision.outline_in_box(vision.encode(rgb), box)
            b = outlined[0] if outlined is not None and outlined[1].outline else box
        _finder_cache[key] = [float(v) for v in np.asarray(b) / [OUT_W, OUT_H, OUT_W, OUT_H]]
    return _finder_cache[key]


def _mask_box(crop) -> np.ndarray | None:
    """The box around a mask crop's inside, in frame pixels; None when nothing is inside."""
    ys, xs = np.nonzero(crop.logits > 0)
    if not xs.size:
        return None
    ox, oy = crop.origin
    box = np.array([xs.min(), ys.min(), xs.max() + 1, ys.max() + 1]) * crop.scale
    return (box + [ox, oy, ox, oy]).clip(0, [OUT_W, OUT_H, OUT_W, OUT_H])


# --- measuring it ------------------------------------------------------------------------------


def _outline_mask(outline: list[list[float]] | None) -> np.ndarray | None:
    if not outline or len(outline) < 3:
        return None
    pts = np.round(np.asarray(outline) * [OUT_W, OUT_H]).astype(np.int32)
    m = np.zeros((OUT_H, OUT_W), np.uint8)
    cv2.fillPoly(m, [pts], 1)
    return m


def _mask_iou(a: np.ndarray, b: np.ndarray) -> float:
    union = np.logical_or(a, b).sum()
    return float(np.logical_and(a, b).sum() / union) if union else 0.0


def _carry(affine_from: np.ndarray, affine_to: np.ndarray) -> np.ndarray:
    """The frame-to-frame motion: frame pixels of one frame to frame pixels of the next, 2x3."""
    a = np.vstack([affine_from, [0, 0, 1]])
    b = np.vstack([affine_to, [0, 0, 1]])
    return (b @ np.linalg.inv(a))[:2]


def _apply(m: np.ndarray, p: np.ndarray) -> np.ndarray:
    return m[:, :2] @ p + m[:, 2]


def measure(seq: Sequence, played: Played) -> dict:
    """The steadiness numbers for one played sequence (see the module docstring)."""
    px = np.array([OUT_W, OUT_H], dtype=np.float64)
    start = played.first if played.first is not None else len(seq.frames)
    visible = lost = coast = found_n = wrong = whole_n = on_whole = 0
    ious: list[float] = []
    streaks: list[int] = []
    run = 0
    rows = []
    for i in range(start, len(seq.frames)):
        a, truth = played.answers[i], seq.frames[i].truth
        row: dict = {"found": a["found"], "truth": truth}
        if truth is not None:
            visible += 1
            if not a["found"]:
                lost += 1
                run += 1
            else:
                if run:
                    streaks.append(run)
                run = 0
            coast += a["state"] == "coasting"
        if a["found"]:
            found_n += 1
            box = np.array(a["box"]) * [OUT_W, OUT_H, OUT_W, OUT_H]
            row["box"] = box
            row["mask"] = _outline_mask(a["outline"])
            row["point"] = np.array(a["point"]) * px
            row["contact"] = np.array(a["contact"]) * px if a["contact"] else None
            if row["mask"] is not None:
                ys, xs = np.nonzero(row["mask"])
                row["centroid"] = np.array([xs.mean(), ys.mean()]) if xs.size else None
            held = seq.frames[i].whole
            if truth is not None and held is not None:
                whole_n += 1
                on_whole += float(iou(box, held)[0, 0]) > float(iou(box, truth)[0, 0])
            if truth is not None:
                overlap = float(iou(box, truth)[0, 0])
                c = (box[:2] + box[2:]) / 2
                inside = truth[0] <= c[0] <= truth[2] and truth[1] <= c[1] <= truth[3]
                if overlap < 0.2 and not inside:
                    wrong += 1
                else:
                    ious.append(overlap)
        rows.append(row)
    if run:
        streaks.append(run)

    jitter: dict[str, list[float]] = {"box": [], "centroid": [], "point": [], "contact": []}
    box_f2f, mask_f2f = [], []
    swaps = 0
    for k in range(2, len(rows)):
        r0, r1, r2 = rows[k - 2], rows[k - 1], rows[k]
        i = start + k
        f1, f2 = seq.frames[i - 1], seq.frames[i]
        if r1.get("box") is not None and r2.get("box") is not None:
            m = _carry(f1.affine, f2.affine)
            b1 = r1["box"]
            moved = np.concatenate([_apply(m, b1[:2]), _apply(m, b1[2:])])
            box_f2f.append(float(iou(moved, r2["box"])[0, 0]))
            if r1.get("mask") is not None and r2.get("mask") is not None:
                warped = cv2.warpAffine(r1["mask"], m, (OUT_W, OUT_H), flags=cv2.INTER_NEAREST)
                v = _mask_iou(warped, r2["mask"])
                mask_f2f.append(v)
                swaps += v < 0.5
        if all(r.get("box") is not None and r["truth"] is not None for r in (r0, r1, r2)):
            # Each point relative to the true box's centre, so the real motion (and the true
            # box being cut by the frame's edge) cancels out and only the tracker's wobble is left.
            for key in jitter:
                if key == "box":
                    pts = [(r["box"][:2] + r["box"][2:]) / 2 for r in (r0, r1, r2)]
                else:
                    pts = [r.get(key) for r in (r0, r1, r2)]
                if any(p is None for p in pts):
                    continue
                e0, e1, e2 = (p - (r["truth"][:2] + r["truth"][2:]) / 2
                              for p, r in zip(pts, (r0, r1, r2), strict=True))  # fmt: skip
                jitter[key].append(float(np.hypot(*(e2 - 2 * e1 + e0))))

    def mean(v):
        return float(np.mean(v)) if len(v) else float("nan")

    def p95(v):
        return float(np.percentile(v, 95)) if len(v) else float("nan")

    tracker_ms = [
        s - e for s, e in zip(played.step_ms[start:], played.encode_ms[start:], strict=True)
    ]
    return {
        "scene": seq.scene.name,
        "frames": len(seq.frames) - start,
        "visible": visible,
        "lost": lost / max(visible, 1),
        "lost_streaks": len(streaks),
        "longest_streak": max(streaks, default=0),
        "coast": coast / max(visible, 1),
        "wrong": wrong / max(found_n, 1),
        "on_whole": on_whole / whole_n if whole_n else float("nan"),
        "iou": mean(ious),
        "jitter_box": mean(jitter["box"]),
        "jitter_box_p95": p95(jitter["box"]),
        "jitter_centroid": mean(jitter["centroid"]),
        "jitter_centroid_p95": p95(jitter["centroid"]),
        "jitter_point": mean(jitter["point"]),
        "jitter_contact": mean(jitter["contact"]),
        "box_f2f": mean(box_f2f),
        "mask_f2f": mean(mask_f2f),
        "swaps": swaps,
        "refreshes": played.refreshes,
        "ms": mean(played.step_ms[start:]),
        "ms_p95": p95(played.step_ms[start:]),
        "tracker_ms": mean(tracker_ms),
    }


def summarize(results: list[dict]) -> dict:
    """All sequences together: shares weighted by frames, the rest averaged per sequence."""
    total = {"scene": "all"}
    visible = sum(r["visible"] for r in results) or 1
    for key in results[0]:
        if key == "scene":
            continue
        values = [r[key] for r in results if not (isinstance(r[key], float) and math.isnan(r[key]))]
        if key in ("lost", "coast"):
            total[key] = sum(r[key] * r["visible"] for r in results) / visible
        elif key in ("frames", "visible", "lost_streaks", "swaps", "refreshes"):
            total[key] = sum(values)
        elif key == "longest_streak":
            total[key] = max(values, default=0)
        else:
            total[key] = float(np.mean(values)) if values else float("nan")
    return total


def summary_rows(
    sequences: list[Sequence], results: dict[str, list[dict]]
) -> list[tuple[str, dict]]:
    """The whole objects, the parts that stay put (`parts`) and the parts that move (`moving`)
    summed up apart, for each implementation in `results` (its rows, one per sequence)."""

    def kind(seq: Sequence) -> str:
        if seq.scene.motion is not None:
            return "moving"
        return "parts" if seq.scene.part is not None else "all"

    rows = []
    for name in ("all", "parts", "moving"):
        ks = [k for k, seq in enumerate(sequences) if kind(seq) == name]
        if not ks:
            continue
        for label, rs in results.items():
            rows.append((label, {**summarize([rs[k] for k in ks]), "scene": name}))
    return rows


COLUMNS = [
    ("lost", "lost", "{:.1%}"),
    ("lost_streaks", "streaks", "{:d}"),
    ("longest_streak", "longest", "{:d}"),
    ("coast", "coast", "{:.1%}"),
    ("wrong", "wrong", "{:.1%}"),
    ("on_whole", "on whole", "{:.1%}"),
    ("iou", "IoU", "{:.3f}"),
    ("jitter_box", "jit box", "{:.2f}"),
    ("jitter_centroid", "jit mask", "{:.2f}"),
    ("jitter_centroid_p95", "p95", "{:.2f}"),
    ("jitter_point", "jit point", "{:.2f}"),
    ("jitter_contact", "jit contact", "{:.2f}"),
    ("box_f2f", "box f2f", "{:.3f}"),
    ("mask_f2f", "mask f2f", "{:.3f}"),
    ("swaps", "swaps", "{:d}"),
    ("refreshes", "refreshes", "{:d}"),
    ("ms", "ms", "{:.1f}"),
    ("ms_p95", "p95", "{:.1f}"),
    ("tracker_ms", "tracker", "{:.1f}"),
]


def table(rows: list[tuple[str, dict]]) -> str:
    head = ["", "scene"] + [c[1] for c in COLUMNS]
    lines = [head]
    for label, r in rows:
        cells = [label, r["scene"]]
        for key, _, fmt in COLUMNS:
            v = r[key]
            cells.append("nan" if isinstance(v, float) and math.isnan(v) else fmt.format(v))
        lines.append(cells)
    widths = [max(len(str(line[i])) for line in lines) for i in range(len(head))]
    return "\n".join("  ".join(str(c).rjust(w) for c, w in zip(line, widths, strict=True))
                     for line in lines)  # fmt: skip


def load_package(directory: Path, name: str = "clio_tracker_baseline"):
    """Another copy of clio_tracker (e.g. the code before a change), imported under `name`."""
    package = directory / "clio_tracker" if (directory / "clio_tracker").is_dir() else directory
    spec = importlib.util.spec_from_file_location(
        name, package / "__init__.py", submodule_search_locations=[str(package)]
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"No clio_tracker package in {directory}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def tracker_params(settings: list[str] | None):
    """TrackerParams with `name=value` (or `smooth.name=value`) changes, for trying settings."""
    from dataclasses import fields, replace

    from .smooth import SmoothParams
    from .tracking import TrackerParams

    params, smooth = TrackerParams(), SmoothParams()
    for item in settings or []:
        key, _, raw = item.partition("=")
        target = smooth if key.startswith("smooth.") else params
        name = key.removeprefix("smooth.")
        kind = {f.name: f.type for f in fields(target)}.get(name)
        if kind is None:
            raise SystemExit(f"jitter: no setting {key!r}")
        value = raw.lower() in ("1", "true", "yes") if kind == "bool" else float(raw)
        value = int(value) if kind == "int" else value
        if target is smooth:
            smooth = replace(smooth, **{name: value})
        else:
            params = replace(params, **{name: value})
    return replace(params, smooth=smooth)


def run(
    model: str,
    backend: str,
    seconds: float,
    baseline: Path | None,
    only: list[str] | None,
    out: Path | None,
    settings: list[str] | None = None,
    flag_parts: bool = True,
    segmenter: str = "none",
) -> int:
    from . import track
    from .vision import default_models_dir, load_vision

    params = tracker_params(settings)

    scenes = [s for s in ALL_SCENES if not only or s.name in only]
    t0 = perf_counter()
    sequences = build(scenes, seconds)
    print(f"{len(sequences)} sequences of {seconds:g} s rendered in {perf_counter() - t0:.1f} s")
    vision = load_vision(model, backend)
    cutter = load_jitter_segmenter(segmenter)
    print(f"segmenter: {cutter.name if cutter is not None else 'none'}")
    impls: list[tuple[str, object, object]] = []
    if baseline is not None:
        load_package(baseline)
        base_vision = importlib.import_module("clio_tracker_baseline.vision")
        base_track = importlib.import_module("clio_tracker_baseline.track")
        impls.append(
            ("before", base_track, base_vision.load_vision(model, backend,
                                                           models_dir=default_models_dir()))
        )  # fmt: skip
    impls.append(("after" if baseline else "now", track, vision))
    # Warm both up so the first frames aren't timed with compilation.
    blank = np.full((OUT_H, OUT_W, 3), 128, np.uint8)
    for _, _, v in impls:
        for _ in range(3):
            v.encode(blank)
    if cutter is not None:
        for _ in range(2):
            cutter.mask_in_box(cutter.encode(blank), np.array([120.0, 90.0, 360.0, 270.0]))
    results: dict[str, list[dict]] = {label: [] for label, _, _ in impls}
    for seq in sequences:
        for label, module, v in impls:
            current = module is track  # a baseline copy has no segmenter and no params
            played = play(seq, module, v, vision, params if current else None, flag_parts,
                          segmenter=cutter if current else None)  # fmt: skip
            results[label].append(measure(seq, played))
    rows = []
    for k in range(len(sequences)):
        for label, _, _ in impls:
            rows.append((label, results[label][k]))
    rows += summary_rows(sequences, results)
    print(table(rows))
    if out is not None:
        out.write_text(json.dumps(results, indent=1, default=float))
    return 0
