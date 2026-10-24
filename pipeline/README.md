# Clio pipeline

Offline Python tools for the episodes the server writes to `data/episodes/<episodeId>/`: validate
them against the protocol's JSON Schemas, replay them in [Rerun](https://rerun.io), and export them
to a [LeRobot](https://github.com/huggingface/lerobot) dataset. The file formats are described in
[docs/data-format.md](../docs/data-format.md).

## Setup

```bash
cd pipeline
uv sync --all-extras    # Python 3.12 (pinned in .python-version), numpy, jsonschema, rerun-sdk, lerobot
uv run pytest -q
```

Extras: `viz` (rerun-sdk, for `clio view`) and `lerobot` (lerobot[dataset], for `clio
export-lerobot`; needs Python >= 3.12). `clio validate` and `clio info` need neither.

## Commands

Any argument can be an episode directory or a directory of episodes (such as `data/episodes`).

```bash
uv run clio validate ../data/episodes            # exit code 1 if any file breaks the schemas
uv run clio info ../data/episodes/ep-20261024-031502-k3f9
uv run clio view ../data/episodes/ep-...         # opens the Rerun viewer
uv run clio view ../data/episodes/ep-... --save out/ep.rrd   # or write a file: `rerun out/ep.rrd`
uv run clio export-lerobot ../data/episodes --out out/shirt-fold --repo-id clio/shirt-fold --fps 30
```

- `validate` reports `file:line: $.json.path: message` per problem: schema errors, NaN/Infinity,
  `t` going backwards, a joint layout other than WebXR's. It also warns (without failing) when
  `batches.json` shows batches lost in transit.
- `info` prints duration, frame count and rate, hand tracking coverage, outcome, the plan origin
  and goal (when `meta.plan` exists), steps with start, duration, who completed them and their
  action verb, mistakes, and coach tool-call counts.

## Library

```python
from clio_pipeline.episode import load_episode
from clio_pipeline.segments import step_segments, frame_labels, mistakes
from clio_pipeline.resample import resample_episode

ep = load_episode("../data/episodes/ep-...", validate=True)
ep.t            # (N,) ms since episode start
ep.hands        # (N, 2, 25, 8) float32: [left, right] x WebXR joints x [px py pz qx qy qz qw radius]; NaN if untracked
ep.pinch        # (N, 2) thumb-index distance (m), NaN if untracked
ep.events_of("mistake.detected")
ep.objects["cup_a"].position_at(1250.0)        # meta.objects placement, then objects.ndjson updates
segments = step_segments(ep)                   # Segment(step_id, index, instruction, start_t, end_t, completed_by, forced, ..., action)
labels = frame_labels(ep, segments)            # per frame: step_index (-1 outside steps), task, action_verb
r = resample_episode(ep, fps=30)
```

A step entered but never completed ends at the next `step.entered`, at `procedure.completed` or
`procedure.aborted`, or at the last frame. Frames outside every step get the procedure title as
their task (or `""` without a procedure).

## Rerun replay

Logged in the workspace frame (y-up, `RUB`) on a `time` timeline in seconds: `world/hands/{left,right}`
(joints and finger bone strips; cleared while untracked), `world/head` (pose and a frustum),
`world/objects/<id>` (boxes: placement, then tracker updates), `world/pinches/<hand>`,
`pinch/{left,right}` (aperture plots), `steps/current` (the active instruction), and text logs under
`events/` (steps, mistakes, coach tool calls and results, transcript, narration, status).

## LeRobot export

Writes LeRobot dataset format v3.0 (lerobot 0.6), robot type `human_hands`, one LeRobot episode per
Clio episode, resampled to `--fps` (positions linear, quaternions normalized lerp; a hand counts as
missing if either neighboring frame lacks it; labels from the nearest previous frame).

| Feature                         | Shape    | Meaning                                                                                        |
| ------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `observation.state`             | (16,)    | left then right: wrist position (3), wrist quaternion xyzw (4), pinch aperture m (1)           |
| `action`                        | (16,)    | the next frame's state (the last frame repeats)                                                |
| `observation.hand_mask`         | (2,)     | 1 = tracked. Untracked hands hold their last known state (their first, before first seen)      |
| `observation.environment_state` | (3K,)    | object positions, sorted ids; only when episodes have objects                                  |
| `step.action_verb`              | string   | the active step's action verb from `meta.plan` (`pinch`, `pour`, ...), or `""`                 |
| `task`                          | string   | the active step's instruction                                                                  |

Poses are converted to the z-up robot frame (base at the workspace origin, facing the table):
`x = -z_W, y = -x_W, z = +y_W`; quaternions are re-expressed in that frame and made sign-continuous.
`meta/clio_episodes.jsonl` maps each LeRobot episode back to its Clio episode, with segments
(frame ranges, who completed them, forced) and mistakes (frame index, kind, message). Video in
`media/` is not exported yet.

## Tests

`tests/conftest.py` builds small synthetic episodes; `test_synthetic_builder.py` checks them against
`packages/protocol/schema` with plain jsonschema so the builder can't drift from the contract.
`test_fixture_episodes.py` runs every stage over `fixtures/episodes/*` (the TypeScript generator's
output) once that exists; point `CLIO_FIXTURES_DIR` elsewhere to run it on other episodes.
`CLIO_SCHEMA_DIR` overrides where the schemas are read from.
