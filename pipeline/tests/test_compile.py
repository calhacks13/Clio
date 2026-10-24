"""`compile_episode` over synthetic episodes. Compiled files are checked against the generated
JSON Schemas in packages/protocol/schema with plain jsonschema, like test_synthetic_builder.py."""

import hashlib
import json
import shutil
import sys
import threading
import types
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import jsonschema
import numpy as np
import pytest

from clio_pipeline import compile as compile_module
from clio_pipeline.compile import compile_episode
from clio_pipeline.schema import validate_derived

SCHEMA_DIR = Path(__file__).resolve().parents[2] / "packages" / "protocol" / "schema"
SCHEMA_OF = {
    "manifest.json": "derived-manifest.schema.json",
    "tracks": "derived-tracks.schema.json",
    "environment": "derived-environment.schema.json",
    "retarget": "derived-retarget.schema.json",
}


def _schema_errors(doc, schema_file):
    schema = json.loads((SCHEMA_DIR / schema_file).read_text())
    return [
        f"{list(e.absolute_path)}: {e.message[:200]}"
        for e in jsonschema.Draft202012Validator(schema).iter_errors(doc)
    ]


def _read(path):
    return json.loads(Path(path).read_text())


def _snapshot(episode_dir):
    return {p.name: p.read_bytes() for p in sorted(episode_dir.rglob("*")) if p.is_file()}


def _stages(result):
    return {s["name"]: s for s in result.manifest["stages"]}


def _listing(path):
    return sorted(p.name for p in Path(path).iterdir())


def test_every_compiled_file_matches_its_schema(featured_episode_dir, tmp_path):
    result = compile_episode(featured_episode_dir, tmp_path / "derived")

    assert _schema_errors(_read(result.out_dir / "manifest.json"), SCHEMA_OF["manifest.json"]) == []
    kinds = {a["name"]: a["kind"] for a in result.manifest["artifacts"]}
    assert kinds == {"tracks.json": "tracks", "environment.json": "environment"}
    for name, kind in kinds.items():
        assert _schema_errors(_read(result.out_dir / name), SCHEMA_OF[kind]) == [], name
    assert validate_derived(result.out_dir) == []


def test_raw_files_are_left_byte_for_byte_as_they_were(featured_episode_dir, tmp_path):
    before = _snapshot(featured_episode_dir)

    compile_episode(featured_episode_dir, tmp_path / "derived")

    assert _snapshot(featured_episode_dir) == before


def test_the_compile_lands_in_its_own_directory_with_nothing_left_over(episode_dir, tmp_path):
    out_root = tmp_path / "derived"

    result = compile_episode(episode_dir, out_root)

    assert result.out_dir == out_root / "ep-20261024-031502-test"
    assert _listing(out_root) == [".ep-20261024-031502-test.lock", "ep-20261024-031502-test"]
    assert sorted(p.name for p in result.out_dir.iterdir()) == [
        "environment.json",
        "manifest.json",
        "tracks.json",
    ]
    assert not (result.out_dir / "meta.json").exists()
    assert result.skipped is False


def test_the_manifest_records_inputs_artifacts_and_the_compiler(featured_episode_dir, tmp_path):
    result = compile_episode(featured_episode_dir, tmp_path / "derived", fps=15)
    manifest = result.manifest

    assert manifest == _read(result.out_dir / "manifest.json")
    assert (manifest["schema"], manifest["episodeId"], manifest["fps"]) == (
        "clio.derived/1",
        "ep-20261024-031502-feat",
        15,
    )
    assert manifest["compiler"] == {"name": "clio_pipeline", "version": "0.4.0"}
    assert manifest["compiledAt"].endswith("Z") and len(manifest["compiledAt"]) == 24
    assert [i["name"] for i in manifest["inputs"]] == [
        "meta.json",
        "frames.ndjson",
        "events.ndjson",
        "objects.ndjson",
        "observations.ndjson",
        "finish.json",
        "batches.json",
    ]
    for i in manifest["inputs"]:
        assert i["bytes"] == (featured_episode_dir / i["name"]).stat().st_size
        assert len(i["sha256"]) == 64
    for a in manifest["artifacts"]:
        assert a["bytes"] == (result.out_dir / a["name"]).stat().st_size


