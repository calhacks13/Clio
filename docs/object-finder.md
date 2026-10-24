# Object finder contract

Every lesson step says what Clio should **show** the learner (see
[procedures.md](procedures.md#show-what-a-step-outlines)). The planner writes, for each item, a
short noun phrase and a standalone visual description. When the step starts, Clio sends one
passthrough camera frame and those texts to an **object finder**, lifts what it returns into 3D,
and outlines it in AR.

Gemini is the built-in finder (points and boxes, so Clio draws corner brackets). Any other finder
(jev, the [tracker](../tracker/README.md), a SAM 3 or Grounding DINO server, a VLM) plugs in over
HTTP: set `CLIO_VISION_URL` and the server sends it every locate request instead. A finder that
returns outlines gets real contours.

```
headset ── POST /api/vision/locate ──▶ Clio server ── POST $CLIO_VISION_URL ──▶ object finder
        ◀──────── LocateResponse ─────            ◀──── { detections, model } ──
```

The headset never talks to the finder directly. The server keeps the URL and token, checks and
bounds the answer, and reports which model answered. The headset lifts the 2D answer into 3D
using the head pose at capture time.

## Request

`POST $CLIO_VISION_URL` with `Content-Type: application/json`, plus
`Authorization: Bearer $CLIO_VISION_TOKEN` when the token is set:

```json
{
  "image": { "mimeType": "image/jpeg", "data": "<base64, no data: prefix>" },
  "objects": [
    {
      "id": "washer_cap",
      "phrase": "blue washer fluid cap",
      "query": "Round blue plastic cap with a windshield-spray symbol, at the front left of the engine bay, next to a yellow coolant cap"
    }
  ],
  "session": "6f1c2b0e-..."
}
```

| Field    | Meaning                                                                                                                                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`     | Echo it back in the detection.                                                                                                                                                                                                                            |
| `phrase` | 2 to 5 words, for detectors and segmenters that take category prompts (SAM 3, Grounding DINO, OWLv2, YOLO-World). It can be absent.                                                                                                                       |
| `query`  | A referring expression that stands on its own, for models that take free text (VLMs, referring segmentation). Always present. It says what the object is, its color, shape, size, markings and where it is now, and what tells it apart from look-alikes. |

`session` names one run of the headset app (the same value for every frame of the run). A
finder that keeps state between frames, such as the tracker, keeps it per session; others can
ignore it.

A request asks for 1 to 16 objects. The image is a Quest 3 passthrough camera frame, a JPEG of
about 1280×960.

The planner writes `phrase` and the description (sent as `query`) for each step's `show` items.
For other lookups (a step's missing targets, or a coach highlight), `query` is the object's
`tracking.query` or label, and `phrase` is its label.

An attached component is a target in its own right: for example, "vernier scale on the sliding
jaw" rather than "caliper". The lesson gives it its own object id with `kind: "item"`, and the
step's `show` describes only that part. `"tool"` and `"container"` are for the whole object: their
glow spills around it, while an `item` keeps a soft surface light on its contour. So the finder
should return the part's own contour. The mask of the object holding it lights up too much and is
not a substitute. The tracker's part mode works this way (a target with `"part": true`, see
[Following a part](../tracker/TRACK.md#following-a-part)), but lessons don't flag parts yet. A
finder with no part contour can send the part's box alone, and Clio draws corner brackets around
it.

## Response

`200` with JSON:

```json
{
  "model": "jev",
  "detections": [
    {
      "id": "washer_cap",
      "found": true,
      "outline": [[0.41, 0.52], [0.47, 0.5], [0.49, 0.58], [0.42, 0.6]],
      "box": [0.41, 0.5, 0.49, 0.6],
      "point": [0.45, 0.55],
      "confidence": 0.87
    }
  ]
}
```

All coordinates are **normalized to 0..1 of the image**: x to the right, y down, origin at the
top left. Values slightly outside 0..1 are clamped. Pixel coordinates fail the request with a
message saying so.

Only `id` is required. Clio fills in the rest:

| Field        | When it is missing                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `outline`    | No contour. Clio draws corner brackets around `box`.                                                                                      |
| `box`        | The bounds of `outline`.                                                                                                                  |
| `point`      | The center of `box`. This is the point Clio lifts into 3D, so send a better one if you have it (e.g. the mask's pole of inaccessibility). |
| `found`      | `true` when there is a point, box or outline.                                                                                             |
| `confidence` | 0.5. Clio ignores detections below 0.3.                                                                                                   |
| `model`      | `"http"`. It is recorded as each detection's `source`.                                                                                    |
| `refreshMs`  | Clio asks again on its own schedule (below). A finder that is cheap per frame sends how soon it wants the next one.                       |
- `outline` is one closed polygon: the outer contour of the object. Don't repeat the first point
  at the end. Clio simplifies it to at most 64 points. For a mask, take the largest external
  contour (OpenCV: `findContours(mask, RETR_EXTERNAL, CHAIN_APPROX_SIMPLE)`), then divide x by
  the width and y by the height.
- Several detections for one id are fine, since segmenters return every instance of a phrase.
  Clio keeps the found one with the highest confidence.
- An id missing from the answer counts as not found.
- A non-2xx status, invalid JSON, or no answer within 15 s fails the locate call with a message
  naming the problem. The headset tries again on its next refresh.

## When Clio asks

When a step starts, Clio sends one request for the step's `show` items and any targets it has not
found yet. It also asks once to place what is still missing when a lesson starts, after the
learner puts an object down, and when the coach highlights an object that has no position yet.
It never sends a second request while one is in flight.

While the step runs, the show items are followed one of two ways:
- **Live, with the tracker** (the default whenever the tracker answers on `/track`). The headset
  streams its camera frames (480 px, as fast as the Mac answers) to the tracker's WebSocket
  ([tracker/TRACK.md](../tracker/TRACK.md), objects mode) and tells it what to follow, in words:
  every object the plan declares, from the moment the lesson starts until it ends, so the
  recording has each one wherever the learner takes it. The focused step's show items come first,
  in rank order, then, for 5 s, whatever the coach highlights (a closer look's highlights
  included), then the plan's other objects in its order, as far as the 8 slots allow; hidden
  zones and points are left out. Only the show items and the highlights are lit; the rest is
  followed for the data alone, including the whole object a shown part belongs to (`partOf` in
  [procedures.md](procedures.md#objects)). Each object keeps one `phrase` for the whole lesson
  (its first show item's, else its label), because the tracker starts a track over when the
  phrase changes; the step's description goes in `query`, else the object's tracking query. The
  tracker asks jev about the objects about once a second and follows them on every frame. The
  headset places each outline at the object's measured distance (depth sensing, then hit-test),
  smooths it and draws it with a depth-correct glow. While this runs, the show items are not asked
  about again over HTTP. `?live=0` turns it off, `?tracker=<port>` picks another tracker (adb
  reverse the port), and `?frame=640` streams wider frames for small parts.
- **Over HTTP**, when the tracker is not running or its connection drops (the headset keeps
  retrying, with backoff). Clio asks again for the `show` items every few seconds, so outlines
  stay on objects that were moved, skipping objects in the learner's hand, because hand tracking
  moves those. Expect a request every 2 to 4 seconds during a lesson. Latency adds directly to
  how long an outline takes to appear. A finder that answers with `refreshMs` sets a faster pace:
  the headset sends its next frame that many milliseconds after each answer (never later than
  `?showRefresh`, and never with `?showRefresh=0`). `refreshMs` is passed through to the headset
  in Clio's own answer.

What the tracker reports is the camera's: positions go to the object registry as `detector`
estimates, never trusted by a Gemini coach's checks, and each frame's answer is recorded in the
episode's `observations.ndjson`. Nothing it sees reaches the coach
([coach-plan.md](coach-plan.md#the-perception-boundary)).

## A tracking finder

[tracker/](../tracker/README.md) serves this contract on `:8790` with jev and YOLOE-26 (it
replaced the jev finder's EdgeTAM and SAM 2.1). A request without `session` is answered like any
finder: one jev call, then YOLOE outlines each box jev found; the primary-object route sends
those. A request with a `session` (the lesson's) is answered from tracking state instead:
YOLOE-26 and ByteTrack follow each object on every frame (about 35 ms a round trip on an M5),
jev is asked which object the words mean only about once a second, in the background, and the
answer carries `refreshMs: 50`, so outlines follow moving objects at 10 to 15 frames a second.
The primary demo page also streams frames to its WebSocket `/track`
([tracker/TRACK.md](../tracker/TRACK.md)).

## Minimal adapter

If jev has its own API, a small adapter maps it onto this contract. In Python with FastAPI:

```python
# pip install fastapi uvicorn pillow numpy opencv-python
import base64, io

import cv2
import numpy as np
from fastapi import FastAPI
from PIL import Image

app = FastAPI()


def find(image: Image.Image, phrase: str | None, query: str):
    """Call jev here. Return (mask as an HxW bool array, score), or (None, 0.0) if not seen."""
    raise NotImplementedError


@app.post("/locate")
def locate(request: dict) -> dict:
    image = Image.open(io.BytesIO(base64.b64decode(request["image"]["data"]))).convert("RGB")
    w, h = image.size
    detections = []
    for obj in request["objects"]:
        mask, score = find(image, obj.get("phrase"), obj["query"])
        if mask is None:
            detections.append({"id": obj["id"], "found": False})
            continue
        contours, _ = cv2.findContours(
            mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        contour = max(contours, key=cv2.contourArea).reshape(-1, 2)
        outline = [[x / w, y / h] for x, y in contour.tolist()]
        detections.append({"id": obj["id"], "outline": outline, "confidence": float(score)})
    return {"model": "jev", "detections": detections}
```

Run it with `uvicorn adapter:app --port 8001`, set
`CLIO_VISION_URL=http://127.0.0.1:8001/locate` in `.env`, and restart the server. Its startup log
shows `Object finder: http://127.0.0.1:8001/locate`.

To try the finder through Clio without the headset, save a request like the one above as
`request.json` and run:

```sh
curl -s localhost:8787/api/vision/locate -H 'content-type: application/json' -d @request.json
```

## What gets recorded

Each answer becomes an `object.detected` event in the episode (see
[data-format.md](data-format.md)). The event holds the text the finder was given, what it
returned (point, box, outline, confidence), the lifted 3D position, and `source` (the `model`).
Every outline the learner sees is also a training label.
