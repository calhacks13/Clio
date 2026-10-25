import json

import numpy as np
import pytest

from clio_pipeline.episode import ObjectTrack, load_episode
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
    ep = load_episode(b.write(), validate=True)

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


def test_older_episodes_get_location_flags_from_each_estimates_source(episode_dir):
    ep = load_episode(episode_dir)

    # layout and pinch: position valid; marker with an orientation: everything valid and tracked
    assert ep.objects["shoulder"].flags.tolist() == [2, 2, 2]
    assert ep.objects["middle"].flags.tolist() == [2, 15]
    assert ep.objects["shoulder"].flags.dtype == np.uint8


def test_detector_and_markers_without_orientation_are_position_tracked_only(new_episode):
    b = new_episode(objects=[])
    b.frame(0.0)
    b.track(100.0, b.object_state("a", [0, 0, 0], source="detector"))
    b.track(200.0, b.object_state("a", [0, 0, 0], source="marker"))
    b.track(300.0, b.object_state("a", [0, 0, 0], orientation=[0, 0, 0, 1], source="detector"))
    ep = load_episode(b.write())

    assert ep.objects["a"].flags.tolist() == [10, 10, 11]


def test_recorded_flags_held_by_and_observed_t_are_kept(featured_episode_dir):
    ep = load_episode(featured_episode_dir)

    syringe = ep.objects["syringe"]
    assert syringe.flags[:2].tolist() == [10, 15]
    assert syringe.flags[-1] == 0
    assert syringe.held_by[:2] == [None, None]
    assert set(syringe.held_by[2:-2]) == {"right"}
    assert syringe.held_by[-2:] == [None, None]
    assert syringe.observed_t[0] == 150.0
    assert np.isnan(syringe.observed_t[1:]).all()


def test_sample_time_is_when_the_estimate_was_measured(featured_episode_dir):
    ep = load_episode(featured_episode_dir)

    syringe = ep.objects["syringe"]
    assert syringe.t[0] == 200.0  # the line
    assert syringe.sample_t[0] == 150.0  # its camera frame
    np.testing.assert_array_equal(syringe.sample_t[1:], syringe.t[1:])


@pytest.mark.parametrize("method", ["layout", "pinch", "marker", "detector", "manual"])
def test_meta_placements_are_position_valid_but_never_tracked(new_episode, method):
    # When a placement was measured is not recorded, so it is never "measured just now".
    placed = {"id": "cup", "label": "cup", "position": [0, 0, 0], "radius": 0.04, "method": method}
    b = new_episode(objects=[placed])
    b.frame(0.0)
    ep = load_episode(b.write())

    assert ep.objects["cup"].flags.tolist() == [2]
    assert ep.objects["cup"].source == [method]
    assert ep.objects["cup"].held_by == [None]
    assert ep.objects["cup"].held_by_known.tolist() == [False]
    assert ep.objects["cup"].sample_t.tolist() == [0.0]


def test_a_missing_held_by_is_told_apart_from_held_by_null(new_episode):
    b = new_episode(objects=[])
    b.frame(0.0)
    b.track(100.0, b.object_state("cup", [0, 0, 0], source="detector", flags=10))
    b.track(200.0, b.object_state("cup", [0, 0, 0], source="detector", flags=10, held_by=None))
    b.track(300.0, b.object_state("cup", [0, 0, 0], source="pinch", flags=2, held_by="left"))
    cup = load_episode(b.write()).objects["cup"]

    assert cup.held_by == [None, None, "left"]
    assert cup.held_by_known.tolist() == [False, True, True]


def test_a_state_without_a_valid_position_is_placed_at_its_line(new_episode):
    # observedT dates a measurement; a lost state says what is true when it was written.
    b = new_episode(objects=[])
    b.frame(0.0)
    state = b.object_state
    b.track(200.0, state("cup", [0, 0, 0], source="detector", flags=10, observed_t=150.0))
    b.track(400.0, state("cup", [0, 0, 0], source="detector", flags=0, observed_t=300.0))
    cup = load_episode(b.write()).objects["cup"]

    assert cup.sample_t.tolist() == [150.0, 400.0]
    assert cup.observed_t.tolist() == [150.0, 300.0]


def test_a_malformed_object_state_raises_naming_the_file_and_line(episode_dir):
    with (episode_dir / "objects.ndjson").open("a") as f:
        f.write('{"t": 2900, "objects": [{"id": "cup", "position": [0, 0]}]}\n')

    with pytest.raises(ValueError, match=r"objects\.ndjson:3: cannot read object state"):
        load_episode(episode_dir)


@pytest.mark.parametrize("line", ['{"objects": []}', "[1, 2]", '{"t": "late", "objects": []}'])
def test_an_object_line_without_a_time_raises_naming_it(episode_dir, line):
    with (episode_dir / "objects.ndjson").open("a") as f:
        f.write(line + "\n")

    with pytest.raises(ValueError, match=r"objects\.ndjson:3: not a record with a numeric t"):
        load_episode(episode_dir)


def test_observations_that_cannot_be_read_are_skipped(featured_episode_dir):
    with (featured_episode_dir / "observations.ndjson").open("a") as f:
        f.write('{"objectId": "cup"}\n[1, 2]\nnot json\n{"t": true}\n{"t": 100, "objectId": "x"}\n')

    ep = load_episode(featured_episode_dir)

    assert [o["t"] for o in ep.observations] == [100, 200.0, 400.0, 2500.0]


def test_observations_are_loaded_in_time_order(featured_episode_dir):
    ep = load_episode(featured_episode_dir)

    assert [(o["t"], o["status"]) for o in ep.observations] == [
        (200.0, "measured"),
        (400.0, "measured"),
        (2500.0, "lost"),
    ]
    assert ep.observations[0]["observedT"] == 150.0


def test_episodes_without_observations_have_none(episode_dir):
    assert load_episode(episode_dir).observations == []


def test_an_object_track_built_without_the_new_fields_derives_them():
    track = ObjectTrack(
        id="cup",
        label="cup",
        radius=None,
        t=np.array([0.0, 100.0]),
        position=np.zeros((2, 3)),
        orientation=np.array([[np.nan] * 4, [0.0, 0.0, 0.0, 1.0]]),
        confidence=np.array([np.nan, 0.9]),
        source=["layout", "marker"],
    )

    assert track.flags.tolist() == [2, 15]
    assert track.held_by == [None, None]
    assert np.isnan(track.observed_t).all()
    np.testing.assert_array_equal(track.sample_t, track.t)
