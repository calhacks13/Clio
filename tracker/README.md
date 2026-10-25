# Clio tracker

Clio's object finder and live tracker on `:8790`. **jev** decides which object the words mean,
about once a second; the vision half of **YOLOE-26**, with ByteTrack, follows that object on
every frame in between. It replaced the jev finder's EdgeTAM and SAM 2.1 models. On an M5 a frame
takes about 31 ms with YOLOE-26L on the Neural Engine (15 ms with YOLOE-26s), plus about 3 ms
per stream for decoding and the camera's motion and 2 ms per tracked object.

```
                       ┌─ POST /locate, no session ──▶ jev now ──▶ YOLOE outlines jev's box
Clio server ───────────┤   (primary-object route, ~1/s)
                       └─ POST /locate + session ────▶ tracking state; jev ~1/s in the background
                           (lesson Spotlight, every ~50 ms)
headset primary.html ──── ws /track ─────────────────▶ YOLOE-26 + ByteTrack on every frame
  (via Vite's proxy)       frames + jev's box as `target`
headset lesson ────────── ws /track, objects mode ───▶ every object on every frame;
  (via Vite's proxy)       frames + the lesson's         jev ~1/s in the background
                           objects in words
```

| Endpoint                  | Who calls it                                                    | What it does                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /locate`            | Clio's primary-object route (`CLIO_PRIMARY_FINDER_URL`)         | One jev call for the frame, then SAM 2.1 outlines each box jev found, YOLOE where SAM finds nothing or without a segmenter (`model`: `jev-1.14.0+yoloe-26l-seg+sam2.1-small`, without the `+sam2.1-small` when there is no segmenter). One request at a time; another gets 503. |
| `POST /locate` + `session` | Clio's locate route (`CLIO_VISION_URL`), for lesson outlines   | Answers at once from tracking state, with `refreshMs: 50` so the headset sends the next frame soon; jev looks again about once a second.                    |
| `WS /track`               | `apps/headset/primary.html`                                     | Frames in, one mask per frame out; the page forwards each primary answer's box as the target. Protocol: [TRACK.md](TRACK.md).                              |
| `WS /track`, objects mode | the headset's lesson                                            | Frames and the lesson's objects in words in, every object's outline per frame out; jev about once a second, as with a session. [TRACK.md](TRACK.md#objects-mode). |
| `GET /health`             |                                                                 | `{ok, model, backend, segmenter, sessions}`                                                                                                                    |

The contract for `/locate` is [docs/object-finder.md](../docs/object-finder.md). The service
listens on 127.0.0.1 only and answers only requests addressed to a local host name; `/track`
also refuses a browser `Origin` that isn't local.

## Demo on a Quest, from a fresh clone

You need Node and pnpm, [uv](https://docs.astral.sh/uv/), adb
(`brew install android-platform-tools`), a Quest 3 in developer mode on USB, a Gemini key and a
jev key (TypeSafe, api.typesafe.ai). A Mac with Apple silicon runs YOLOE on the Neural Engine;
elsewhere it runs on CUDA or MPS through PyTorch (or slowly on the CPU).

```sh
# Clio, from the repository root
pnpm install
cp .env.example .env               # add GEMINI_API_KEY (Gemini picks the object) and TYPESAFE_API_KEY
pnpm dev                           # Vite on 5173, Clio server on 8787

# The tracker, in a second terminal
pnpm tracker                       # 127.0.0.1:8790; the first run downloads YOLOE-26L (79 MB)
                                   # and converts it for the Neural Engine (about a minute, once),
                                   # and SAM 2.1 Small, which cuts the outlines (the default,
                                   # auto, is sam2.1-small; CLIO_TRACKER_SEGMENTER=none: no SAM)

