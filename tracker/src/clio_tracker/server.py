"""HTTP: Clio's object-finder contract (docs/object-finder.md), answered from tracking state.

`POST /locate` takes Clio's LocateRequest plus an optional `session`, and answers
`{ model, detections, refreshMs, timings }`. `refreshMs` tells the headset how soon to send the
next frame: this finder is cheap per frame, unlike one that calls a model on every request.
"""

from __future__ import annotations

import base64
import binascii
from collections.abc import Callable

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .identify import FrameImage, Query
from .session import Sessions

MIME_TYPES = ("image/jpeg", "image/png", "image/webp")


class ImagePayload(BaseModel):
    mimeType: str  # noqa: N815 - Clio's wire name
    data: str


class LocateObject(BaseModel):
    id: str = Field(min_length=1)
    query: str = Field(min_length=1)
    phrase: str | None = None


class LocateRequest(BaseModel):
    image: ImagePayload
    objects: list[LocateObject] = Field(min_length=1, max_length=16)
    session: str | None = Field(default=None, max_length=128)


def create_app(sessions: Sessions, model: str, refresh_ms: int, health: Callable[[], dict]):
    app = FastAPI(title="Clio tracker", docs_url=None, redoc_url=None)

    @app.post("/locate")
    def locate(request: LocateRequest) -> dict:
        image = decode_image(request.image)
        queries: list[Query] = []
        for o in request.objects:
            if all(q.id != o.id for q in queries):
                queries.append(Query(o.id, o.query.strip(), (o.phrase or "").strip() or None))
        session = sessions.get(request.session)
        detections, timings = session.locate(image, queries)
        return {
            "model": f"{model}+{session.identifier.name}",
            "detections": detections,
            "refreshMs": refresh_ms,
            "timings": {"encodeMs": timings.encode_ms, "trackMs": timings.track_ms},
        }

    @app.get("/health")
    def get_health() -> dict:
        return {"ok": True, "sessions": len(sessions), **health()}

    @app.post("/reset")
    def reset() -> dict:
        sessions.reset()
        return {"ok": True}

    return app


def decode_image(payload: ImagePayload) -> FrameImage:
    if payload.mimeType not in MIME_TYPES:
        raise HTTPException(400, f"image.mimeType must be one of {', '.join(MIME_TYPES)}")
    try:
        data = base64.b64decode(payload.data, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(
            400, "image.data is not base64 (send it without a data: prefix)"
        ) from None
    bgr = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if bgr is None or bgr.size == 0:
        raise HTTPException(400, f"image.data does not decode as {payload.mimeType}")
    return FrameImage(data, payload.mimeType, np.ascontiguousarray(bgr[..., ::-1]))
