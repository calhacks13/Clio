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


@pytest.mark.parametrize("fixture", ["episode_dir", "planned_episode_dir"])
def test_synthetic_episode_matches_the_protocol_schemas(fixture, request):
    episode = request.getfixturevalue(fixture)
    for file, schema_file, ndjson in FILES:
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
