# jev finder

An object finder for Clio ([docs/object-finder.md](../../docs/object-finder.md)): jev decides
whether each object is in the frame and boxes it, then a SAM model (EdgeTAM, or SAM 2.1 Small
if EdgeTAM can't load) turns each box into a mask, and the mask becomes one outline, a box and a
point. The demo's primary-object route (`/api/vision/primary`) sends it the object Gemini picked;
`CLIO_VISION_URL` can point the regular locate route at it too.

The same service tracks that object live: the demo page streams camera frames over the WebSocket
`/track` ([TRACK.md](TRACK.md), the contract with the headset) and gets a mask for every frame,
while jev's box arrives about once a second to say what to track.

```
Clio server ── POST /locate ──▶ jev finder ── one request ──▶ jev (api.typesafe.ai)
                                   │
headset ─── ws /track ───────────▶ ├── EdgeTAM on the laptop GPU (mps), one call at a time
```

It has its own uv env (`pyproject.toml`, `uv.lock`). The models are not in git:
`python -m jev_finder.setup_models` fetches EdgeTAM (code and checkpoint, from GitHub at a pinned
commit) and SAM 2.1 Small (from Hugging Face at a pinned revision) into `models/`, which is
gitignored. Licenses are in [THIRD_PARTY.md](THIRD_PARTY.md). uvicorn's WebSocket support is
not used: `websocket.py` implements the protocol itself (RFC 6455 without extensions).

## Demo from a fresh clone

You need Node and pnpm, [uv](https://docs.astral.sh/uv/), git, adb
(`brew install android-platform-tools`), a Quest 3 in developer mode on USB, a Gemini key and
your own jev key (TypeSafe, api.typesafe.ai). A Mac with Apple silicon runs EdgeTAM on the GPU
(mps); CUDA works too, and the CPU is slow.

```sh
# Clio, from the repository root
pnpm install
cp .env.example .env               # add GEMINI_API_KEY: Gemini picks the object
pnpm dev                           # Vite on 5173, Clio server on 8787

# The jev finder, in a second terminal
cd services/jev-finder
uv sync                            # Python 3.12, torch, transformers, FastAPI
uv run python -m jev_finder.setup_models   # about 500 MB into models/, once
cp .env.example .env               # add TYPESAFE_API_KEY
./run.sh                           # 127.0.0.1:8790; real jev, one call per look

# The Quest, once per USB connection
adb reverse tcp:5173 tcp:5173      # or pnpm quest:reverse
```

Open **`http://localhost:5173/primary.html`** in Quest Browser. If the camera never asks for
permission (Quest Browser 150 to 154), grant it over adb, then reload
([docs/dev-setup.md](../../docs/dev-setup.md#camera-permission-workaround) has the check):

```sh
adb shell pm grant com.oculus.browser horizonos.permission.HEADSET_CAMERA
adb shell pm grant com.oculus.browser android.permission.CAMERA
```

`curl 127.0.0.1:8790/health` should answer `{"ok":true,"model":"jev-1.14.0+edgetam",...}`;
`+sam2.1-small` means EdgeTAM didn't load (the log says why). `./run.sh --fake-jev` runs without
a key and without cost, with every object at one fixed box.

## Run

```sh
./run.sh                  # 127.0.0.1:8790, real jev (each request costs one jev call)
./run.sh --fake-jev       # every object present at the box 0.3,0.3,0.7,0.7; no key, no cost
./run.sh --fake-jev 0.2,0.1,0.6,0.9 --port 8791
```

| Setting                      | Default                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| `--port` / `JEV_FINDER_PORT` | 8790, which the Clio server expects                            |
| `--device`                   | `auto` (cuda, then mps, then cpu)                              |
| `--segmenter`                | `auto`: EdgeTAM, or `sam2.1-small` if EdgeTAM can't load       |
| `--track`                    | `memory`: EdgeTAM's video memory on /track; `box`: prev. box   |
| `--jev-timeout`              | 12 s for the whole jev call. Clio gives up on the finder at 15 |
| `JEV_FINDER_MODELS`          | `models/` here, where `setup_models` puts them                 |
| `JEV_FINDER_PYTHON`          | `.venv/bin/python` here (run.sh)                               |
| `JEV_MODEL`, `JEV_ENDPOINT`  | `jev-1.14.0`, TypeSafe's systemone URL                         |

The key is `TYPESAFE_API_KEY`, from `.env` here (gitignored; copy `.env.example`) or from the
environment, which wins. It stays in this process and is never logged.
The service listens on 127.0.0.1 only and answers only requests addressed to a local host name.

`GET /health` returns `{ok, model, device}`; `model` is `jev-1.14.0+edgetam` (or `+sam2.1-small`). Each `/locate` answer carries a `Server-Timing`
header with the stages below, and the log has one line per request with the same numbers and
jev's token counts.

## What a request does

1. **Fit the frame.** The image is decoded (JPEG, PNG or WebP), EXIF-rotated, and shrunk to fit
   1568 px. A short side under 280 px is padded, as the Jev fun benchmark did, because
   jev rejects sides outside 256 to 1568 px. jev gets JPEG; a Quest frame that already fits is
   sent unchanged. Boxes are mapped back from the padded frame.
2. **Ask jev once.** One request for all objects, with a Noul `present_<id>` and a Box
   `target_<id>` question per object, the model pinned and the image header set, as the Jev fun
   benchmark's jev client did. The phrase fills the benchmark's templates, so the Noul question
   is exactly the benchmarked one, and the query (the standalone description) is added to the
   Box question as context. Without a phrase, both questions quote the query as a
   description instead of treating it as a noun. A query with no words is refused with 422.
3. **Gate.** An object is found when Noul is at least 0.5 and its box passes `valid_box`
   (`bench.py`, from the benchmark). Invalid boxes are dropped, never repaired. `confidence` is
   the Noul value, also for objects not found.
4. **Never retry, never overlap.** A jev error, timeout or malformed answer fails the request
   (502, or 504 on timeout) and says no retry was sent: a request that timed out may still be
   billed. The timeout caps the whole call (connecting and sending get 3 s each within it), so
   the finder answers before Clio's 15 s. One request is answered at a time: another that
   arrives meanwhile, or while a timed-out jev call is still running, gets 503 and no jev call.
   Clio asks again on its next refresh.
5. **Segment.** SAM encodes the frame once, while jev is still answering, then decodes every
   found box in one call and keeps the candidate mask with the highest predicted IoU. /locate and
   /track share the model and never run it at the same time; a tracking frame waits for an
   encode and the other way around. The box
   is not padded: in the Jev fun benchmark padding hurt more objects than it helped.
6. **Outline.** The mask's largest 8-connected piece is traced along pixel edges (scipy and
   numpy, no OpenCV), simplified with Douglas-Peucker to at most 64 points and normalized to
   0..1. `box` is the outline's bounds; `point` is the deepest interior pixel by distance
   transform, ignoring specks but not real holes. If SAM's mask is empty, jev's box is sent
   without an outline and Clio draws corner brackets.

`model` is `jev-1.14.0+edgetam`, or `jev-1.14.0+sam2.1-small` when EdgeTAM couldn't load.

## Tracking (`/track`)

[TRACK.md](TRACK.md) has the messages and rules. Each connection gets its own tracker
(`tracker.py`); `stream.py` reads messages as they come and segments only the newest frame.
EdgeTAM follows the object with its video memory (`edgetam.py`, `MemoryTrack`), under bfloat16
autocast; SAM 2.1 Small prompts each frame with the previous mask's padded box and deepest point
(`BoxChain`). Masks are traced at 320 px wide.

## Measured on an M-series laptop

Tracking, 300 640x480 JPEG frames (six Jev fun photos, 50 frames each, panned like a moving head;
a target every 25 frames from the benchmark's reference box), M5 Pro:

| Tracker                  | Per frame (median) | Frames/s | Box IoU vs reference | RSS over 300 frames |
| ------------------------ | ------------------ | -------- | -------------------- | ------------------- |
| EdgeTAM memory (default) | 74 ms              | 15       | 0.90                 | 742 to 743 MB       |
| EdgeTAM, previous box    | 52 ms              | 19       | 0.64                 | 721 to 726 MB       |
| SAM 2.1 Small, prev. box | 208 ms             | 5        | 0.67 (two photos)    | 586 MB, flat        |

Over the real WebSocket with the page's backpressure (next frame after each answer), EdgeTAM
memory ran at 11.8 frames/s (88 ms round trip), and the service's RSS stayed at 813 MB. With the
previous box alone, masks drift onto neighbors within a second on the harder photos (glassware,
tubes, PCB); the memory keeps them. EdgeTAM in fp32 takes 100 to 120 ms a frame; bfloat16 halves
the memory attention with the same masks. EdgeTAM still loses the test tubes after 5 frames.

/locate with EdgeTAM: encode 27 ms, decode 10 to 18 ms for 1 to 3 boxes at 960x638.

With SAM 2.1 Small (before EdgeTAM): startup loads SAM in 3 to 4 s and warms up MPS in under
1 s. The process starts at about 575 MB RSS (2.6 GB physical footprint, most of it the model on
the GPU) and levels off near 650 MB RSS and 2.8 GB footprint. Over 40 identical requests after that, RSS grew 4 MB and footprint 5 MB.

| Stage   | Median per request                                    |
| ------- | ----------------------------------------------------- |
| decode  | 4 to 8 ms                                             |
| jev     | 105 to 260 ms in October 2026; 3.9 s in the benchmark |
| encode  | 140 to 270 ms (SAM image encoder, overlaps jev)       |
| segment | 10 to 20 ms for 1 to 3 boxes                          |
| outline | 15 to 40 ms per object                                |

Five real jev calls on four photos (three calls with three objects, two with one) found all 7 present
objects, rejected the 3 absent ones (Noul 0.03 to 0.06), and gave boxes with IoU 0.82 to 0.98
against the benchmark's reference boxes. A small diode on an unseen photo scored Noul 0.47 and
was not found: the 0.5 gate is close for small parts. Those calls used benchmark-style noun
phrases; the gate has not yet been re-measured on primary-route picks (Gemini's 2 to 4 word
name as the phrase, its sentence-long description as Box context).

## Tests

```sh
uv run pytest
```

The tests never reach the network: jev is faked behind an `httpx` mock transport, real HTTP
transports are disabled, and SAM is replaced by an ellipse inscribed in each box. They cover the
jev request, the Noul gate, invalid boxes, no retries, the size rules, contour tracing and
simplification on synthetic masks, and the HTTP contract as Clio's server parses it. For /track:
message parsing, the matching rule, tracking a moving shape, losing it, stale-frame dropping, the
shared-model lock, and the WebSocket protocol through uvicorn on a real socket.