def test_compiled_files_are_strict_json_compact_except_the_manifest(episode_dir, tmp_path):
    result = compile_episode(episode_dir, tmp_path / "derived")

    tracks = (result.out_dir / "tracks.json").read_text()
    assert "NaN" not in tracks and "Infinity" not in tracks
    assert tracks.count("\n") == 1 and ": " not in tracks
    assert (result.out_dir / "manifest.json").read_text().startswith('{\n  "schema"')


def test_tracks_hold_null_while_a_hand_is_untracked(episode_dir, tmp_path):
    result = compile_episode(episode_dir, tmp_path / "derived")
    tracks = _read(result.out_dir / "tracks.json")

    right = next(h for h in tracks["hands"] if h["hand"] == "right")
    lost = [t for t, wrist in zip(tracks["t"], right["wrist"], strict=True) if wrist is None]
    assert lost and min(lost) >= 1000.0 and max(lost) <= 1500.0
    assert [p is None for p in right["pinch"]] == [w is None for w in right["wrist"]]
    assert all(w is not None for w in tracks["hands"][0]["wrist"])
    assert len(tracks["head"]) == len(tracks["t"]) == 90


def test_tracks_round_space_to_four_decimals_and_time_to_two(episode_dir, tmp_path):
    result = compile_episode(episode_dir, tmp_path / "derived")
    tracks = _read(result.out_dir / "tracks.json")

    assert tracks["t"][:3] == [0.0, 33.33, 66.67]
    values = [v for pose in tracks["head"] + tracks["hands"][0]["wrist"] for v in pose]
    assert all(round(v, 4) == v for v in values)
    assert tracks["policy"] == {
        "maxInterpolateGapMs": 250.0,
        "staleMs": 100.0,
        "maxFrameGapMs": 100.0,
    }


def test_objects_carry_masks_sources_and_held_spans(featured_episode_dir, tmp_path):
    result = compile_episode(featured_episode_dir, tmp_path / "derived")
    tracks = _read(result.out_dir / "tracks.json")

    syringe = next(o for o in tracks["objects"] if o["id"] == "syringe")
    assert syringe["heldSpans"] == [
        {"hand": "right", "startT": 1600.0, "endT": 2000.0, "origin": "recorded", "grip": "pinch"}
    ]
    assert syringe["position"][0] is None and syringe["source"][0] is None  # not yet seen
    assert syringe["position"][-1] is None and syringe["source"][-1] == "detector"  # lost
    held = [t for t, hand in zip(tracks["t"], syringe["heldBy"], strict=True) if hand == "right"]
    assert held[0] == 1600.0 and held[-1] < 2000.0
    assert all(c is None or 0 <= c <= 1 for c in syringe["confidence"])


def test_an_up_to_date_compile_is_kept(featured_episode_dir, tmp_path):
    first = compile_episode(featured_episode_dir, tmp_path / "derived")
    stamp = (first.out_dir / "tracks.json").stat().st_mtime_ns

    again = compile_episode(featured_episode_dir, tmp_path / "derived", if_stale=True)

    assert again.skipped is True
    assert again.manifest == first.manifest
    assert (again.out_dir / "tracks.json").stat().st_mtime_ns == stamp


def test_a_changed_raw_file_makes_the_compile_stale(featured_episode_dir, tmp_path):
    first = compile_episode(featured_episode_dir, tmp_path / "derived")
    with (featured_episode_dir / "events.ndjson").open("a") as f:
        f.write('{"t":2900,"type":"annotation","label":"late"}\n')

    again = compile_episode(featured_episode_dir, tmp_path / "derived", if_stale=True)

    assert again.skipped is False
    events = next(i for i in again.manifest["inputs"] if i["name"] == "events.ndjson")
    assert events != next(i for i in first.manifest["inputs"] if i["name"] == "events.ndjson")


def test_a_same_size_edit_is_caught_by_the_hash(episode_dir, tmp_path):
    compile_episode(episode_dir, tmp_path / "derived")
    finish = episode_dir / "finish.json"
    finish.write_text(finish.read_text().replace("interrupted", "interruptez"))

    assert compile_episode(episode_dir, tmp_path / "derived", if_stale=True).skipped is False


