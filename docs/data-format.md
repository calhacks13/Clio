# Data formats

The source of truth is `packages/protocol/src/*.ts` (zod). JSON Schemas generated from it live in
`packages/protocol/schema/`; run `pnpm gen:schema` after changing a schema. This page explains
what the fields mean.

## Conventions

| Thing               | Convention                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Units               | meters, milliseconds                                                                                                                                                  |
| Handedness          | right-handed, **+y up** (WebXR)                                                                                                                                       |
| Quaternion          | `[x, y, z, w]`                                                                                                                                                        |
| Pose                | `[px, py, pz, qx, qy, qz, qw]` ("Pose7")                                                                                                                              |
| Workspace frame `W` | origin at the first calibration corner, on the table surface; +x along the table edge toward the second corner; +y up; +z toward the user, so the table lies at z < 0 |
| World frame         | WebXR `local-floor`; `meta.space.worldFromWorkspace` relates the two                                                                                                  |
| Time `t`            | ms since episode start, on the `performance.now()` timeline (the same clock as XR frames); `meta.clock.startEpochMs` is the wall clock at `t = 0`                     |

**Every spatial value in an episode is in `W`.** Recalibrating starts a new episode.

## On disk (server `CLIO_DATA_DIR`, default `./data`)

```
data/
├── episodes/<episodeId>/
│   ├── meta.json        EpisodeMeta: written once when the episode is created
│   ├── frames.ndjson    one FrameRecord per line, in time order
│   ├── events.ndjson    one EpisodeEvent per line, in time order
│   ├── finish.json      EpisodeFinish: written when the headset finishes the episode
│   ├── batches.json     server bookkeeping: received batch seqs (for idempotency and gap reports)
│   └── media/<name>     optional uploads, e.g. egocentric.webm (see media.started events)
├── clips/<procedureId>/<stepId>.json   DemoClip: ghost-hand demos sliced from expert episodes
└── drafts/<procedureId>.json           LLM-drafted procedures awaiting review
```

Episode ids look like `ep-20261024-031502-k3f9` (UTC timestamp plus a random suffix), so they sort
by creation time.

## `meta.json`: `EpisodeMeta`

| Field                    | Meaning                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `schema`                 | `"clio.episode/1"`                                                                             |
| `episodeId`, `createdAt` | assigned by the server                                                                         |
| `mode`                   | `learn` (a learner with a coach), `record_demo` (an expert recording ghost-hand demos), `free` |
| `procedure`              | `{ id, version, title }`, or `null` for free recording                                         |
| `operator.role`          | `learner`, `expert` or `collector`                                                             |
| `clock`                  | `{ timeline: "performance.now", startEpochMs }`                                                |
| `space`                  | `{ frame: "workspace", units: "m", upAxis: "+y", worldFromWorkspace, calibration, anchored }`  |
| `hands`                  | `{ joints: [25 names], jointFields: [8 names] }`: self-describing layout for `frames.ndjson`   |
| `objects`                | object placements at episode start: `{ id, label, position, radius, method }`                  |
| `coach`                  | `{ kind: gemini \| scripted \| none, model?, transport? }`                                     |
| `device`                 | `{ userAgent, emulated, xrFeatures }`                                                          |

## `frames.ndjson`: `FrameRecord` (one per XR frame, 72–120 Hz)

```json
{"t":1234.56,"head":[px,py,pz,qx,qy,qz,qw],"left":{"joints":[...200 numbers],"pinch":0.031},"right":null}
```

- `left` / `right` is `null` when that hand isn't tracked.
- `joints` holds 25 joints × 8 values, `[px, py, pz, qx, qy, qz, qw, radius]`, in WebXR order
  (`wrist`, `thumb-metacarpal` … `pinky-finger-tip`). Joint _i_ starts at offset `i × 8`.
- `pinch` is the thumb-tip to index-tip distance in meters. Use it as the gripper-aperture proxy.
- Values are quantized: 0.1 mm for positions, 1e-4 for quaternions.

In Python, load the frames into an array of shape `(N, 2, 25, 8)`, with NaN where a hand is missing.

## `events.ndjson`: `EpisodeEvent` (sparse, one per line)

Every event has `t` and `type`.

| `type`                                      | Payload                                                            | Used for                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `procedure.started`                         | `procedureId, version, stepCount`                                  | episode boundaries                                                         |
| `step.entered`                              | `stepId, index, instruction, targets`                              | **the language label**: frames until the next step carry this instruction  |
| `step.completed`                            | `stepId, index, by (check\|coach\|user\|skip), forced, durationMs` | segment end, and who decided it was done                                   |
| `procedure.completed` / `procedure.aborted` | `durationMs` / `reason`                                            | outcome                                                                    |
| `mistake.detected`                          | `stepId, kind, message, source (rule\|coach)`                      | failure labels; the frames that follow are the recovery                    |
| `hand.pinch`                                | `hand, phase (start\|end), point, nearest`                         | grasp events                                                               |
| `object.registered`                         | `objectId, position, method`                                       | placement changes mid-episode                                              |
| `coach.status`                              | `state, detail?`                                                   | coach availability                                                         |
| `coach.narration`                           | `kind, text`                                                       | what the app told the model (its inputs)                                   |
| `coach.tool_call` / `coach.tool_result`     | `callId, name, args` / `callId, name, ok, result`                  | coach actions                                                              |
| `transcript`                                | `role (user\|coach), text, final`                                  | speech, aggregated per turn                                                |
| `demo.playback`                             | `stepId, clipId, phase`                                            | when ghost hands were on screen                                            |
| `media.started`                             | `name, mimeType`                                                   | aligns `media/<name>` with `t`                                             |
| `annotation`                                | `label, data?`                                                     | free-form labels (an escape hatch, so you don't have to change the schema) |

## `finish.json`: `EpisodeFinish`

`{ durationMs, outcome (completed|aborted|interrupted), stepsCompleted, stepsTotal, batches }`. If
`batches` doesn't match what `batches.json` received, data was lost in transit.

## Ingest protocol (headset → server)

1. `POST /api/episodes` with the meta minus `episodeId` and `createdAt`. The response is `{ episodeId }`.
2. `POST /api/episodes/:id/batches` with `{ seq, frames, events }`. `seq` starts at 0 and goes
   up by one. The headset sends batches one at a time and in order, retrying until each is
   acknowledged. The server appends in arrival order. A repeated `seq` returns
   `{ ok: true, duplicate: true }` and is not appended twice.
3. `POST /api/episodes/:id/finish` with `EpisodeFinish`.

## Demo clips: `DemoClip`

`POST /api/clips/from-episode { episodeId, stepIds? }` slices each completed, unforced step of a
`record_demo` episode into a clip: the frames between `step.entered` and `step.completed`, with `t`
rebased to 0. A clip's `clipId` is `<procedureId>/<stepId>`. Clips are in `W`, so they replay on any
calibrated table.

## Export conventions (pipeline)

Robotics tools expect z-up. The pipeline converts at export time, with the robot base at the
workspace origin, facing the table:

```
x_robot = -z_W     (forward, away from the user)
y_robot = -x_W     (left)
z_robot = +y_W     (up)
```

LeRobot export: each frame's `task` is the instruction of the active step. `observation.state` /
`action` are the wrist pose and pinch aperture for each hand, resampled to a fixed fps.
