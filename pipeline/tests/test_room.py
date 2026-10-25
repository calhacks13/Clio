"""The compile's `room` stage: the Quest room scan kept as room.glb and summed up in
environment.json (room.py). Compiled files are checked against the generated JSON Schemas with
plain jsonschema, like test_compile.py."""

import copy
import json
import os
from pathlib import Path

import jsonschema
import numpy as np
import pytest

from clio_pipeline.compile import compile_episode
from clio_pipeline.glb import parse_glb, read_glb
from clio_pipeline.room import RoomScan, room_doc, room_scan_media
from clio_pipeline.schema import validate_derived
from conftest import (
    GLOBAL_MESH_POSE,
    QUARTER_TURN_Y,
    ROOM_MESHES,
    TABLE_MESH_POSE,
    box_mesh,
    build_room_scan,
    room_glb,
    room_scan_glb,
)

SCHEMA_DIR = Path(__file__).resolve().parents[2] / "packages" / "protocol" / "schema"
GLOBAL_BOUNDS = {"min": [-1.6, -0.75, -1.5], "max": [2.4, 1.75, 2.5]}
TABLE_BOUNDS = {"min": [0.0, -0.74, -0.6], "max": [0.8, 0.0, 0.0]}


def _read(path):
    return json.loads(Path(path).read_text())


def _schema_errors(doc, schema_file):
    schema = json.loads((SCHEMA_DIR / schema_file).read_text())
    return [
        f"{list(e.absolute_path)}: {e.message[:200]}"
        for e in jsonschema.Draft202012Validator(schema).iter_errors(doc)
    ]


def _stage(result, name="room"):
    return next(s for s in result.manifest["stages"] if s["name"] == name)


def _environment(result):
    return _read(result.out_dir / "environment.json")


def _table_glb(translation=(1.0, 0.0, -1.0)) -> bytes:
    corners, triangles = box_mesh([-0.1, 0.0, -0.1], [0.1, 0.2, 0.1])
    node = {
        "name": "mesh-2",
        "translation": list(translation),
        "rotation": [0.0, 0.0, 0.0, 1.0],
        "positions": corners,
        "indices": triangles,
        "extras": {"kind": "table", "label": "table", "global": False},
    }
    return room_glb([node])


def test_the_room_scan_compiles_into_room_glb_and_the_environment(room_scan_episode_dir, tmp_path):
    result = compile_episode(room_scan_episode_dir, tmp_path / "derived")

    assert _stage(result) == {"name": "room", "status": "ok"}
    kinds = {a["name"]: a["kind"] for a in result.manifest["artifacts"]}
    assert kinds == {"tracks.json": "tracks", "room.glb": "room", "environment.json": "environment"}
    room = next(a for a in result.manifest["artifacts"] if a["kind"] == "room")
    assert room["bytes"] == (result.out_dir / "room.glb").stat().st_size
    environment = _environment(result)
    assert _schema_errors(environment, "derived-environment.schema.json") == []
    assert _schema_errors(result.manifest, "derived-manifest.schema.json") == []
    assert environment["room"] == {
        "file": "room.glb",
        "source": "quest-scene",
        "media": "room-scan-1.glb",
        "snapshotT": 0.0,
        "snapshots": 1,
        "meshes": [
            {**ROOM_MESHES[0], "bounds": GLOBAL_BOUNDS},
            {**ROOM_MESHES[1], "bounds": TABLE_BOUNDS},
        ],
    }
    assert validate_derived(result.out_dir) == []


def test_room_glb_keeps_the_node_layout_in_w_and_adds_normals(room_scan_episode_dir, tmp_path):
    result = compile_episode(room_scan_episode_dir, tmp_path / "derived")

    original = read_glb(room_scan_episode_dir / "media" / "room-scan-1.glb")
    kept = read_glb(result.out_dir / "room.glb")
    assert [n.name for n in kept] == ["mesh-1", "mesh-2"]
    for before, after in zip(original, kept, strict=True):
        np.testing.assert_allclose(after.translation, before.translation, atol=1e-7)
        np.testing.assert_allclose(after.rotation, before.rotation, atol=1e-7)
        np.testing.assert_array_equal(after.mesh.positions, before.mesh.positions)
        np.testing.assert_array_equal(after.mesh.indices, before.mesh.indices)
        assert before.mesh.normals is None and after.mesh.normals.shape == (8, 3)
        assert after.extras == before.extras
    np.testing.assert_allclose(kept[1].translation, TABLE_MESH_POSE[0])
    np.testing.assert_allclose(kept[1].rotation, QUARTER_TURN_Y, atol=1e-7)
    np.testing.assert_allclose(kept[0].translation, GLOBAL_MESH_POSE[0])
    # The floor's normals point up, whichever way the scan wound it.
    floor = kept[0].mesh.normals[:4]
    np.testing.assert_allclose(np.abs(floor), [[0, 1, 0]] * 4, atol=1e-6)
    doc, _ = parse_glb((result.out_dir / "room.glb").read_bytes())
    assert doc["scenes"][0]["extras"] == {
        "source": "quest-scene",
        "media": "room-scan-1.glb",
        "snapshotT": 0.0,
    }


