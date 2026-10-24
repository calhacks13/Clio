# Clio pipeline

Offline Python tools for the episodes the server writes to `data/episodes/<episodeId>/`: validate
them against the protocol's JSON Schemas, compile them into `data/derived/<episodeId>/`, replay
them in [Rerun](https://rerun.io), and export them to a
[LeRobot](https://github.com/huggingface/lerobot) dataset. The file formats are described in
[docs/data-format.md](../docs/data-format.md), the compiled files in
[docs/data-pipeline.md](../docs/data-pipeline.md).

## Setup

```bash
cd pipeline
uv sync --all-extras    # Python 3.12 (pinned in .python-version), numpy, jsonschema, rerun-sdk, lerobot
uv run pytest -q
```

Extras: `viz` (rerun-sdk, for `clio view`) and `lerobot` (lerobot[dataset], for `clio
export-lerobot`; needs Python >= 3.12). `clio validate`, `clio info` and `clio compile` need
neither.

## Commands

Any argument can be an episode directory or a directory of episodes (such as `data/episodes`).

```bash
uv run clio validate ../data/episodes            # exit code 1 if any file breaks the schemas
uv run clio info ../data/episodes/ep-20261024-031502-k3f9
uv run clio compile ../data/episodes --if-stale  # into ../data/derived/<id>/
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

## Compile

The server runs `clio compile` after each episode finishes; run it by hand to rebuild.

```bash
uv run clio compile ../data/episodes/ep-...                  # writes ../data/derived/ep-.../
uv run clio compile ../data/episodes --if-stale --finished-only
uv run clio compile some/dir/ep-... --out out/derived --fps 30 \
    --retarget src/clio_pipeline/retarget/profiles/clio-arm-6dof.json --json
```

An episode inside an `episodes/` directory compiles into the `derived/` directory beside it;
anywhere else, `--out` says where (never the episode itself or its `episodes/` directory: that is
refused). Each episode gets `<out>/<episodeId>/`:

| File                      | Contents                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `manifest.json`           | compiler version, raw inputs (bytes, SHA-256), stage results, artifacts, quality verdict          |
| `tracks.json`             | head, wrists (pose, pinch) and every object on one grid: masks, sources, held spans, observations |
| `environment.json`        | table, floor and every detected plane                                                             |
| `retarget-<profile>.json` | one per `--retarget` profile: robot joint trajectories                                            |

- Raw files are only read. Everything is written to a hidden directory first, then swapped in.
  Only an earlier compile (a directory with a `clio.derived/1` manifest.json) or an empty
  directory is replaced; anything else at `<out>/<episodeId>` stops the compile.
- Compiles of one episode take turns (a lock on `<out>/.<episodeId>.lock`, which stays), and each
  first removes the hidden directories a killed compile left. SIGTERM (the server's timeout and
  shutdown) ends `clio compile` with exit code 143 after cleaning up.
- Each stage (`tracks`, `environment`, `retarget-<profile>`, `quality`) runs on its own: a
  failure is recorded in the manifest and the others still run. Without `--retarget` the
  `retarget` stage is skipped. The exit code is 1 only when an episode could not be compiled at
  all: `meta.json`, `frames.ndjson`, `events.ndjson` and `objects.ndjson` must be readable (if not,
  the error names the file and line). `observations.ndjson` is not needed: bad lines are skipped.
- `--if-stale` keeps a compile made from the same raw files, compiler version, fps and profile
  versions. `--finished-only` skips episodes without `finish.json`. `--json` prints one line per
  episode: `{episodeId, skipped, outDir, usable, stages}`.
- The quality verdict calls an episode usable only when it finished as `completed`, every batch
  arrived, no two frames are more than a second apart, a hand was tracked in at least half of the
  frames and validation found nothing; `reasons` lists what failed. `validationIssues` counts
  every invalid line.
- Head and wrists are never interpolated across recorded frames more than 100 ms apart
  (`policy.maxFrameGapMs`): they are null there, and the robot arms get no target.
- Environment: the table is the plan's workspace at the calibration corner, else the largest
  detected table plane (placed and sized on the plane itself). The floor is always given; its
  `tableHeightM` comes from a calibrated workspace (`pinch_two_corners`, `workspace_marker`,
  `persisted_anchor`) or a detected table plane, and is null when the workspace was only guessed.
  A plane is last seen when a later snapshot first leaves it out, or at the end of the episode.
- Objects (`objects.py`, `ObjectSeries`): the estimate measured last at or before each grid time
  governs (by `observedT` where recorded and the position is valid; a lost state counts from its
  line's `t`); a short gap (up to 250 ms) between valid estimates is interpolated, and flagged when
  longer than 100 ms; an estimate counts as tracked for 100 ms (a `meta.objects` placement never
  does: when it was measured is unknown). Nothing is filled in before an object is first seen or
  while its position is not valid.
- Held spans (`held.py`): recorded grasp events when the episode lists `object.grasp`; else, for
  an `object.flags` episode, runs of `heldBy` for objects whose states record it; else inferred
  from pinches. A state without `heldBy` says nothing about holding (null means not held).

## Library

```python
from clio_pipeline.episode import load_episode
from clio_pipeline.segments import step_segments, frame_labels, mistakes
from clio_pipeline.resample import resample_episode
from clio_pipeline.objects import object_series
from clio_pipeline.compile import compile_episode

ep = load_episode("../data/episodes/ep-...", validate=True)
ep.t            # (N,) ms since episode start
ep.hands        # (N, 2, 25, 8) float32: [left, right] x WebXR joints x [px py pz qx qy qz qw radius]; NaN if untracked
ep.pinch        # (N, 2) thumb-index distance (m), NaN if untracked
ep.events_of("mistake.detected")
ep.objects["cup_a"].position_at(1250.0)        # meta.objects placement, then objects.ndjson updates
ep.objects["cup_a"].flags                      # (K,) location flags per estimate (derived for older episodes)
ep.observations                                # observations.ndjson: what object finders saw in 2D
segments = step_segments(ep)                   # Segment(step_id, index, instruction, start_t, end_t, completed_by, forced, ..., action)
labels = frame_labels(ep, segments)            # per frame: step_index (-1 outside steps), task, action_verb
r = resample_episode(ep, fps=30)               # max_gap_ms=MAX_FRAME_GAP_MS leaves long frame gaps out
series = object_series(ep, r.t)                # {id: ObjectSeries}: position, valid, tracked, interpolated, held_by, ...
result = compile_episode(ep.path, "../data/derived", if_stale=True)   # CompileResult(episode_id, out_dir, skipped, manifest)
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

With `--robot-profile <file>` the dataset is the retargeted joint trajectory instead (robot type
from the profile): joint values then one gripper per arm, held at the last solved frame, plus
`observation.retarget.valid` (1 where that frame was solved) and
`observation.retarget.residual_pos` (how far the tool of the exported joint values is from the
hand target, m; 0 without a target). In this mode the hands are not interpolated across frame
gaps longer than 100 ms, so those frames hold with valid 0, as in `clio compile`.

Poses are converted to the z-up robot frame (base at the workspace origin, facing the table):
`x = -z_W, y = -x_W, z = +y_W`; quaternions are re-expressed in that frame and made sign-continuous.
`meta/clio_episodes.jsonl` maps each LeRobot episode back to its Clio episode, with segments
(frame ranges, who completed them, forced) and mistakes (frame index, kind, message). Video in
`media/` is not exported yet.

## Tests

`tests/conftest.py` builds small synthetic episodes; `test_synthetic_builder.py` checks them against
`packages/protocol/schema` with plain jsonschema so the builder can't drift from the contract.
`test_fixture_episodes.py` runs every stage, compile included, over `fixtures/episodes/*` (the
TypeScript generator's output); point `CLIO_FIXTURES_DIR` elsewhere to run it on other episodes.
`test_compile.py` checks compiled files against the `derived-*` schemas with plain jsonschema.
`CLIO_SCHEMA_DIR` overrides where the schemas are read from.
