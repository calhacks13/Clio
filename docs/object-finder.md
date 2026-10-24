# Object finder contract

Every lesson step says what Clio should **show** the learner (see
[procedures.md](procedures.md#show-what-a-step-outlines)). The planner writes, for each item, a
short noun phrase and a standalone visual description. When the step starts, Clio sends one
passthrough camera frame and those texts to an **object finder**, lifts what it returns into 3D,
and outlines it in AR.

Gemini is the built-in finder (points and boxes, so Clio draws corner brackets). Any other finder
(jev, a SAM 3 or Grounding DINO server, a VLM) plugs in over HTTP: set `CLIO_VISION_URL` and the
server sends it every locate request instead. A finder that returns outlines gets real contours.

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
  ]
}
```

| Field    | Meaning                                                                                                                                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`     | Echo it back in the detection.                                                                                                                                                                                                                            |
| `phrase` | 2 to 5 words, for detectors and segmenters that take category prompts (SAM 3, Grounding DINO, OWLv2, YOLO-World). It can be absent.                                                                                                                       |
| `query`  | A referring expression that stands on its own, for models that take free text (VLMs, referring segmentation). Always present. It says what the object is, its color, shape, size, markings and where it is now, and what tells it apart from look-alikes. |

A request asks for 1 to 16 objects. The image is a Quest 3 passthrough camera frame, a JPEG of
about 1280×960.

The planner writes `phrase` and the description (sent as `query`) for each step's `show` items.
For other lookups (a step's missing targets, or a coach highlight), `query` is the object's
`tracking.query` or label, and `phrase` is its label.

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
found yet. While the step runs, it asks again for the `show` items every few seconds, so outlines
stay on objects that were moved. It skips objects in the learner's hand, because hand tracking
moves those, and it never sends a second request while one is in flight. Expect a request every
2 to 4 seconds during a lesson. Latency adds directly to how long an outline takes to appear.

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