# The Quest, once per USB connection
pnpm quest:reverse                 # adb reverse tcp:5173 tcp:5173
```

Open **`http://localhost:5173/primary.html`** in Quest Browser. If the camera never asks for
permission (Quest Browser 150 to 154), grant it over adb, then reload
([docs/dev-setup.md](../docs/dev-setup.md#camera-permission-workaround)):

```sh
adb shell pm grant com.oculus.browser horizonos.permission.HEADSET_CAMERA
adb shell pm grant com.oculus.browser android.permission.CAMERA
```

`curl 127.0.0.1:8790/health` should answer `{"ok":true,...,"model":"jev-1.14.0+yoloe-26l-seg+sam2.1-small",
"backend":"coreml-ane"}` (`jev-1.14.0+yoloe-26l-seg` without a segmenter).
Without a jev key, `pnpm tracker --fake-jev` answers every object at one fixed box (no cost), and
`CLIO_TRACKER_IDENTIFIER_URL=http://127.0.0.1:8787/api/vision/locate` uses Gemini's locator in jev's
place (only while Clio's `CLIO_VISION_URL` is unset: otherwise Clio would send the request straight
back here).

`pnpm tracker` outlines with SAM 2.1 Small instead of YOLOE's masks: the default segmenter,
`auto`, is `sam2.1-small` (`transformers` is one of the tracker's dependencies; the weights, about
180 MB, download on first use). `--segmenter sam2.1-large` picks Large, and
`CLIO_TRACKER_SEGMENTER=none` (or `--segmenter none`) turns SAM off. Under `auto`, a SAM that
fails to load is one warning and the tracker starts without it; a size named on purpose stops it.
`/health` says `"segmenter":"sam2.1-small"` (null without one) and `/locate`'s `model` ends in
`+sam2.1-small`. In the log, `Outline: sam2.1-small's mask, carried to every frame by the
object's own pixels` and `sam2.1-small on mps: loaded in ... s, warmed up in ... s` appear at
start-up. The `Stream: ... frames/s, ... ms each (...)` line every 3 s shows what a frame costs
with SAM running (24 to 27 ms in the harness against 18 without), and with SAM it ends in
`follower N%, segmenter: K calls, M ms, E empty`: the share of found frames whose outline was
SAM's mask carried by the follower, then the boxes SAM cut since the last line, their mean time
and how many held nothing (objects mode's `Objects:` line counts every object's answers). A
failing SAM writes `sam2.1-small: <error>. Tracking continues.` once per stream or session as it
starts failing and `sam2.1-small answers again` as it recovers, and `/locate` without a session
writes its own `sam2.1-small: <error>. YOLOE outlines jev's boxes meanwhile.`

For lesson outlines that follow objects live, also set `CLIO_VISION_URL=http://127.0.0.1:8790/locate`
in `.env` and restart `pnpm dev`. The lesson needs no flag: the tracker's `refreshMs` sets the
pace (`?showRefresh=0` still turns refreshing off).

## How a lesson uses `/track`

Objects mode ([TRACK.md](TRACK.md#objects-mode)) does what `/locate` with a session does, over
the stream instead of one HTTP request per frame through Clio's server. The headset opens
`/track` (through Vite's proxy, as `primary.html` does) and sends the objects to follow in words
whenever they change: every object the plan declares (up to 8, the focused step's show items
first, then the coach's highlights, then the rest; only the first two kinds are lit), each with
its id, a phrase that stays the same from step to step, and the step's description (else the
object's tracking query) as the query; `"objects": []` once the lesson ends, which stops jev. It
streams frames as `primary.html` does and gets every object's box,
outline, point and contact on each one. The tracker asks jev itself, about once a second, in
one call for all the objects that are due, and less often while jev fails (up to 16 s apart,
as with a session). What comes back feeds the learner's AR view and the recording only, never a
Gemini coach ([docs/coach-plan.md](../docs/coach-plan.md#the-perception-boundary)).

## Settings

From the environment, then `tracker/.env`, then the repo's `.env`.

| Setting                               | Default                 |                                                                                         |
| ------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| `TYPESAFE_API_KEY`                    |                         | jev's key. It stays in this process and is never logged.                                |
| `CLIO_TRACKER_IDENTIFIER_URL`         |                         | Without a jev key: any finder that speaks Clio's contract names the targets instead.    |
| `--fake-jev [L,T,R,B]`                | `0.3,0.3,0.7,0.7`       | Every object present at this box; no key, no cost.                                      |
| `CLIO_TRACKER_MODEL`, `--model`       | `l`                     | The size: `s`, `m` or `l` (also `n`, `x`, or a name such as `yoloe-26s-seg`). See below. |
| `CLIO_TRACKER_BACKEND`, `--backend`   | `auto`                  | `coreml` (Apple Neural Engine) or `torch` (MPS, CUDA or CPU).                           |
| `CLIO_TRACKER_SEGMENTER`, `--segmenter` | `auto` | `auto` is `sam2.1-small` (`transformers` is a dependency), or no segmenter when it fails to load; `sam2.1-large`; `none` turns SAM off: YOLOE's masks. `clio-tracker jitter` takes only `--segmenter` (default `none`). |
| `CLIO_TRACKER_IDENTIFY_INTERVAL_MS`   | `1000`                  | With a session or in objects mode: how often jev looks again at each object.            |
| `CLIO_TRACKER_IDENTIFY_MAX_IN_FLIGHT` | `1`                     | jev calls in flight. jev's client never overlaps billed calls.                          |
| `CLIO_TRACKER_JEV_TIMEOUT_S`          | `12`                    | The whole jev call. Clio gives up on the finder at 15 s.                                |
| `JEV_MODEL`, `JEV_ENDPOINT`           | `jev-1.14.0`, TypeSafe  | Box needs jev 1.14 or later.                                                            |
| `CLIO_TRACKER_REFRESH_MS`             | `50`                    | The `refreshMs` hint in session answers.                                                |
| `CLIO_TRACKER_PORT`, `--port`         | `8790`                  | Clio's server and Vite's `/track` proxy expect 8790.                                    |

`uv run --project tracker clio-tracker bench` times the graph and the per-object work here;
`clio-tracker export` converts for Core ML ahead of time; `clio-tracker jitter` measures how
steady `/track`'s answers are ([Measured](#measured)).

## Sizes

Each size goes through the same steps: the vision half of the checkpoint, split the same way
(`tests/test_vision.py` checks each against Ultralytics' own forward pass), the same Core ML
conversion, the same tracker. `pnpm tracker:export` downloads and converts all three ahead of
time.

| Command            | Size | Port | Used for                                                           |
| ------------------ | ---- | ---- | ------------------------------------------------------------------ |
| `pnpm tracker`     | l    | 8790 | everything: Clio's server and Vite's `/track` proxy expect 8790    |
| `pnpm tracker:s`   | s    | 8791 | comparing on the headset, beside l                                 |
| `pnpm tracker:m`   | m    | 8792 | comparing on the headset, beside l                                 |

To compare, run all three, forward the extra ports to the Quest
(`adb reverse tcp:8791 tcp:8791` and `adb reverse tcp:8792 tcp:8792`), and open
`primary.html?tracker=8791`, or switch live in AR with `__setTracker(8792)` in the page's
console (`__setTracker(null)` goes back to l through Vite). Gemini and jev keep going through
l's `/locate`; only the frame-by-frame tracking moves. To run a smaller size on its own, use
`pnpm tracker --model s`.

| Size | Weights | Core ML package | A frame on the Neural Engine | On PyTorch (MPS, fp16) | Person on the bus pan (median IoU) |
| ---- | ------- | --------------- | ---------------------------- | ---------------------- | ---------------------------------- |
| `s`  | 31 MB   | 24 MB           | 16 to 19 ms                  | 37 to 51 ms            | 0.94                               |
| `m`  | 70 MB   | 56 MB           | 28 to 44 ms                  | 50 to 98 ms            | 0.94                               |
| `l`  | 79 MB   | 64 MB           | 27 to 37 ms                  | 55 to 204 ms           | 0.96 to 0.97                       |

A frame is everything but decoding the JPEG: fitting it to the model's input, the graph, and
copying out every candidate's box, features and mask data. Following one object adds 1 to 4 ms. Times are medians from several runs on an M5 (24 GB)
that was running other jobs at the same time (load average 6 to 22), so they vary. The Core ML
graph alone takes about 18 ms for both m and l: on this Mac's Neural Engine, m is no faster
than l. Every layer of all three runs on the Neural Engine (Core ML's compute plan).

All three tracked their target on every frame of the test pans (the bus person through Clio's
session mode and over `/track`; the caliper close-up, 228 of 228 frames for s and m, 226 plus
2 coasting for l), never on another person, and outlined jev's box for `/locate`. Those scenes
are large, distinct objects, so they don't tell the sizes apart on small or unusual parts; that
is untested. Use l unless the frame rate matters more: s answers about twice as fast.

## How it works

**One pass per frame.** `vision.py` cuts YOLOE-26's text half (MobileCLIP2-B and RepRTA) off and
keeps everything that only looks at pixels: backbone, neck, and the head's NMS-free one-to-one
branch. For each of the 8,400 candidate positions it returns a box, the region features before
the classifier, and mask coefficients; plus the mask prototypes and the prompt-independent maps
of SAVPE, YOLOE's visual prompt encoder.

**Prompts come from boxes, not words.** jev's box on a frame goes through SAVPE's small
prompt-dependent tail and becomes a 512-number prompt, in the same space YOLOE's text prompts
live in. Scoring a frame against it is YOLOE's own contrastive head, folded once per prompt:
`sigmoid(s·e·(P h + c) + o)` is `sigmoid(w·h + b)` with `w = s Pᵀe` and `b = s e·c + o`, so
scoring a frame is one short dot product per candidate (256 numbers for L).
`tests/test_vision.py` pins the split graph, the folded scores and the SAVPE split to
Ultralytics' unmodified forward pass.

**ByteTrack keeps identity; jev picks it.** Each followed object has its own ByteTrack over the
candidates its prompt scores (the best score against the prompt and jev's last four views of the
object, since one view taken half out of frame or blurred can hardly find it again): a track
starts at 0.45 and confirms on its second sighting, and an existing track continues on
candidates down to 0.10. One track is the target. jev's answers arrive a second or more late,
about a frame the tracker has already moved past, so each box is matched to the track that was
there on that frame (IoU 0.3, or a part inside its whole): a late answer still lands on the right
object, or moves the target if it had drifted to a look-alike. When no track was there, jev's box
is carried to now (below) and the candidate filling it becomes the target on the next frame, as
a new track if need be.

**Everything moves with the camera.** The headset's camera turns with the head, so most motion
in the picture is the wearer's. `motion.py` measures it between frames (sparse optical flow with
a forward-backward check and RANSAC, a phase-correlation guess for fast glances; about 1.5 ms at
240 px wide) and every track's Kalman state, the last sighting, jev's pending box and the
smoothed output are carried by it before ByteTrack matches, as BoT-SORT does. A glance no longer
breaks the track, and jev's box from a second ago lands where its object is now.

**The appearance keeps up between answers.** Each confident sighting's own visual prompt is
blended into a running appearance (15% a frame), but only while it still resembles jev's view
(cosine ≥ 0.8) and is not cut off by the frame edge, so turning the object is learned and a hand
covering it is not. The prompt is half jev's view and half the running one.

**Losing and finding it again.** YOLOE's score for an object swings from frame to frame (blur,
glare), while its box stays put: a target ByteTrack misses continues on a weaker candidate (down
to 0.03) that overlaps its predicted box by IoU 0.5. Otherwise it coasts on its predicted box for
0.5 s (1 s when it was at an edge or filled the view), unless the prediction has left the view,
then reads as lost; its track lives 3 s, carried by the camera, so after a glance away it is the
same track again. In a close-up, the whole object and one part of it can swap scores and
ByteTrack starts a new track where the target was: a track born there after the target was last
seen takes over at a lower appearance bar (0.75), and a late jev answer about the old track
means the new one. Otherwise a target with no track is re-acquired by appearance alone (0.88):
YOLOE's visual prompts tell instances of one kind apart (on `bus.jpg`, two different people at
0.77 to 0.86 cosine, one person across views at 0.95 to 0.97), so a look-alike that scores well
is not taken. When the target stops looking like itself for three frames, jev is asked early.

**Parts of objects** (`part.py`, `?focus=part`). A target flagged `"part": true`, or a box
covering less than half of the track it would land on and lying inside it, is never matched to
a track: it would end on the whole object, whose candidate is usually the only one there and
whose look the part's resembles. The part is a box riding on the object holding it (followed as
an object of its own: the candidate holding the part that best matches its own view), or on the
camera's motion when nothing holds it; without a segmenter, its outline is the holder's mask
inside the part box, or the box as a rounded rectangle ([TRACK.md](TRACK.md#following-a-part)).

**YOLOE's outlines.** Without a segmenter the target's mask is its coefficients times the
prototypes, cut to its box. Clio gets the largest piece's contour (at most 64 points), the point
deepest inside it, where Clio lifts the object into 3D, and its contact point (the middle of its
lowest edge), which the primary demo uses to measure the object's distance.

**The outline is the segmenter's mask** (`segment.py`, `follow.py`, `refresh.py`). YOLOE's mask
comes from 32 coarse prototypes and is ragged as an outline; judged by eye on the still-photo
benchmark, SAM 2.1 cuts an object out of its box more cleanly, but a call took 140 to 180 ms with
Small and 470 to 620 ms with Large on the M5 Pro's GPU, so it never runs on every frame. It cuts
jev's box out on jev's frame, and again whenever the tracker doubts the mask it has, in a background
thread (one call at a time, at least 150 ms apart; a new jev answer goes first, the boxes of all
the objects it placed cut out of one encoding of its frame). Of SAM's three
candidate masks for a box it keeps the one with the highest predicted IoU times the IoU between its
bounding box and the box, so a box around a whole object gets the whole, not one clean piece of it,
and a box around a part gets the part. The follower carries the latest mask to every frame:
optical-flow points inside it, started from where the camera's motion and the object's own last
motion put them and kept by the same forward-backward check and RANSAC as the camera's, so the mask
moves with the object itself and not only with the camera. The harness has two scenes of a part
moving on its own, a caliper's jaw sliding along its scale and a name plate swinging on its hinge
(`jaw-slide`, `plate-swing`). In the full runs of the measured table the follower did not beat
YOLOE's mask on them by the box measures: the sliding jaw's IoU was 0.493 with Small against 0.616
without a segmenter (a single re-run since the rules below gave 0.639; [Measured](#measured)).
YOLOE and ByteTrack still decide which object it is. The follower's mask
is what is drawn while it is sure of itself and its box agrees with ByteTrack's (IoU 0.3, or
inside it as a part inside its whole), and, for an object too plain to follow by its own pixels
(a white door), while the mask carried by the camera's motion alone still agrees; otherwise
YOLOE's is, and after two frames of doubt SAM is asked again, around ByteTrack's box when the
follower's was only carried by the camera. jev's keyframe replaces the follower's mask even when a
refresh of a newer frame landed while jev answered. A part gets a mask of its own the same way and
reads `tracking`: it is measured, not predicted ([TRACK.md](TRACK.md#following-a-part)).

**Steady outlines** (`smooth.py`). What is returned is filtered; what is tracked is not. The box
goes through a One Euro filter (cutoff 1.5 Hz at rest, rising 4 Hz per box size a second of
motion, so it trails a hand-moved object by 1 to 3 px) in the scene's frame of reference: the
camera's motion is applied first and never smoothed, so turning the head adds no lag. The mask is
blended in its box's own coordinates (55% of the last blend kept), so a one-frame glitch, a lost
piece or a speck, doesn't show and a change that lasts two frames does. `point` is the middle of
the mask's deepest ridge rather than its single deepest pixel, which hops along a long shape;
`point` and `contact` are eased in box coordinates. A box that jumps (IoU under 0.3 with the last)
starts over rather than morphing from another object.

## Measured

On an M5 (24 GB), YOLOE-26L on the Neural Engine, Gemini standing in for jev (no jev key on this
machine). Simulated cameras pan and zoom across still photos at up to 15 frames a second.

**The primary demo, played like `primary.html`:** frames over `ws://localhost:5173/track`
through Vite's proxy, a look every second through `/api/vision/primary` (Gemini names the
object, this service's `/locate` boxes and outlines it), each answer sent back as the target.
`apps/headset/public/demo/caliper.jpg`, 300 frames, ending in a close-up wider than the frame:

| Measure                                   | Value                                                     |
| ----------------------------------------- | --------------------------------------------------------- |
| Stream                                    | 13.2 frames/s; round trip 36 ms p50, 40 ms p95            |
| A look (Gemini pick + `/locate`)          | 2.6 s p50                                                 |
| Frames found after the first answer       | 270 of 270 (one frame coasting)                           |
| Tracked box vs each later look's box      | IoU 1.0 on 7 of 7: the same object jev's stand-in named   |

**Lesson outlines** (`/locate` with a session, through Clio's server), `bus.jpg` with four
people: round trip 36 ms p50, 40 ms p95; the first outline 1.2 s in (the first identifier
answer); the described person found on 72 of 72 frames after that, IoU 0.95 to 0.96, never on
another person.

`tests/test_end_to_end.py` runs the same pans on real weights with jev answering once (on
`/track`, with a session, and in objects mode): the person is kept on every frame. In objects
mode it follows two people at once, the man and the person at the left edge, both on every
frame after jev's one answer and never on anyone else; a frame of the two took 12 to 14 ms with
s and 21 to 23 ms with l on the Neural Engine, decoding included. Nothing here has run on a
Quest yet. jev itself has not been called from this machine; its client is the jev finder's,
which was measured against real jev (five calls, 7 of 7 present objects found, 3 of 3 absent
ones rejected, boxes at IoU 0.82 to 0.98), and is tested here against a fake transport.

**Steadiness of `/track`** (`clio-tracker jitter --baseline DIR`, `jitter.py`): seven 12 s
sequences at 25 frames a second, 480x360 JPEGs like the headset's, of a camera panning, zooming
and shaking across the demo photos and five from the Jev fun set (motion blur, a hand passing in
front, a quick glance and a look away and back), with a look answered 1 to 2 s later about once a
second (jev's box with jev-sized noise, outlined by YOLOE as `/locate` does). Every frame has a
true box, so wobble is measured with the real motion taken out. YOLOE-26L on the Neural Engine,
before and after the camera motion, weak-candidate continuation, jev views and smoothing:

| All seven sequences                                    | Before | After |
| ------------------------------------------------------ | -----: | ----: |
| Frames lost while the object is in view                |  33.1% |  1.0% |
| Longest run of lost frames                             |    274 |     9 |
| Found frames on another object                         |  16.9% |    0% |
| Box centre wobble, px (second difference, mean)        |   3.91 |  1.37 |
| Outline centroid wobble, px (mean / p95)               | 8.9 / 34.4 | 2.5 / 12.8 |
| `point` / `contact` wobble, px                         | 14.8 / 14.5 | 4.7 / 2.0 |
| Outline IoU with the last frame's, camera motion removed | 0.925 | 0.959 |
| Outlines that change by more than half (swaps)         |     23 |     1 |
| Time in `step` per frame, ms (mean / p95)              | 24.3 / 28.3 | 25.2 / 26.9 |

Before, the glass condenser and the test tube (seven look-alikes) were never followed: YOLOE's
visual prompt scores them weakly (0.0 to 0.5 even on jev's own frame), so no track started and
jev's box waited for one. The rest of the lost frames were glances (the Kalman prediction can't
follow a 100 px a frame turn) and score dips under ByteTrack's floor. With the smoother told
nothing of the camera (all motion treated as the object's own, the worst case for lag), the box
still matches the truth at IoU 0.875 against 0.885.

**Parts** (`clio-tracker jitter`, the five part scenes: a caliper's vernier scale, a
micrometer's thimble and name plate, a rotary switch's shaft, a 9 V battery's terminals; the
camera frames the part, and the target says `"part": true`). Before, each was followed as an
object:

| All five part sequences                          | Before | After |
| ------------------------------------------------ | -----: | ----: |
| Frames lost while the part is in view            |   9.1% |    0% |
| Found frames nearer the whole object than the part | 27.3% |  0.7% |
| IoU with the true part box                       |  0.602 | 0.746 |
| Box centre wobble, px (mean)                     |   3.35 |  1.67 |
| Outline centroid wobble, px (mean / p95)         | 5.0 / 24.4 | 3.5 / 13.6 |
| Outlines that change by more than half (swaps)   |     19 |    16 |

The thimble, which has no YOLOE candidate of its own, was on the micrometer's barrel in 92% of
frames before (IoU 0.45), 3% after (0.78). The seven whole-object sequences give the same
numbers as before to the last digit.

**With a segmenter** (`clio-tracker jitter --segmenter sam2.1-small`, and `sam2.1-large`): the same
fourteen sequences, summed up as `all` (seven whole objects), `parts` (five parts that stay put) and
`moving` (two parts that move on their own: a caliper's sliding jaw and a micrometer's swinging name
plate, with the photo's own part erased where it leaves). The SAM runs were paced (the harness does
so by itself with a segmenter, and `--no-pace` turns it off: each frame at least 1/25 s, the fast
end of the headset's stream at 40 to 75 ms a frame, because the refresher spaces its calls by wall
clock and the harness alone plays a frame in 20 ms) and took 3.7 and 4.4 minutes; the run without a
segmenter, 1.4. These runs were on an Apple M5 Pro (48 GB), not the M5 (24 GB) of the sections
above: YOLOE-26L on the Neural Engine, SAM 2.1 on the GPU (MPS, float32), load average 0.7 to 1.3
with nothing else busy. The look was outlined by SAM, and by YOLOE where SAM cut nothing.

| Set (sequences)  | Segmenter | Lost | Wrong | IoU   | Mask f2f | Swaps | Followed | Refreshes | Step, ms |
| ---------------- | --------- | ---: | ----: | ----: | -------: | ----: | -------: | --------: | -------: |
| `all` (7)        | none      | 1.0% |    0% | 0.880 |    0.959 |     1 |      n/a |         0 |     18.2 |
|                  | Small     | 1.7% |    0% | 0.874 |    0.958 |    18 |    85.6% |        93 |     27.0 |
|                  | Large     | 4.1% |    0% | 0.888 |    0.959 |    16 |    76.0% |        74 |     25.5 |
| `parts` (5)      | none      |   0% |  2.8% | 0.746 |    0.933 |    16 |      n/a |         0 |     18.2 |
|                  | Small     |   0% |  2.8% | 0.768 |    0.918 |    30 |    80.6% |        83 |     27.0 |
|                  | Large     |   0% |  3.1% | 0.731 |    0.912 |    34 |    71.0% |        67 |     24.4 |
| `moving` (2)     | none      |   0% |  2.4% | 0.600 |    0.920 |    10 |      n/a |         0 |     18.4 |
|                  | Small     | 1.8% |    0% | 0.642 |    0.884 |    11 |    74.7% |        40 |     27.0 |
|                  | Large     |   0% |    0% | 0.633 |    0.892 |    22 |    55.7% |        32 |     24.1 |

`Followed` is the share of found frames whose outline was the follower's, SAM's mask carried from
frame to frame (the mean of the sequences' shares); the rest were YOLOE's mask, or for a part the
part box. Without a segmenter nothing follows, so there is no figure.

By these measures SAM raised the IoU of some scenes and steadied none. The caliper's IoU over the
sequence was 0.950 with Small and 0.926 with Large against 0.894 with YOLOE's mask, its vernier's
0.873 and 0.807 against 0.772, and `moving` 0.642 and 0.633 against 0.600; the sliding jaw was never
taken for something else (4.8% with YOLOE's mask). But the whole objects' IoU was 0.874 and 0.888
against 0.880; the outlines were redrawn as a different shape more often (swaps, 18 and 16 against 1
on the whole objects, 30 and 34 against 16 on `parts`) and changed more from frame to frame on
`parts` and `moving` (mask f2f, the IoU of each outline with the last frame's, camera motion
removed: 0.918 and 0.912 against 0.933, and 0.884 and 0.892 against 0.920; on the whole objects
0.958 and 0.959 against 0.959); and a frame took 6 to 9 ms longer in `step`. It also lost more of
the whole objects (1.7% with Small and 4.1% with Large against 1.0%: the condenser, for a run of 21
frames in both, against 9 with YOLOE's mask, and with Large the test tube, for 43, which YOLOE's
mask never lost) and did worse on the terminals scene (IoU 0.581 and 0.546 against 0.753; its box
nearer the whole battery than the terminals on 15.5% of found frames with Small against 1.0%, and on
something else on 15.7% with Large against 14.0%). The follower drew 85.6% and 76.0% of the whole
objects' found frames, 80.6% and 71.0% of the parts' and 74.7% and 55.7% of the moving parts'. Each
row is a single run: in a repeat of Small made on earlier code, `parts` varied by 0.04 IoU and
`moving` by 0.15, so a difference of that size between rows is not a finding. The harness's truth is
a box per frame, so what SAM is for, the outline's shape, is not measured here.

**The two moving scenes.** The jaw sliding along the caliper was taken for something else on 4.8% of
its found frames with YOLOE's mask and on none with either SAM; Small lost it for a run of 9 frames
(3.3%), Large never. Its IoU was 0.616, 0.609 and 0.653, its swaps 9, 10 and 18, and the follower
drew 64.8% and 56.3% of its found frames. The name plate swinging on the micrometer was never taken
for anything else; its IoU was 0.583, 0.676 and 0.613, its swaps 1, 1 and 4, and the follower drew
84.6% and 55.1%. So on the moving scenes SAM's IoU was 0.03 to 0.04 above YOLOE's mask (0.642 and
0.633 against 0.600), inside the spread of a repeat, with a lower mask f2f and, with Large, twice
the swaps (22 against 10). Small made 216 calls over the fourteen sequences and Large 173; measured
apart, on a 480x360 frame, a call took 143 ms with Small (121 encoding the frame, 22 cutting the
box) and 467 ms with Large (445 and 22), where an earlier measurement read 182 and 624 ms.

**The candidate rule.** SAM proposes three masks for a box, and the one the model rated best used to
be the one drawn. On the harness's caliper scene that was one jaw instead of the whole caliper at
one of Small's eight keyframes (IoU 0.22 with the caliper's true box; the eight averaged 0.88); with
the rule that scales the rating by how well the mask's bounds fit the box, all eight hold the whole
(0.92 or better, mean 0.97), and Large held it both ways (0.98). Across the fourteen scenes' 112
keyframes the rule moved the mean IoU from 0.880 to 0.888 with Small and from 0.885 to 0.890 with
Large, and by 0.05 or less on any scene but Small's caliper. In the table's runs the caliper's
tracked IoU over the sequence was 0.950 with Small and 0.926 with Large, against 0.894 with YOLOE's
mask.

## Tests

```bash
cd tracker
uv run pytest -q                 # all; the "model" ones load real YOLOE-26 weights:
                                 # s, plus m and l when downloaded (CLIO_TRACKER_TEST_MODELS=s,m,l)
uv run pytest -q -m "not model"  # logic only: synthetic scenes, fake jev, no network
uv run ruff check src tests
```

Licenses: Ultralytics and the YOLOE-26 weights are AGPL-3.0; SAM 2.1 (Apache-2.0) comes through
`transformers`. `jev.py`, `images.py`, `stream.py`, `bench.py` and the `/track` protocol's target
mode come from the jev finder (this repository).
