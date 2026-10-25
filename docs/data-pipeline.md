# Session data pipeline

How a lesson becomes data: what is recorded while it runs, when it is compiled, where it is kept,
how the visualizer gets it, and where the object tracker and robot retargeting plug in. Field
meanings are in [data-format.md](data-format.md); the contracts are in `packages/protocol/src/`
(`episode.ts` for raw episodes, `derived.ts` for compiled ones).

## The short version

```
 headset (live)                     laptop server (files)                pipeline (after finish)
 ───────────────                    ─────────────────────                ───────────────────────
 XR frame: head + 25-joint hands ─┐
 objects (registry, tracker)  ────┤ batch every ~1 s   data/episodes/<id>/          clio compile
 2D observations (a tracker)  ────┼──────────────────► meta.json            ──────► data/derived/<id>/
 detected planes (on change)  ────┤ POST /batches      frames.ndjson        finish   manifest.json
 lesson events                ────┘                    events.ndjson        (auto)   tracks.json
                                    POST /finish ────► objects.ndjson                environment.json
                                                       observations.ndjson           retarget-<profile>.json
                                                       finish.json
                                                            │                              │
                                                            └───── GET /api/episodes ──────┘
                                                                          │
                                                       visualizer /clio (reads, stores nothing)
                                                       clio export-lerobot (explicit, selected episodes)
```

1. **Collect live.** The headset streams each episode to the laptop while it runs: one batch about
   every second (90 frames or 1000 ms), appended to plain NDJSON files. Nothing is compiled on the
   headset.
2. **Store as files.** `data/episodes/<id>/` is the source of truth. Raw files are append-only and
   never rewritten. There is no database: not SQLite, not anything else. A SQLite index could be
   added later for searching a large library, built from `meta.json`, `finish.json` and
   `manifest.json`, but nothing needs it today.
3. **Compile after the episode.** When the headset finishes an episode, the server runs
   `clio compile` in the background (it never delays the finish reply). The compiler writes
   `data/derived/<id>/`, which can be deleted and rebuilt at any time. A compile is **stale** when
   any raw file, the compiler version or a robot profile changed after it. At startup the server
   checks every finished episode once (`--if-stale`, one episode at a time, after any compile a
   lesson asked for), so a pipeline or profile change recompiles the library.
   `POST /api/episodes/:id/compile` always recompiles; media uploads never trigger a compile.
   Compiles of one episode take a lock (`data/derived/.<id>.lock`), so the server and a manual
   `clio compile` never collide, and a compile that is stopped cleans up after itself.
4. **Inspect.** The visualizer (`/clio`, port 3001) reads raw files while an episode records and
   the compiled files once it is done, both through the server's read routes. The visualizer
   keeps no copy of either.
5. **Export on purpose.** A LeRobot dataset is built from episodes you pick
   (`clio export-lerobot`). Compiling is automatic; exporting and publishing never are.

## What runs live, what runs after the episode

Everything that can wait for the episode to end does. Only work whose inputs exist nowhere else
runs on the headset:

| Live on the headset                            | Why it cannot wait                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Lifting 2D detections into 3D                  | Camera frames are not stored, and the head pose at capture time comes from a live pose history |
| Grasp and release detection                    | The lesson reacts to it (checks, held objects riding the wrist)                                |
| Recording 2D observations and the camera model | Without them nothing can be lifted again offline (see below)                                   |
| Snapshotting detected planes                   | `XRFrame.detectedPlanes` exists only inside an XR frame                                        |

| After the episode, in `pipeline/`                              | Why later is better                                                                                                     |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Resampling hands, head and objects onto one fixed-rate grid    | Needs samples on both sides of each grid time                                                                           |
| Held spans, validity masks, interpolation between measurements | Needs the whole object history; never fills gaps silently                                                               |
| Environment (table, floor, walls)                              | Merges every plane snapshot of the episode                                                                              |
| Inverse kinematics retargeting                                 | Warm-starts across the whole trajectory, reruns when a robot profile changes, and costs the Quest no heat or frame time |
| Quality verdict                                                | Needs `finish.json` and batch bookkeeping                                                                               |
| LeRobot export                                                 | A deliberate choice of episodes, never automatic                                                                        |

## Raw episode additions (`clio.episode/1`, all optional)

Older episodes stay valid, and readers check `meta.features` before trusting a new field. What a
lesson records today: head, hands, object estimates and lesson events as before, plus detected
planes when the session has plane detection, `meta.camera` whenever the passthrough camera is open,
and 2D observations while the live tracker follows the lesson's objects (see below). The
primary-object page (`primary.html`) records detected planes and `meta.camera` too. The synthetic
`tracked-objects` fixture has all of them.

