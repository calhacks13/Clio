"""The triposr and command backends over the synthetic scene of test_models.py, without loading a
model: TripoSR's tool is a fake that answers its JSON jobs with a box GLB written by
clio_pipeline.glb, and the image-to-3D command is a small Python script doing the same."""

import json
import shlex
import sys
from pathlib import Path

import numpy as np
import pytest

from clio_pipeline.glb import glb_bounds, parse_glb
from clio_pipeline.models import ModelSettings, build_object_models
from test_models import BARE_ENV, build_scene

# glb.apply_matrix's matmul goes through Accelerate on macOS, which raises spurious floating point
# flags on exact zeros (inputs and results are finite); they are not this package's to fix.
pytestmark = pytest.mark.filterwarnings("ignore:.*encountered in matmul:RuntimeWarning")


def settings(**env):
    return ModelSettings(env={**BARE_ENV, **env})


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


# --- triposr --------------------------------------------------------------------------------------

FAKE_TRIPOSR = """\
import json
import sys
from pathlib import Path

import numpy as np

from clio_pipeline.glb import MeshData, Node, write_glb

notes = Path(__file__).parent / "notes"
with open(notes / "starts.txt", "a") as f:
    f.write(" ".join(sys.argv[1:]) + "\\n")
mode = (notes / "mode.txt").read_text().strip() if (notes / "mode.txt").exists() else "ok"
if mode == "dead":
    sys.stderr.write("CUDA out of memory\\n")
    sys.exit(1)
print(json.dumps({"ok": True, "ready": True, "device": "cpu"}), flush=True)
# A 2 x 4 x 1 box away from the origin: the pipeline must scale and move it.
p = np.array([[x, y, z] for x in (0, 2) for y in (0, 4) for z in (0, 1)], dtype=np.float32)
t = [[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1],
     [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]]
for n, line in enumerate(sys.stdin):
    job = json.loads(line)
    with open(notes / "jobs.jsonl", "a") as f:
        mask = job["mask"]
        f.write(json.dumps({**job, "image_there": Path(job["image"]).is_file(),
                            "mask_there": bool(mask) and Path(mask).is_file()}) + "\\n")
    if mode == "fail-first" and n == 0:
        answer = {"ok": False, "error": "RuntimeError: TripoSR found no surface"}
        print(json.dumps(answer), flush=True)
        continue
    if mode == "exit-first":
        sys.exit(2)
    box = MeshData(p + [5, 1, 5], np.array(t, dtype=np.uint32))
    write_glb([Node("geometry_0", box)], job["out"])
    print(json.dumps({"ok": True, "vertices": 8, "faces": 12, "seconds": 0.01, "device": "cpu"}),
          flush=True)
"""


def fake_triposr(tmp_path, mode="ok") -> Path:
    """A tool folder laid out like pipeline/tools/triposr after setup.sh, running the fake."""
    tool = tmp_path / "triposr"
    (tool / ".vendor" / "TripoSR").mkdir(parents=True)
    (tool / ".venv" / "bin").mkdir(parents=True)
    (tool / "notes").mkdir()
    python = tool / ".venv" / "bin" / "python"
    # exec, not a symlink: the pipeline's interpreter keeps its environment (numpy, this package).
    python.write_text(f'#!/bin/sh\nexec {shlex.quote(sys.executable)} "$@"\n')
    python.chmod(0o755)
    (tool / "clio_triposr.py").write_text(FAKE_TRIPOSR)
    if mode != "ok":
        (tool / "notes" / "mode.txt").write_text(mode)
    return tool


