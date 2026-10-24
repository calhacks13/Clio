# Clio tracker

Real-time object tracking for Clio's object finder. It replaces the jev + SAM 2.1 service on
`:8790`: **jev** decides which object the words mean, about once a second; the vision half of
**YOLOE-26** follows that object on every frame in between. On an M5 a frame takes 31 ms with
YOLOE-26L on the Neural Engine (15 ms with YOLOE-26s), plus about 2 ms per tracked object.

```
headset ─ frame every ~50 ms ─▶ Clio server ─▶ tracker  /locate ─▶ YOLOE-26 vision graph (1 pass)
        ◀─ outline, point, box ─             ◀─ from tracking state      │ ByteTrack per object
                                                       └── ~1/s, in the background ──▶ jev (Box + Noul)
```

It speaks Clio's object-finder contract ([docs/object-finder.md](../docs/object-finder.md)), so
Clio needs no new route: point `CLIO_VISION_URL` (lesson outlines) and/or
`CLIO_PRIMARY_FINDER_URL` (the primary-object demo, already the default) at it.

## Run it

```bash
cd tracker
uv sync --all-extras          # Python 3.12, Ultralytics, PyTorch, FastAPI; coremltools on a Mac
uv run clio-tracker           # serves http://127.0.0.1:8790/locate
```

It reads the repo's `.env`. Set one way to name targets:

| Setting                                  | Names the target with                                                                                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TYPESAFE_API_KEY`                       | jev (`jev-1.14.0`, Box + Noul questions). The key stays on the laptop.                                                                                         |
| `CLIO_TRACKER_IDENTIFIER_URL`            | any finder that speaks Clio's contract, e.g. Gemini through Clio's own `http://127.0.0.1:8787/api/vision/locate`. Only while Clio's `CLIO_VISION_URL` is unset: otherwise Clio would send the request straight back here. |

Then in `.env`, `CLIO_VISION_URL=http://127.0.0.1:8790/locate`, and restart `pnpm dev`. The
headset needs no flag: the tracker answers with `refreshMs: 50` and Spotlight sends the next frame
that soon (`?showRefresh=0` still turns refreshing off).

The first run downloads `yoloe-26l-seg.pt` (79 MB) into `tracker/models/` and exports the Core ML
graph there (about a minute, once; `uv run clio-tracker export` does it ahead of time).

| Setting                               | Default         |                                                                                |
| ------------------------------------- | --------------- | ------------------------------------------------------------------------------ |
| `CLIO_TRACKER_MODEL`                  | `yoloe-26l-seg` | any `yoloe-26{n,s,m,l,x}-seg` checkpoint (not `-pf`: those have no SAVPE)      |
| `CLIO_TRACKER_BACKEND`                | `auto`          | `coreml` (Apple Neural Engine), `torch` (MPS, CUDA or CPU)                     |
| `CLIO_TRACKER_IDENTIFY_INTERVAL_MS`   | `1000`          | how often jev looks again at each object                                       |
| `CLIO_TRACKER_IDENTIFY_MAX_IN_FLIGHT` | `2`             | jev takes 2 to 6 s, so calls overlap; this caps paid calls in flight           |
| `CLIO_TRACKER_REFRESH_MS`             | `50`            | the `refreshMs` hint sent to the headset                                       |
| `CLIO_TRACKER_PORT`, `_HOST`          | `8790`, local   |                                                                                |

`uv run clio-tracker bench` times the graph and the per-object work on this machine.

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

**ByteTrack keeps identity; jev picks it.** Each requested object has its own ByteTrack over the
candidates its prompt scores: a track starts at 0.45 and confirms on its second sighting, and an
existing track continues on candidates down to 0.10. One track is the target. When jev answers
(about a frame several seconds old), its box is matched to the track that was there on that
frame, so a late answer still lands on the right object, or moves the target if it had drifted
to a look-alike.

**The appearance keeps up between answers.** Each confident sighting's own visual prompt is
blended into a running appearance (15% a frame), but only while it still resembles jev's view
(cosine ≥ 0.8) and is not cut off by the frame edge, so turning the object is learned and a hand
covering it is not. The prompt is half jev's view and half the running one.

**Losing and finding it again.** A lost target coasts on its predicted box for 0.35 s (1 s when it
left by an edge or filled the view), then reads as not found; its track lives 1 s more. A target
with no track is re-acquired by appearance: YOLOE's visual prompts tell instances of one kind
apart (on `bus.jpg`, two different people at 0.77 to 0.86 cosine, one person across views at
0.95 to 0.97), so a look-alike that scores well is not taken. When the target stops looking like
itself for three frames, jev is asked early.

**Outlines replace SAM's masks.** The target's mask is its coefficients times the prototypes,
cut to its box; Clio gets the largest piece's contour (at most 64 points) and the point deepest
inside it, which is where Clio lifts the object into 3D.

## Measured

On an M5 (24 GB), a simulated camera panning and zooming across `bus.jpg` at 15 fps for 6 s,
through Clio's server, with Gemini standing in for jev:

| Measure                        | Value                                                    |
| ------------------------------ | -------------------------------------------------------- |
| Round trip, Clio → tracker     | 36 ms p50, 40 ms p95 (YOLOE-26L, Core ML)                |
| First outline                  | 1.2 s: the first identifier answer                       |
| Frames found after that        | 72 of 72, IoU with the described person 0.95 to 0.96     |
| Frames on another person       | 0 (the scene has four)                                   |

`tests/test_end_to_end.py` runs the same pan with jev answering only once and failing after:
the person is kept on every frame. Nothing here has run on a Quest yet, and jev itself has not
been called from this tracker (no key on this machine); its request format follows TypeSafe's
docs and is tested against a fake transport.

## Tests

```bash
uv run pytest -q                 # all; the "model" ones load real YOLOE-26 weights
uv run pytest -q -m "not model"  # logic only: synthetic scenes, fake jev, no network
uv run ruff check src tests
```

Ultralytics is AGPL-3.0.
