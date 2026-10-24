from collections import defaultdict

import pytest

rr = pytest.importorskip("rerun")
pa = pytest.importorskip("pyarrow")

from clio_pipeline.episode import load_episode  # noqa: E402
from clio_pipeline.rerun_view import save_rrd  # noqa: E402


def _read(path):
    """entity path -> list of rows; each row maps 'time' (ms, None if static) and every
    'Archetype:component' column to its value."""
    from rerun.chunk import RrdReader

    rows = defaultdict(list)
    for chunk in RrdReader(path).stream().to_chunks():
        batch = chunk.to_record_batch()
        names = batch.schema.names
        times = (
            [
                None if ns is None else ns / 1e6
                for ns in batch.column("time").cast(pa.int64()).to_pylist()
            ]
            if "time" in names
            else [None] * batch.num_rows
        )
        for r in range(batch.num_rows):
            row = {"time": times[r]}
            row.update({n: batch.column(n)[r].as_py() for n in names if ":" in n})
            rows[chunk.entity_path].append(row)
    for entity in rows:
        rows[entity].sort(key=lambda row: (row["time"] is not None, row["time"] or 0.0))
    return rows


def _texts(rows):
    return [(round(r["time"]), r["TextLog:text"][0]) for r in rows if r.get("TextLog:text")]


@pytest.fixture(autouse=True)
def strict_rerun():
    """Rerun normally turns logging errors into warnings; make them fail the test instead."""
    rr.set_strict_mode(True)
    yield
    rr.set_strict_mode(False)


@pytest.fixture
def recording(episode_dir, tmp_path):
    return _read(save_rrd(load_episode(episode_dir), tmp_path / "out.rrd"))


def test_world_uses_the_y_up_workspace_convention(recording):
    [world] = recording["/world"]
    assert world["ViewCoordinates:xyz"] == [[3, 1, 6]]  # Right, Up, Back (RUB)


def test_hand_joints_are_logged_while_tracked(recording):
    left = recording["/world/hands/left/joints"]
    right = recording["/world/hands/right/joints"]
    assert (len(left), len(right)) == (180, 150)  # the right hand is untracked for 30 frames
    assert len(left[0]["Points3D:positions"]) == 25
    assert left[0]["Points3D:positions"][0] == pytest.approx([0.1, 0.08, -0.18])
    assert left[6]["time"] == pytest.approx(100.0)  # timeline in seconds (read back as ms)
    assert len(recording["/world/hands/left/bones"][0]["LineStrips3D:strips"]) == 5


def test_untracked_hand_is_cleared_when_tracking_drops(recording):
    clears = [r for r in recording["/world/hands/right"] if "Clear:is_recursive" in r]
    assert [round(r["time"]) for r in clears] == [1000]


def test_head_pose_and_frustum(recording):
    head = [r for r in recording["/world/head"] if "Transform3D:translation" in r]
    assert len(head) == 180
    assert head[0]["Transform3D:translation"][0] == pytest.approx([0.3, 0.45, 0.35])
    assert "Pinhole:image_from_camera" in recording["/world/head/view"][0]


def test_objects_start_at_their_placement_then_follow_the_tracker(recording):
    shoulder = [r for r in recording["/world/objects/shoulder"] if "Boxes3D:centers" in r]
    assert [round(r["time"]) for r in shoulder] == [0, 500, 2000]
    assert shoulder[0]["Boxes3D:centers"][0] == pytest.approx([0.14, 0.0, -0.18])
    assert shoulder[2]["Boxes3D:centers"][0] == pytest.approx([0.15, 0.02, -0.18])
    assert "shoulder dot" in shoulder[0]["Boxes3D:labels"][0]
    middle = [r for r in recording["/world/objects/middle"] if "Boxes3D:centers" in r]
    assert middle[0]["Boxes3D:quaternions"] == []  # layout placement: orientation unknown
    assert middle[1]["Boxes3D:quaternions"][0] == pytest.approx([0, 0, 0, 1])  # marker


def test_pinch_apertures_are_scalar_series(recording):
    left = [r for r in recording["/pinch/left"] if "Scalars:scalars" in r]
    assert len(left) == 180
    assert left[0]["Scalars:scalars"][0] == pytest.approx(0.05)