def test_the_last_snapshot_that_arrived_is_kept(tmp_path):
    b = build_room_scan(tmp_path)
    moved = copy.deepcopy(ROOM_MESHES[1:])
    b.room_scan(1500.0, 2, _table_glb(), moved)
    b.room_scan(2500.0, 3, None, moved)  # its upload was dropped
    b.events.sort(key=lambda e: e["t"])

    result = compile_episode(b.write(), tmp_path / "derived")

    assert _stage(result) == {"name": "room", "status": "ok"}
    room = _environment(result)["room"]
    assert (room["media"], room["snapshotT"], room["snapshots"]) == ("room-scan-2.glb", 1500.0, 3)
    assert room["meshes"] == [
        {
            **ROOM_MESHES[1],
            "bounds": {"min": [0.9, 0.0, -1.1], "max": [1.1, 0.2, -0.9]},
        }
    ]
    assert [n.name for n in read_glb(result.out_dir / "room.glb")] == ["mesh-2"]


def test_an_unreadable_later_snapshot_is_passed_over_and_said(tmp_path):
    b = build_room_scan(tmp_path)
    b.room_scan(1500.0, 2, b"glTF but not really", copy.deepcopy(ROOM_MESHES))
    b.events.sort(key=lambda e: e["t"])

    result = compile_episode(b.write(), tmp_path / "derived")

    stage = _stage(result)
    assert stage["status"] == "ok"
    assert stage["detail"].startswith("kept room-scan-1.glb; room-scan-2.glb is unreadable (")
    assert _environment(result)["room"]["media"] == "room-scan-1.glb"
    assert validate_derived(result.out_dir) == []


def test_an_unreadable_room_scan_fails_only_its_stage(tmp_path):
    b = build_room_scan(tmp_path)
    b.media["room-scan-1.glb"] = room_scan_glb()[:200]  # cut off mid-upload

    result = compile_episode(b.write(), tmp_path / "derived")

    stage = _stage(result)
    assert stage["status"] == "failed"
    assert stage["detail"].startswith("ValueError: room-scan-1.glb is unreadable (")
    assert _environment(result)["room"] is None
    assert not (result.out_dir / "room.glb").exists()
    assert "room" not in {a["kind"] for a in result.manifest["artifacts"]}
    assert [s["status"] for s in result.manifest["stages"] if s["name"] != "room"] == [
        "ok",
        "skipped",
        "ok",
        "skipped",
        "ok",
    ]
    assert validate_derived(result.out_dir) == []


def test_without_a_room_scan_the_stage_is_skipped(featured_episode_dir, tmp_path):
    result = compile_episode(featured_episode_dir, tmp_path / "derived")

    assert _stage(result) == {"name": "room", "status": "skipped", "detail": "no room scan"}
    assert _environment(result)["room"] is None
    assert not (result.out_dir / "room.glb").exists()


def test_a_room_scan_that_never_arrived_is_skipped(tmp_path):
    b = build_room_scan(tmp_path)
    del b.media["room-scan-1.glb"]

    result = compile_episode(b.write(), tmp_path / "derived")

    assert _stage(result) == {
        "name": "room",
        "status": "skipped",
        "detail": "no room scan arrived (room-scan-1.glb not in media/)",
    }
    assert _environment(result)["room"] is None


def test_a_failing_environment_stage_keeps_room_glb(room_scan_episode_dir, tmp_path, monkeypatch):
    from clio_pipeline import compile as compile_module

    def broken(episode):
        raise RuntimeError("no planes today")

    monkeypatch.setattr(compile_module, "environment_doc", broken)

    result = compile_episode(room_scan_episode_dir, tmp_path / "derived")

    assert _stage(result)["status"] == "ok"
    assert _stage(result, "environment")["status"] == "failed"
    assert [a["name"] for a in result.manifest["artifacts"]] == ["tracks.json", "room.glb"]
    assert validate_derived(result.out_dir) == []


# --- staleness ------------------------------------------------------------------------------------


def test_room_scan_glbs_are_compile_inputs(room_scan_episode_dir, tmp_path):
    (room_scan_episode_dir / "media" / "keyframe-0001.jpg").write_bytes(b"\xff\xd8 not a jpeg")

    result = compile_episode(room_scan_episode_dir, tmp_path / "derived")

    names = [i["name"] for i in result.manifest["inputs"]]
    assert names[-1] == "media/room-scan-1.glb" and "media/keyframe-0001.jpg" not in names
    glb = next(i for i in result.manifest["inputs"] if i["name"] == "media/room-scan-1.glb")
    assert glb["bytes"] == (room_scan_episode_dir / "media" / "room-scan-1.glb").stat().st_size


