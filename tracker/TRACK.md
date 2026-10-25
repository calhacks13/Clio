# Live tracking stream (`/track`)

The primary-object demo page (`apps/headset/primary.html`) streams camera frames to the tracker,
which follows the current target on every frame as fast as YOLOE runs on the Mac. Gemini and jev
still run about once a second (`POST /api/vision/primary` on the Clio server, which calls this
service's `/locate`) to decide _what_ the target is; the page sends their box to the tracker,
which matches it against the object it is already following.

A lesson uses [objects mode](#objects-mode) instead: it names its objects in words (the focused
step's first), and the tracker asks jev about them itself and follows all of them on every frame.
Gemini Robotics-ER 2's boxes for them, sent as anchors ([below](#objects-mode)), outrank jev's.

Endpoint: WebSocket `ws://127.0.0.1:8790/track`. The headset reaches it through Vite's proxy at
`ws://localhost:5173/track` (USB `adb reverse tcp:5173`). A connection whose `Origin` (or `Host`)
isn't a local host name is refused, so only pages served from localhost can open it.

The target-mode messages are the jev finder's (EdgeTAM), which this service replaced, plus a
`track` field in each mask. A connection is in target mode until it sends `objects`.

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
- `part` (optional, default `false`): the box is one part of the main object (`?focus=part`: a
  label, a button, a wheel), not all of it. See [Following a part](#following-a-part). Pages that
  never send it keep working.

```json
{ "type": "target", "seq": 52, "box": [0.4, 0.45, 0.52, 0.5], "name": "vernier scale of caliper", "part": true }
```
- `{ "type": "clear" }` drops the target.

**Backpressure:** the page sends the next frame only after the result for the previous one arrives
(or 500 ms pass), so the stream runs exactly as fast as the Mac answers. If frames arrive faster
than that, a frame waiting to be tracked is replaced by the newer one and gets no answer: only
the newest frame is ever tracked. Targets, objects, anchors and `clear` apply in order before
the next frame.

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
- `track`: ByteTrack's id for the track the target is on, null when not found. It changes when
  the target moves to another track (jev's next box was on another object, or ByteTrack split
  it).
- `ms`: time spent in the tracker per stage, in milliseconds. `segment` is the YOLOE pass and
  the tracking step.
- `found: false` with null geometry, score, name and track when there is no target or it isn't
  in view.

## Matching jev to the tracked object

The tracker keeps the last 300 frames it was sent. When a target arrives, it runs YOLOE on the
very frame jev measured, so jev's box becomes the object's visual prompt as jev saw it, and
compares the box with the tracks on that frame: a track it overlaps by IoU 0.3 or more, or one
of the two inside the other (a part and its whole), is the target (the same one: kept; another
one: the target moves to it). When no track was there, jev's box is carried to the newest frame
by the camera's motion since (the tracker measures it on every frame it is sent, also before the
first target), and the candidate filling it becomes the target on the next frame. A target whose
frame was never sent applies to the next frame, as if measured on it. A target with another
`name` starts over.

A box with no `part` flag that would land on something it is only a part of (it covers less than
half of that track's or candidate's box and lies at least 80% inside it, and is not cut by the
frame's edge, as an object partly out of view is) is followed as a part too; a later box that is the whole object again goes back to following the object, on the track
that held the part.

## Following a part

Followed like an object, a part ends up as its whole: YOLOE proposes whole objects far more
often than their parts (a micrometer's thimble has no candidate of its own), and the part's
visual prompt resembles its whole's, so the part's box was placed on, confirmed as or
re-acquired as the whole object's track, whose mask came back. A part target is never matched
to a track (`part.py`):

- The object holding the part is followed as an object of its own, the **parent**: on jev's
  frame, the smallest candidate holding the part box that scores at least 0.4 against its own
  view (an object's own box scores 0.9 or more, a box over pieces of several things next to
  nothing). That is the part itself when YOLOE proposes it (a name plate, a vernier scale),
  else what holds it (the micrometer for its thimble).
- The camera's motion carries the part box, and the parent's own motion on top, as far as the
  sides of its box agree (YOLOE's box for an object also changes extent, taking in a neighbor
  or cut by the frame edge): per axis the smaller shift of its two sides when they agree, and a
  scale when the parent, wholly in view, grows alike in width and height. While the parent
  coasts or none is in sight, the camera alone carries it (`state: "coasting"`, for up to 6 s
  after jev's last answer or the parent's last sighting).
- Without a segmenter, `outline` is the parent's mask inside the part box, so it follows the
  object's edges where the part meets them; when that mask hardly covers the part box, the part
  box as a rounded rectangle. `point` and `contact` are the part's. `box` is the part box.
- Each new answer re-seeds the part box where jev put it; it is never snapped to the parent.

With a segmenter (the default, `--segmenter`, [README.md](README.md#how-it-works)), the part's
outline is SAM 2.1's mask of it, carried to every frame by the part's own pixels, also where the
parent's motion would never take it (a jaw sliding along its caliper). A part on its own pixels
reports `tracking` (it is measured, not predicted), at the parent's score while the parent is in
sight, else 0.5. The mask cut from jev's next box puts the part box where jev says, even over a
follower sure of another place. The mask message is unchanged.

## Between jev's answers

Each frame is one pass through YOLOE-26 and one ByteTrack step over the candidates the target's
prompt scores ([README.md](README.md#how-it-works)), with every track moved by the camera's
motion first. The prompt keeps learning the object's look from confident sightings that still
resemble jev's view. A target ByteTrack misses continues on a weaker candidate on its predicted
box; otherwise it coasts at its predicted box for 0.5 s (1 s when it was at the frame's edge or
filled it), then reads as lost, and at once when the prediction leaves the view. Its track
survives 3 s, so after a glance away it comes back as the same object; a target with no track is
found again by appearance, not by whichever look-alike scores highest. With a segmenter (the
default), SAM 2.1's latest mask for the target is carried from frame to frame by the motion of
points inside it (`follow.py`), or by the camera's motion alone for an object too plain to
follow, and the segmenter is asked to cut the object out again after two frames of doubt.

The `box`, `outline`, `point` and `contact` sent back are steadied over frames in the scene's
frame of reference (`smooth.py`): the camera's motion is followed exactly, the object's own
motion with a lag of a few pixels, and a one-frame glitch in the mask does not show.

## Objects mode

A lesson follows several objects at once and knows them by their words, not by a box: the
phrase and description the plan gives each of its objects (a step's show items first, then the
rest of the plan, for the recording). In objects mode the tracker asks
jev itself, as `POST /locate` with a session does ([README.md](README.md#how-it-works)): jev
places the objects in one background call at most every 0.15 s
(`CLIO_TRACKER_IDENTIFY_INTERVAL_MS`), with every object that is due, and never more than one
call at a time. An object that moves on its own, coasts, is lost, new or in doubt is due on
every call; one held steadily and still on screen (tracked on every frame for 0.5 s, slower than
one box size a second across the picture, its own motion and the camera's together, so turning
the head counts too) only once a second
(`CLIO_TRACKER_IDENTIFY_STEADY_MS`). An object jev has just said is out of view waits the
second too, not the next call, until its words change. A failed call is not retried: jev is next asked after the interval,
then twice as long after each further failure, up to 16 s, and the first answer brings back the
usual pace. YOLOE-26 and ByteTrack follow every object on every frame, with one YOLOE pass for
all of them. Each connection in objects mode has a tracking session of its own.

The connection switches to objects mode on its first `objects` message and back to target mode
on a `target`; either way, what the other mode followed is dropped. Frames, backpressure and
`ready` are the same in both modes. What objects mode answers is for the learner's AR view and
the recording only, never for a Gemini coach ([the perception
boundary](../docs/coach-plan.md#the-perception-boundary)).

**Objects** (text, JSON): the set to follow from now on.

```json
{
  "type": "objects",
  "objects": [
    {
      "id": "cup_a",
      "phrase": "clear plastic cup",
      "query": "A clear plastic cup on the left, half full of pink liquid, beside two other cups"
    }
  ]
}
```

- `id`: the lesson's object id. `phrase`: a short noun phrase for its kind (2 to 5 words), jev's
  subject; without one, jev is given the `query` alone. `query`: the words that tell this one
  apart (where it is, what is next to it). jev is asked whether the one the query describes is
  in view ("Is the clear plastic cup described below visible…"), not whether any of its kind is,
  and is given the query to box it among look-alikes.
- Send the whole set whenever it changes. An object left out is dropped at once, along with any
  jev answer about it still on the way. A new `phrase` for an id starts its track over, as
  another object; a new `query` only changes what jev is told next, and the track goes on. So
  keep an object's phrase the same from step to step and put each step's wording in its query.
- At most 8 objects: the rest of a longer list is ignored. An id sent twice keeps its first
  words. A message whose objects aren't a list of `{id, phrase, query}` (an id of 1 to 200
  characters, a query with words) is logged and skipped, and the set stays as it was.
- `"objects": []` stops tracking and every jev call. Frames are still answered, with no
  detections. `{ "type": "clear" }` does the same and stays in objects mode.

```json
{ "type": "objects", "objects": [] }
```

**Anchor** (text, JSON): where Gemini Robotics-ER 2 boxed one object of the set, on a frame the
page captured.

```json
{
  "type": "anchor",
  "id": "cup_a",
  "t": 123456.7,
  "box": [0.31, 0.42, 0.58, 0.77],
  "source": "er",
  "query": "clear plastic cup on the left, half full of pink liquid"
}
```

- `id`: an object of the current set. `box`: `[left, top, right, bottom]`, normalized 0..1, on
  the frame captured at `t` (the page's `performance.now()` clock, like a frame's `t`). That frame
  need not be one the page streamed. `source`: who boxed it; `"er"` is the only one for now, and
  the default. `query` (optional): what jev is told about the object from now on, as a new
  `query` in `objects` would be. The phrase stays, so the track goes on.
- The tracker places the object from the box as it places it from a jev answer, on the next
  frame. The box is on the streamed frame whose `t` is nearest, if within 120 ms: it is matched to
  the track there, or carried to now by the camera's motion when no track was there. Otherwise it
  is carried from the nearest streamed frame to the next one by the camera's motion since. With
  no frame streamed before, or the next frame the nearest, it is applied to the next frame as if
  measured on it. The tracker keeps the last 300 streamed frames (20 s at 15 frames a second) for
  this. An object jev hasn't placed yet (`unknown`) is placed on the next frame.
- With a segmenter, the box is cut out of the frame it was placed on, as jev's boxes are.
- **An anchor outranks jev.** It is never stale: it applies even when jev has answered about a
  newer frame. For 6 s after it, a jev answer about the object that disagrees is ignored: one
  that says the object is not in view, and one whose box is elsewhere. jev's box agrees when it
  is on the object's track on jev's frame (IoU 0.3, or one box inside the other), or, when the
  track was not there yet, on where the object is now. A jev answer that agrees changes nothing
  either: the anchor's box and its cut stay, since jev's box takes in neighbors (a row of three
  chargers for one, on a Quest lesson). After 6 s jev's answers apply as before.
- An anchor for an id outside the set, an anchor in target mode, and a malformed one are logged
  and skipped; the connection stays open.

**Detections** (one per frame, text, JSON):

```json
{
  "type": "detections",
  "seq": 41,
  "t": 123456.7,
  "model": "yoloe-26l-seg",
  "ms": { "decode": 2, "track": 30, "total": 37 },
  "detections": [
    {
      "id": "cup_a",
      "found": true,
      "state": "tracking",
      "box": [0.31, 0.42, 0.58, 0.77],
      "outline": [[0.41, 0.52], [0.47, 0.5], [0.49, 0.58]],
      "point": [0.45, 0.6],
      "contact": [0.44, 0.76],
      "score": 0.91,
      "track": 3,
      "source": "er"
    }
  ]
}
```

- One entry per object of the set, in its order. `box`, `outline` (at most 64 points), `point`,
  `contact`, `score` and `track` are as in the mask message. Each object has a ByteTrack of its
  own, so `track` tells one object's tracks apart, not one object from another: two objects can
  both be on track 1.
- `state`: `tracking`; `coasting` (not seen on this frame, drawn where it is predicted to be);
  `lost` (not in view, also when jev says so); `unknown` (jev hasn't placed it yet).
- `found: false` with null `box`, `outline`, `point`, `contact`, `score` and `track`.
- `source`: the finder that last placed the object: `"jev"`, `"er"` (an anchor), or
  null before any. It stays while the object is lost. Pages that ignore it keep working.
- `ms`: `decode` is the JPEG, `track` the YOLOE pass, every object's tracking step, and jev's
  answers and anchors applied (an anchor on an earlier frame costs a YOLOE pass on that frame).
  With an empty set there is only `total`:

```json
{ "type": "detections", "seq": 42, "t": 123523.4, "model": "yoloe-26l-seg", "ms": { "total": 0.1 }, "detections": [] }
```

jev is sent the streamed JPEG, so it sees what the tracker sees: small objects need a larger
frame. There is no part mode here: each object is followed as a whole object, and a phrase
naming a part of one is followed as whatever YOLOE proposes there.