| Feature               | What it adds                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `object.observations` | Batches carry `observations`, stored as `observations.ndjson`: one `ObjectObservation` per line, what an object finder saw in one camera frame (2D)   |
| `object.surface`      | Observations carry `surface`: depth samples measured inside the outline on that frame, in W, so a shape can be fused after the episode                |
| `environment.planes`  | `environment.planes` events: a full snapshot of every detected plane (kind, raw label, pose in W, polygon), at the start and whenever a plane changes |
| (none)                | `meta.camera`: the passthrough camera model (intrinsics, `headFromCamera`, where it came from) that observations were lifted with                     |

`ObjectObservation` keeps the 2D answer separate from the 3D estimate. The 3D estimate still goes
to `objects.ndjson` as an `ObjectState`, with the same `objectId` and its `observedT`. Its
`status` is never upgraded: a tracker coasting on a predicted box writes `predicted`, and the 3D
state it implies is valid but not tracked (location flags 2, or 3 with a measured orientation),
never measured. The same goes for a box seen on its frame whose distance was not measured on that
frame (a depth reused from an earlier frame, or where its ray meets a surface): flags 2. A made-up
distance gives no 3D state at all. A lost or absent object gets one state with flags 0 at its last
position. A sample without a score records its 2D observation but no 3D state, so no confidence is
invented.

A server on an older protocol silently drops `observations` and `meta.camera` and answers 400 to
`environment.planes` events, so restart the server whenever the headset changes (as for every
protocol change).

## Compiled files (`clio.derived/1`)

All spatial values stay in the episode's workspace frame W and all times in episode ms, exactly
like the raw episode, so the visualizer converts them with the same code it uses for raw data.
Arrays hold one value per grid frame and use `null` for "no valid value"; there is never a NaN or
a silently filled gap. Where the recorded frames around a grid time are more than 100 ms apart
(`policy.maxFrameGapMs`: a lost batch, or the XR loop paused while the headset was off), the head
and wrists are `null` and the robot arms get no target.

