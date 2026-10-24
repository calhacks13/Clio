import json

import numpy as np
import pytest

from clio_pipeline.episode import load_episode
from clio_pipeline.schema import EpisodeValidationError

Q_Y90 = [0.0, 0.7071, 0.0, 0.7071]


def test_arrays_have_the_documented_shapes_and_dtypes(episode_dir):
    ep = load_episode(episode_dir)

    assert ep.n_frames == 180
    assert (ep.t.shape, ep.t.dtype) == ((180,), np.float64)
    assert ep.head.shape == (180, 7)
    assert (ep.hands.shape, ep.hands.dtype) == ((180, 2, 25, 8), np.float32)
    assert ep.pinch.shape == (180, 2)
    assert ep.tracked.shape == (180, 2)


def test_frame_values_land_in_the_right_slots(new_episode):
    b = new_episode()
    b.frame(
        0.0,
        left=b.hand((0.1, 0.2, -0.3), pinch=0.03),
        right=b.hand((0.5, 0.25, -0.2), Q_Y90, pinch=0.04),
    )
    b.frame(
        12.5,
        left=None,
        right=b.hand((0.5, 0.26, -0.2), pinch=0.02),
        head=[0.0, 1.6, 0.1, 0.0, 0.0, 0.0, 1.0],
    )
    ep = load_episode(b.write())

    np.testing.assert_allclose(ep.t, [0.0, 12.5])
    np.testing.assert_allclose(ep.head[1], [0.0, 1.6, 0.1, 0.0, 0.0, 0.0, 1.0])
    # index 0 = left, joint 0 = wrist; the builder puts the index tip (joint 9) 2 cm to the
    # side and 17 cm forward of the wrist, and the pinky tip (joint 24) 3.4 cm the other way.
    np.testing.assert_allclose(ep.hands[0, 0, 0], [0.1, 0.2, -0.3, 0, 0, 0, 1, 0.01], atol=1e-6)
    np.testing.assert_allclose(ep.hands[0, 0, 9, :3], [0.12, 0.2, -0.47], atol=1e-6)
    np.testing.assert_allclose(ep.hands[0, 0, 24, :3], [0.066, 0.2, -0.45], atol=1e-6)
    np.testing.assert_allclose(ep.hands[0, 1, 0, 3:7], Q_Y90, atol=1e-6)
    np.testing.assert_allclose(ep.pinch[0], [0.03, 0.04], atol=1e-6)
    # frame 1: left hand missing
    assert np.isnan(ep.hands[1, 0]).all()
    assert np.isnan(ep.pinch[1, 0])
    np.testing.assert_allclose(ep.hands[1, 1, 0, :3], [0.5, 0.26, -0.2], atol=1e-6)
    assert ep.tracked.tolist() == [[True, True], [False, True]]


def test_missing_hand_is_nan_only_while_untracked(episode_dir):
    ep = load_episode(episode_dir)

    right = ep.hands[:, 1]
    assert np.isnan(right[60:90]).all()
    assert not np.isnan(right[:60]).any() and not np.isnan(right[90:]).any()
    assert not np.isnan(ep.hands[:, 0]).any()
    assert ep.tracked[:, 1].sum() == 150


def test_events_are_in_time_order_and_selectable_by_type(episode_dir):
    ep = load_episode(episode_dir)

    entered = ep.events_of("step.entered")
    assert [e["stepId"] for e in entered] == ["lay-flat", "pinch-shoulder", "pinch-middle"]
    assert [e["t"] for e in ep.events_of("step.entered", "step.completed")] == [
        100.0,
        1000.0,
        1000.0,
        2000.0,
        2000.0,
    ]
    assert len(ep.events_of("coach.tool_call")) == 3


def test_events_out_of_order_on_disk_are_sorted_keeping_ties_in_file_order(new_episode):
    b = new_episode()
    b.frame(0.0)
    b.event(300.0, "annotation", label="late")
    b.step_completed(100.0, "a", 0)
    b.step_entered(100.0, "b", 1, "Do B.")
    b.event(50.0, "annotation", label="early")
    ep = load_episode(b.write())

    assert [(e["t"], e["type"]) for e in ep.events] == [
        (50.0, "annotation"),
        (100.0, "step.completed"),
        (100.0, "step.entered"),
        (300.0, "annotation"),
    ]