def jobs(tool: Path) -> list[dict]:
    path = tool / "notes" / "jobs.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def test_triposr_makes_each_model_from_its_best_crop_in_one_process(scene, tmp_path):
    tool = fake_triposr(tmp_path)
    out = tmp_path / "s"
    results, log = run(scene, out, "triposr", settings(CLIO_TRIPOSR_DIR=str(tool)))
    cup = results["cup"]
    assert (cup["backend"], cup["generator"]) == ("triposr", "TripoSR (grid 128)")
    low, high = glb_bounds(out / "model-cup.glb")
    np.testing.assert_allclose(high - low, [0.08, 0.1, 0.08], atol=1e-6)  # the measured box
    np.testing.assert_allclose(low, [-0.04, 0.0, -0.04], atol=1e-6)  # bottom center at origin
    assert (
        "TripoSR's model was stretched to the measured size (1.6x across, 3.2x deep)" in cup["note"]
    )
    doc, _ = parse_glb((out / "model-cup.glb").read_bytes())
    assert doc["scenes"][0]["nodes"] == [1] and doc["nodes"][1]["children"] == [0]
    starts = (tool / "notes" / "starts.txt").read_text().splitlines()
    assert len(starts) == 1 and "--serve --mc-resolution 128 --device auto" in starts[0]
    sent = jobs(tool)
    assert len(sent) == len(results) and all(job["image_there"] for job in sent)
    # The cup's best view came from the tracker, so its outline is the mask; nothing is left behind.
    assert sent[0]["mask_there"]
    assert any("triposr (cut out by the tracker's outline)" in line for line in log)
    assert not list(out.glob(".*"))


def test_the_grid_and_device_come_from_the_environment(scene, tmp_path):
    tool = fake_triposr(tmp_path)
    s = settings(
        CLIO_TRIPOSR_DIR=str(tool), CLIO_TRIPOSR_RESOLUTION="256", CLIO_TRIPOSR_DEVICE="cpu"
    )
    results, _ = run(scene, tmp_path / "s", "triposr", s)
    assert results["cup"]["generator"] == "TripoSR (grid 256)"
    assert "--mc-resolution 256 --device cpu" in (tool / "notes" / "starts.txt").read_text()


def test_triposr_not_set_up_draws_primitives_saying_how_to_set_it_up(scene, tmp_path):
    results, _ = run(
        scene, tmp_path / "s", "triposr", settings(CLIO_TRIPOSR_DIR=str(tmp_path / "none"))
    )
    for result in results.values():
        assert result["backend"] == "primitive"
        assert "TripoSR is not set up: run" in result["note"] and "setup.sh" in result["note"]


def test_one_failed_object_is_a_primitive_and_the_next_still_uses_triposr(scene, tmp_path):
    tool = fake_triposr(tmp_path, "fail-first")
    results, _ = run(scene, tmp_path / "s", "triposr", settings(CLIO_TRIPOSR_DIR=str(tool)))
    first, second = results.values()
    assert first["backend"] == "primitive"
    assert "The triposr backend failed (RuntimeError: TripoSR found no surface)" in first["note"]
    assert second["backend"] == "triposr"


@pytest.mark.parametrize(
    "mode, why", [("dead", "TripoSR did not start"), ("exit-first", "TripoSR stopped answering")]
)
def test_a_triposr_that_dies_leaves_primitives_for_the_rest(scene, tmp_path, mode, why):
    tool = fake_triposr(tmp_path, mode)
    results, _ = run(scene, tmp_path / "s", "triposr", settings(CLIO_TRIPOSR_DIR=str(tool)))
    for result in results.values():
        assert result["backend"] == "primitive" and why in result["note"]
    assert len((tool / "notes" / "starts.txt").read_text().splitlines()) == 1  # never restarted
    assert not list((tmp_path / "s").glob(".*"))


def test_triposr_needs_a_crop(scene, tmp_path):
    tool = fake_triposr(tmp_path)
    episode, _, tracks, shapes = scene
    s = settings(CLIO_TRIPOSR_DIR=str(tool))
    results = build_object_models(
        episode, [], tracks, shapes, tmp_path / "s", backend="triposr", settings=s
    )
    assert all("no crop to give it" in r["note"] for r in results)
    assert not (tool / "notes" / "starts.txt").exists()  # not started for nothing


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
    assert (cup["backend"], cup["generator"]) == ("command", template)
    assert (tmp_path / "notes" / "label.txt").read_text() == "wooden block"  # one argument each
    low, high = glb_bounds(out / "model-cup.glb")
    np.testing.assert_allclose(high - low, [0.08, 0.1, 0.08], atol=1e-6)
    np.testing.assert_allclose(low, [-0.04, 0.0, -0.04], atol=1e-6)
    np.testing.assert_allclose(cup["size"], [0.08, 0.1, 0.08], atol=1e-4)
    assert cup["note"] == (
        "The command's model was stretched to the measured size (1.6x across, 3.2x deep)."
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
