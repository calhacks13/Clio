# Glow Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The tracker's outline becomes SAM 2.1's mask of the target, carried to every frame by a region follower, with a refresh whenever the follower is in doubt, behind a `--segmenter` flag that leaves today's tracker untouched when off.

**Architecture:** Three loops at three rates. jev names and boxes the target about once a second (unchanged). A `Segmenter` (SAM 2.1 through `transformers`, on MPS) turns jev's box into a *keyframe mask* on jev's frame and re-segments the newest frame when asked, both through a background `Refresher` so no frame waits. A `RegionFollower` carries the latest mask to each frame by the camera's motion (motion.py) plus the part's own motion from Lucas-Kanade points inside the mask, and reports doubt when points die or its box disagrees with ByteTrack's. `ObjectTracker` and `PartTracker` prefer the follower's mask when it is confident and fall back to today's behaviour otherwise.

**Tech Stack:** Python 3.12, numpy, OpenCV, PyTorch 2.14 on MPS, `transformers>=5.20` (`Sam2Model`, `Sam2Processor`), the existing tracker package (`tracker/src/clio_tracker`), pytest.

**Spec:** `docs/superpowers/specs/2026-10-24-glow-tracking-design.md`

## Global Constraints

- The branch is based on `origin/main` (444ab64), which added **objects mode** to `/track` (tracker/TRACK.md#objects-mode): a lesson streams 480 px frames and names objects in words; `track.Modes` routes each connection to `StreamTracker` (target mode, primary.html) or `ObjectsTracker`, which steps a `TrackerSession` of its own through `TrackerSession.follow()`. `locate()` wraps `follow()`. The lesson's live glow comes through objects mode, so the segmenter and follower must be wired into `TrackerSession.follow()` as well as `StreamTracker.step()`.
- Local and test only. Do not commit, do not touch `main`, do not change `apps/`, `packages/` or the `/track` and `/locate` message formats (TRACK.md, docs/object-finder.md).
- `--segmenter none` (and `CLIO_TRACKER_SEGMENTER=none`) must leave every existing test green and every existing code path identical; new behaviour only when a segmenter is loaded.
- The stream thread never calls the segmenter. Segmenter calls run in the `Refresher`'s executor; at most one in flight; at least 150 ms apart unless it is a keyframe.
- Segmenter names: `none`, `auto`, `sam2.1-small` (`facebook/sam2.1-hiera-small`), `sam2.1-large` (`facebook/sam2.1-hiera-large`). `auto` is `sam2.1-small` when `transformers` imports, else `none`.
- Mask selection in SAM 2.1: best of the three candidate masks by the model's predicted IoU, no box padding.
- Follower motion model: full affine (`cv2.estimateAffine2D`, RANSAC) with at least 12 inliers, similarity (`cv2.estimateAffinePartial2D`) with 8 to 11, else the camera's motion alone and `confident=False`.
- When not confident the tracker behaves exactly as today (ByteTrack box, YOLOE crop, coast and fade), and asks for a refresh.
- Style: ruff clean (`uv run ruff check src tests`), line length 100, the repository's prose style in docstrings and README (no bullet dots or arrows in UI text; none of this is UI).
- Model weights: `Sam2Model.from_pretrained(<hf id>)` may download on first use, like YOLOE does. Never download anything else. `~/.cache/huggingface/hub/models--facebook--sam2.1-hiera-large` already holds `transformers`-format files; small may have to download (about 180 MB).
- Memory: keep RSS under 2 GB in tests; load one SAM model per process.

## Review Focus

1. A refresh answer arriving for a frame the follower has already replaced (an older `seq` than its current reference): it must be ignored, never applied as the newest reference. Test in Task 4 (`test_refreshed_older_than_reference_is_ignored`).
2. A keyframe mask that is empty or a sliver (SAM returned nothing useful inside jev's box): the tracker must keep today's YOLOE outline and not start a follower on an empty mask. Test in Task 1 (`test_mask_in_box_returns_none_for_empty_mask`) and Task 4 (`test_identified_with_none_mask_keeps_yoloe_outline`).
3. The followed region leaving the view, or the frame size changing between frames (the page switches `?frame=`): the follower must report not confident and never index outside the frame. Test in Task 2 (`test_region_leaving_view_is_not_confident`, `test_frame_size_change_resets`).
4. The stream running with a segmenter whose executor is slow (SAM busy): frames must keep answering at the tracker's rate with today's outline; no second call queued. Test in Task 3 (`test_submit_refuses_while_in_flight`) and Task 6 (`test_stream_answers_while_refresh_pending`).
5. A part target whose follower is confident but whose warped box no longer lies inside the parent's box (the door swung out of the fridge's box): the part must keep the follower's box, not snap back to the parent. Test in Task 5 (`test_part_follows_its_own_motion_out_of_parent_box`).

---

### Task 1: Segmenter module and the `--segmenter` setting

**Files:**
- Create: `tracker/src/clio_tracker/segment.py`
- Modify: `tracker/pyproject.toml` (add `"transformers>=5.20,<6"` to `dependencies`)
- Modify: `tracker/src/clio_tracker/config.py` (new field `segmenter: str`, setting `CLIO_TRACKER_SEGMENTER`, default `auto`)
- Modify: `tracker/src/clio_tracker/cli.py` (`--segmenter` on every subcommand, like `--model`)
- Test: `tracker/tests/test_segment.py`
- Modify: `tracker/tests/conftest.py` (add `FakeSegmenter`)

**Interfaces:**
- Produces:
  ```python
  SEGMENTERS = {"sam2.1-small": "facebook/sam2.1-hiera-small", "sam2.1-large": "facebook/sam2.1-hiera-large"}

  @dataclass
  class SegEncoding:            # one frame through the segmenter's image encoder
      width: int
      height: int
      embeddings: object        # the model's image embeddings, opaque to callers

  class Segmenter(Protocol):
      name: str
      def encode(self, rgb: np.ndarray) -> SegEncoding: ...
      def mask_in_box(self, enc: SegEncoding, box: np.ndarray) -> MaskCrop | None: ...

  class Sam2Segmenter:          # Segmenter
      def __init__(self, model_id: str = SEGMENTERS["sam2.1-small"], device: str = "auto"): ...

  def load_segmenter(name: str, device: str = "auto") -> Segmenter | None: ...
  def clean_mask(logits: np.ndarray) -> np.ndarray: ...   # 3x3 morphological open on logits > 0, returned as logits (+10 inside, -10 outside)
  ```
  `mask_in_box` returns a `MaskCrop` (vision.py) over the box grown by 10% per side and clipped to the frame, `scale` chosen so the crop's longer side is at most 256 pixels, `origin` in frame pixels, logits > 0 inside; `None` when fewer than 16 frame pixels are inside the mask. `FakeSegmenter` (conftest) fills the box at scale 1 and records every call in `self.calls: list[tuple[int, int, tuple]]`.

- [ ] **Step 1: Write the failing tests**

```python
# tracker/tests/test_segment.py
def test_fake_segmenter_crop_covers_box(segmenter):
    enc = segmenter.encode(np.zeros((720, 960, 3), np.uint8))
    crop = segmenter.mask_in_box(enc, np.array([100.0, 200.0, 300.0, 400.0]))
    assert crop is not None and crop.scale >= 1.0
    assert crop.origin[0] <= 100 and crop.origin[1] <= 200
    assert (crop.logits > 0).sum() > 0

def test_load_segmenter_none_and_unknown():
    assert load_segmenter("none") is None
    with pytest.raises(ValueError):
        load_segmenter("sam9")

def test_clean_mask_drops_specks():
    logits = np.full((20, 20), -10.0, np.float32)
    logits[5:15, 5:15] = 10.0
    logits[0, 0] = 10.0           # a speck
    out = clean_mask(logits)
    assert out[0, 0] < 0 and (out[5:15, 5:15] > 0).all()

@pytest.mark.model
def test_sam2_small_masks_a_bright_square():
    seg = load_segmenter("sam2.1-small")
    if seg is None:
        pytest.skip("transformers not installed")
    rgb = np.full((480, 640, 3), 30, np.uint8); rgb[150:330, 200:440] = 230
    crop = seg.mask_in_box(seg.encode(rgb), np.array([190.0, 140.0, 450.0, 340.0]))
    assert crop is not None
    full = paste(crop, 640, 480)      # helper in the test: crop logits > 0 pasted at origin/scale
    inside = full[150:330, 200:440].mean(); outside = full.mean() * full.size - full[150:330, 200:440].sum()
    assert inside > 0.9 and outside < 0.05 * full.size

def test_settings_segmenter_default_and_validation():
    assert load_settings({}).segmenter == "auto"
    assert load_settings({"CLIO_TRACKER_SEGMENTER": "sam2.1-large"}).segmenter == "sam2.1-large"
    with pytest.raises(ConfigError):
        load_settings({"CLIO_TRACKER_SEGMENTER": "sam3"})
```
Add a `segmenter` fixture in conftest returning `FakeSegmenter()`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd tracker && uv run pytest -q tests/test_segment.py`
Expected: FAIL with `ModuleNotFoundError: clio_tracker.segment` / `AttributeError: segmenter`.

- [ ] **Step 3: Implement `segment.py`, the setting and the flag**

`Sam2Segmenter.encode`: `Sam2Processor(images=rgb)` then `model.get_image_embeddings(pixel_values)` under a `threading.Lock`, on `device` (`mps` when available, as `vision._pick_device`). `mask_in_box`: `model(image_embeddings=..., input_boxes=[[[x1, y1, x2, y2]]], multimask_output=True)`, pick `iou_scores.argmax()`, `processor.post_process_masks([...], [(h, w)], binarize=False)` to logits at frame size, cut the grown box, `clean_mask`, downscale to 256 on the long side with `cv2.INTER_LINEAR`, return the `MaskCrop`. `load_segmenter` maps names; `auto` tries `import transformers`. `config.load_settings` validates against `("auto", "none", *SEGMENTERS)`. `cli` adds `--segmenter` to the shared option loop and to `overrides`.

- [ ] **Step 4: Run the tests and ruff**

Run: `cd tracker && uv sync --extra coreml && uv run pytest -q tests/test_segment.py -m "not model" && uv run pytest -q tests/test_segment.py -m model && uv run ruff check src tests`
Expected: all PASS (the model test downloads small on first run; report its time).

---

### Task 2: The region follower

**Files:**
- Create: `tracker/src/clio_tracker/follow.py`
- Test: `tracker/tests/test_follow.py`

**Interfaces:**
- Consumes: `MaskCrop` (vision.py), `compose`, `warp_box` (motion.py).
- Produces:
  ```python
  @dataclass(frozen=True)
  class FollowParams:
      max_width: int = 480        # frames wider than this are tracked at this width
      max_corners: int = 120
      min_inliers: int = 8
      affine_inliers: int = 12
      redetect_every: int = 10    # frames between re-seeding points inside the warped mask
      fb_max_px: float = 1.0      # forward-backward error, in tracked-frame pixels
      doubt_ratio: float = 0.5    # inliers / points tracked, below this is doubt
      in_view: float = 0.25       # share of the warped box inside the frame
      crop_side: int = 256

  @dataclass
  class Followed:
      box: np.ndarray             # frame pixels, bounds of the warped mask
      crop: MaskCrop              # the warped mask
      inliers: int
      ratio: float
      confident: bool

  class RegionFollower:
      def __init__(self, params: FollowParams | None = None): ...
      @property
      def active(self) -> bool: ...
      @property
      def reference_seq(self) -> int | None: ...
      def set_reference(self, seq: int, crop: MaskCrop) -> None: ...   # a mask measured on frame `seq`; applied on the next step, carried by the motions logged since `seq`
      def step(self, seq: int, gray: np.ndarray, camera: np.ndarray | None, t: float) -> Followed | None: ...
      def clear(self) -> None: ...
  ```
  `step` must be called for every frame in order (also before any reference, so motion is logged like `CameraMotion`). `gray` is the full frame in 8-bit gray. The follower keeps a deque of `(seq, M)` where `M` is the 2x3 frame-pixel transform from the previous frame to this one: its own estimate when confident, else `camera`, else identity. `set_reference` for a `seq` older than the newest logged frame is applied with the composed `M`s after `seq`; a `seq` older than the current reference's is ignored (returns without change). A `step` whose frame size differs from the last clears the follower.

- [ ] **Step 1: Write the failing tests**

Build a synthetic scene helper in the test: a 480x360 gray frame with random texture (`np.random.default_rng(0).integers(0, 255, ...)`) blurred by 3x3, a textured 120x80 patch pasted at a known position, and a `MaskCrop` filling that patch. Each frame moves the patch by a known translation (and a scale for one test), keeps the background still, and returns the true patch box.

```python
def test_follows_translating_patch_at_iou_above_09():
    # 30 frames, patch moves 4 px right and 2 px down per frame, camera None
    for seq, (gray, truth) in enumerate(frames): out = f.step(seq, gray, None, seq / 25)
    assert out.confident and iou(out.box, truth)[0, 0] > 0.9 on the last 20 frames

def test_camera_motion_alone_carries_when_patch_is_textureless():
    # flat patch (no corners inside), camera=[[1,0,3],[0,1,0]] each frame: box moves 3 px/frame, confident is False

def test_reference_on_older_frame_is_carried_to_now():
    # step 0..9, then set_reference(seq=4, crop on frame 4's patch position), step 10: box matches truth at frame 10 (IoU > 0.85)

def test_reference_older_than_current_is_ignored():
    # set_reference(8, ...) then set_reference(5, ...): reference_seq stays 8

def test_region_leaving_view_is_not_confident():
    # patch moves 40 px/frame off the right edge: once < 25% of box is in view, out.confident is False and out.box stays finite

def test_frame_size_change_resets():
    # after a reference, step with a 640x480 frame: active is False, returns None

def test_scale_change_is_followed():
    # patch grows 2% per frame for 15 frames: box area ratio to truth within 0.85..1.15
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd tracker && uv run pytest -q tests/test_follow.py`
Expected: FAIL with `ModuleNotFoundError: clio_tracker.follow`.

- [ ] **Step 3: Implement `follow.py`**

Points: `cv2.goodFeaturesToTrack(gray_small, max_corners, 0.01, 5, mask=warped_mask_small)`; track with `cv2.calcOpticalFlowPyrLK` forward and back (winSize 15, maxLevel 3, as motion.py), keep points with both statuses and forward-backward error under `fb_max_px`; estimate `M` with `estimateAffine2D` (RANSAC, threshold 2.0) when inliers >= `affine_inliers`, else `estimateAffinePartial2D` when >= `min_inliers`, else fall back to `camera` or identity and `confident=False`. Scale `M`'s translation back to frame pixels. Keep `T` = `compose(M, T)` (reference crop pixels to frame pixels, starting from the crop's `origin`/`scale`). Output: warp the reference logits with `cv2.warpAffine` into a crop around `warp_box(reference bounds, T)` at `crop_side`; `confident = inliers >= min_inliers and ratio >= doubt_ratio and in-view share >= in_view`. Re-seed points every `redetect_every` frames or when fewer than `min_inliers` remain.

- [ ] **Step 4: Run the tests and ruff**

Run: `cd tracker && uv run pytest -q tests/test_follow.py && uv run ruff check src tests`
Expected: PASS.

---

### Task 3: The refresher (background segmenter calls)

**Files:**
- Create: `tracker/src/clio_tracker/refresh.py`
- Test: `tracker/tests/test_refresh.py`

**Interfaces:**
- Consumes: `Segmenter` (Task 1); conftest's `FakeExecutor` (`submit` queues work, `run_all()` runs it) and `FakeClock`.
- Produces:
  ```python
  @dataclass(frozen=True)
  class Refreshed:
      key: str                    # object id, or "target" on the stream
      seq: int
      crop: MaskCrop | None       # None when the segmenter found nothing in the box
      box: np.ndarray             # the prompt box, frame pixels
      keyframe: bool
      took_s: float

  class Refresher:
      def __init__(self, segmenter: Segmenter, executor: Executor, min_interval_s: float = 0.15, clock: Callable[[], float] = time.monotonic): ...
      def submit(self, key: str, seq: int, rgb: np.ndarray, box: np.ndarray, keyframe: bool = False) -> bool: ...
      def drain(self) -> list[Refreshed]: ...
      @property
      def in_flight(self) -> int: ...
  ```
  `submit` returns False (and does nothing) when a call is in flight, or when the last submit for any key was under `min_interval_s` ago and this is not a keyframe. A keyframe waits for the in-flight call to finish: it is kept as `pending` and submitted by the next `drain`. Errors from the segmenter are logged once and the `Refreshed` is dropped.

- [ ] **Step 1: Write the failing tests**

```python
def test_submit_runs_segmenter_and_drain_returns_crop()
def test_submit_refuses_while_in_flight()           # second submit returns False; after run_all + drain, allowed again
def test_submit_respects_min_interval()             # two submits 0.1 s apart: second False; 0.2 s apart: True
def test_keyframe_waits_then_goes()                 # in flight + keyframe submit: returns True, drain after run_all submits it
def test_segmenter_error_is_dropped_and_logged(caplog)
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd tracker && uv run pytest -q tests/test_refresh.py`
Expected: FAIL with `ModuleNotFoundError: clio_tracker.refresh`.

- [ ] **Step 3: Implement `refresh.py`** with a `queue.SimpleQueue` of results like `session._Ask`, a copy of `rgb` taken at submit, and the segmenter call `segmenter.mask_in_box(segmenter.encode(rgb), box)` in the worker.

- [ ] **Step 4: Run the tests and ruff**

Run: `cd tracker && uv run pytest -q tests/test_refresh.py && uv run ruff check src tests`
Expected: PASS.

---

### Task 4: ObjectTracker uses the follower's mask

**Files:**
- Modify: `tracker/src/clio_tracker/tracking.py` (`TrackerParams`, `ObjectTracker.__init__`, `step`, `_sighted`, `_coast`, `identified`; new `refreshed`, `wants_refresh`, `refresh_box`)
- Test: `tracker/tests/test_tracking.py` (append)

**Interfaces:**
- Consumes: `RegionFollower`, `Followed`, `FollowParams` (Task 2).
- Produces:
  ```python
  # TrackerParams additions
  follow: FollowParams = field(default_factory=FollowParams)
  follow_agree_iou: float = 0.3     # follower box vs ByteTrack's box: below this the follower is doubted
  refresh_after_frames: int = 2     # frames of doubt before asking for a refresh

  # ObjectTracker
  def __init__(self, object_id, phrase, params=None, follower: RegionFollower | None = None)
  def step(self, enc, seq, t, vision, camera=None, gray: np.ndarray | None = None) -> Sighting
  def identified(self, seq, t, present, box, appearance, carry=None, mask: MaskCrop | None = None) -> str
  def refreshed(self, seq: int, crop: MaskCrop | None) -> None
  @property wants_refresh -> bool        # follower doubted for refresh_after_frames frames, or no reference yet while a target exists
  @property refresh_box -> np.ndarray | None   # the box to prompt with: the follower's last box, else the tracked box
  ```
  Rule in `step`: call `follower.step(seq, gray, camera, t)` whenever a follower exists and `gray` is given, every frame. When the target is sighted by ByteTrack and the follower is confident and `iou(followed.box, tracked box) >= follow_agree_iou`, the Sighting uses the follower's box and crop (`self._smooth.sighted(t, followed.box, followed.crop, size)`) and `Sighting.measured` is the follower's box. When coasting, a confident follower still supplies box and crop (the object is followed by its pixels even when YOLOE missed it). Otherwise today's path. `identified(..., mask=crop)` calls `follower.set_reference(seq, crop)` when `crop` is not None; `refreshed` does the same, and a `None` crop counts one frame of doubt.

- [ ] **Step 1: Write the failing tests** (FakeVision scenes as in the existing tests; a `FakeFollower` in the test file that returns a scripted `Followed` per call and records `set_reference` calls)

```python
def test_confident_follower_mask_replaces_yoloe_crop()      # Sighting.crop is the follower's and box is the follower's
def test_doubting_follower_falls_back_and_wants_refresh()   # confident False for 2 frames: crop is YOLOE's, wants_refresh True
def test_follower_disagreeing_with_bytetrack_is_doubted()   # follower box far from the track: today's box, wants_refresh after 2 frames
def test_identified_with_mask_sets_reference()              # follower.set_reference called with jev's seq
def test_identified_with_none_mask_keeps_yoloe_outline()    # no set_reference, Sighting.crop from vision.mask
def test_refreshed_older_than_reference_is_ignored()        # refreshed(seq=3) after set_reference(seq=7): reference_seq stays 7 (use the real RegionFollower here)
def test_coasting_with_confident_follower_keeps_mask()      # YOLOE misses the frame, follower confident: state "tracking" with the follower's crop
def test_no_follower_is_identical_to_before()               # follower None: outputs equal a tracker built without the new arguments
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd tracker && uv run pytest -q tests/test_tracking.py -k "follower or refresh or identified_with"`
Expected: FAIL with `TypeError: unexpected keyword argument`.

- [ ] **Step 3: Implement the changes in `tracking.py`** per the Interfaces block; keep `_sighted`'s learning and `_fresh` bookkeeping on ByteTrack's box as today.

- [ ] **Step 4: Run the whole tracking suite and ruff**

Run: `cd tracker && uv run pytest -q tests/test_tracking.py tests/test_smooth.py && uv run ruff check src tests`
Expected: PASS, including every pre-existing test.

---

### Task 5: PartTracker uses the follower's mask

**Files:**
- Modify: `tracker/src/clio_tracker/part.py` (`PartTracker.__init__`, `identified`, `step`; new `refreshed`, `wants_refresh`, `refresh_box`)
- Test: `tracker/tests/test_part.py` (append)

**Interfaces:**
- Consumes: Task 2 and Task 4's names (`follower`, `gray`, `mask`, `refreshed`, `wants_refresh`, `refresh_box`), same signatures as `ObjectTracker`.
- Produces: `PartTracker(object_id, phrase, params=None, follower: RegionFollower | None = None)`; `step(enc, seq, t, vision, camera=None, gray=None)`; `identified(seq, t, present, box, enc, vision, carry=None, mask: MaskCrop | None = None)`.
  Rule: when the follower is confident, `self._box` becomes the follower's box (it rides on its own pixels, not the parent) and the Sighting's crop is the follower's crop with the parent's `confidence` and `state`; the parent still steps every frame (it is what re-acquires the whole object). When not confident: today's ride and outline, and `wants_refresh` after `refresh_after_frames` frames.

- [ ] **Step 1: Write the failing tests**

```python
def test_part_uses_follower_mask_when_confident()
def test_part_follows_its_own_motion_out_of_parent_box()    # scripted follower box moves 200 px outside the parent's box: Sighting.box is the follower's, state "tracking"
def test_part_falls_back_to_ride_when_follower_doubts()     # confident False: box equals today's ride, wants_refresh after 2 frames
def test_part_identified_with_mask_sets_reference()
def test_part_without_follower_is_identical_to_before()
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd tracker && uv run pytest -q tests/test_part.py -k follower`
Expected: FAIL with `TypeError`.

- [ ] **Step 3: Implement the changes in `part.py`.**

- [ ] **Step 4: Run the part and tracking suites and ruff**

Run: `cd tracker && uv run pytest -q tests/test_part.py tests/test_tracking.py && uv run ruff check src tests`
Expected: PASS.

---

### Task 6: Wire the stream, the session, the finder and the CLI

**Files:**
- Modify: `tracker/src/clio_tracker/track.py` (`StreamTracker.__init__(vision, params=None, segmenter: Segmenter | None = None, refresher: Refresher | None = None)`; `_identify`, `step`)
- Modify: `tracker/src/clio_tracker/session.py` (`TrackerSession.__init__(..., segmenter=None, refresher=None)`; keep `image.rgb` next to the `Encoding` in `_frames` for frames jev looks at; `_apply`; the per-frame rule goes in `follow()`, which `locate()` and objects mode's `ObjectsTracker.step()` both call)
- Modify: `tracker/src/clio_tracker/finder.py` (`Finder.__init__(identifier, vision, segmenter=None)`; `_detection` uses the segmenter's mask when there is one; `model` gains `+<segmenter name>`)
- Modify: `tracker/src/clio_tracker/cli.py` (`_serve`: `load_segmenter(settings.segmenter, settings.device)`, one `Refresher` per `StreamTracker` and per `TrackerSession` (the `Sessions` factory and `sessions.new()` both build one), all sharing one segmenter and a 1-worker `ThreadPoolExecutor(thread_name_prefix="segment")`; warm up the segmenter with one encode; health reports `"segmenter": name`; the start-up log names it)
- Modify: `tracker/src/clio_tracker/track.py` only inside `StreamTracker` (`Modes` and `ObjectsTracker` need no change: `ObjectsTracker.step` already goes through `TrackerSession.follow`)
- Modify: `tracker/src/clio_tracker/server.py` only if `health()` needs the field passed through (it takes a callable already; no change expected)
- Test: `tracker/tests/test_track.py`, `tracker/tests/test_session.py`, `tracker/tests/test_server.py` (append), `tracker/tests/test_identify.py` untouched

**Interfaces:**
- Consumes: Tasks 1 to 5.
- Rule for both `StreamTracker.step` and `TrackerSession.follow`, per frame: `gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)`; `for r in refresher.drain(): tracker_for(r.key).refreshed(r.seq, r.crop)`; step with `gray`; after the step, if `tracker.wants_refresh and tracker.refresh_box is not None: refresher.submit(key, seq, rgb, tracker.refresh_box)`. On a jev answer with a box (`_identify` / `_apply`): `refresher.submit(key, jev_seq, rgb_of_that_frame, jev_box, keyframe=True)`; the `identified` call itself passes `mask=None` (the mask arrives through `drain` a moment later). `StreamTracker` already keeps JPEGs per seq; `TrackerSession` keeps `rgb` next to `enc` in `_frames` while jev is in flight. With `segmenter is None` nothing new runs. Objects mode has no part mode (TRACK.md): there every object is an `ObjectTracker`, so a lesson's part (`kind: "item"`) gets its organic outline from the follower's SAM mask, not from part.py.

- [ ] **Step 1: Write the failing tests**

```python
# test_track.py
def test_stream_submits_keyframe_on_target_and_applies_refresh()   # FakeSegmenter + FakeExecutor: after target, refresher has 1 call with the target's seq and box; run_all; next frame's answer outline is the fake mask's box (4 points) not FakeVision's
def test_stream_answers_while_refresh_pending()                     # executor never runs: frames keep answering with today's outline, in_flight stays 1, no second submit
def test_stream_without_segmenter_unchanged()                       # answers equal to a StreamTracker built the old way
# test_session.py
def test_session_keyframe_after_jev_answer()                        # same shape as the stream test through locate()
def test_objects_mode_outline_comes_from_the_segmenter()            # Modes + ObjectSet with FakeSegmenter: after jev's answer and run_all, the detections outline is the fake mask's box
# test_server.py
def test_health_reports_segmenter()                                 # {"segmenter": "fake-segmenter"} and model string ends with "+fake-segmenter"
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd tracker && uv run pytest -q tests/test_track.py tests/test_session.py tests/test_server.py -k "segmenter or refresh or keyframe"`
Expected: FAIL with `TypeError`.

- [ ] **Step 3: Implement the wiring** per the rule above. In `finder._detection`, when a segmenter is set: `crop = segmenter.mask_in_box(seg_enc, jev_box)` (encode once per request, in the same background encode thread as YOLOE's), then `mask_shape(crop.logits > 0, crop.origin, crop.scale, w, h, box)`; fall back to YOLOE's path when `crop` is None.

- [ ] **Step 4: Run the full suite, ruff, and a real serve**

Run: `cd tracker && uv run pytest -q -m "not model" && uv run ruff check src tests`
Expected: PASS.
Run: `cd /Users/peter/Desktop/Clio && pnpm tracker --fake-jev --segmenter sam2.1-small` for 20 s in the background, then `curl -s 127.0.0.1:8790/health`
Expected: `"segmenter":"sam2.1-small"` and `"model":"fake-jev+yoloe-26l-seg+sam2.1-small"`; stop the server.

---

### Task 7: Jitter harness: segmenter, moving-part scenes, numbers

**Files:**
- Modify: `tracker/src/clio_tracker/jitter.py` (`run(..., segmenter: str = "none")`; `_target` outlines jev's box with the segmenter when one is loaded; `Scene` gains `motion: str | None` with values `"slide"` and `"swing"`; two new `PART_SCENES` entries; `play` feeds a `Refresher` with conftest-free `ThreadPoolExecutor(1)` and drains it before each frame, and passes `gray`)
- Modify: `tracker/src/clio_tracker/cli.py` (`jitter` passes `settings.segmenter`)
- Modify: `tracker/README.md` (Settings row for `CLIO_TRACKER_SEGMENTER`, a "Glow tracking" paragraph in How it works, and the measured table below)
- Test: `tracker/tests/test_jitter.py` (append)

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 5.
- Scenes: `Scene("door-slide", DEMO / "caliper.jpg", whole=(222,185,1280,745), label="sliding jaw of caliper", part=(445,410,865,463), share=0.45, motion="slide")` where the part patch is cut from the photo and pasted back translated by `0.25 * part width * sin(2π · 0.5 · t)` along x with the gap behind it filled by the photo's own pixels at the original position (a plain copy; realism is not the point); `Scene("door-swing", DL / "fridge-closed.jpg" ...)` is NOT used (keep to repository images): instead `Scene("plate-swing", DEMO / "micrometer.jpg", whole=(115,60,1230,875), label="name plate of micrometer", part=(400,712,588,842), share=0.3, motion="swing")` where the patch is warped by `cv2.warpPerspective` so its right edge stays and its width scales by `0.5 + 0.5 · cos(2π · t / 3)`. The true box follows the warp; the whole-object box stays.

- [ ] **Step 1: Write the failing tests**

```python
def test_slide_scene_truth_moves_and_whole_stays()       # truth x differs between frames 0 and 12; whole box identical
def test_swing_scene_truth_narrows()                      # truth width at t = 1.5 s is about half of t = 0
def test_run_with_fake_segmenter_reports_follow_columns() # run(..., segmenter="fake") on one short scene returns a dict with "refreshes" and "followed" counts
```
Expose a `"fake"` segmenter name in `jitter.load_segmenter_for_jitter(name)` that returns conftest-free `FakeSegmenter` (define a tiny one in jitter.py or import from a new `clio_tracker.fakes` module) so the harness is testable without weights.

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd tracker && uv run pytest -q tests/test_jitter.py -k "slide or swing or fake_segmenter"`
Expected: FAIL.

