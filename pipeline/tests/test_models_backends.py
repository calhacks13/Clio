"""The gemini-cad and command backends over the synthetic scene of test_models.py, without the
network: Gemini's HTTP layer is a fake that records each request and answers from a script, and
the image-to-3D command is a small Python script writing a GLB with clio_pipeline.glb."""

import base64
import json
import shlex
import sys
from pathlib import Path

import numpy as np
import pytest

from clio_pipeline.glb import glb_bounds, parse_glb, read_glb
from clio_pipeline.models import ModelSettings, build_object_models
from clio_pipeline.models.gemini import (
    API_ROOT,
    RESPONSE_SCHEMA,
    SYSTEM_INSTRUCTION,
    GeminiError,
    answer_program,
)
from test_models import NO_KEY, build_scene

# glb.apply_matrix's matmul goes through Accelerate on macOS, which raises spurious floating point
# flags on exact zeros (inputs and results are finite); they are not this package's to fix.
pytestmark = pytest.mark.filterwarnings("ignore:.*encountered in matmul:RuntimeWarning")

MUG = {
    "name": "paper cup",
    "notes": "A tapered paper cup with a rolled rim and a printed letter on the front.",
    "parts": [
        {
            "name": "cup",
            "shape": "lathe",
            "dims": {
                "profile": [[0, 0], [0.3, 0], [0.4, 1.0], [0.38, 1.0], [0.28, 0.02], [0, 0.02]]
            },
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "color": "#f4f1ea",
            "metalness": 0,
            "roughness": 0.8,
        },
        {
            "name": "rim",
            "shape": "torus",
            "dims": {"radius": 0.39, "tube": 0.015},
            "position": [0, 1.0, 0],
            "rotation": [0, 0, 0],
            "color": "#ffffff",
        },
        {
            "name": "letter A",
            "shape": "extrude",
            "dims": {"outline": [[-0.1, 0.1], [0, -0.15], [0.1, 0.1]], "height": 0.01},
            "position": [0, 0.5, 0.36],
            "rotation": [90, 0, 0],
            "color": "#111111",
        },
    ],
}


def ok(program, *, finish="STOP", text=None) -> tuple[int, dict, bytes]:
    body = {
        "candidates": [
            {
                "content": {
                    "role": "model",
                    "parts": [{"text": text if text is not None else json.dumps(program)}],
                },
                "finishReason": finish,
            }
        ],
        "usageMetadata": {"promptTokenCount": 1800, "candidatesTokenCount": 420},
    }
    return 200, {"Content-Type": "application/json"}, json.dumps(body).encode()


def error(status, message="try later", headers=None) -> tuple[int, dict, bytes]:
    body = {"error": {"code": status, "message": message, "status": "UNAVAILABLE"}}
    return status, headers or {}, json.dumps(body).encode()


