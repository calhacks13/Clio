"""The gemini-cad backend: Gemini looks at an object's crops, reads what the lesson calls it and how
big it was measured, and writes a CAD program (cad.py) that this package turns into the model.

One call per object to the Generative Language REST API, with urllib and nothing else:

    POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
    x-goog-api-key: <key>
    {"system_instruction": {...}, "contents": [{"role": "user", "parts": [text, inline_data...]}],
     "generationConfig": {"responseMimeType": "application/json", "responseSchema": {...}}}

The crops go as inline JPEG parts, each after a line saying where its camera stood relative to the
model's front, so Gemini can tell the sides apart. The answer is constrained to RESPONSE_SCHEMA
(Gemini's OpenAPI subset); `notes` comes before `parts` so the program is planned before it is
written. HTTP 429 and 5xx are retried (`ModelSettings.gemini_retries`, backing off, or as long as
Retry-After says, capped); anything else is a GeminiError, and the caller draws a primitive.

This sends camera crops of the learner's room to Google, so it runs only when gemini-cad is asked
for (docs/room-scene.md).
"""

from __future__ import annotations

import base64
import io
import json
import math
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..derived_io import write_json
from ..glb import write_glb
from .cad import MAX_PARTS, SHAPES, Program, fit_program, srgb_to_hex, validate_program
from .describe import ObjectWords
from .fit import Measured, Placement, off_axes
from .settings import ModelSettings, Transport
from .views import View

API_ROOT = "https://generativelanguage.googleapis.com/v1beta"
RETRY_STATUS = frozenset({429, 500, 502, 503, 504})
MAX_RETRY_WAIT_S = 30.0
UPLOAD_PX = 768  # longest side of a crop as sent
UPLOAD_QUALITY = 88


class GeminiError(RuntimeError):
    """Gemini could not be asked, or did not answer with a usable program."""


# --- the request ----------------------------------------------------------------------------------

# The schema carries no minItems / maxItems. Gemini answers 400 "Request contains an invalid
# argument" once a schema has several bounded arrays (checked live on gemini-pro-latest and
# gemini-3.8-flash, October 2026), so lengths are said in the descriptions and enforced when the
# program is checked (cad.py): a vector of the wrong length or a part past MAX_PARTS is dropped.
_NUMBER = {"type": "NUMBER"}


def _num(description: str) -> dict[str, Any]:
    return {"type": "NUMBER", "description": description}


def _vec3(description: str) -> dict[str, Any]:
    return {"type": "ARRAY", "items": _NUMBER, "description": f"{description} (3 numbers)"}


def _pairs(description: str) -> dict[str, Any]:
    pair = {"type": "ARRAY", "items": _NUMBER}
    return {"type": "ARRAY", "items": pair, "description": f"{description} (at most 128 pairs)"}


_PART_FIELDS = ["name", "shape", "dims", "position", "rotation", "color", "metalness", "roughness"]

RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "name": {"type": "STRING", "description": "What the object is, in a few words"},
        "notes": {
            "type": "STRING",
            "description": "Before the parts: what the object is, its overall proportions, and "
            "which parts build it, with their key sizes",
        },
        "parts": {
            "type": "ARRAY",
            "description": f"1 to {MAX_PARTS} parts",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "name": {"type": "STRING", "description": "e.g. body, lid, handle, label"},
                    "shape": {"type": "STRING", "enum": list(SHAPES)},
                    "dims": {
                        "type": "OBJECT",
                        "description": "Only the fields of this part's shape, meters",
                        "properties": {
                            "x": _num("box: full length along x"),
                            "y": _num("box: full height along y"),
                            "z": _num("box: full length along z"),
                            "bevel": _num("box, cylinder: radius of the rounded edges, 0 sharp"),
                            "radius": _num("cylinder, sphere, capsule; torus: center to tube"),
                            "height": _num("cylinder, cone, extrude: along y"),
                            "radiusBottom": _num("cone: radius at the bottom, may be 0"),
                            "radiusTop": _num("cone: radius at the top, may be 0"),
                            "tube": _num("torus: radius of the tube"),
                            "arc": _num("torus: degrees kept, centered on +x; 360 whole ring"),
                            "length": _num("capsule: the straight middle along y"),
                            "profile": _pairs("lathe: [r, y] points, bottom to top"),
                            "outline": _pairs("extrude: [x, z] polygon"),
                        },
                    },
                    "position": _vec3("Center of the part, meters"),
                    "rotation": _vec3("Degrees about x, then y, then z"),
                    "color": {"type": "STRING", "description": '"#rrggbb"'},
                    "metalness": _num("0 to 1"),
                    "roughness": _num("0 to 1"),
                    "opacity": _num("1 opaque; lower only for glass or clear plastic"),
                },
                "required": ["name", "shape", "dims", "position", "rotation", "color"],
                "propertyOrdering": [*_PART_FIELDS, "opacity"],
            },
        },
    },
    "required": ["name", "notes", "parts"],
    "propertyOrdering": ["name", "notes", "parts"],
}