@pytest.mark.parametrize(
    "change",
    ["fps", "new file", "missing artifact"],
)
def test_other_changes_also_make_the_compile_stale(episode_dir, tmp_path, change):
    first = compile_episode(episode_dir, tmp_path / "derived")
    fps = 30
    if change == "fps":
        fps = 15
    elif change == "new file":
        (episode_dir / "batches.json").write_text('{"received":[0,1,2],"gaps":[]}')
    else:
        (first.out_dir / "environment.json").unlink()

    assert (
        compile_episode(episode_dir, tmp_path / "derived", fps=fps, if_stale=True).skipped is False
    )


def test_a_failing_stage_is_recorded_and_the_others_still_run(episode_dir, tmp_path, monkeypatch):
    def broken(episode):
        raise RuntimeError("no planes today")

    monkeypatch.setattr(compile_module, "environment_doc", broken)

    result = compile_episode(episode_dir, tmp_path / "derived")

    stages = _stages(result)
    assert stages["environment"] == {
        "name": "environment",
        "status": "failed",
        "detail": "RuntimeError: no planes today",
    }
    assert stages["tracks"]["status"] == "ok" and stages["quality"]["status"] == "ok"
    assert [a["name"] for a in result.manifest["artifacts"]] == ["tracks.json"]
    assert not (result.out_dir / "environment.json").exists()
    assert validate_derived(result.out_dir) == []


def test_a_failing_quality_stage_still_writes_a_valid_manifest(episode_dir, tmp_path, monkeypatch):
    def broken(*args):
        raise ValueError("bad")

    monkeypatch.setattr(compile_module, "quality", broken)

    result = compile_episode(episode_dir, tmp_path / "derived")

    assert _stages(result)["quality"]["status"] == "failed"
    assert result.manifest["quality"]["usable"] is False
    assert result.manifest["quality"]["reasons"] == ["quality check failed"]
    assert _schema_errors(result.manifest, SCHEMA_OF["manifest.json"]) == []


def test_retargeting_is_skipped_without_a_profile(episode_dir, tmp_path):
    result = compile_episode(episode_dir, tmp_path / "derived")

    assert _stages(result)["retarget"] == {
        "name": "retarget",
        "status": "skipped",
        "detail": "no profile",
    }


def test_a_profile_that_cannot_be_loaded_fails_only_its_stage(episode_dir, tmp_path):
    missing = tmp_path / "no-such-profile.json"

    result = compile_episode(episode_dir, tmp_path / "derived", retarget_profiles=[missing])

    failed = [s for s in result.manifest["stages"] if s["status"] == "failed"]
    assert [s["name"] for s in failed] == ["retarget"]
    assert [s["status"] for s in result.manifest["stages"] if s["name"] != "retarget"] == [
        "ok",
        "ok",
        "ok",
    ]
    assert not any(a["kind"] == "retarget" for a in result.manifest["artifacts"])


@pytest.fixture
def fake_retarget(monkeypatch, tmp_path):
    """A stand-in for clio_pipeline.retarget: profiles are {"id", "version"} files, and the
    document has no arms."""
    module = types.ModuleType("clio_pipeline.retarget")

    def load_profile(path):
        text = Path(path).read_text()
        sha = hashlib.sha256(text.encode()).hexdigest()
        return types.SimpleNamespace(**json.loads(text), profile_sha256=sha, urdf_sha256="0" * 64)

    def retarget_episode(episode, profile, *, fps):
        if profile.id == "broken-arm":
            raise ValueError("cannot reach")
        return profile, fps

    def retarget_doc(result, episode):
        profile, fps = result
        return {
            "schema": "clio.derived/1",
            "episodeId": episode.episode_id,
            "frame": "workspace",
            "fps": fps,
            "t": [],
            "kind": "retarget",
            "profile": {
                "id": profile.id,
                "version": profile.version,
                "robot": "test arm",
                "robotType": "test_arm",
                "urdfSha256": "0" * 64,
                "example": True,
                "orientationMode": "position_only",
                "tolPosM": 0.005,
                "tolRotRad": 0.1,
            },
            "arms": [],
            "summary": {"reachableFraction": 0, "targetFraction": 0, "meanResidualPosM": None},
        }

    module.load_profile = load_profile
    module.retarget_episode = retarget_episode
    module.retarget_doc = retarget_doc
    monkeypatch.setitem(sys.modules, "clio_pipeline.retarget", module)

    def profile(name, version=1):
        path = tmp_path / f"{name}-v{version}.json"
        path.write_text(json.dumps({"id": name, "version": version}))
        return path

    return profile