class FakeGemini:
    """Answers each POST from `answers`, in order, and keeps every request."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls: list[dict] = []

    def __call__(self, url, headers, body, timeout):
        self.calls.append(
            {"url": url, "headers": headers, "body": json.loads(body), "timeout": timeout}
        )
        return self.answers.pop(0)


def settings(transport=None, slept=None, **env):
    env = {**NO_KEY, **env}
    sleep = slept.append if slept is not None else (lambda s: None)
    return ModelSettings(env=env, transport=transport, sleep=sleep)


@pytest.fixture
def scene(tmp_path):
    return build_scene(tmp_path)


def run(scene, out, backend, s):
    episode, keyframes, tracks, shapes = scene
    log: list[str] = []
    results = build_object_models(
        episode, keyframes, tracks, shapes, out, backend=backend, log=log.append, settings=s
    )
    return {r["id"]: r for r in results}, log


# --- gemini-cad -----------------------------------------------------------------------------------


def test_gemini_cad_sends_the_crops_label_and_size_and_builds_the_program(scene, tmp_path):
    fake = FakeGemini(ok(MUG), ok(MUG))
    out = tmp_path / "s"
    results, _ = run(scene, out, "gemini-cad", settings(fake, GEMINI_API_KEY="k-123"))

    request = fake.calls[0]
    assert request["url"] == f"{API_ROOT}/models/gemini-pro-latest:generateContent"
    assert request["headers"]["x-goog-api-key"] == "k-123"
    assert "k-123" not in request["url"]
    assert request["timeout"] == 120.0
    body = request["body"]
    assert set(body) == {"system_instruction", "contents", "generationConfig"}
    assert body["system_instruction"] == {"parts": [{"text": SYSTEM_INSTRUCTION}]}
    assert body["generationConfig"] == {
        "responseMimeType": "application/json",
        "responseSchema": RESPONSE_SCHEMA,
    }
    [content] = body["contents"]
    assert content["role"] == "user"
    parts = content["parts"]
    intro = parts[0]["text"]
    assert intro.startswith('Object: "cup A" (a container)')
    assert "- white paper cup with a big letter A" in intro
    assert "- White paper cup with a big black letter A, front left" in intro
    assert "Parts of it the lesson points at: cup lid" in intro
    assert "Measured size: 0.080 m across (x) and 0.100 m tall (y)" in intro
    assert "depth was not measured" in intro
    assert "Its main color in the photos is about #c" in intro  # the red cup
    images = [p["inline_data"] for p in parts if "inline_data" in p]
    labels = [p["text"] for p in parts[1:] if "text" in p]
    assert len(images) == 3 and len(labels) == 3
    assert labels[0] == "Photo 1: seen from the front, 29 degrees above it, 0.5 m away."
    assert "toward +x" in labels[1] or "toward +x" in labels[2]
    for image in images:
        assert set(image) == {"mime_type", "data"} and image["mime_type"] == "image/jpeg"
        assert base64.b64decode(image["data"])[:2] == b"\xff\xd8"
    assert [list(p) for p in parts[1:]] == [["text"], ["inline_data"]] * 3

    cup = results["cup"]
    assert (cup["backend"], cup["generator"], cup["cad"]) == (
        "gemini-cad",
        "gemini-pro-latest",
        "cad-cup.json",
    )
    assert cup["model"] == "model-cup.glb" and len(cup["crops"]) == 3
    nodes = read_glb(out / "model-cup.glb")
    assert [n.name for n in nodes] == ["cup", "rim", "letter A"]
    low, high = glb_bounds(out / "model-cup.glb")
    assert high[1] - low[1] == pytest.approx(0.1, abs=1e-6)  # fitted to the measured height
    assert low[1] == pytest.approx(0.0, abs=1e-7)
    assert (low[0] + high[0]) / 2 == pytest.approx(0.0, abs=1e-6)
    np.testing.assert_allclose(cup["size"], high - low, atol=1e-4)
    cad = json.loads((out / "cad-cup.json").read_text())
    assert cad["name"] == "paper cup" and [p["name"] for p in cad["parts"]] == [
        "cup",
        "rim",
        "letter A",
    ]
    assert cad["clio"]["generator"] == "gemini-pro-latest" and cad["clio"]["sizeSource"] == "extent"
    assert cad["clio"]["usage"]["promptTokenCount"] == 1800
    # 0.8 m across for 1 m tall, fitted to 0.1 m tall: 0.081 across against 0.080 measured.
    assert cup["note"] is None

    block = results["block"]
    assert block["backend"] == "gemini-cad" and block["sizeSource"] == "shape"
    block_intro = fake.calls[1]["body"]["contents"][0]["parts"][0]["text"]
    assert block_intro.startswith('Object: "wooden block" (an item)')
    assert "from depth samples on the object" in block_intro
    # The block is 0.12 x 0.06 x 0.08; a cup fitted to 6 cm tall is far narrower and rounder.
    assert block["note"].startswith("Gemini's model is ")


def test_gemini_cad_retries_busy_answers_with_backoff(scene, tmp_path):
    fake = FakeGemini(error(503), error(429, headers={"Retry-After": "3"}), ok(MUG), ok(MUG))
    slept: list[float] = []
    results, _ = run(scene, tmp_path / "s", "gemini-cad", settings(fake, slept, GOOGLE_API_KEY="g"))
    assert results["cup"]["backend"] == "gemini-cad"
    assert slept == [2.0, 3.0]
    assert len(fake.calls) == 4
    assert fake.calls[0]["body"] == fake.calls[2]["body"]


def test_gemini_cad_falls_back_to_a_primitive_saying_why(scene, tmp_path):
    fake = FakeGemini(error(503), error(500), error(502), error(400, "API key not valid"))
    results, log = run(scene, tmp_path / "s", "gemini-cad", settings(fake, GEMINI_API_KEY="k"))
    cup, block = results["cup"], results["block"]
    assert len(fake.calls) == 4  # three tries for the cup, one for the block (400 is final)
    assert (cup["backend"], cup["generator"], cup["cad"]) == ("primitive", None, None)
    assert (
        cup["note"] == "The gemini-cad backend failed (HTTP 502: try later), so it is a primitive."
    )
    assert (
        block["note"]
        == "The gemini-cad backend failed (HTTP 400: API key not valid), so it is a primitive."
    )
    assert read_glb(tmp_path / "s" / "model-cup.glb")[0].name == "cylinder"
    assert not (tmp_path / "s" / "cad-cup.json").exists()
    assert any("cup: gemini-cad failed" in line for line in log)


def test_gemini_cad_without_a_key_draws_primitives_and_calls_nothing(scene, tmp_path):
    fake = FakeGemini()
    results, _ = run(scene, tmp_path / "s", "gemini-cad", settings(fake))
    assert fake.calls == []
    assert results["cup"]["backend"] == "primitive"
    assert "no GEMINI_API_KEY (or GOOGLE_API_KEY) is set" in results["cup"]["note"]


@pytest.mark.parametrize(
    "answer, why",
    [
        (ok(None, text="a mug, roughly"), "the answer is not JSON"),
        (
            ok(None, text='{"parts": [', finish="MAX_TOKENS"),
            "the answer is not JSON (cut off: MAX_TOKENS)",
        ),
        (ok({"name": "x", "parts": [{"shape": "blob"}]}), "no part could be built"),
        (
            (200, {}, json.dumps({"promptFeedback": {"blockReason": "SAFETY"}}).encode()),
            "blocked (SAFETY)",
        ),
        ((200, {}, b"<html>"), "the response is not JSON"),
    ],
)
def test_unusable_answers_fall_back(scene, tmp_path, answer, why):
    fake = FakeGemini(answer, answer)
    results, _ = run(scene, tmp_path / "s", "gemini-cad", settings(fake, GEMINI_API_KEY="k"))
    assert results["cup"]["backend"] == "primitive" and why in results["cup"]["note"]


def test_the_model_name_comes_from_the_environment(scene, tmp_path):
    fake = FakeGemini(ok(MUG), ok(MUG))
    s = settings(fake, GEMINI_API_KEY="k", CLIO_CAD_MODEL="models/gemini-3-pro-preview")
    results, _ = run(scene, tmp_path / "s", "gemini-cad", s)
    assert fake.calls[0]["url"].endswith("/models/gemini-3-pro-preview:generateContent")
    assert results["cup"]["generator"] == "gemini-3-pro-preview"


def test_without_a_photo_gemini_models_it_from_its_name(scene, tmp_path):
    episode, _, tracks, shapes = scene
    fake = FakeGemini(ok(MUG), ok(MUG))
    s = settings(fake, GEMINI_API_KEY="k")
    [cup, _] = build_object_models(
        episode, [], tracks, shapes, tmp_path / "s", backend="gemini-cad", settings=s
    )
    parts = fake.calls[0]["body"]["contents"][0]["parts"]
    assert len(parts) == 1 and "No photo of it was taken" in parts[0]["text"]
    assert cup["backend"] == "gemini-cad" and "from its name alone" in cup["note"]


def test_answers_are_read_past_thoughts_and_code_fences():
    response = {
        "candidates": [
            {
                "content": {
                    "parts": [
                        {"text": "thinking about mugs", "thought": True},
                        {"text": '```json\n{"name": "mug", "parts": []}\n```'},
                    ]
                }
            }
        ]
    }
    assert answer_program(response) == {"name": "mug", "parts": []}
    with pytest.raises(GeminiError, match="no candidate"):
        answer_program({"candidates": []})
    with pytest.raises(GeminiError, match="empty answer"):
        answer_program({"candidates": [{"content": {"parts": []}, "finishReason": "SAFETY"}]})


def test_the_response_schema_stays_in_geminis_openapi_subset():
    # No minItems / maxItems: with several bounded arrays Gemini refuses the whole request (400).
    allowed = {"type", "properties", "required", "items", "enum", "description", "propertyOrdering"}

    def walk(node, path):
        assert set(node) <= allowed, path
        assert node["type"] in {"OBJECT", "ARRAY", "STRING", "NUMBER"}, path
        if node["type"] == "OBJECT":
            assert node["properties"], path
            assert set(node.get("required", [])) <= set(node["properties"]), path
            assert set(node.get("propertyOrdering", node["properties"])) == set(
                node["properties"]
            ), path
            for key, child in node["properties"].items():
                walk(child, f"{path}.{key}")
        if node["type"] == "ARRAY":
            walk(node["items"], f"{path}[]")

    walk(RESPONSE_SCHEMA, "$")
    shapes = RESPONSE_SCHEMA["properties"]["parts"]["items"]["properties"]["shape"]["enum"]
    assert shapes == ["box", "cylinder", "cone", "sphere", "torus", "capsule", "lathe", "extrude"]


def test_the_example_in_the_prompt_is_a_valid_program():
    from clio_pipeline.models.cad import fit_program, validate_program
    from clio_pipeline.models.gemini import _EXAMPLE

    program = validate_program(_EXAMPLE)
    assert program.dropped == () and len(program.parts) == 3
    fitted = fit_program(program, 0.095)
    assert fitted.scale == pytest.approx(1.0)
    assert fitted.size[0] > fitted.size[2]  # the handle sticks out to +x


# --- command --------------------------------------------------------------------------------------

SCRIPT = """\
import sys
from pathlib import Path

