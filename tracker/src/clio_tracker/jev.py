"""One jev request per frame: a Noul presence question and a Box question for every object.

From the jev finder (services/jev-finder, before YOLOE replaced its EdgeTAM and SAM models).

The request and the rules follow `jevbench.providers.Jev`, which the Jev fun benchmark measured:
the model is pinned (Box needs jev-1.14.0), the danger-zone image header is sent, presence comes
from Noul alone (Box always answers with some box), every box is checked with `valid_box`, and
nothing is ever retried, because a request that timed out may still be billed. For the same
reason only one call is in flight at a time, including one that ran past its deadline.
"""

from __future__ import annotations

import base64
import json
import re
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import httpx

from .bench import probability, valid_box

DEFAULT_MODEL = "jev-1.14.0"
DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
DEFAULT_TIMEOUT_S = 12.0
# Connecting and sending the frame get short limits of their own, so a stalled handshake fails
# well before the deadline; the deadline itself caps the whole call.
STAGE_TIMEOUT_S = 3.0
# Absent objects scored 0.02 to 0.10 on Noul in the benchmark, present ones 0.54 to 0.97.
PRESENCE_THRESHOLD = 0.5
NO_RETRY = "No automatic retry was sent."

# Question names are built from object ids; anything unusual falls back to the object's index.
SAFE_ID = re.compile(r"[A-Za-z0-9_]{1,64}")
ARTICLE = re.compile(r"^(a|an|the)\s+(?=\S)", re.IGNORECASE)


class JevError(Exception):
    """jev failed as a whole. `status` is the HTTP status the finder answers with."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Target:
    id: str
    query: str
    """The standalone description."""
    phrase: str | None = None
    """A short noun phrase naming the object, when the caller has one."""


@dataclass(frozen=True)
class Answer:
    presence: float | None
    """The Noul probability; None when jev's answer for it was unusable."""
    box: list[float] | None
    """[left, top, right, bottom] in 0..1 of the frame jev saw, when present and valid."""
    problem: str | None = None
    """Why a present object has no box, or why the answer was unusable."""

    @property
    def present(self) -> bool:
        return self.presence is not None and self.presence >= PRESENCE_THRESHOLD


@dataclass(frozen=True)
class Reply:
    answers: list[Answer]
    """One per target, in order."""
    usage: dict = field(default_factory=dict)


class JevClient:
    def __init__(
        self,
        key: str,
        model: str = DEFAULT_MODEL,
        endpoint: str = DEFAULT_ENDPOINT,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        transport: httpx.BaseTransport | None = None,
    ):
        if not key:
            raise ValueError("Missing TYPESAFE_API_KEY.")
        self.key = key
        self.model = model
        self.endpoint = endpoint
        self.timeout_s = timeout_s
        stage_s = min(STAGE_TIMEOUT_S, timeout_s)
        self.client = httpx.Client(
            timeout=httpx.Timeout(timeout_s, connect=stage_s, write=stage_s, pool=1),
            transport=transport,
        )
        # Calls run on their own thread so `ask` can give up at the deadline. A call that ran
        # past it keeps the slot until it ends, so no second billed call starts beside it.
        self.caller = ThreadPoolExecutor(max_workers=1, thread_name_prefix="jev")
        self.calling = threading.Lock()

    def ask(self, jpeg: bytes, targets: list[Target]) -> Reply:
        keys = question_keys([t.id for t in targets])
        body = request_body(self.model, jpeg, targets, keys)
        if not self.calling.acquire(blocking=False):
            raise JevError("jev is still answering an earlier request; this one was not sent.", 503)
        try:
            call = self.caller.submit(self._post, body)
        except BaseException:
            self.calling.release()
            raise
        call.add_done_callback(lambda _: self.calling.release())
        try:
            response = call.result(timeout=self.timeout_s)
        except TimeoutError as e:
            raise JevError(self._too_slow(), 504) from e
        if not response.is_success:
            detail = " ".join(response.text.split())[:200]
            raise JevError(
                f"jev answered HTTP {response.status_code}{f': {detail}' if detail else ''}. "
                + NO_RETRY
            )
        try:
            raw = response.json()
            answers = raw["answers"]
            if not isinstance(answers, dict):
                raise TypeError
        except (ValueError, KeyError, TypeError) as e:
            raise JevError("jev's answer has no answers object.") from e
        return Reply(
            answers=[read_answer(answers, key) for key in keys],
            usage=raw.get("usage") or {},
        )

    def _post(self, body: dict) -> httpx.Response:
        try:
            return self.client.post(
                self.endpoint,
                json=body,
                headers={
                    "Authorization": f"Bearer {self.key}",
                    "TypeSafe-Danger-Zone-Images": "true",
                },
            )
        except httpx.TimeoutException as e:
            raise JevError(self._too_slow(), 504) from e
        except httpx.TransportError as e:
            raise JevError(f"jev is unreachable ({type(e).__name__}). {NO_RETRY}") from e

    def _too_slow(self) -> str:
        return f"jev did not answer within {self.timeout_s:g} s. {NO_RETRY}"

    def close(self) -> None:
        self.caller.shutdown(wait=False, cancel_futures=True)
        self.client.close()


