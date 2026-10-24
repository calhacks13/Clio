# Live tracking stream (`/track`)

The demo page streams camera frames to the jev finder service, which segments the current target
on every frame as fast as SAM runs on the Mac. Gemini and jev still run about once a second
(`POST /api/vision/primary` on the Clio server) to decide _what_ the target is; their box is sent
to the tracker, which matches it against the object it is already tracking.

Endpoint: WebSocket `ws://127.0.0.1:8790/track`. The headset reaches it through Vite's proxy at
`ws://localhost:5173/track` (USB `adb reverse tcp:5173`). A connection whose `Origin` (or `Host`)
isn't a local host name is refused, so only pages served from localhost can open it.

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
than that, a frame waiting to be segmented is replaced by the newer one and gets no answer: only
the newest frame is ever segmented. Targets and `clear` apply in order before the next frame.

A message that doesn't follow this (bad header, not JSON, unknown type) is logged and skipped
without an answer; the connection stays open.

## Tracker to headset

**Ready** (once, on connect): `{ "type": "ready", "model": "edgetam" }`. `model` is `edgetam`, or
`sam2.1-small` when EdgeTAM couldn't load (about 5 frames/s instead of 12 to 15).

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
  "ms": { "decode": 1, "segment": 70, "outline": 3, "total": 75 },
  "model": "edgetam"
}
```

- `outline`: one closed polygon, at most 64 points, normalized like the finder's (docs/object-finder.md).
- `point`: the point deepest inside the mask. `contact`: the middle of the mask's lowest edge, where
  the object most likely rests on a surface (used to measure its distance).
- `score`: with EdgeTAM, its confidence (0..1) that the object is visible; with SAM 2.1 Small,
  SAM's predicted IoU of the mask. `ms`: time spent in the tracker per stage, in milliseconds
  (`decode`, `segment` and `outline` only when a frame was segmented).
- `found: false` with null geometry, score and name when there is no target or the object was lost.

## Matching jev to the tracked object

When a target arrives, the tracker compares its box with the box of the mask it is tracking on the
nearest frame. IoU of 0.3 or more: same object, so it keeps tracking and re-seeds from jev's box
(which corrects drift). Below 0.3: a different object, so it switches to jev's box.

jev's box is about a second old by the time it arrives, so a re-seed uses it moved and scaled the
way the tracked box has moved since the frame jev measured. If the tracker can't follow the object
into that box (the track had drifted onto something else), it starts over from the box instead.

## Between jev's answers

With EdgeTAM, each frame attends to EdgeTAM's memory of the last few frames and of jev's latest
boxes (its video tracking, fed live). With SAM 2.1 Small, each frame is prompted with the previous
mask's box padded by 10% and the point deepest inside it.

The object is lost, and `found: false` is sent until the next target, when the mask is empty
(EdgeTAM says the object isn't visible), shrinks below a quarter or grows past four times the
previous frame's area, or its box overlaps the previous box by less than 0.2 IoU. On a re-seeded
frame, most of the mask's box must lie inside jev's box instead.
