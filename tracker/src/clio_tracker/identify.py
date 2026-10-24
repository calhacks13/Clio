"""Who decides which object the words mean: jev, or any finder that speaks Clio's contract.

An identifier gets one camera frame and the words for each object, and answers, per object,
whether it is in view and a box around it. The tracker asks about once a second and never
retries: a jev request that timed out may still be billed.
"""

from __future__ import annotations

import base64
import uuid
from dataclasses import dataclass
from typing import Protocol

import cv2
import httpx
import numpy as np

from .geometry import valid_box

JEV_URL = "https://api.typesafe.ai/v1/systemone"
# Box questions need jev 1.14 or the preview alias; 1.13 takes images but has no Box.
JEV_MODEL = "jev-1.14.0"
# TypeSafe's image rules: JPEG or PNG, 280 to 1568 px a side. Oversize images are rejected.
JEV_MIN_SIDE, JEV_MAX_SIDE = 280, 1568


@dataclass(frozen=True)
class Query:
    id: str
    query: str  # a standalone visual description
    phrase: str | None = None  # 2 to 5 words


@dataclass(frozen=True)
class Identification:
    id: str
    present: float  # 0..1: the object is in view
    box: tuple[float, float, float, float] | None  # normalized xyxy


@dataclass(frozen=True)
class FrameImage:
    """The camera frame as the client sent it, plus the decoded pixels for re-encoding."""

    data: bytes
    mime_type: str
    rgb: np.ndarray

    @property
    def width(self) -> int:
        return int(self.rgb.shape[1])

    @property
    def height(self) -> int:
        return int(self.rgb.shape[0])

    def jpeg_within(self, lo: int, hi: int) -> bytes:
        """The original JPEG when it fits [lo, hi] px a side, else a resized re-encode."""
        w, h = self.width, self.height
        if self.mime_type == "image/jpeg" and lo <= min(w, h) and max(w, h) <= hi:
            return self.data
        gain = min(hi / max(w, h), 1.0)
        gain = max(gain, lo / min(w, h))
        size = (max(lo, round(w * gain)), max(lo, round(h * gain)))
        bgr = cv2.resize(self.rgb[..., ::-1], size, interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, 90])
        if not ok:
            raise ValueError("could not encode the frame as JPEG")
        return buf.tobytes()


class Identifier(Protocol):
    name: str

    def identify(self, image: FrameImage, queries: list[Query]) -> list[Identification]: ...


class JevIdentifier:
    """TypeSafe's jev: a Noul (yes/no) and a Box question per object, all on one image.

    Box always returns a box, even for an absent object, so presence comes from Noul alone.
    """

    def __init__(
        self,
        api_key: str,
        model: str = JEV_MODEL,
        url: str = JEV_URL,
        timeout_s: float = 15.0,
        transport: httpx.BaseTransport | None = None,
    ):
        self.name = model
        self._model = model
        self._url = url
        self._client = httpx.Client(
            timeout=timeout_s,
            transport=transport,
            headers={
                "authorization": f"Bearer {api_key}",
                # Required on every request that carries an image or a Box question.
                "typesafe-danger-zone-images": "true",
            },
        )

    def identify(self, image: FrameImage, queries: list[Query]) -> list[Identification]:
        key = str(uuid.uuid4())
        jpeg = image.jpeg_within(JEV_MIN_SIDE, JEV_MAX_SIDE)
        questions: dict[str, dict[str, str]] = {}
        for i, q in enumerate(queries):
            what = _describe(q)
            questions[f"present_{i}"] = {
                "type": "noul",
                "instructions": f"Is this object visible in `frame`? {what}",
            }
            questions[f"target_{i}"] = {
                "type": "box",
                "instructions": f"Locate this one object in `frame`. {what}",
            }
        body = {
            "model": self._model,
            "state": {"frame": key},
            "assets": {
                key: {
                    "type": "image",
                    "format": "jpg",
                    "data_base64": base64.b64encode(jpeg).decode("ascii"),
                }
            },
            "questions": questions,
        }
        response = self._client.post(self._url, json=body)
        if response.status_code != 200:
            raise IdentifierError(f"jev answered {response.status_code}: {_snippet(response.text)}")
        answers = response.json().get("answers")
        if not isinstance(answers, dict):
            raise IdentifierError(f"jev's answer has no answers object: {_snippet(response.text)}")
        return [
            Identification(
                q.id,
                _noul(answers.get(f"present_{i}")),
                _jev_box(answers.get(f"target_{i}")),
            )
            for i, q in enumerate(queries)
        ]


class HttpIdentifier:
    """Any object finder behind Clio's contract (docs/object-finder.md): Gemini through Clio's
    /api/vision/locate, or an existing jev service. Point it at a finder that is not this
    tracker, or each request would come back here."""

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
        response = self._client.post(self._url, json=body)
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


class IdentifierError(Exception):
    pass


def _describe(q: Query) -> str:
    if q.phrase and q.phrase.lower() not in q.query.lower():
        return f"{q.phrase}: {q.query}"
    return q.query


def _noul(answer: object) -> float:
    if not isinstance(answer, dict):
        return 0.0
    for key in ("noul", "probability"):
        v = answer.get(key)
        if isinstance(v, (int, float)) and np.isfinite(v):
            return float(min(1.0, max(0.0, v)))
    choice = answer.get("choice")
    return 1.0 if choice is True else 0.0


def _jev_box(answer: object) -> tuple[float, float, float, float] | None:
    if not isinstance(answer, dict):
        return None
    try:
        box = np.array(
            [answer["left"], answer["top"], answer["right"], answer["bottom"]], dtype=np.float64
        )
    except (KeyError, TypeError, ValueError):
        return None
    # Box answers come rounded to 0.01 and have been reported zero-width.
    if not valid_box(box, min_size=0.005) or box.min() < -0.01 or box.max() > 1.01:
        return None
    return tuple(float(v) for v in box.clip(0, 1))  # type: ignore[return-value]


def _finder_box(d: dict) -> tuple[float, float, float, float] | None:
    raw = d.get("box")
    if raw is None and d.get("outline"):
        pts = np.asarray(d["outline"], dtype=np.float64)
        raw = [pts[:, 0].min(), pts[:, 1].min(), pts[:, 0].max(), pts[:, 1].max()]
    if raw is None:
        return None
    box = np.asarray(raw, dtype=np.float64)
    if not valid_box(box, min_size=0.002):
        return None
    return tuple(float(v) for v in box.clip(0, 1))  # type: ignore[return-value]


def _snippet(text: str) -> str:
    return " ".join(text.split())[:200]
