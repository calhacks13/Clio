"""HTTP and WebSocket routes: Clio's object-finder contract (docs/object-finder.md) and the live
tracking stream (TRACK.md).

- `POST /locate` with a `session` (the lesson's Spotlight) answers from tracking state at once,
  with `refreshMs` so the headset sends the next frame soon; jev looks in the background.
- `POST /locate` without one (the primary-object route) asks jev now and outlines its boxes
  with YOLOE: one request at a time, another gets 503 rather than a second billed call.
- `WS /track` follows the target the page names on every frame it streams, or, in objects mode,
  the objects it names in words, with a TrackerSession of the connection's own (not one of the
  shared Sessions).

The service listens on 127.0.0.1 only. Requests must name a local host, which stops a web page
from reaching it through DNS rebinding, and must be sent as JSON, which a page can't do across
origins without a CORS preflight this service never answers. WebSockets skip CORS, so /track
also refuses a browser Origin that isn't a local host.
"""

from __future__ import annotations

import base64
import binascii
import re
from collections.abc import Callable
from typing import Annotated, Literal
from urllib.parse import urlsplit

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StringConstraints, field_validator

from .finder import Busy, Finder
from .identify import FrameImage, IdentifierError, Query
from .images import BadImage
from .session import Sessions
from .stream import run_stream
from .track import Modes, StreamTracker

LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]", "testserver"}
WORD = re.compile(r"\w")


class ImageIn(BaseModel):
    mimeType: Literal["image/jpeg", "image/png", "image/webp"]  # noqa: N815 - Clio's wire name
    data: str = Field(min_length=1)


class ObjectIn(BaseModel):
    id: Annotated[str, StringConstraints(min_length=1, max_length=200)]
    query: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]
    phrase: Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)] | None = None

    @field_validator("query")
    @classmethod
    def has_words(cls, query: str) -> str:
        if not WORD.search(query):
            raise ValueError("query has no words")
        return query

    @field_validator("phrase")
    @classmethod
    def phrase_or_none(cls, phrase: str | None) -> str | None:
        return phrase if phrase and WORD.search(phrase) else None


class LocateIn(BaseModel):
    image: ImageIn
    objects: list[ObjectIn] = Field(min_length=1, max_length=16)
    session: Annotated[str, StringConstraints(min_length=1, max_length=128)] | None = None


def create_app(
    sessions: Sessions,
    finder: Finder,
    stream: Callable[[], StreamTracker],
    refresh_ms: int,
    health: Callable[[], dict],
) -> FastAPI:
    app = FastAPI(title="Clio tracker", docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        if request.url.hostname not in LOCAL_HOSTS:
            return JSONResponse({"detail": "Use 127.0.0.1 to reach the tracker."}, 403)
        return await call_next(request)

    @app.get("/health")
    def get_health() -> dict:
        return {"ok": True, "sessions": len(sessions), **health()}

    @app.post("/locate")
    async def locate(body: LocateIn) -> JSONResponse:
        queries: list[Query] = []
        for o in body.objects:
            if all(q.id != o.id for q in queries):
                queries.append(Query(o.id, o.query, o.phrase))
        if body.session is None:
            try:
                answer, timings = await run_in_threadpool(
                    finder.locate, body.image.mimeType, body.image.data, queries
                )
            except (BadImage, Busy, IdentifierError) as e:
                return JSONResponse({"detail": str(e)}, e.status)
            return JSONResponse(answer, headers={"Server-Timing": timings.header()})

        image = decode_image(body.image)
        session = sessions.get(body.session)
        detections, timings = await run_in_threadpool(session.locate, image, queries)
        return JSONResponse(
            {
                "model": f"{session.identifier.name}+{session.vision.model}",
                "detections": detections,
                "refreshMs": refresh_ms,
                "timings": {"encodeMs": timings.encode_ms, "trackMs": timings.track_ms},
            }
        )

    @app.post("/reset")
    def reset() -> dict:
        sessions.reset()
        return {"ok": True}

    @app.websocket("/track")
    async def track(websocket: WebSocket) -> None:
        origin = websocket.headers.get("origin")
        if websocket.url.hostname not in LOCAL_HOSTS or (
            origin is not None and urlsplit(origin).hostname not in LOCAL_HOSTS
        ):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        await run_stream(websocket, Modes(stream(), sessions.new))

    return app


def decode_image(payload: ImageIn) -> FrameImage:
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