def test_each_profile_gets_its_own_retarget_file(episode_dir, tmp_path, fake_retarget):
    profiles = [fake_retarget("arm-a"), fake_retarget("broken-arm"), fake_retarget("arm-b", 3)]

    result = compile_episode(episode_dir, tmp_path / "derived", retarget_profiles=profiles)

    stages = _stages(result)
    assert stages["retarget-arm-a"] == {
        "name": "retarget-arm-a",
        "status": "ok",
        "detail": "version 1",
    }
    assert stages["retarget-broken-arm"]["status"] == "failed"
    assert stages["retarget-broken-arm"]["detail"] == "version 1: ValueError: cannot reach"
    assert stages["retarget-arm-b"]["detail"] == "version 3"
    retarget = [a["name"] for a in result.manifest["artifacts"] if a["kind"] == "retarget"]
    assert retarget == ["retarget-arm-a.json", "retarget-arm-b.json"]
    assert validate_derived(result.out_dir) == []


def test_a_new_profile_version_makes_the_compile_stale(episode_dir, tmp_path, fake_retarget):
    out_root = tmp_path / "derived"
    compile_episode(episode_dir, out_root, retarget_profiles=[fake_retarget("arm-a")])

    same = compile_episode(
        episode_dir, out_root, retarget_profiles=[fake_retarget("arm-a")], if_stale=True
    )
    newer = compile_episode(
        episode_dir, out_root, retarget_profiles=[fake_retarget("arm-a", 2)], if_stale=True
    )
    none = compile_episode(episode_dir, out_root, if_stale=True)

    assert (same.skipped, newer.skipped, none.skipped) == (True, False, False)


def test_editing_a_profile_without_a_new_version_makes_the_compile_stale(
    episode_dir, tmp_path, fake_retarget
):
    out_root = tmp_path / "derived"
    path = fake_retarget("arm-a")
    first = compile_episode(episode_dir, out_root, retarget_profiles=[path])
    path.write_text(json.dumps({"id": "arm-a", "version": 1, "note": "moved the base"}))

    again = compile_episode(episode_dir, out_root, retarget_profiles=[path], if_stale=True)

    assert [r["id"] for r in first.manifest["retarget"]] == ["arm-a"]
    assert first.manifest["retarget"][0]["version"] == 1
    assert again.skipped is False
    assert (
        again.manifest["retarget"][0]["profileSha256"]
        != first.manifest["retarget"][0]["profileSha256"]
    )


def test_an_unreadable_episode_raises_and_keeps_the_previous_compile(episode_dir, tmp_path):
    first = compile_episode(episode_dir, tmp_path / "derived")
    frames = episode_dir / "frames.ndjson"
    frames.write_text(frames.read_text() + '{"t": 5000, "head": [1, 2]}\n')

    with pytest.raises(ValueError, match="frames.ndjson"):
        compile_episode(episode_dir, tmp_path / "derived")

    assert _read(first.out_dir / "manifest.json") == first.manifest
    assert _listing(tmp_path / "derived") == [f".{first.episode_id}.lock", first.out_dir.name]


def test_an_episode_without_frames_still_compiles(new_episode, tmp_path):
    path = new_episode("ep-empty").write()

    result = compile_episode(path, tmp_path / "derived")

    tracks = _read(result.out_dir / "tracks.json")
    assert tracks["t"] == [] and tracks["head"] == []
    assert "hands tracked in 0% of frames" in result.manifest["quality"]["reasons"]
    assert validate_derived(result.out_dir) == []


def test_validation_issues_are_counted_not_fatal(episode_dir, tmp_path):
    events = episode_dir / "events.ndjson"
    events.write_text(events.read_text() + '{"t": 2950, "type": "step.teleported"}\n')

    result = compile_episode(episode_dir, tmp_path / "derived")

    assert result.manifest["quality"]["validationIssues"] == 1
    assert "1 validation issue" in result.manifest["quality"]["reasons"]


@pytest.mark.parametrize("fps", [0, -5, 29.97, True])
def test_the_grid_rate_must_be_a_positive_integer(episode_dir, tmp_path, fps):
    with pytest.raises(ValueError, match="fps"):
        compile_episode(episode_dir, tmp_path / "derived", fps=fps)