import numpy as np

from clio_pipeline.glb import MeshData, Node, write_glb

image, out, label, notes = sys.argv[1:5]
assert Path(image).is_file(), image
(Path(notes) / "label.txt").write_text(label)
# A 2 x 4 x 1 box away from the origin: the pipeline must scale and move it.
p = np.array([[x, y, z] for x in (0, 2) for y in (0, 4) for z in (0, 1)], dtype=np.float32)
t = [[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1],
     [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]]
node = Node("thing", MeshData(p + [5, 1, 5], np.array(t, dtype=np.uint32)), base_color=(1, 0, 0, 1))
write_glb([node], out)
"""


def command(tmp_path, body=SCRIPT) -> str:
    script = tmp_path / "make_model.py"
    script.write_text(body)
    (tmp_path / "notes").mkdir(exist_ok=True)
    return " ".join(
        [
            shlex.quote(sys.executable),
            shlex.quote(str(script)),
            "{image}",
            "{out}",
            "{label}",
            shlex.quote(str(tmp_path / "notes")),
        ]
    )


def test_the_command_backend_scales_and_moves_the_commands_glb(scene, tmp_path):
    template = command(tmp_path)
    out = tmp_path / "s"
    results, _ = run(scene, out, "command", settings(CLIO_MODEL_COMMAND=template))
    cup = results["cup"]
    assert (cup["backend"], cup["generator"], cup["cad"]) == ("command", template, None)
    assert (tmp_path / "notes" / "label.txt").read_text() == "wooden block"  # one argument each
    low, high = glb_bounds(out / "model-cup.glb")
    np.testing.assert_allclose(high - low, [0.05, 0.1, 0.025], atol=1e-6)
    np.testing.assert_allclose(low, [-0.025, 0.0, -0.0125], atol=1e-6)
    np.testing.assert_allclose(cup["size"], [0.05, 0.1, 0.025], atol=1e-4)
    assert (
        cup["note"]
        == "The command's model is 0.050 m across (measured 0.080) after fitting its height."
    )
    doc, _ = parse_glb((out / "model-cup.glb").read_bytes())
    assert doc["scenes"][0]["nodes"] == [1] and doc["nodes"][1]["children"] == [0]  # one new root
    assert not list(out.glob(".*"))  # the command's own output is not left behind


@pytest.mark.parametrize(
    "body, env, why",
    [
        (
            "import sys\nsys.stderr.write('no GPU here')\nsys.exit(3)\n",
            {},
            "it exited with 3: no GPU here",
        ),
        ("pass\n", {}, "it wrote no GLB at {out}"),
        (
            "import time\ntime.sleep(5)\n",
            {"CLIO_MODEL_COMMAND_TIMEOUT": "0.3"},
            "no GLB within 0.3 s",
        ),
        (
            "import sys\nopen(sys.argv[2], 'wb').write(b'not a glb')\n",
            {},
            "not a GLB that can be read",
        ),
    ],
)
def test_a_failing_command_falls_back_to_a_primitive(scene, tmp_path, body, env, why):
    s = settings(CLIO_MODEL_COMMAND=command(tmp_path, body), **env)
    results, _ = run(scene, tmp_path / "s", "command", s)
    assert results["cup"]["backend"] == "primitive"
    assert why in results["cup"]["note"] and results["cup"]["note"].startswith(
        "The command backend failed ("
    )
    assert not list((tmp_path / "s").glob(".*"))


def test_the_command_needs_a_template_a_program_and_a_crop(scene, tmp_path):
    results, _ = run(scene, tmp_path / "a", "command", settings())
    assert "CLIO_MODEL_COMMAND is not set" in results["cup"]["note"]
    results, _ = run(
        scene, tmp_path / "b", "command", settings(CLIO_MODEL_COMMAND="/no/such/tool {image} {out}")
    )
    assert "/no/such/tool was not found" in results["cup"]["note"]
    episode, _, tracks, shapes = scene
    s = settings(CLIO_MODEL_COMMAND=command(tmp_path))
    [cup, _] = build_object_models(
        episode, [], tracks, shapes, tmp_path / "c", backend="command", settings=s
    )
    assert "no crop to give it" in cup["note"]
    assert not Path(tmp_path / "notes" / "label.txt").exists()


def test_a_relative_command_path_runs_from_the_callers_directory(scene, tmp_path, monkeypatch):
    command(tmp_path)  # writes make_model.py and notes/ into tmp_path
    monkeypatch.chdir(tmp_path)
    template = f"{shlex.quote(sys.executable)} make_model.py {{image}} {{out}} {{label}} notes"
    results, _ = run(scene, tmp_path / "s", "command", settings(CLIO_MODEL_COMMAND=template))
    assert results["cup"]["backend"] == "command"