- [ ] **Step 3: Implement**, adding two columns to `measure`/`table`: `refreshes` (segmenter calls per sequence) and `followed` (share of found frames whose outline came from the follower).

- [ ] **Step 4: Run the harness before and after, and record**

Run: `cd tracker && uv run clio-tracker jitter --segmenter none --json /tmp/jitter-none.json` and `uv run clio-tracker jitter --segmenter sam2.1-small --json /tmp/jitter-sam.json` (each a few minutes; run in the background and wait).
Expected: both complete. Put the two summary tables (whole scenes, part scenes, the two moving-part scenes on their own) in `tracker/README.md` under Measured, with the per-frame `ms` so the follower's cost is visible, and say which outline (follower or YOLOE) each scene mostly drew.

- [ ] **Step 5: Full suite and ruff**

Run: `cd tracker && uv run pytest -q -m "not model" && uv run ruff check src tests`
Expected: PASS.

---

### Task 8: Try it on the headset (manual, documented)

**Files:**
- Modify: `tracker/README.md` (Demo section: one line on `pnpm tracker --segmenter sam2.1-small`; Licenses line for SAM 2.1, Apache-2.0)
- Modify: `docs/object-finder.md` (the tracking-finder paragraph mentions the segmenter outline)

- [ ] **Step 1: Document** the flag, the three loops in three sentences, and what to look for (`/health` shows the segmenter; the log prints `refresh` lines with their ms).
- [ ] **Step 2: Run** `pnpm tracker --segmenter sam2.1-small` with the headset on `primary.html` (the person at the keyboard does this; the agent only prepares the command and the log lines to watch) and note the stream's frames/s and the refresh rate from the log.