# --- the raw episode is never touched -------------------------------------------------------------


def _in_episodes_dir(tmp_path, make_default_episode, name="ep-a"):
    episodes = tmp_path / "data" / "episodes"
    episodes.mkdir(parents=True, exist_ok=True)
    return make_default_episode(name).rename(episodes / name)


@pytest.mark.parametrize("where", ["its episodes dir", "the episode", "inside the episode"])
def test_a_compile_into_or_beside_the_episode_is_refused(make_default_episode, tmp_path, where):
    path = _in_episodes_dir(tmp_path, make_default_episode)
    out_root = {
        "its episodes dir": path.parent,
        "the episode": path,
        "inside the episode": path / "derived",
    }[where]
    before = _snapshot(path)

    with pytest.raises(ValueError, match="will not compile"):
        compile_episode(path, out_root)

    assert _snapshot(path) == before
    assert _listing(path.parent) == ["ep-a"]
    assert not (path / "derived").exists()


def test_a_copy_named_otherwise_cannot_compile_over_its_siblings(make_default_episode, tmp_path):
    path = _in_episodes_dir(tmp_path, make_default_episode)
    copy = make_default_episode("ep-a-copy")  # its meta.json still says ep-a
    copy = copy.rename(path.parent / "ep-a-copy")
    before = _snapshot(path)

    with pytest.raises(ValueError, match="will not compile"):
        compile_episode(copy, path.parent)

    assert _snapshot(path) == before


@pytest.mark.parametrize("content", ["notes.txt", "meta.json", "manifest.json"])
def test_a_directory_that_is_not_a_compile_is_never_replaced(episode_dir, tmp_path, content):
    out_root = tmp_path / "derived"
    occupied = out_root / "ep-20261024-031502-test"
    occupied.mkdir(parents=True)
    (occupied / content).write_text('{"schema": "clio.episode/1"}')

    with pytest.raises(FileExistsError, match="not a compile"):
        compile_episode(episode_dir, out_root)

    assert _listing(occupied) == [content]
    assert _listing(out_root) == [".ep-20261024-031502-test.lock", occupied.name]


def test_an_empty_directory_is_replaced(episode_dir, tmp_path):
    (tmp_path / "derived" / "ep-20261024-031502-test").mkdir(parents=True)

    result = compile_episode(episode_dir, tmp_path / "derived")

    assert (result.out_dir / "manifest.json").is_file()


# --- killed and concurrent compiles ---------------------------------------------------------------


def test_a_compile_removes_what_killed_compiles_of_the_episode_left_behind(episode_dir, tmp_path):
    out_root = tmp_path / "derived"
    first = compile_episode(episode_dir, out_root)
    eid = first.episode_id
    leftovers = [f".{eid}.k3j_x9q2", f".{eid}.old-0a1b2c3d"]
    others = [f".{eid}.notes", ".ep-other.abcdefgh"]  # not this episode's work or backup
    for name in leftovers + others:
        (out_root / name).mkdir()
        (out_root / name / "tracks.json").write_text("{}")

    compile_episode(episode_dir, out_root)

    assert _listing(out_root) == sorted([f".{eid}.lock", eid, *others])


def test_compiles_of_one_episode_at_the_same_time_take_turns(featured_episode_dir, tmp_path):
    out_root = tmp_path / "derived"
    eid = "ep-20261024-031502-feat"

    def race(if_stale):
        barrier = threading.Barrier(2)

        def run(_):
            barrier.wait()
            return compile_episode(featured_episode_dir, out_root, if_stale=if_stale)

        with ThreadPoolExecutor(2) as pool:
            return list(pool.map(run, range(2)))

    for _ in range(3):
        assert [r.skipped for r in race(False)] == [False, False]
        assert _listing(out_root) == [f".{eid}.lock", eid]
    shutil.rmtree(out_root)
    # The one that waited finds the other's compile up to date.
    assert sorted(r.skipped for r in race(True)) == [False, True]
    assert validate_derived(out_root / eid) == []


