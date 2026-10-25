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
│   ├── events.ndjson    one EpisodeEvent per line, in arrival order
│   ├── objects.ndjson   one ObjectTrackRecord per tracker update, in arrival order
│   ├── observations.ndjson  one ObjectObservation per 2D object-finder answer (optional)
│   ├── finish.json      EpisodeFinish: written when the headset finishes the episode
│   ├── batches.json     server bookkeeping: {"received": [seq…], "gaps": [seq…]}
│   └── media/<name>     optional uploads: room-scan-<n>.glb, keyframe-<nnnn>.jpg (see below),
│                        egocentric.webm (see media.started events)
├── derived/<episodeId>/                compiled after the episode finishes; rebuildable (see below)
├── clips/<procedureId>/<stepId>.json   DemoClip: ghost-hand demos sliced from expert episodes
└── plans/<planId>.json                 procedures written by the planner (and their revisions)
```

Episode ids look like `ep-20261024-031502-k3f9` (UTC timestamp plus a random suffix), so they sort
by creation time.

Frames must be in timestamp order. Events, object updates and observations can arrive out of
order from asynchronous callbacks. The Python loader stably sorts these channels by recorded `t`,
preserving file order for equal timestamps. Validation checks every record's schema without
rejecting delayed arrivals; raw files and timestamps remain unchanged.

## `meta.json`: `EpisodeMeta`

| Field                    | Meaning                                                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                 | `"clio.episode/1"`                                                                                                                                                                                                                 |
| `episodeId`, `createdAt` | assigned by the server                                                                                                                                                                                                             |
| `mode`                   | `learn` (a learner with a coach), `record_demo` (an expert recording ghost-hand demos), `free`                                                                                                                                     |
| `procedure`              | `{ id, version, title }`, or `null` for free recording                                                                                                                                                                             |
| `plan`                   | the full Procedure used (optional), including each step's `show` items. AI-generated plans exist nowhere else, so episodes are self-contained                                                                                      |
| `operator.role`          | `learner`, `expert` or `collector`                                                                                                                                                                                                 |
| `clock`                  | `{ timeline: "performance.now", startEpochMs }`                                                                                                                                                                                    |
| `space`                  | `{ frame: "workspace", units: "m", upAxis: "+y", worldFromWorkspace, calibration, anchored }`                                                                                                                                      |
| `hands`                  | `{ joints: [25 names], jointFields: [8 names] }`: self-describing layout for `frames.ndjson`                                                                                                                                       |
| `objects`                | object placements at episode start: `{ id, label, position, radius, method }`                                                                                                                                                      |
| `coach`                  | `{ kind: gemini \| scripted \| none, model?, transport? }`                                                                                                                                                                         |
| `device`                 | `{ userAgent, emulated, xrFeatures }`                                                                                                                                                                                              |
| `features`               | optional recording features in use, e.g. `"object.flags"`, `"environment.planes"` (see [Optional fields](#optional-fields) and [Room scan](#room-scan-and-keyframes)). Absent in older episodes                                    |
| `camera`                 | optional passthrough camera model: `{ intrinsics: { width, height, fx, fy, cx, cy }, headFromCamera, source }`, so 2D observations can be lifted again offline. `source` is `lens-metadata`, `default`, `calibrated` or `override` |

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

| `type`                                      | Payload                                                                                                      | Used for                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `procedure.started`                         | `procedureId, version, stepCount`                                                                            | episode boundaries                                                                                                                                                                                                                                                                                                                                    |
| `step.entered`                              | `stepId, index, instruction, targets`                                                                        | **the language label**: frames until the next step carry this instruction                                                                                                                                                                                                                                                                             |
| `step.completed`                            | `stepId, index, by (check\|coach\|user\|skip), forced, durationMs`                                           | segment end, and who decided it was done                                                                                                                                                                                                                                                                                                              |
| `procedure.completed` / `procedure.aborted` | `durationMs` / `reason`                                                                                      | outcome                                                                                                                                                                                                                                                                                                                                               |
| `mistake.detected`                          | `stepId, kind, message, source (rule\|coach)`                                                                | failure labels; the frames that follow are the recovery                                                                                                                                                                                                                                                                                               |
| `hand.pinch`                                | `hand, phase (start\|end), point, nearest`                                                                   | pinch gestures; without recorded grasps (older episodes), grasps are inferred from these                                                                                                                                                                                                                                                              |
| `object.detected`                           | `objectId, stepId, phrase, description, found, point, box, outline, confidence, position, source, latencyMs` | **detection labels**: what the object finder was asked (the step's words) and answered, in normalized image coordinates (x right, y down), plus the lifted workspace position. The frame was captured at `t - latencyMs`. `source` is the finder's model (Gemini, or jev at `CLIO_VISION_URL`)                                                        |
| `object.registered`                         | `objectId, position, method`                                                                                 | placement changes mid-episode                                                                                                                                                                                                                                                                                                                         |
| `object.grasped`                            | `objectId, hand, grip (pinch\|fist), position`                                                               | a hand took hold of the object (`"object.grasp"` feature). `position` is the object's reference point at that moment                                                                                                                                                                                                                                  |
| `object.released`                           | `objectId, hand, reason (opened\|hand_lost\|plan_changed), position`                                         | the hand let go (`opened`), hand tracking dropped out (`hand_lost`) or a new plan was loaded (`plan_changed`)                                                                                                                                                                                                                                         |
| `coach.status`                              | `state, detail?`                                                                                             | coach availability                                                                                                                                                                                                                                                                                                                                    |
| `coach.narration`                           | `kind, text`                                                                                                 | what the app told the model (its inputs)                                                                                                                                                                                                                                                                                                              |
| `coach.tool_call` / `coach.tool_result`     | `callId, name, args` / `callId, name, ok, result`                                                            | coach actions                                                                                                                                                                                                                                                                                                                                         |
| `transcript`                                | `role (user\|coach), text, final`                                                                            | speech, aggregated per turn                                                                                                                                                                                                                                                                                                                           |
| `demo.playback`                             | `stepId, clipId, phase`                                                                                      | when ghost hands were on screen                                                                                                                                                                                                                                                                                                                       |
| `media.started`                             | `name, mimeType`                                                                                             | aligns `media/<name>` with `t`                                                                                                                                                                                                                                                                                                                        |
| `environment.planes`                        | `planes: [{ id, kind, label, orientation, pose, polygon }]`                                                  | every plane the headset detects (`"environment.planes"` feature): a full snapshot at the start and whenever a plane appears, disappears or changes, at most once a second. `pose` is in `W` with the polygon in its local x/z plane (+y is the normal). `kind` is `table`, `floor`, `wall`, `ceiling`, `couch` or `other`, from the raw WebXR `label` |
| `environment.meshes`                        | `media, meshes: [{ id, kind, label, global, vertices, triangles }]`                                          | the Quest room scan (`"environment.meshes"` feature): a full snapshot of the detected meshes, their geometry in `media/<media>` ([below](#room-scan-and-keyframes))                                                                                                                                                                                   |
| `scene.keyframe`                            | `media, capturedT, pose, width, height, intrinsics`                                                          | a passthrough camera still, `media/<media>`, with the camera's pose in `W` (`"scene.keyframes"` feature, [below](#room-scan-and-keyframes))                                                                                                                                                                                                           |
| `annotation`                                | `label, data?`                                                                                               | free-form labels (an escape hatch, so you don't have to change the schema; see [Annotations](#annotations))                                                                                                                                                                                                                                           |

## `objects.ndjson`: `ObjectTrackRecord` (one per update that changed an estimate)

```json
{
  "t": 1250.0,
  "objects": [
    {
      "id": "syringe",
      "position": [0.21, 0.05, -0.1],
      "orientation": [0, 0, 0, 1],
      "confidence": 0.92,
      "source": "marker"
    }
  ]
}
```

- Each line lists the objects whose estimate **changed** in that update. To reconstruct the state at
  time `t`, start from `meta.objects` and apply every line up to `t`.
- Lines are sparse. An object at rest gets a line only when it is placed, registered or detected
  again. A held object follows the wrist, so it gets one line per XR frame (72–120 Hz) until it is
  released.
- `position` is the object's reference point (rim center, bottle mouth, tool tip) in `W`.
- `orientation` is set only for marker-tracked objects; it's `null` for detector or layout estimates.
- `source` is one of `layout`, `pinch`, `marker`, `detector` or `manual`. `confidence` is in 0..1.

Marker frame (used by `tracking.marker.offset` in procedures): the origin is the marker's center,
+x points to the marker's right, +y toward its top edge, and +z comes out of the printed face toward
the viewer. Meters.

### Optional fields

Newer episodes add three fields to each object state and list `"object.flags"` in `meta.features`.
The schema id stays `clio.episode/1`; older episodes leave the fields out and stay valid.

| Field           | Meaning                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `locationFlags` | bits, as in OpenXR and Capture v1: 1 orientation valid, 2 position valid, 4 orientation tracked, 8 position tracked. Valid means the value can be used; tracked means it was just measured |
| `heldBy`        | `left` or `right` while that hand carries the object, otherwise `null`. Left out when the recorder does not know (the tracker seam records grasps as events instead)                       |
| `observedT`     | ms since episode start when the estimate was measured (for a detection, when its camera frame was taken). Omitted when within 1 ms of `t`; negative if measured before the episode started |

```json
{
  "id": "syringe",
  "position": [0.21, 0.05, -0.1],
  "orientation": null,
  "confidence": 0.8,
  "source": "detector",
  "locationFlags": 10,
  "heldBy": null,
  "observedT": 1180.0
}
```

Rules, checked by the protocol schema at ingest (the JSON Schema checks only the 0–15 range):
- `position` is always present. Without the position-valid bit it holds the last valid estimate,
  because readers such as the pipeline use it.
- A tracked bit needs its valid bit, so the allowed values are 0, 1, 2, 3, 5, 7, 10, 11 and 15.
- `orientation` is non-null exactly when the orientation-valid bit is set.

What the headset writes: 2 for `layout`, `pinch` and `manual` placements; 10 for `detector`; 15 for
`marker` with an orientation, 10 without. A one-shot finder answer (`object.detected`) is lifted
onto the table or a detected plane on its own frame and keeps 10. A live tracker's estimate (the
lesson's `/track` objects, the primary page, `ObjectTrackRecorder`) is tracked only when the box
was seen on its frame and its distance measured there by depth sensing or hit-test; otherwise it
is valid but never tracked, 2 (3 with an orientation): a tracker coasting on a predicted box, a
distance reused from an earlier frame, or where the box's ray meets a surface. A distance the
headset made up (the primary page's fixed guess) records no state at all. When a live source loses
an object, or says it is absent, one state with 0 is written at its last position (confidence 0,
no `observedT`), until it is seen again. A held object has 2 while its wrist is tracked (3 if its
orientation is known) and 0 while the wrist is lost; where the hand let go it has 2, whatever
placed it before.

Without `locationFlags` (older episodes), derive them from `source`: position valid always, plus
position tracked for `marker` and `detector`; when `orientation` is non-null, also orientation valid,
plus orientation tracked for `marker`.

Episodes that list `"object.grasp"` in `meta.features` record every grasp and release as
`object.grasped` and `object.released` events. Without it, grasps can only be inferred from
`hand.pinch` events and from runs of per-frame `source: "pinch"` lines.

## `observations.ndjson`: `ObjectObservation` (optional, one per line)

Episodes that list `"object.observations"` in `meta.features` keep what object finders saw in the
camera image, separately from the 3D estimates in `objects.ndjson`:

```json
{
  "t": 1250,
  "observedT": 1190,
  "objectId": "syringe",
  "status": "measured",
  "role": "tracker",
  "source": "yoloe-26l-seg",
  "box": [0.4, 0.3, 0.5, 0.45],
  "outline": null,
  "point": [0.45, 0.36],
  "contact": [0.45, 0.45],
  "score": 0.81,
  "frame": { "seq": 42, "width": 480, "height": 360 },
  "trackId": "7"
}
```

- `t` is when the answer arrived; `observedT` is when its camera frame was captured (can be
  negative). Image coordinates are normalized 0..1, x right, y down.
- `surface` (optional, `"object.surface"` feature): up to 64 depth samples measured on that frame,
  in `W` (meters): where camera rays through a grid inside the outline met the depth map, kept only
  within 0.3 m of the object's measured center, at most every 0.5 s per object, never while the
  object is in hand or only coasting. `clio compile` fuses them into `shapes.json`
  ([data-pipeline.md](data-pipeline.md#compiled-files-clioderived1)).
- `status`: `measured` (seen in that frame), `predicted` (carried forward by the tracker without
  being seen), `lost`, `absent` (the identifier says it is not in view) or `unknown`. A
  `predicted` observation never produces a measured 3D estimate: its `objects.ndjson` state has
  position valid but not tracked (flags 2, or 3 with an orientation).
- `role`: `tracker` (every frame), `identifier` (about once a second, e.g. jev) or `detector`
  (one-shot, e.g. Gemini). `score` is the raw score as reported, not a calibrated probability.
  `trackId` is the tracker's own id, provenance only.

Who writes them: a lesson while the live tracker follows its objects (one line per tracked frame
and object, a loss once), and the synthetic `tracked-objects` capture. In a lesson the 3D estimates
come from the object registry instead (flags as above, source `detector`), so an observation and a
state about the same frame share `objectId` and `observedT` but are written by different parts of
the app. Observations are recorded for the dataset only: nothing in them reaches a Gemini coach.
`clio compile` sums them up per object in `tracks.json` (`observations`: counts by status, roles,
models, track ids, first and last frame time); the 2D geometry stays here.

## `meta.camera`

The passthrough camera model the 2D answers were lifted with, written when the episode is created
by any app that has a camera open (lessons, and the primary-object page):
- `intrinsics`: pinhole focal lengths and principal point in pixels of an image `width` x `height`.
  Image coordinates in episodes are normalized, so scale them to that size to use the intrinsics.
- `headFromCamera`: the camera's pose in the XR viewer (head) frame, a Pose7.
- `source`: where the model came from. `override` when URL parameters (`?camX=` and the like on
  `primary.html`) moved it, `calibrated` when calibrate.html's stored calibration fits the camera,
  `lens-metadata` when the browser reported lens intrinsics, `default` for the Quest 3 guess (Quest
  Browser 154 reports no lens fields).

## Room scan and keyframes

Two optional additions for the rebuilt room and the object models ([room-scene.md](room-scene.md)
is the design). Both put their files in `media/` through the upload queue, after the episode's
create and before its finish; an event whose file never arrived is skipped by readers.

`environment.meshes` (`"environment.meshes"` feature) records the Quest room scan, read through
WebXR mesh detection: the room's global mesh (`global: true`, label `global mesh`) and a volume per
labelled piece of furniture. Each event is a full snapshot, numbered from 1 per episode, and
`media/room-scan-<n>.glb` holds its geometry: one root node per mesh named by its `id`, its
translation and rotation the mesh pose in `W`, POSITION in mesh-local meters (float32, with
min/max), uint32 triangle indices, and `extras: { kind, label, global }`. `kind` comes from the
label as for planes. The headset records a snapshot as soon as there are meshes while recording,
and again when a mesh appears, disappears or changes, at most every 10 s and 8 times an episode.
It never records an empty one, waits up to 2 s for a mesh it cannot locate, and leaves out a mesh
whose geometry is unusable (non-finite vertices, indices out of range).

`scene.keyframe` (`"scene.keyframes"` feature) records a passthrough camera still for the object
models, `media/keyframe-<nnnn>.jpg` (numbered from 1, at most 960 px wide). `capturedT` is when the
camera frame was captured, on the same clock as an observation's `observedT` (can be negative).
`pose` is the camera in `W` at `capturedT`: the head pose then `meta.camera.headFromCamera`, camera
axes as WebXR (x right, y up, looking down -z). `width` and `height` are the stored image's, and
`intrinsics` (`fx, fy, cx, cy`) are `meta.camera`'s scaled to it. The headset keeps a frame from a
new viewpoint (20 cm or 12° from every earlier keyframe), with the head still (under 40°/s and
0.5 m/s), that shows a placed object or the middle of the work area, at least 2 s after the last
one and at most 40 an episode, only with `?scan=1`. The stills stay on the laptop like the rest of
the episode.

## Annotations

`annotation` events carry labels a new app needs without a new event type (an older server would
answer 400 to one), so readers skip labels they don't know. Among them:

| `label`               | Written by                                      | `data`                                                                             |
| --------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `primary.target`      | `primary.html`, when the tracked target changes | `{ objectId, name, previous }`: what the tracker follows now (null for nothing)    |
| `lesson.first_step`   | a lesson, as its first step starts              | how `start_lesson` got there and how long it took ([coach-plan.md](coach-plan.md)) |
| `lesson.first_locate` | a lesson, once its first look has answered      | `{ locateMs, sinceStartMs, located, missing }`                                     |
| `widget.updated`      | the coach's widgets, on every change            | the whole widget after each change ([widgets.md](widgets.md#what-is-recorded))     |

A change of what a tracker follows is an annotation for the same reason, and so is every change to
the coach's widgets: folding the `widget.updated` annotations by `seq` gives what the learner saw at
any frame. The coach's own labels (`plan.*`, `step.watch`, `coach.*`) are described in
[coach-plan.md](coach-plan.md).

## `finish.json`: `EpisodeFinish`

`{ durationMs, outcome (completed|aborted|interrupted), stepsCompleted, stepsTotal, batches }`. If
`batches` doesn't match what `batches.json` received, data was lost in transit.

## Ingest protocol (headset → server)

1. `POST /api/episodes` with the meta minus `episodeId` and `createdAt`. The response is `{ episodeId }`.
2. `POST /api/episodes/:id/batches` with `{ seq, frames, events, objects, observations }`
   (`objects` and `observations` default to empty). `seq` starts at 0 and goes
   up by one. The headset sends batches one at a time and in order, retrying until each is
   acknowledged. The server appends in arrival order. A repeated `seq` returns
   `{ ok: true, duplicate: true }` and is not appended twice.
3. `PUT /api/episodes/:id/media/:name` with a file's bytes (`room-scan-<n>.glb`,
   `keyframe-<nnnn>.jpg`), in the same queue as the batches: in the order the headset made them,
   retried the same way, a refused one dropped. While the server is unreachable the headset holds
   up to 24 MiB of files, then drops the oldest keyframes waiting (never a room scan).
4. `POST /api/episodes/:id/finish` with `EpisodeFinish`.

Restart the server whenever the headset's protocol changes. A server on an older protocol silently
drops fields it doesn't know and rejects batches containing new event types with 400; the headset
drops each rejected batch (about a second of data).

## Compiled episodes: `data/derived/<episodeId>/`

After an episode finishes, the server runs `clio compile` in the background and writes
`manifest.json`, `tracks.json`, `environment.json` and one `retarget-<profile>.json` per robot
profile (schema `clio.derived/1`, `packages/protocol/src/derived.ts`). They never change the raw
files and can be deleted and rebuilt. `GET /api/episodes/:id` reports the compile state
(`derived.state`: `none`, `queued`, `running`, `ok`, `stale` or `failed`) and
`GET /api/episodes/:id/derived/<name>` serves the files. [data-pipeline.md](data-pipeline.md)
explains what each file holds and when it is compiled.

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
With `--robot-profile <profile.json>` they are instead the joint values (URDF joint names, one
gripper value per arm) that IK retargeting solves for that profile, with
`observation.retarget.valid` and `observation.retarget.residual_pos` per arm. Frames the solver
could not reach hold the last reachable joints with valid 0, and `residual_pos` is the tool error
of the joints actually exported (0 where the hand gave no target).