_EXAMPLE = {
    "name": "white ceramic coffee mug",
    "notes": "A straight-sided mug about 1.2 times as tall as it is wide, a loop handle on the "
    "right. Body: a lathe with a 3.5 mm wall and a thick base. Handle: part of a torus stood "
    "upright, its ends sunk into the body. Logo: a thin disc on the front.",
    "parts": [
        {
            "name": "body",
            "shape": "lathe",
            "dims": {
                "profile": [
                    [0, 0],
                    [0.036, 0],
                    [0.04, 0.004],
                    [0.04, 0.095],
                    [0.0365, 0.095],
                    [0.0365, 0.008],
                    [0, 0.008],
                ]
            },
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "color": "#f1eee8",
            "metalness": 0,
            "roughness": 0.3,
        },
        {
            "name": "handle",
            "shape": "torus",
            "dims": {"radius": 0.024, "tube": 0.0055, "arc": 210},
            "position": [0.038, 0.05, 0],
            "rotation": [90, 0, 0],
            "color": "#f1eee8",
            "metalness": 0,
            "roughness": 0.3,
        },
        {
            "name": "logo",
            "shape": "cylinder",
            "dims": {"radius": 0.012, "height": 0.001},
            "position": [0, 0.055, 0.0402],
            "rotation": [90, 0, 0],
            "color": "#c0392b",
            "metalness": 0,
            "roughness": 0.5,
        },
    ],
}

SYSTEM_INSTRUCTION = f"""\
You model real objects in 3D as small CAD programs. You get up to three photos of one object, \
cut from a headset camera, what a lesson calls it, and its size as the headset measured it. You \
answer with a JSON program of named parts, each a primitive solid with dimensions, a position, a \
rotation and a color. The render must be recognizable at a glance: someone who sees it names the \
object, and it has the object's real proportions.

Frame and units
- Meters. +y is up. The object stands on y = 0. Put its main body on the y axis; the pipeline \
moves the bottom center of the whole model's bounds to the origin afterwards.
- The front faces +z: the side photo 1 shows, or nearly (each photo says where its camera stood \
relative to the front). +x is to the right as you face the front.
- position is the center of the part (for a lathe, the point its profile's y and r are measured \
from). rotation is [x, y, z] in degrees about that center: first about x, then y, then z. Most \
parts need none.

Shapes and their dims (only the fields of the part's shape are read)
- box: x, y, z, full lengths, centered; bevel rounds its edges (a few mm for plastic or wood, \
0 for sharp). Most manufactured boxes have a small bevel.
- cylinder: radius, height; its axis along y, centered; bevel rounds both rims.
- cone: radiusBottom, radiusTop, height; a frustum along y, centered; one radius may be 0.
- sphere: radius.
- torus: radius (center to the middle of the tube), tube; a ring around y lying flat in x-z. arc \
keeps that many degrees of it centered on +x (360 by default): a handle is about 200 degrees, \
stood upright with rotation [90, 0, 0] so it loops in x-y, its ends sunk into the body.
- capsule: radius, length; a cylinder of that length along y with a half sphere on each end, \
centered.
- lathe: profile [[r, y], ...], revolved about the part's y axis. Start on the axis at the \
bottom, go out and up the outside. For anything hollow (cup, bowl, bottle neck, pot) go over the \
rim and back down the inside to the inner floor on the axis: the wall gets a real thickness and \
the opening reads as open. An end left off the axis is closed with a flat cap. Use it for \
bottles, vases, cups, bowls, bulbs, knobs, lids and anything round whose outline changes.
- extrude: outline [[x, z], ...], height; a flat polygon in x-z (edges must not cross) \
extruded along y, centered. Use it for anything with a flat outline: blades, brackets, plates, \
tags, phones, the body of a tool. Stand it up with a rotation.

How to model
- First decide exactly what the object is from the photos, its name and the hints, and write \
that, its proportions and your part plan in notes. Then write the parts.
- Match the measured proportions: the union of all parts should span about the measured size. \
The model is scaled uniformly to the measured height, so get the height-to-width ratio right.
- Use as few parts as make it unmistakable: usually 3 to 20, never more than {MAX_PARTS}. The \
main body first, then what makes it what it is: lids, caps, necks, spouts, handles, buttons, \
screens, legs, tips, hinges, blades.
- Printed labels, stickers, stripes and markings are thin parts (about 1 mm) set just proud of \
the surface they sit on, in their own color: on a round body a lathe band slightly wider than \
the body, or a thin disc or box on the front.
- Parts may overlap; they are drawn together, not merged. Nothing should float: joined parts \
touch or sink slightly into each other.
- Colors are "#rrggbb" as the object would look under neutral light. metalness 1 is bare metal; \
roughness is low for glossy plastic, glaze, glass and polished metal, high for paper, cloth and \
wood. Glass and clear plastic: a light tint, low roughness and opacity about 0.35.
- The camera saw only some sides. Complete the rest the way such an object is made, symmetric \
where it normally is. Do not model the hand, the table, the background or anything around it.
- If the measured size disagrees with what the object plainly is, keep its real proportions.

Example, for a white mug with a red logo, about 0.095 m tall:
{json.dumps(_EXAMPLE, separators=(",", ":"))}

Answer with the JSON program only."""


