import json

import pytest

from clio_pipeline.episode import load_episode
from clio_pipeline.objects import grid_times, object_series
from clio_pipeline.quality import quality
from clio_pipeline.schema import ValidationIssue, validate_episode


def _quality(path, issues=None):
    ep = load_episode(path)
    series = object_series(ep, grid_times(ep, 30))
    return quality(path, ep, series, validate_episode(path) if issues is None else issues)


def _complete(b, outcome="completed"):
    b.finish = {**b.finish, "outcome": outcome}
    b.batches = {"received": [0, 1, 2], "gaps": []}
    return b


def test_a_completed_episode_with_every_batch_and_tracked_hands_is_usable(default_episode):
    q = _quality(_complete(default_episode).write())

    assert (q["usable"], q["reasons"]) == (True, [])
    assert (q["finished"], q["outcome"]) == (True, "completed")
    assert q["batches"] == {"sent": 3, "received": 3, "missing": []}
    assert q["validationIssues"] == 0


def test_the_default_episode_is_not_usable_and_says_why(episode_dir):
    q = _quality(episode_dir)

    assert q["usable"] is False
    assert q["reasons"] == ["outcome interrupted", "no batch record"]
    assert q["batches"] is None


def test_an_unfinished_episode_is_not_usable(default_episode):
    default_episode.finish = None
    default_episode.batches = {"received": [0, 1], "gaps": []}

    q = _quality(default_episode.write())

    assert q["reasons"] == ["not finished"]
    assert (q["finished"], q["outcome"]) == (False, None)
    assert q["batches"] == {"sent": None, "received": 2, "missing": []}
    assert q["durationMs"] == 2983.33  # the last frame


@pytest.mark.parametrize(
    "received, gaps, reason, missing",
    [
        ([0, 2], [1], "1 batch missing", [1]),
        ([0], [], "2 batches missing", [1, 2]),
        ([0, 1, 2, 3], [], "4 batches received, 3 sent", []),
    ],
)
def test_lost_batches_make_an_episode_unusable(default_episode, received, gaps, reason, missing):
    _complete(default_episode).batches = {"received": received, "gaps": gaps}

    q = _quality(default_episode.write())

    assert q["reasons"] == [reason]
    assert q["batches"]["missing"] == missing


def test_hands_tracked_in_too_few_frames_make_an_episode_unusable(new_episode):
    b = new_episode()
    for k in range(10):
        b.frame(k * 10.0, left=b.hand((0.1, 0.1, -0.2)) if k < 3 else None)
    b.finish = {
        "durationMs": 90.0,
        "outcome": "completed",
        "stepsCompleted": 0,
        "stepsTotal": 0,
        "batches": 1,
    }
    b.batches = {"received": [0], "gaps": []}

    q = _quality(b.write())

    assert q["reasons"] == ["hands tracked in 30% of frames"]
    assert q["hands"] == {"left": 0.3, "right": 0.0}


def test_validation_issues_make_an_episode_unusable(default_episode):
    path = _complete(default_episode).write()
    issues = [ValidationIssue("frames.ndjson", k, "$.t", "bad") for k in (1, 2, 3)]

    q = _quality(path, issues)

    assert q["reasons"] == ["3 validation issues"]
    assert q["validationIssues"] == 3


def test_frame_rate_gaps_hands_and_objects_are_measured(episode_dir):
    q = _quality(episode_dir)

    assert (q["frames"], q["frameRateHz"], q["maxFrameGapMs"]) == (180, 60.0, 16.67)
    assert q["hands"] == {"left": 1.0, "right": 0.8333}
    assert q["durationMs"] == 2983.33
    by_id = {o["id"]: o for o in q["objects"]}
    assert list(by_id) == ["shoulder", "middle", "hem"]
    assert by_id["hem"] == {"id": "hem", "validFraction": 1.0, "trackedFraction": 0.0}
    assert 0 < by_id["middle"]["trackedFraction"] < 0.1  # marker-tracked once, at 2000 ms


def test_an_unreadable_batch_record_is_a_reason(default_episode):
    path = _complete(default_episode).write()
    (path / "batches.json").write_text(json.dumps({"received": "all"}))

    q = _quality(path)

    assert q["reasons"] == ["unreadable batch record"] and q["batches"] is None


def test_without_object_series_the_objects_are_left_out(episode_dir):
    ep = load_episode(episode_dir)

    assert quality(episode_dir, ep, None, [])["objects"] == []


def test_frames_missing_for_more_than_a_second_make_an_episode_unusable(frame_gap_episode_dir):
    q = _quality(frame_gap_episode_dir)

    assert q["reasons"] == ["frames missing for 2.0 s"]
    assert q["maxFrameGapMs"] == 2000.0 and q["batches"]["missing"] == []
