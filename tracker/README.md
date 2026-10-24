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
```

| Endpoint                  | Who calls it                                                    | What it does                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /locate`            | Clio's primary-object route (`CLIO_PRIMARY_FINDER_URL`)         | One jev call for the frame, then YOLOE outlines each box jev found (`model`: `jev-1.14.0+yoloe-26l-seg`). One request at a time; another gets 503. |
| `POST /locate` + `session` | Clio's locate route (`CLIO_VISION_URL`), for lesson outlines   | Answers at once from tracking state, with `refreshMs: 50` so the headset sends the next frame soon; jev looks again about once a second.                    |
| `WS /track`               | `apps/headset/primary.html`                                     | Frames in, one mask per frame out; the page forwards each primary answer's box as the target. Protocol: [TRACK.md](TRACK.md).                              |
| `GET /health`             |                                                                 | `{ok, model, backend, sessions}`                                                                                                                               |

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
                                   # and converts it for the Neural Engine (about a minute, once)

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

`curl 127.0.0.1:8790/health` should answer `{"ok":true,...,"model":"jev-1.14.0+yoloe-26l-seg",
"backend":"coreml-ane"}`. Without a jev key, `pnpm tracker --fake-jev` answers every object at
one fixed box (no cost), and `CLIO_TRACKER_IDENTIFIER_URL=http://127.0.0.1:8787/api/vision/locate`
uses Gemini's locator in jev's place (only while Clio's `CLIO_VISION_URL` is unset: otherwise
Clio would send the request straight back here).

For lesson outlines that follow objects live, also set `CLIO_VISION_URL=http://127.0.0.1:8790/locate`
in `.env` and restart `pnpm dev`. The lesson needs no flag: the tracker's `refreshMs` sets the
pace (`?showRefresh=0` still turns refreshing off).

## Settings

From the environment, then `tracker/.env`, then the repo's `.env`.

| Setting                               | Default                 |                                                                                         |
| ------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| `TYPESAFE_API_KEY`                    |                         | jev's key. It stays in this process and is never logged.                                |
| `CLIO_TRACKER_IDENTIFIER_URL`         |                         | Without a jev key: any finder that speaks Clio's contract names the targets instead.    |
| `--fake-jev [L,T,R,B]`                | `0.3,0.3,0.7,0.7`       | Every object present at this box; no key, no cost.                                      |
| `CLIO_TRACKER_MODEL`, `--model`       | `yoloe-26l-seg`         | Any `yoloe-26{n,s,m,l,x}-seg` checkpoint (not `-pf`: those have no SAVPE).              |
| `CLIO_TRACKER_BACKEND`, `--backend`   | `auto`                  | `coreml` (Apple Neural Engine) or `torch` (MPS, CUDA or CPU).                           |
| `CLIO_TRACKER_IDENTIFY_INTERVAL_MS`   | `1000`                  | With a session: how often jev looks again at each object.                               |
| `CLIO_TRACKER_IDENTIFY_MAX_IN_FLIGHT` | `1`                     | jev calls in flight. jev's client never overlaps billed calls.                          |
| `CLIO_TRACKER_JEV_TIMEOUT_S`          | `12`                    | The whole jev call. Clio gives up on the finder at 15 s.                                |
| `JEV_MODEL`, `JEV_ENDPOINT`           | `jev-1.14.0`, TypeSafe  | Box needs jev 1.14 or later.                                                            |
| `CLIO_TRACKER_REFRESH_MS`             | `50`                    | The `refreshMs` hint in session answers.                                                |
| `CLIO_TRACKER_PORT`, `--port`         | `8790`                  | Clio's server and Vite's `/track` proxy expect 8790.                                    |

`uv run --project tracker clio-tracker bench` times the graph and the per-object work here;
`clio-tracker export` converts for Core ML ahead of time; `clio-tracker jitter` measures how
steady `/track`'s answers are ([Measured](#measured)).

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
camera's motion when nothing holds it; its outline is the holder's mask inside the part box, or
the box as a rounded rectangle ([TRACK.md](TRACK.md#following-a-part)).

**Outlines replace SAM's masks.** The target's mask is its coefficients times the prototypes,
cut to its box. Clio gets the largest piece's contour (at most 64 points), the point deepest
inside it, where Clio lifts the object into 3D, and its contact point (the middle of its lowest
edge), which the primary demo uses to measure the object's distance.

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

`tests/test_end_to_end.py` runs the same pans on real weights with jev answering once (both on
`/track` and with a session): the person is kept on every frame. Nothing here has run on a
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

## Tests

```bash
cd tracker
uv run pytest -q                 # all; the "model" ones load real YOLOE-26 weights
uv run pytest -q -m "not model"  # logic only: synthetic scenes, fake jev, no network
uv run ruff check src tests
```

Licenses: Ultralytics and the YOLOE-26 weights are AGPL-3.0. `jev.py`, `images.py`, `stream.py`,
`bench.py` and the `/track` protocol come from the jev finder (this repository).