def request_body(
    words: ObjectWords,
    measured: Measured,
    placement: Placement,
    views: list[View],
    color: np.ndarray | None,
) -> dict[str, Any]:
    """The generateContent request for one object."""
    parts: list[dict[str, Any]] = [{"text": _object_text(words, measured, placement, views, color)}]
    for n, view in enumerate(views, start=1):
        if view.crop is None:
            continue
        parts.append({"text": f"Photo {n}: {_view_text(view, placement.yaw)}"})
        parts.append({"inline_data": {"mime_type": "image/jpeg", "data": _jpeg_b64(view)}})
    return {
        "system_instruction": {"parts": [{"text": SYSTEM_INSTRUCTION}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": RESPONSE_SCHEMA,
        },
    }


def _object_text(
    words: ObjectWords,
    measured: Measured,
    placement: Placement,
    views: list[View],
    color: np.ndarray | None,
) -> str:
    x, y, z = (float(v) for v in placement.size)
    kind = f" ({'an' if words.kind[0] in 'aeiou' else 'a'} {words.kind})" if words.kind else ""
    lines = [f'Object: "{words.label}"{kind}']
    hints = words.hints()
    if hints:
        lines.append("How the lesson describes it and how the camera looked for it:")
        lines += [f"- {hint}" for hint in hints]
    if words.parts:
        lines.append("Parts of it the lesson points at: " + ", ".join(words.parts))
    if measured.source == "shape":
        lines.append(
            f"Measured size: {x:.3f} m across (x), {y:.3f} m tall (y), {z:.3f} m deep (z), from "
            "depth samples on the object. The camera saw only the sides it faced, so a side can "
            "be larger than measured but not smaller."
        )
    elif measured.source == "extent":
        lines.append(
            f"Measured size: {x:.3f} m across (x) and {y:.3f} m tall (y), from the camera's view "
            "of it; its depth was not measured."
        )
    else:
        lines.append(
            f"Size: only a rough guess of about {max(x, y, z):.2f} m; give it the usual "
            "proportions of such an object."
        )
    if measured.source != "radius" and y > 0 and x > 0:
        lines.append(f"Height to width: {y / x:.2f}.")
    if color is not None:
        lines.append(f"Its main color in the photos is about {srgb_to_hex(color)}.")
    if views:
        lines.append(
            f"{len(views)} photo{'s' if len(views) > 1 else ''} follow, the object in the middle "
            "of each, with a little of its surroundings."
        )
    else:
        lines.append("No photo of it was taken: model it from its name and the hints.")
    return "\n".join(lines)


def _view_text(view: View, yaw: float) -> str:
    """Where the camera stood, in the model's frame (front +z, right +x)."""
    c, s = math.cos(yaw), math.sin(yaw)
    d = view.toward_camera
    x, z = c * d[0] - s * d[2], s * d[0] + c * d[2]
    around = math.degrees(math.atan2(x, z))
    above = math.degrees(math.asin(max(-1.0, min(1.0, float(d[1])))))
    if abs(around) < 10:
        side = "the front"
    elif abs(around) > 170:
        side = "the back"
    else:
        toward = "+x" if around > 0 else "-x"
        side = f"{abs(around):.0f} degrees round from the front toward {toward}"
    height = f"{above:.0f} degrees above it" if above >= 5 else "about level with it"
    return f"seen from {side}, {height}, {view.depth:.1f} m away."


def _jpeg_b64(view: View) -> str:
    assert view.crop is not None
    image = view.crop.copy()
    image.thumbnail((UPLOAD_PX, UPLOAD_PX))
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=UPLOAD_QUALITY)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


# --- the call -------------------------------------------------------------------------------------


def urllib_transport(
    url: str, headers: dict[str, str], body: bytes, timeout: float
) -> tuple[int, dict[str, str], bytes]:
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as e:
        return e.code, dict((e.headers or {}).items()), e.read()
    except TimeoutError as e:
        raise GeminiError(f"no answer within {timeout:g} s") from e
    except urllib.error.URLError as e:
        raise GeminiError(f"cannot reach Gemini: {e.reason}") from e