def test_a_compile_removed_during_the_swap_is_nothing_to_back_up(
    episode_dir, tmp_path, monkeypatch
):
    out_root = tmp_path / "derived"
    first = compile_episode(episode_dir, out_root)
    read_manifest = compile_module._read_manifest

    def moved_away(out_dir):  # by a compiler that does not take the lock, right after the check
        manifest = read_manifest(out_dir)
        shutil.rmtree(out_dir)
        return manifest

    monkeypatch.setattr(compile_module, "_read_manifest", moved_away)

    result = compile_episode(episode_dir, out_root)

    assert _read(result.out_dir / "manifest.json") == result.manifest
    assert _listing(out_root) == [f".{first.episode_id}.lock", first.episode_id]


def test_a_failed_swap_puts_the_previous_compile_back(episode_dir, tmp_path, monkeypatch):
    out_root = tmp_path / "derived"
    first = compile_episode(episode_dir, out_root)
    rename = Path.rename

    def interrupted(self, target):
        is_work = self.name.startswith(".") and ".old-" not in self.name
        if is_work and Path(target) == first.out_dir:  # swapping the new compile in
            raise SystemExit(143)  # what SIGTERM raises in `clio compile`
        return rename(self, target)

    monkeypatch.setattr(Path, "rename", interrupted)

    with pytest.raises(SystemExit):
        compile_episode(episode_dir, out_root)

    assert _read(first.out_dir / "manifest.json") == first.manifest
    assert _listing(out_root) == [f".{first.episode_id}.lock", first.episode_id]


# --- frame gaps, validation counts ----------------------------------------------------------------


def test_tracks_leave_head_and_wrists_null_across_a_frame_gap(frame_gap_episode_dir, tmp_path):
    result = compile_episode(frame_gap_episode_dir, tmp_path / "derived")
    tracks = _read(result.out_dir / "tracks.json")

    t = np.array(tracks["t"])
    left, right = tracks["hands"]
    for k in np.flatnonzero((t > 1010.0) & (t < 2990.0)):
        assert tracks["head"][k] is None, t[k]
        assert left["wrist"][k] is None and left["pinch"][k] is None, t[k]
        assert right["wrist"][k] is None and right["pinch"][k] is None, t[k]
    for k in np.flatnonzero((t < 990.0) | (t > 3010.0)):
        assert None not in (tracks["head"][k], left["wrist"][k], right["pinch"][k]), t[k]
    assert tracks["policy"]["maxFrameGapMs"] == 100.0
    quality = result.manifest["quality"]
    assert (quality["usable"], quality["reasons"]) == (False, ["frames missing for 2.0 s"])
    assert validate_derived(result.out_dir) == []


def test_a_guessed_workspace_compiles_with_the_floor_but_no_table_height(default_episode, tmp_path):
    default_episode.meta["space"]["calibration"] = "default_in_front"

    result = compile_episode(default_episode.write(), tmp_path / "derived")

    floor = _read(result.out_dir / "environment.json")["floor"]
    assert floor == {"pose": [0.4, -0.75, 0.5, 0.0, 0.0, 0.0, 1.0], "tableHeightM": None}
    assert validate_derived(result.out_dir) == []


def test_every_invalid_line_is_counted(episode_dir, tmp_path):
    events = episode_dir / "events.ndjson"
    events.write_text(events.read_text() + '{"t": 2950, "type": "step.teleported"}\n' * 30)

    result = compile_episode(episode_dir, tmp_path / "derived")

    assert result.manifest["quality"]["validationIssues"] == 30
    assert "30 validation issues" in result.manifest["quality"]["reasons"]


def test_a_malformed_object_state_names_its_line(episode_dir, tmp_path):
    objects = episode_dir / "objects.ndjson"
    lines = objects.read_text().splitlines()
    record = json.loads(lines[1])
    del record["objects"][0]["confidence"]
    lines[1] = json.dumps(record)
    objects.write_text("\n".join(lines) + "\n")

    with pytest.raises(ValueError, match=r"objects\.ndjson:2: .*confidence"):
        compile_episode(episode_dir, tmp_path / "derived")


def test_a_malformed_observation_does_not_stop_the_compile(featured_episode_dir, tmp_path):
    with (featured_episode_dir / "observations.ndjson").open("a") as f:
        f.write('{"objectId": "cup"}\n[1, 2]\nnot json\n')

    result = compile_episode(featured_episode_dir, tmp_path / "derived")

    assert [s["status"] for s in result.manifest["stages"]] == ["ok", "ok", "skipped", "ok"]
    assert result.manifest["quality"]["validationIssues"] == 3
