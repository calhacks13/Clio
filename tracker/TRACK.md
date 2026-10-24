# Live tracking stream (`/track`)

The primary-object demo page (`apps/headset/primary.html`) streams camera frames to the tracker,
which follows the current target on every frame as fast as YOLOE runs on the Mac. Gemini and jev
still run about once a second (`POST /api/vision/primary` on the Clio server, which calls this
service's `/locate`) to decide _what_ the target is; the page sends their box to the tracker,
which matches it against the object it is already following.

Endpoint: WebSocket `ws://127.0.0.1:8790/track`. The headset reaches it through Vite's proxy at
`ws://localhost:5173/track` (USB `adb reverse tcp:5173`). A connection whose `Origin` (or `Host`)
isn't a local host name is refused, so only pages served from localhost can open it.

The messages are unchanged from the jev finder (EdgeTAM), which this service replaced.

## Headset to tracker

**Frame** (binary message): a 4-byte big-endian header length, the UTF-8 JSON header, then the
JPEG bytes.

```json
{ "type": "frame", "seq": 41, "t": 123456.7, "width": 640, "height": 480 }
```

- `seq` increases by one per frame. `t` is the capture time on the page's `performance.now()`
  clock; the tracker echoes it back untouched so the page can use the head pose at capture time.

**Target** (text message, JSON): the main object Gemini named and jev boxed.

```json
{ "type": "target", "seq": 37, "box": [0.31, 0.42, 0.58, 0.77], "name": "silver metal caliper" }
```

- `seq` is the frame the box was measured on; `box` is `[left, top, right, bottom]`, normalized
  0..1, origin top left.
- `{ "type": "clear" }` drops the target.

**Backpressure:** the page sends the next frame only after the result for the previous one arrives
(or 500 ms pass), so the stream runs exactly as fast as the Mac answers. If frames arrive faster
than that, a frame waiting to be tracked is replaced by the newer one and gets no answer: only
the newest frame is ever tracked. Targets and `clear` apply in order before the next frame.

A message that doesn't follow this (bad header, not JSON, unknown type) is logged and skipped
without an answer; the connection stays open.

## Tracker to headset

**Ready** (once, on connect): `{ "type": "ready", "model": "yoloe-26l-seg" }`.

**Mask** (one per frame, text, JSON):

```json
{
  "type": "mask",
  "seq": 41,
  "t": 123456.7,
  "found": true,
  "name": "silver metal caliper",
  "outline": [[0.41, 0.52], [0.47, 0.5], [0.49, 0.58]],
  "box": [0.31, 0.42, 0.58, 0.77],
  "point": [0.45, 0.6],
  "contact": [0.44, 0.76],
  "score": 0.93,
  "state": "tracking",
  "ms": { "decode": 2, "segment": 34, "total": 37 },
  "model": "yoloe-26l-seg"
}
```

- `outline`: one closed polygon, at most 64 points, normalized like the finder's (docs/object-finder.md).
- `point`: the point deepest inside the mask. `contact`: the middle of the mask's lowest edge, where
  the object most likely rests on a surface (used to measure its distance).
- `score`: how sure the tracker is that this is the target: YOLOE's score for it, at least 0.5
  while jev placed it (0.35 when it was found again by appearance), falling while it coasts.
- `state`: `tracking`; `coasting` (not seen on this frame, drawn where it is predicted to be);
  `lost`; `unknown` (a target whose frame hasn't come in yet); `idle` (no target).
- `ms`: time spent in the tracker per stage, in milliseconds. `segment` is the YOLOE pass and
  the tracking step.
- `found: false` with null geometry, score and name when there is no target or it isn't in view.

## Matching jev to the tracked object

The tracker keeps the last 300 frames it was sent. When a target arrives, it runs YOLOE on the
very frame jev measured, so jev's box becomes the object's visual prompt as jev saw it, and
compares the box with the tracks on that frame: a track it overlaps by IoU 0.3 or more is the
target (the same one: kept; another one: the target moves to it). When no track was there, the
target is the track that turns up near jev's box and looks most like it. A target whose frame
was never sent applies to the next frame, as if measured on it. A target with another `name`
starts over.

## Between jev's answers

Each frame is one pass through YOLOE-26 and one ByteTrack step over the candidates the target's
prompt scores ([README.md](README.md#how-it-works)). The prompt keeps learning the object's look
from confident sightings that still resemble jev's view. A target not seen on a frame coasts at
its predicted box for 0.35 s (1 s when it left by the frame's edge or filled it), then reads as
lost; its track survives 1 s more, and a lost target is found again by appearance, not by
whichever look-alike scores highest.