def test_step_boundaries_mistakes_and_coach_activity_are_text_logs(recording):
    steps = _texts(recording["/events/steps"])
    assert [t for t, _ in steps] == [100, 1000, 1000, 2000, 2000]
    assert "Lay the shirt flat in the outline" in steps[0][1]
    assert "Keep holding. With your right hand, pinch the middle dot." in steps[4][1]
    assert _texts(recording["/events/mistakes"]) == [
        (1500, "wrong_hand (rule): Use your left hand for the shoulder dot.")
    ]
    calls = _texts(recording["/events/coach/tool_calls"])
    assert [t for t, _ in calls] == [950, 1550, 2100]
    assert calls[2][1].startswith("highlight(")
    assert [text for _, text in _texts(recording["/events/transcript"])] == [
        "coach: Lay the shirt flat.",
        "user: Ready",
    ]


def test_step_text_names_the_plan_action(planned_episode_dir, tmp_path):
    recording = _read(save_rrd(load_episode(planned_episode_dir), tmp_path / "planned.rrd"))

    entered = [text for t, text in _texts(recording["/events/steps"]) if t == 1000][-1]
    assert entered.endswith("[action: pinch shoulder]")


def test_object_update_without_orientation_clears_the_previous_one(new_episode, tmp_path):
    b = new_episode(objects=[])
    b.frame(0.0)
    b.track(100.0, b.object_state("cup", [0.1, 0.0, -0.1], orientation=[0, 0, 0, 1]))
    b.track(200.0, b.object_state("cup", [0.2, 0.0, -0.1], source="detector"))
    recording = _read(save_rrd(load_episode(b.write()), tmp_path / "cup.rrd"))

    rows = [r for r in recording["/world/objects/cup"] if "Boxes3D:centers" in r]
    assert [round(r["time"]) for r in rows] == [100, 200]
    assert rows[0]["Boxes3D:quaternions"] == [[0, 0, 0, 1]]
    assert rows[1]["Boxes3D:quaternions"] == []  # cleared, not left at the marker's value


def test_current_step_reverts_to_the_title_when_the_procedure_is_aborted(new_episode, tmp_path):
    b = new_episode()
    for k in range(5):
        b.frame(k * 100.0)
    b.step_entered(100.0, "a", 0, "Do A.")
    b.event(300.0, "procedure.aborted", reason="user quit")
    recording = _read(save_rrd(load_episode(b.write()), tmp_path / "aborted.rrd"))

    docs = [(round(r["time"]), r["TextDocument:text"][0]) for r in recording["/steps/current"]]
    assert docs == [
        (0, "Fold a T-shirt in two seconds"),
        (100, "Step 0: Do A."),
        (300, "Fold a T-shirt in two seconds"),
    ]


def _detected(t, object_id, phrase, found, position=None, confidence=0.0):
    return {
        "objectId": object_id,
        "stepId": "open-cap",
        "phrase": phrase,
        "description": f"the {phrase}",
        "found": found,
        "point": [0.5, 0.4] if found else None,
        "box": [0.45, 0.35, 0.55, 0.45] if found else None,
        "outline": None,
        "confidence": confidence,
        "position": position,
        "source": "jev",
        "latencyMs": 850.0,
    }


def test_detections_are_points_where_the_finder_saw_them(new_episode, tmp_path):
    b = new_episode()
    b.frame(0.0)
    b.event(
        400.0, "object.detected", **_detected(400, "cap", "blue cap", True, [0.2, 0.1, -0.3], 0.87)
    )
    b.event(400.0, "object.detected", **_detected(400, "jug", "fluid jug", False))
    recording = _read(save_rrd(load_episode(b.write()), tmp_path / "detections.rrd"))

    [cap] = [r for r in recording["/world/detections/cap"] if "Points3D:positions" in r]
    assert round(cap["time"]) == 400
    assert cap["Points3D:positions"][0] == pytest.approx([0.2, 0.1, -0.3])
    assert cap["Points3D:labels"] == ["blue cap"]
    assert "/world/detections/jug" not in recording
    assert _texts(recording["/events/detections"]) == [
        (400, "cap 'blue cap': found (0.87) by jev in 850 ms"),
        (400, "jug 'fluid jug': not found by jev in 850 ms"),
    ]
