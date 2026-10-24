import json

from clio_pipeline.compile import compile_episode
from clio_pipeline.episode import load_episode
from clio_pipeline.observations import observation_summaries


def _summaries(b):
    return observation_summaries(load_episode(b.write()))


def test_observations_are_summed_up_per_object(new_episode):
    b = new_episode()
    b.frame(0.0)
    b.observation(100.0, "mug", observed_t=40.0)
    b.observation(150.0, "mug", observed_t=90.0, status="predicted")
    b.observation(160.0, "mug", observed_t=-20.0, role="identifier", source="jev")
    b.observation(300.0, "mug", status="lost", box=None, score=None)
    b.observation(310.0, "bottle", status="absent", role="identifier", source="jev", box=None)

    summaries = _summaries(b)

    assert summaries["mug"] == {
        "count": 4,
        "statuses": {"measured": 2, "predicted": 1, "lost": 1, "absent": 0, "unknown": 0},
        "roles": ["tracker", "identifier"],
        "sources": ["yoloe-26l-seg", "jev"],
        "trackIds": ["7"],
        "firstObservedT": -20.0,
        "lastObservedT": 300.0,
    }
    assert summaries["bottle"]["statuses"]["absent"] == 1
    assert summaries["bottle"]["trackIds"] == []


def test_unreadable_observations_are_not_counted(new_episode):
    b = new_episode()
    b.frame(0.0)
    b.observation(100.0, "mug")
    b.observation(120.0, "mug", status="glimpsed")
    b.observation(130.0, "mug", role="oracle", source="x")
    path = b.write()
    with (path / "observations.ndjson").open("a") as f:
        f.write('{"t": 140, "objectId": "mug", "status": "measured"}\n')
        f.write('{"t": 150, "objectId": 7, "status": "measured", "observedT": 150}\n')
        f.write("not json\n")

    mug = observation_summaries(load_episode(path))["mug"]

    # The bad status, a missing observedT and a non-string id are skipped; an unknown role still
    # counts, but is not listed.
    assert mug["count"] == 2
    assert mug["roles"] == ["tracker"]
    assert mug["sources"] == ["yoloe-26l-seg", "x"]


def test_tracks_carry_the_summary_only_for_observed_objects(featured_episode_dir, tmp_path):
    result = compile_episode(featured_episode_dir, tmp_path / "derived")
    tracks = json.loads((result.out_dir / "tracks.json").read_text())

    by_id = {o["id"]: o for o in tracks["objects"]}
    assert by_id["syringe"]["observations"] == {
        "count": 3,
        "statuses": {"measured": 2, "predicted": 0, "lost": 1, "absent": 0, "unknown": 0},
        "roles": ["tracker"],
        "sources": ["yoloe-26l-seg"],
        "trackIds": ["7"],
        "firstObservedT": 150.0,
        "lastObservedT": 2500.0,
    }
    assert all("observations" not in o for i, o in by_id.items() if i != "syringe")
