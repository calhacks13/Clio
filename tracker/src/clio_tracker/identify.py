"""Who decides which object the words mean: jev, or any finder that speaks Clio's contract.

An identifier gets one camera frame and the words for each object, and answers, per object,
whether it is in view and a box around it. Nothing is retried: a jev request that timed out may
still be billed.
"""

from __future__ import annotations

import base64
import io
from dataclasses import dataclass
from typing import Protocol

import httpx
import numpy as np
from PIL import Image

from .bench import valid_box
from .images import BadImage, fit_frame, plain_pil
from .jev import JevClient, JevError, Target


@dataclass(frozen=True)
class Query:
    id: str
    query: str  # a standalone visual description
    phrase: str | None = None  # 2 to 5 words


@dataclass(frozen=True)
class Identification:
    id: str
    present: float  # 0..1: the object is in view
    box: tuple[float, float, float, float] | None  # normalized xyxy, only when present


@dataclass(frozen=True)
class FrameImage:
    """The camera frame as the client sent it, plus the decoded pixels."""

    data: bytes
    mime_type: str
    rgb: np.ndarray

    @property
    def width(self) -> int:
        return int(self.rgb.shape[1])

    @property
    def height(self) -> int:
        return int(self.rgb.shape[0])


class Identifier(Protocol):
    name: str

    def identify(self, image: FrameImage, queries: list[Query]) -> list[Identification]: ...


class IdentifierError(Exception):
    """The identifier failed as a whole. `status` is the HTTP status to answer with."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


class JevIdentifier:
    """jev through the jev finder's client (jev.py): its Noul and Box questions (Noul about the
    one object the query describes, not any of the phrase's kind), one call at a time, never
    retried. Presence is the Noul probability; boxes only when present."""

    def __init__(self, client: JevClient, name: str | None = None):
        self.client = client
        self.name = name or client.model

    def identify(self, image: FrameImage, queries: list[Query]) -> list[Identification]:
        plain_pil()
        try:
            source = Image.open(io.BytesIO(image.data))
            source.load()
            frame = fit_frame(source, image.data)
        except (OSError, BadImage) as e:
            raise IdentifierError(f"The frame can't be sent to jev: {e}", 422) from e
        targets = [Target(id=q.id, query=q.query, phrase=q.phrase) for q in queries]
        try:
            reply = self.client.ask(frame.jpeg, targets)
        except JevError as e:
            raise IdentifierError(str(e), e.status) from e
        out = []
        for q, answer in zip(queries, reply.answers, strict=True):
            box = frame.from_jev(answer.box) if answer.present and answer.box else None
            out.append(Identification(q.id, answer.presence or 0.0, _tuple(box)))
        return out

    def close(self) -> None:
        self.client.close()


class HttpIdentifier:
    """Any object finder behind Clio's contract (docs/object-finder.md): Gemini through Clio's
    /api/vision/locate, for one. Point it at a finder that is not this tracker, or each request
    would come back here."""

    def __init__(
        self,
        url: str,
        token: str | None = None,
        timeout_s: float = 15.0,
        transport: httpx.BaseTransport | None = None,
    ):
        self.name = "http"
        self._url = url
        headers = {"authorization": f"Bearer {token}"} if token else {}
        self._client = httpx.Client(timeout=timeout_s, transport=transport, headers=headers)

    def identify(self, image: FrameImage, queries: list[Query]) -> list[Identification]:
        body = {
            "image": {"mimeType": image.mime_type, "data": base64.b64encode(image.data).decode()},
            "objects": [
                {"id": q.id, "query": q.query, **({"phrase": q.phrase} if q.phrase else {})}
                for q in queries
            ],
        }
        try:
            response = self._client.post(self._url, json=body)
        except httpx.TimeoutException as e:
            raise IdentifierError(f"{self._url} did not answer in time", 504) from e
        except httpx.TransportError as e:
            raise IdentifierError(f"{self._url} is unreachable ({type(e).__name__})") from e
        if response.status_code != 200:
            raise IdentifierError(
                f"{self._url} answered {response.status_code}: {_snippet(response.text)}"
            )
        payload = response.json()
        model = payload.get("model")
        if isinstance(model, str) and model:
            self.name = model
        by_id: dict[str, Identification] = {}
        for d in payload.get("detections", []):
            if not isinstance(d, dict) or d.get("id") not in {q.id for q in queries}:
                continue
            box = _finder_box(d)
            found = d.get("found", box is not None) and box is not None
            confidence = float(d.get("confidence") or 0.5) if found else 0.0
            previous = by_id.get(d["id"])
            if previous is None or confidence > previous.present:
                by_id[d["id"]] = Identification(d["id"], confidence, box)
        return [by_id.get(q.id, Identification(q.id, 0.0, None)) for q in queries]

    def close(self) -> None:
        self._client.close()


def _tuple(box: list[float] | None) -> tuple[float, float, float, float] | None:
    return (box[0], box[1], box[2], box[3]) if box and valid_box(box) else None


def _finder_box(d: dict) -> tuple[float, float, float, float] | None:
    raw = d.get("box")
    if raw is None and d.get("outline"):
        pts = np.asarray(d["outline"], dtype=np.float64)
        raw = [pts[:, 0].min(), pts[:, 1].min(), pts[:, 0].max(), pts[:, 1].max()]
    if raw is None:
        return None
    return _tuple([float(min(1.0, max(0.0, v))) for v in raw])


def _snippet(text: str) -> str:
    return " ".join(text.split())[:200]