def test_object_tracks_start_at_the_meta_placement_and_apply_updates(episode_dir):
    ep = load_episode(episode_dir)

    shoulder = ep.objects["shoulder"]
    assert (shoulder.label, shoulder.radius) == ("shoulder dot", 0.025)
    np.testing.assert_allclose(shoulder.t, [0.0, 500.0, 2000.0])
    np.testing.assert_allclose(
        shoulder.position, [[0.14, 0.0, -0.18], [0.141, 0.0, -0.181], [0.15, 0.02, -0.18]]
    )
    assert shoulder.source == ["layout", "pinch", "pinch"]
    np.testing.assert_allclose(shoulder.position_at(1999.0), [0.141, 0.0, -0.181])
    np.testing.assert_allclose(shoulder.position_at(2000.0), [0.15, 0.02, -0.18])

    middle = ep.objects["middle"]
    np.testing.assert_allclose(middle.t, [0.0, 2000.0])
    assert np.isnan(middle.orientation[0]).all()  # layout placement: orientation unknown
    np.testing.assert_allclose(middle.orientation[1], [0, 0, 0, 1])
    np.testing.assert_allclose(ep.objects["hem"].t, [0.0])
    assert len(ep.object_updates) == 2


def test_object_seen_only_by_the_tracker_starts_at_its_first_update(new_episode):
    b = new_episode(objects=[])
    b.frame(0.0)
    b.track(250.0, b.object_state("syringe", [0.2, 0.05, -0.1], orientation=[0, 0, 0, 1]))
    ep = load_episode(b.write())

    syringe = ep.objects["syringe"]
    np.testing.assert_allclose(syringe.t, [250.0])
    assert np.isnan(syringe.position_at(100.0)).all()
    np.testing.assert_allclose(syringe.position_at(300.0), [0.2, 0.05, -0.1])


def test_finish_media_and_meta_accessors(episode_dir):
    ep = load_episode(episode_dir)

    assert ep.episode_id == "ep-20261024-031502-test"
    assert ep.procedure_title == "Fold a T-shirt in two seconds"
    assert ep.finish["outcome"] == "interrupted"
    assert ep.media == {"egocentric.webm": episode_dir / "media" / "egocentric.webm"}
    assert ep.plan is None


def test_optional_files_may_be_absent(episode_dir):
    (episode_dir / "objects.ndjson").unlink()
    (episode_dir / "finish.json").unlink()

    ep = load_episode(episode_dir)

    assert ep.finish is None
    assert ep.object_updates == []
    np.testing.assert_allclose(ep.objects["shoulder"].t, [0.0])


def test_plan_is_exposed_when_present(planned_episode_dir):
    ep = load_episode(planned_episode_dir)

    assert ep.plan["origin"] == {
        "kind": "generated",
        "goal": "fold my t-shirt fast",
        "model": "gemini-test",
        "createdAt": "2026-10-24T03:14:00.000Z",
    }


def test_episode_without_frames_loads_as_empty_arrays(new_episode):
    ep = load_episode(new_episode().write())

    assert ep.n_frames == 0
    assert ep.hands.shape == (0, 2, 25, 8)
    assert ep.duration_ms == 0.0


def test_validate_true_raises_with_the_issues(episode_dir):
    frames = episode_dir / "frames.ndjson"
    lines = frames.read_text().splitlines()
    record = json.loads(lines[4])
    del record["head"]
    lines[4] = json.dumps(record)
    frames.write_text("\n".join(lines) + "\n")

    with pytest.raises(EpisodeValidationError) as info:
        load_episode(episode_dir, validate=True)

    assert [(i.file, i.line) for i in info.value.issues] == [("frames.ndjson", 5)]
    assert "frames.ndjson:5" in str(info.value)


def test_unreadable_frame_without_validation_names_the_line(episode_dir):
    frames = episode_dir / "frames.ndjson"
    lines = frames.read_text().splitlines()
    lines[6] = '{"t": 100.0, "left": null, "right": null}'
    frames.write_text("\n".join(lines) + "\n")

    with pytest.raises(ValueError, match=r"frames\.ndjson:7"):
        load_episode(episode_dir)


def test_directory_without_meta_is_rejected(tmp_path):
    with pytest.raises(FileNotFoundError, match="meta.json"):
        load_episode(tmp_path)
