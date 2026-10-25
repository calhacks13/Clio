"""The synthetic-episode builder must produce exactly what the protocol schemas allow.

This uses plain jsonschema (not clio_pipeline.schema) so a bug in the pipeline's validator can't
hide drift between the builder and the contract.
"""

import json
from pathlib import Path

import jsonschema
import pytest

SCHEMA_DIR = Path(__file__).resolve().parents[2] / "packages" / "protocol" / "schema"

FILES = [
    ("meta.json", "episode-meta.schema.json", False),
    ("frames.ndjson", "frame-record.schema.json", True),
    ("events.ndjson", "episode-event.schema.json", True),
    ("objects.ndjson", "object-track.schema.json", True),
    ("finish.json", "episode-finish.schema.json", False),
]


def _records(path: Path, ndjson: bool) -> list:
    if not ndjson:
        return [json.loads(path.read_text())]
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


OBSERVATIONS = ("observations.ndjson", "object-observation.schema.json", True)


@pytest.mark.parametrize(
    "fixture, files",
    [
        ("episode_dir", FILES),
        ("planned_episode_dir", FILES),
        ("featured_episode_dir", [*FILES, OBSERVATIONS]),
        ("measured_episode_dir", [*FILES, OBSERVATIONS]),
        ("room_scan_episode_dir", [*FILES, OBSERVATIONS]),
        ("frame_gap_episode_dir", [f for f in FILES if f[0] != "objects.ndjson"]),
    ],
)
def test_synthetic_episode_matches_the_protocol_schemas(fixture, files, request):
    episode = request.getfixturevalue(fixture)
    for file, schema_file, ndjson in files:
        schema = json.loads((SCHEMA_DIR / schema_file).read_text())
        validator = jsonschema.Draft202012Validator(schema)
        records = _records(episode / file, ndjson)
        assert records, f"{file} is empty"
        for i, record in enumerate(records, start=1):
            errors = [e.message[:200] for e in validator.iter_errors(record)]
            assert not errors, f"{file}:{i}: {errors}"


def test_planned_episode_carries_the_plan_in_meta(planned_episode_dir):
    meta = json.loads((planned_episode_dir / "meta.json").read_text())
    assert meta["plan"]["origin"]["kind"] == "generated"
    assert [s.get("action", {}).get("verb") for s in meta["plan"]["steps"]] == [
        "other",
        "pinch",
        None,
    ]


def test_featured_episode_states_have_consistent_location_flags(featured_episode_dir):
    # The JSON Schema checks only the 0..15 range; the protocol also requires a tracked bit's
    # valid bit, and an orientation exactly when the orientation-valid bit is set.
    lines = (featured_episode_dir / "objects.ndjson").read_text().splitlines()
    states = [state for line in lines for state in json.loads(line)["objects"]]
    assert states and all("locationFlags" in state for state in states)
    for state in states:
        flags = state["locationFlags"]
        assert flags in (0, 1, 2, 3, 5, 7, 10, 11, 15)
        assert bool(flags & 1) == (state["orientation"] is not None)
