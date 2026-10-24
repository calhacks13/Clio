"""Every pipeline stage over the synthetic episodes the TypeScript generator writes to
fixtures/episodes/<name>/ (apps/headset/scripts/synth-episode.ts). Skipped until there are some.
Set CLIO_FIXTURES_DIR to run it over another directory of episodes."""

import importlib.util
import os
from pathlib import Path

import numpy as np
import pytest

from clio_pipeline.cli import describe_episode
from clio_pipeline.episode import load_episode
from clio_pipeline.lerobot_export import episode_arrays
from clio_pipeline.resample import resample_episode
from clio_pipeline.schema import validate_episode
from clio_pipeline.segments import frame_labels, step_segments

ROOT = Path(
    os.environ.get("CLIO_FIXTURES_DIR")
    or Path(__file__).resolve().parents[2] / "fixtures" / "episodes"
)
EPISODES = sorted(p.parent for p in ROOT.glob("*/meta.json"))

pytestmark = pytest.mark.skipif(not EPISODES, reason=f"no episodes in {ROOT}")


@pytest.mark.parametrize("path", EPISODES, ids=lambda p: p.name)
def test_fixture_episode_is_valid(path):
    assert [str(issue) for issue in validate_episode(path)] == []


@pytest.mark.parametrize("path", EPISODES, ids=lambda p: p.name)
def test_fixture_episode_goes_through_every_stage(path, tmp_path):
    ep = load_episode(path, validate=True)
    segments = step_segments(ep)
    labels = frame_labels(ep, segments)
    assert len(labels.task) == ep.n_frames
    assert describe_episode(ep).startswith(ep.episode_id)

    resampled = resample_episode(ep, fps=30)
    arrays = episode_arrays(ep, fps=30, object_ids=sorted(ep.objects))
    assert len(arrays) == len(resampled)
    assert not np.isnan(arrays.state).any()

    if importlib.util.find_spec("rerun"):
        from clio_pipeline.rerun_view import save_rrd

        assert save_rrd(ep, tmp_path / "episode.rrd").stat().st_size > 0
    if importlib.util.find_spec("lerobot") and ep.n_frames:
        from clio_pipeline.lerobot_export import export_lerobot

        result = export_lerobot([path], tmp_path / "dataset", repo_id="clio/fixture")
        assert result.episodes[0].frames == len(arrays)