def request_body(model: str, jpeg: bytes, targets: list[Target], keys: list[str]) -> dict:
    asset_id = str(uuid.uuid4())
    questions = {}
    for target, key in zip(targets, keys, strict=True):
        present, box = instructions(target)
        questions[f"present_{key}"] = {"type": "noul", "instructions": present}
        questions[f"target_{key}"] = {"type": "box", "instructions": box}
    return {
        "model": model,
        "state": {"photo": asset_id},
        "assets": {
            asset_id: {
                "type": "image",
                "format": "jpg",
                "data_base64": base64.b64encode(jpeg).decode(),
            }
        },
        "questions": questions,
    }


def instructions(target: Target) -> tuple[str, str]:
    """The Noul and Box instructions for one object.

    The benchmark that set the 0.5 gate asked about short noun phrases, so a phrase fills the
    same templates, and a phrase alone gets exactly the benchmarked Noul question. But a phrase
    names the object's kind, and the description is what singles it out: asked "Is there a
    paper cup", jev says yes whenever any cup is in view, and Box then boxes a look-alike. So
    with a description, Noul asks about the one it describes, as it does without a phrase: on
    two real frames (2026-10-24) an absent cup D among cups A to C scored 0.97 asked about the
    kind and 0.02 asked about the one described, an absent ORANGE JUICE bottle among other
    bottles 0.95 and 0.01, an absent kind (a pear) 0.04 and 0.05, and present objects 0.93 to
    0.99 either way, so the 0.5 gate holds. Box gets the description as context, to pick the
    right one among look-alikes (wording it as "that one, not another" made no difference
    there). Without a phrase, the description is quoted as is: it is often a whole sentence,
    not a noun phrase.
    """
    query = " ".join(target.query.split())
    subject = describe(target.phrase or "")
    if subject:
        present = f"Is there a {subject} visible in `photo`?"
        box = f"The {subject} in `photo`. Return a tight box around one matching object."
        if subject.lower() != describe(query).lower():
            present = f"Is the {subject} described below visible in `photo`? Description: {query}"
            box += f" Description: {query}"
        return present, box
    return (
        f"Is the object described below visible in `photo`? Description: {query}",
        "The object described below, in `photo`. Return a tight box around one matching "
        f"object. Description: {query}",
    )


def read_answer(answers: dict, key: str) -> Answer:
    """Presence from Noul, then the box only when present. Invalid boxes are never repaired."""
    try:
        presence = probability(answers[f"present_{key}"]["noul"], "Noul probability")
    except (KeyError, TypeError, ValueError):
        return Answer(None, None, f"no usable Noul answer for present_{key}")
    if presence < PRESENCE_THRESHOLD:
        return Answer(presence, None)
    try:
        coords = answers[f"target_{key}"]["box"]
        box = [coords[k] for k in ("left", "top", "right", "bottom")]
    except (KeyError, TypeError):
        return Answer(presence, None, f"no Box answer for target_{key}")
    if not valid_box(box):
        return Answer(presence, None, f"invalid box {box} for target_{key}")
    return Answer(presence, [float(v) for v in box])


def question_keys(ids: list[str]) -> list[str]:
    keys: list[str] = []
    for index, object_id in enumerate(ids):
        key = object_id if SAFE_ID.fullmatch(object_id) else f"object{index}"
        while key in keys:
            key += "_"
        keys.append(key)
    return keys


def describe(phrase: str) -> str:
    """A noun phrase as the subject of a sentence: 'A round blue cap.' becomes 'round blue cap'."""
    subject = ARTICLE.sub("", " ".join(phrase.split()).rstrip(".").strip())
    if subject[1:2].islower():
        subject = subject[:1].lower() + subject[1:]
    return subject


def fake_transport(box: tuple[float, ...] = (0.3, 0.3, 0.7, 0.7)) -> httpx.MockTransport:
    """Stands in for jev without the network: every object present, boxed by `box`.

    For dry runs (`--fake-jev`) and tests. It still goes through the real request and parsing.
    """

    def answer(request: httpx.Request) -> httpx.Response:
        questions = json.loads(request.content)["questions"]
        left, top, right, bottom = box
        answers = {
            name: (
                {"type": "noul", "noul": 0.9}
                if question["type"] == "noul"
                else {
                    "type": "box",
                    "box": {"left": left, "top": top, "right": right, "bottom": bottom},
                    "confidence": None,
                }
            )
            for name, question in questions.items()
        }
        return httpx.Response(200, json={"answers": answers, "usage": {}})

    return httpx.MockTransport(answer)