def generate(body: dict[str, Any], settings: ModelSettings) -> dict[str, Any]:
    """POST the request; the decoded response. GeminiError without a key or a 200."""
    key = settings.gemini_key
    if key is None:
        raise GeminiError("no GEMINI_API_KEY (or GOOGLE_API_KEY) is set")
    transport: Transport = settings.transport or urllib_transport
    url = f"{API_ROOT}/models/{urllib.parse.quote(settings.cad_model, safe='-._')}:generateContent"
    headers = {"Content-Type": "application/json", "x-goog-api-key": key}
    data = json.dumps(body, separators=(",", ":")).encode("utf-8")
    for attempt in range(settings.gemini_retries + 1):
        status, response_headers, payload = transport(url, headers, data, settings.gemini_timeout_s)
        if status == 200:
            try:
                return json.loads(payload)
            except ValueError as e:
                raise GeminiError("the response is not JSON") from e
        if status in RETRY_STATUS and attempt < settings.gemini_retries:
            settings.sleep(_wait(attempt, response_headers))
            continue
        raise GeminiError(f"HTTP {status}: {_error_message(payload)}")
    raise AssertionError("unreachable")


def _wait(attempt: int, headers: dict[str, str]) -> float:
    retry_after = next((v for k, v in headers.items() if k.lower() == "retry-after"), None)
    try:
        if retry_after is not None:
            return min(MAX_RETRY_WAIT_S, max(0.0, float(retry_after)))
    except ValueError:
        pass
    return min(MAX_RETRY_WAIT_S, 2.0 * 4.0**attempt)


def _error_message(payload: bytes) -> str:
    try:
        message = json.loads(payload)["error"]["message"]
    except (ValueError, KeyError, TypeError):
        message = payload.decode("utf-8", "replace")
    return " ".join(str(message).split())[:300] or "no message"


def answer_program(response: dict[str, Any]) -> Any:
    """The decoded JSON program in a generateContent response."""
    blocked = (response.get("promptFeedback") or {}).get("blockReason")
    if blocked:
        raise GeminiError(f"the request was blocked ({blocked})")
    candidates = response.get("candidates") or []
    if not candidates:
        raise GeminiError("the answer has no candidate")
    candidate = candidates[0]
    parts = (candidate.get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts if isinstance(p, dict) and not p.get("thought"))
    finish = candidate.get("finishReason")
    if not text.strip():
        raise GeminiError(f"an empty answer (finishReason {finish})")
    text = re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", text)
    try:
        return json.loads(text)
    except ValueError as e:
        cut = " (cut off: MAX_TOKENS)" if finish == "MAX_TOKENS" else ""
        raise GeminiError(f"the answer is not JSON{cut}") from e


# --- the backend ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class CadModel:
    size: np.ndarray  # (3,) the model's bounds after fitting
    generator: str  # the Gemini model
    cad: str  # "cad-<stem>.json"
    notes: tuple[str, ...]


def make_cad_model(
    *,
    object_id: str,
    stem: str,
    words: ObjectWords,
    measured: Measured,
    placement: Placement,
    views: list[View],
    color: np.ndarray | None,
    out_dir: Path,
    settings: ModelSettings,
) -> CadModel:
    """Ask Gemini, build and fit the program, write model-<stem>.glb and cad-<stem>.json."""
    body = request_body(words, measured, placement, views, color)
    response = generate(body, settings)
    program: Program = validate_program(answer_program(response))
    fitted = fit_program(program, float(placement.size[1]))
    model = settings.cad_model
    write_glb(
        fitted.nodes,
        out_dir / f"model-{stem}.glb",
        extras={"clio": {"object": object_id, "backend": "gemini-cad", "program": program.name}},
    )
    cad = f"cad-{stem}.json"
    write_json(
        out_dir / cad,
        {
            **program.to_json(),
            "clio": {
                "object": object_id,
                "label": words.label,
                "generator": model,
                "sizeSource": measured.source,
                "measuredSize": _rounded(placement.size),
                "programSize": _rounded(fitted.program_size),
                "scale": round(fitted.scale, 6),
                "dropped": list(program.dropped),
                "crops": len(views),
                "usage": response.get("usageMetadata"),
            },
        },
        indent=2,
    )
    notes = []
    if program.dropped:
        notes.append(f"left out of Gemini's program: {'; '.join(program.dropped)}")
    off = off_axes(fitted.size, placement.size, measured.source)
    if off:
        notes.append(f"Gemini's model is {off} after fitting its height")
    return CadModel(fitted.size, model, cad, tuple(notes))


def _rounded(values: np.ndarray) -> list[float]:
    return [round(float(v), 4) + 0.0 for v in values]