| File                      | Contents                                                                                                                                                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`           | Compiler version, the raw inputs with byte counts and SHA-256, each stage's status, the artifacts written and the quality verdict                                                                                                                                                       |
| `tracks.json`             | The head, both wrists (pose and pinch) and every object on one grid (default 30 fps): position, orientation, tracked, interpolated, held by, confidence, source, held spans, the plan's kind and `partOf`, an estimated `extent` (below), and a summary of the object's 2D observations |
| `environment.json`        | The table (from calibration, the plan, or placed on a detected table plane), the floor of the WebXR space with the table height when it is known, and every detected plane                                                                                                              |
| `shapes.json`             | Each object's depth samples fused into a point set and a yaw-aligned box, as offsets from its tracked position (below); skipped when no observation carries `surface`                                                                                                                   |
| `retarget-<profile>.json` | Per robot arm: joint values, gripper, tool target and achieved pose, residuals, reachability, and joint positions for drawing                                                                                                                                                           |

The quality verdict marks an episode **usable** only when it finished as `completed`, every batch
arrived, no frames are missing for more than a second, the hands were tracked for most of it, and
every line passed validation. `reasons` says why not otherwise.

### Measured 3D for objects

A camera-tracked object is recorded as one point per frame (where its inner ray met the depth
map) and a 2D outline; nothing says how big it is or what shape it has. Two compiled values add
that without inventing anything, and the visualizer labels them as what they are:
- **`extent`** (in `tracks.json`, estimated): each measured observation's box, at the object's
  compiled depth from the camera, through `meta.camera`'s intrinsics, gives a width and a height in
  meters; the medians over at least three observations are kept, with the sample count. Null without
  a camera model, boxes or depth. The depth across the camera is unknown, so the viewer draws a
  box of width by width by height.
- **`shapes.json`** (measured): the `surface` samples of every measured observation, each frame's
  taken relative to the object's compiled position at that frame so the shape rides with the
  object, skipping frames where the object is held or has no valid position. Offsets are fused on
  a 1 cm voxel grid (a voxel needs two samples once there are more than 50), capped at 2000
  points, and summed up as a yaw-aligned box: the principal horizontal axis from the points, the
  2nd to 98th percentile along each axis, standing on the table. The points show the side the
  camera saw; the box is the honest envelope of that.

## Where the object tracker plugs in

The live tracker (YOLOE-26 + ByteTrack over `/track`, [object-finder.md](object-finder.md)) follows
every object a lesson declares, for the whole lesson (8 at a time, the focused step's show items
first), including the whole object a shown part belongs to (`partOf`). Only the show items and the
coach's highlights are lit; the rest is followed for the recording. It feeds only the learner's AR
view and the recording: nothing it says reaches a Gemini coach, completes a step or fires a rule
under one ([coach-plan.md](coach-plan.md)).
Four seams carry its answers into the data:
1. **Headset: `TrackedObjectSample`** (`apps/headset/src/domain/world/tracked-object.ts`). Any
   object source (`/track`, a session `/locate`, a marker tracker, a future 6DoF tracker) converts
   its answers into this one class: object id, capture time, status (measured, predicted, lost,
   absent, unknown), role, model name, raw score, optional 2D image geometry, optional 3D position
   and orientation, and `positionMeasured: false` when that position was not measured on the
   frame. `ObjectTrackRecorder` records each sample: the 2D part as an `ObjectObservation`, the 3D
   part (when asked to) as an `ObjectState` with honest location flags.
2. **Headset, in a lesson: `ObjectRegistry`** owns the 3D estimates, so the recorder writes only
   the 2D observations (`states: 'none'`, feature `object.observations`). The live tracker puts
   about five lifted positions a second per object into the registry as `detector` observations,
   the camera's untrusted source: `measured: false` gives flags 2 instead of 10, and
   `registry.lose(id, t)` writes one state with flags 0 at the last position. The lesson keeps that
   last position for its checks, pinch targets and overlays, as it always has; under a Gemini coach
   checks ignore `detector` positions anyway. A held object belongs to the hand: the registry
   ignores camera answers and losses about it, and a lost object a hand grasps is carried again.
3. **Pipeline: `ObjectSeries`** (`pipeline/src/clio_pipeline/objects.py`). The compiler turns any
   object's raw states into one series on the grid, with masks for valid, tracked and
   interpolated values; a predicted (flags 2) detector state is valid there but never tracked.
   Each object's entry in `tracks.json` also gets an `observations` summary
   (`pipeline/src/clio_pipeline/observations.py`): how many lines `observations.ndjson` has about
   it, by status, the roles and models that answered, the trackers' own ids and the first and last
   frame times. The 2D geometry stays in the raw file; an object with observations but no 3D state
   gets no track. Retargeting, export and the visualizer read the series, so they do not care which
   tracker produced the data.
4. **Visualizer.** It reads `observations.ndjson` for episodes that list `object.observations`
   (the inspector says what the camera last saw) and types a valid but untracked camera estimate as
   predicted. Compiled files arrive through `/api/clio/episodes/<id>/derived/<name>`. The viewer
   draws the compiled planes, table and floor, the retargeted arms (inferred look) and the compile
   state. Once an episode is compiled, its objects play back from `tracks.json` (position, held,
   tracked), with the estimated `extent` as a box and the fused `shapes.json` as points and a yaw
   box riding on the position; live and uncompiled episodes show the raw estimates.

Pipeline 0.4.0 added the observations summary, 0.5.0 each object's `partOf`, 0.6.0 the estimated `extent` and `shapes.json`. A version change makes every compile stale, so the
server's startup sweep recompiles the library once, one episode at a time.

## Robot retargeting

Human hands are the measured motion; a robot arm is an assumption layered on top. Retargeting is
therefore an explicit, versioned **profile** (`pipeline/src/clio_pipeline/retarget/profiles/`): the
URDF and its SHA-256, the actuated joints, which hand drives which arm, where each robot base sits
relative to the table corner, the wrist-to-tool offset, an optional workspace scale, the
orientation mode (`full`, `approach_axis` or `position_only`), the pinch-to-gripper mapping and
the solver tolerances.

`clio compile` solves every grid frame with damped least squares on the URDF chain (numpy only,
warm-started from the previous frame, joint limits enforced) and records the residual and
reachability of every frame. Frames without a tracked hand get no target and `null` joints. The
bundled `clio-arm-6dof` profile drives two made-up 6-DoF arms (left hand, right hand), marked
`example`, so the pipeline and the viewer can be tried before a real robot is chosen. For a real
robot, add a profile with its URDF.

The robot trajectory is an inference from the hands and is labelled that way everywhere: it is not
proprioception and not a measured command. `clio export-lerobot --robot-profile <file>` builds a joint-space dataset from
it; without that flag the export keeps the `human_hands` profile.

## Running it

```bash
pnpm dev                                   # server compiles each finished episode automatically
cd pipeline && uv run clio compile ../data/episodes/<id>    # by hand, into ../data/derived/<id>/
cd pipeline && uv run clio compile ../data/episodes --if-stale
```

Server settings: `CLIO_COMPILE=off` disables automatic compiles. `CLIO_RETARGET_PROFILES` is a
comma-separated list of profile files (`none` for no retargeting); the default is the bundled
example arm.
