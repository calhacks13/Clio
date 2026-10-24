# Clio tracker

Clio's object finder and live tracker on `:8790`. **jev** decides which object the words mean,
about once a second; the vision half of **YOLOE-26**, with ByteTrack, follows that object on
every frame in between. It replaced the jev finder's EdgeTAM and SAM 2.1 models. On an M5 a frame
takes about 31 ms with YOLOE-26L on the Neural Engine (15 ms with YOLOE-26s), plus about 2 ms
per tracked object.

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
| `CLIO_TRACKER_MODEL`, `--model`       | `l`                     | The size: `s`, `m` or `l` (also `n`, `x`, or a name such as `yoloe-26s-seg`). See below. |
| `CLIO_TRACKER_BACKEND`, `--backend`   | `auto`                  | `coreml` (Apple Neural Engine) or `torch` (MPS, CUDA or CPU).                           |
| `CLIO_TRACKER_IDENTIFY_INTERVAL_MS`   | `1000`                  | With a session: how often jev looks again at each object.                               |
| `CLIO_TRACKER_IDENTIFY_MAX_IN_FLIGHT` | `1`                     | jev calls in flight. jev's client never overlaps billed calls.                          |
| `CLIO_TRACKER_JEV_TIMEOUT_S`          | `12`                    | The whole jev call. Clio gives up on the finder at 15 s.                                |
| `JEV_MODEL`, `JEV_ENDPOINT`           | `jev-1.14.0`, TypeSafe  | Box needs jev 1.14 or later.                                                            |
| `CLIO_TRACKER_REFRESH_MS`             | `50`                    | The `refreshMs` hint in session answers.                                                |
| `CLIO_TRACKER_PORT`, `--port`         | `8790`                  | Clio's server and Vite's `/track` proxy expect 8790.                                    |

`uv run --project tracker clio-tracker bench` times the graph and the per-object work here;
`clio-tracker export` converts for Core ML ahead of time.

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
candidates its prompt scores: a track starts at 0.45 and confirms on its second sighting, and an
existing track continues on candidates down to 0.10. One track is the target. jev's answers
arrive a second or more late, about a frame the tracker has already moved past, so each box is
matched to the track that was there on that frame: a late answer still lands on the right
object, or moves the target if it had drifted to a look-alike.

**The appearance keeps up between answers.** Each confident sighting's own visual prompt is
blended into a running appearance (15% a frame), but only while it still resembles jev's view
(cosine ≥ 0.8) and is not cut off by the frame edge, so turning the object is learned and a hand
covering it is not. The prompt is half jev's view and half the running one.

**Losing and finding it again.** A target missed on a frame coasts on its predicted box for
0.35 s (1 s when it left by an edge or filled the view), then reads as lost; its track lives 1 s
more. In a close-up, the whole object and one part of it can swap scores and ByteTrack starts a
new track where the target was: a track born there after the target was last seen takes over
at a lower appearance bar (0.75), and a late jev answer about the old track means the new one.
Otherwise a target with no track is re-acquired by appearance alone (0.88): YOLOE's visual
prompts tell instances of one kind apart (on `bus.jpg`, two different people at 0.77 to 0.86
cosine, one person across views at 0.95 to 0.97), so a look-alike that scores well is not
taken. When the target stops looking like itself for three frames, jev is asked early.

**Outlines replace SAM's masks.** The target's mask is its coefficients times the prototypes,
cut to its box. Clio gets the largest piece's contour (at most 64 points), the point deepest
inside it, where Clio lifts the object into 3D, and its contact point (the middle of its lowest
edge), which the primary demo uses to measure the object's distance.

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

## Tests

```bash
cd tracker
uv run pytest -q                 # all; the "model" ones load real YOLOE-26 weights:
                                 # s, plus m and l when downloaded (CLIO_TRACKER_TEST_MODELS=s,m,l)
uv run pytest -q -m "not model"  # logic only: synthetic scenes, fake jev, no network
uv run ruff check src tests
```

Licenses: Ultralytics and the YOLOE-26 weights are AGPL-3.0. `jev.py`, `images.py`, `stream.py`,
`bench.py` and the `/track` protocol come from the jev finder (this repository).
