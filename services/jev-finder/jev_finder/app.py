"""The service's routes: POST /locate and GET /health from the object-finder contract
(docs/object-finder.md), and the WebSocket /track stream (TRACK.md).

The service listens on 127.0.0.1 only. Requests must name a local host, which stops a web page
from reaching it through DNS rebinding, and must be sent as JSON, which a page can't do across
origins without a CORS preflight this service never answers. Each request costs a jev call, so
only one is answered at a time; another that arrives meanwhile gets 503 rather than a queue.
WebSockets skip CORS, so /track also refuses a browser Origin that isn't a local host.
"""

from __future__ import annotations

import re
from typing import Annotated, Literal
from urllib.parse import urlsplit

from fastapi import FastAPI, Request, WebSocket
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StringConstraints, field_validator

from .finder import Busy, Finder
from .images import BadImage
from .jev import JevError, Target
from .stream import run_stream
from .tracker import Tracker

LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]", "testserver"}
WORD = re.compile(r"\w")


class ImageIn(BaseModel):
    mimeType: Literal["image/jpeg", "image/png", "image/webp"]
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


def create_app(finder: Finder, device: str) -> FastAPI:
    app = FastAPI(title="jev finder", docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        if request.url.hostname not in LOCAL_HOSTS:
            return JSONResponse({"detail": "Use 127.0.0.1 to reach the jev finder."}, 403)
        return await call_next(request)

    @app.get("/health")
    def health() -> dict:
        return {"ok": True, "model": finder.model, "device": device}

    @app.post("/locate")
    async def locate(body: LocateIn) -> JSONResponse:
        targets = [Target(id=o.id, query=o.query, phrase=o.phrase) for o in body.objects]
        try:
            answer, timings = await run_in_threadpool(
                finder.locate, body.image.mimeType, body.image.data, targets
            )
        except (BadImage, Busy, JevError) as e:
            return JSONResponse({"detail": str(e)}, e.status)
        return JSONResponse(answer, headers={"Server-Timing": timings.header()})

    @app.websocket("/track")
    async def track(websocket: WebSocket) -> None:
        origin = websocket.headers.get("origin")
        if websocket.url.hostname not in LOCAL_HOSTS or (
            origin is not None and urlsplit(origin).hostname not in LOCAL_HOSTS
        ):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        # The finder's segmenter is shared with /locate, which never runs it at the same time.
        segmenter = finder.segmenter
        await run_stream(websocket, Tracker(segmenter.track_session(), segmenter.label))

    return app