def test_a_room_scan_that_arrives_late_makes_the_compile_stale(tmp_path):
    b = build_room_scan(tmp_path)
    glb = b.media.pop("room-scan-1.glb")
    path = b.write()
    first = compile_episode(path, tmp_path / "derived")
    assert _stage(first)["status"] == "skipped"

    (path / "media" / "room-scan-1.glb").write_bytes(glb)
    again = compile_episode(path, tmp_path / "derived", if_stale=True)

    assert again.skipped is False
    assert _stage(again) == {"name": "room", "status": "ok"}
    assert compile_episode(path, tmp_path / "derived", if_stale=True).skipped is True


@pytest.mark.parametrize("change", ["same size", "removed", "keyframe arrived"])
def test_changes_to_media_and_staleness(room_scan_episode_dir, tmp_path, change):
    compile_episode(room_scan_episode_dir, tmp_path / "derived")
    glb = room_scan_episode_dir / "media" / "room-scan-1.glb"
    if change == "same size":
        data = bytearray(glb.read_bytes())
        data[-2] ^= 0x01  # the last triangle now refers to another vertex
        glb.write_bytes(bytes(data))
    elif change == "removed":
        os.remove(glb)
    else:
        (room_scan_episode_dir / "media" / "keyframe-0001.jpg").write_bytes(b"\xff\xd8")

    again = compile_episode(room_scan_episode_dir, tmp_path / "derived", if_stale=True)

    assert again.skipped is (change == "keyframe arrived")


def test_room_scan_media_lists_snapshots_in_number_order(tmp_path):
    media = tmp_path / "media"
    media.mkdir()
    for name in ["room-scan-10.glb", "room-scan-2.glb", "room-scan-x.glb", "keyframe-0001.jpg"]:
        (media / name).write_bytes(b"")
    (media / "room-scan-3.glb").mkdir()

    assert room_scan_media(tmp_path) == ["room-scan-2.glb", "room-scan-10.glb"]
    assert room_scan_media(tmp_path / "nowhere") == []


# --- validation -----------------------------------------------------------------------------------


@pytest.mark.parametrize("problem", ["indices", "nan"])
def test_a_room_scan_no_viewer_could_draw_is_unreadable(tmp_path, problem):
    corners, triangles = box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0])
    if problem == "indices":
        triangles[3][1] = 8
    else:
        corners[2][1] = float("nan")
    node = {**_node("mesh-2"), "positions": corners, "indices": triangles}
    b = build_room_scan(tmp_path)
    b.media["room-scan-1.glb"] = room_glb([node])

    result = compile_episode(b.write(), tmp_path / "derived")

    assert _stage(result)["status"] == "failed"
    assert "mesh-2: " in _stage(result)["detail"]
    assert _environment(result)["room"] is None


def test_validate_derived_reads_room_glb(room_scan_episode_dir, tmp_path):
    result = compile_episode(room_scan_episode_dir, tmp_path / "derived")
    (result.out_dir / "room.glb").write_bytes(b"not a glb")

    issues = [str(issue) for issue in validate_derived(result.out_dir)]

    assert len(issues) == 1 and issues[0].startswith("room.glb: not a readable GLB")


# --- the summary ----------------------------------------------------------------------------------


def _scan(nodes, meshes) -> RoomScan:
    return RoomScan("room-scan-1.glb", 0.0, 1, read_glb(room_glb(nodes)), meshes)


def _node(name, extras=None, translation=(0.0, 0.0, 0.0)):
    corners, triangles = box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0])
    return {
        "name": name,
        "translation": list(translation),
        "rotation": [0.0, 0.0, 0.0, 1.0],
        "positions": corners,
        "indices": triangles,
        "extras": extras or {},
    }


def test_the_summary_lists_the_events_meshes_then_the_rest():
    listed = [
        {"id": "mesh-3", "kind": "couch", "label": "couch", "global": False},
        {"id": "mesh-9", "kind": "table", "label": "table", "global": False},  # no geometry
        {"id": "mesh-4", "kind": "sofa?", "label": 7, "global": "yes"},  # not what the schema says
    ]
    nodes = [
        _node("mesh-4"),
        _node("mesh-5", {"kind": "wall", "label": "wall art", "global": False}, (2.0, 0.0, 0.0)),
        _node("mesh-3"),
    ]

    doc = room_doc(_scan(nodes, listed))

    assert [m["id"] for m in doc["meshes"]] == ["mesh-3", "mesh-9", "mesh-4", "mesh-5"]
    by_id = {m["id"]: m for m in doc["meshes"]}
    assert by_id["mesh-9"] == {
        "id": "mesh-9",
        "kind": "table",
        "label": "table",
        "global": False,
        "vertices": 0,
        "triangles": 0,
        "bounds": None,
    }
    assert (by_id["mesh-4"]["kind"], by_id["mesh-4"]["label"], by_id["mesh-4"]["global"]) == (
        "other",
        None,
        False,
    )
    assert by_id["mesh-5"]["kind"] == "wall" and by_id["mesh-5"]["label"] == "wall art"
    assert by_id["mesh-5"]["bounds"] == {"min": [2.0, 0.0, 0.0], "max": [3.0, 1.0, 1.0]}
    assert (by_id["mesh-3"]["vertices"], by_id["mesh-3"]["triangles"]) == (8, 12)
