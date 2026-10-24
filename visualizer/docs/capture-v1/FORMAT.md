# Quest Capture v1

Implementation contract, designed 2026-10-23. This is an application format, not a Meta, OpenXR, or LeRobot standard. The existing viewer's static scene importer does not yet load this package. The recorder, receiver, motion playback adapter, and LeRobot exporter remain to be implemented. The JSON Schema, validator, and synthetic example are usable now.

## Start here

One package is one episode, with one task string, stable recording ID, and continuous world reference. A dataset aggregates packages later. Record locally on the headset, finalize a manifest, transfer the files, validate them, then view or export. Keep original capture files immutable after finalization.

```text
recording/
  recording.json
  scene.json
  calibration.json
  assets/                         # Optional self-contained GLBs
  streams/
    hands.jsonl
    objects.jsonl
    headset.jsonl
    events.jsonl                  # Optional annotations
  video/                          # Optional camera streams
    left.mp4
    left.timestamps.jsonl
```

`recording.json` is the entry point. It identifies the schema version, source software/device, task, duration, clock mappings, streams, optional videos, and an inventory of every payload file with byte length and SHA-256. The manifest excludes itself from that inventory. A ZIP may wrap the folder for manual transport; it is not a second format. Do not inline video or encode GLBs in base64. All paths are canonical, relative to the package root, case sensitive, and use `/`; no empty components, `.`, `..`, absolute paths, URI schemes, or symlinks.

`capture.schema.json` validates each document or individual JSONL record. `kind` selects its definition. Unknown core fields are rejected; experimental additions go inside `extensions`. Incompatible meaning/units require a new `schema_version`; never silently reinterpret an old recording. JSON numbers must be finite. All integer times/indices fit JavaScript's safe integer range. UTF-8 JSONL has one complete JSON object per line and ends in a newline.

Run `bun install` in this starter-kit directory, then `bun run validate -- example/recording.json`. The validator checks structure, hashes, references, ordering, location flags, clock mappings, and quaternion norms. Video decoding, calibration accuracy, and tracking accuracy require separate runtime checks.

## Capture profile

There is no universal robotics capture frequency. These are this application's initial defaults, not promised sensor rates.

| Stream         | Request / target                                                          | Store                                                                                          |
| -------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Hand poses     | 60 Hz logging and high-frequency tracking where supported                 | Every acquired sample with source pose time, availability time, and flags; retain actual rates |
| Headset        | 90 Hz logging if app/runtime supplies it, otherwise actual XR update rate | Pose estimates with target time and prediction provenance                                      |
| RGB            | 60 FPS, 1280×960 per camera if negotiated; fall back to 30 FPS            | Actual camera frames, hardware-encoded H.264 MP4, per-frame timestamps                         |
| Object pose    | Every completed tracker estimate, initially target 30–60 Hz               | Input camera frame/time, pose, quality, algorithm version                                      |
| Static room    | Once after calibration                                                    | Geometry/planes, dimensions and world transforms                                               |
| LeRobot export | 30 Hz default; optional 60 Hz                                             | Resampled training timeline, with explicit export profile                                      |

Meta documents default hand tracking at 30 Hz and Fast Motion Mode at 60 Hz. A higher-frequency hint may be ignored. Polling at 90 Hz does not imply 90 independent hand measurements. The current camera API documents 60 Hz and selectable resolutions; negotiate capabilities instead of assuming them. Capture both RGB cameras when available within the measured recording budget, but support a single-camera package without a schema change. Do not force stereo timestamps to match or invent missing frames.

Start video encoding near 12–20 Mbit/s per 1280×960 camera at 60 FPS (configuration target, not a Meta requirement). Measure hand visibility, compression artifacts, thermal load, write speed, and dropped frames on hardware. Two cameras at 16 Mbit/s each use about 240 MB/minute before other data. Prefer retaining original resolution and downsampling at export. Do not treat display refresh as a camera or tracking rate.

The recorder logs requested rates and observed per-track rates. For event files, rates are null. For shared hand files, `sample_count` counts both hands' rows, while `observed_hz` is the median per-hand rate, not their sum. A quality report should list per-entity rate distribution, gaps, tracking validity fraction, dropped video frames, and clock uncertainty. v1 does not claim these rates or accuracy until measured on a Quest.

## Coordinates and calibration

The canonical world is right-handed, meters, X forward, Y left, Z up (ROS REP-103). Define it deliberately at session setup: floor below the worktable center, X toward the workspace, Y left, Z vertical. A table-corner origin is also valid if explicitly described. There is no mandatory robot frame and no `base_link` requirement for human recordings.

A pose contains `translation: [x,y,z]` and `rotation: [x,y,z,w]`. Its matrix `T_parent_child` maps points from child coordinates into parent coordinates: `p_parent = R * p_child + translation`. Quaternions are unit length within 0.001. Poses use scale one; dimensions are baked into GLB assets or primitive sizes. Primitive boxes are centered on their pose. Assets have a deliberately chosen origin such as the object's center; changing that origin changes every tracked pose's meaning.

All hand joint and entity samples are expressed directly in `world`, not parent-relative joint rotations. The original SDK basis and calibration are recorded for audit. In `calibration.json`, `basis_conversion.matrix_row_major` is an orthonormal source-basis-to-ROS matrix B; convert position as B*p and rotation as B*R\*inverse(B), then apply `T_world_source`. OpenXR basis to ROS is `(x,y,z) -> (-z,-x,y)`. Unity basis to ROS is `(x,y,z) -> (z,-x,y)` and changes handedness; matrix conversion is required. Do not just reorder quaternion components. The `T_world_source` pose is the calibrated placement of the converted source origin in world.

Camera optical frames use X right, Y down, Z forward. `T_parent_camera` in camera calibration maps this optical frame into the headset's canonical ROS-oriented frame. Camera intrinsics are pixels for the stored resolution, origin at top left, U right, V down. Record distortion model/coefficients and whether calibration describes raw or rectified images. Crop, resize, rotate, or mirror operations must be reflected in intrinsics and image metadata. Prefer upright, unmirrored video. Each video-index sample may include `T_world_camera` at that frame's exposure time; this is preferable to using the newest head pose.

Self-contained GLB assets follow glTF Y-up meters. Apply asset `(x,y,z) -> ROS(x,-z,y)` before its entity pose. Do not auto-center or rescale on import. Floor/table models are optional; their calibrated planes/locations can still be stored as static entities. This scene document is separate from the existing `.scene.json` editor format; an adapter can convert static entities later.

Recenter or relocalization must preserve the established world by updating the source-to-world transform and logging a `recenter` event with before/after transforms in `details`. This event is an audit record: already-recorded samples stay in world. If the transform cannot be recovered, stop this recording and start a new recording ID/world. Never silently join trajectories across an unknown jump. Continuous anchor corrections may likewise update the producer's calibration; record their timestamped transforms in events.

## Time and synchronization

`t_us` is an integer microsecond offset from the recording's monotonic origin: the time represented by the observation/pose. It is never the computer's packet arrival time. `available_t_us` is when that estimate/frame became available on the recording clock. A tracker can finish late while describing an earlier camera frame. A predicted pose can describe a future time, and must have `estimate_type: predicted`.

Keep native source time as decimal-string `source_time.ticks_ns`, with a `clock_id` declared in the manifest. Decimal strings avoid losing 64-bit timestamp precision in JavaScript. For each clock, v1 defines:

```text
t_us = round(scale * (ticks_ns - source_origin_ns) / 1000 + offset_us)
```

Subtract the integer nanosecond origin before converting to floating point. `scale` handles clock drift; `offset_us` maps to recording zero; `uncertainty_us` is null if unknown. A recording uses one mapping per clock ID. If a new fit is needed, declare a new clock ID and preserve earlier mappings. Do not assume Camera2, OpenXR, Unity and Android elapsed-time clocks are interchangeable. Query the camera timestamp source, use runtime conversion APIs where available, and record the mapping method. If synchronization is uncalibrated, retain that fact rather than claiming precision. Source clock names can describe raw Camera2 timestamps or runtime target times; logging source pose time is not proof of the hidden sensor exposure time used by a tracking model.

For every logical track `(stream ID, entity ID)` timestamps and sequence numbers strictly increase; different hands may share timestamps. Sequence gaps are allowed and reported. Do not deduplicate merely because a stationary hand has identical coordinates. If the SDK exposes a measurement ID/time, use it to identify repeated estimates; otherwise record query target time and describe the limitation in source metadata. Stop ingestion cleanly on a truncated JSONL tail; recovered packages must set `status: recovered` and inventory only complete files/records.

Videos have one index record per encoded frame, with recording `t_us`, source time, camera ID, zero-based decoded presentation-order `frame_index`, relative MP4 path and presentation timestamp `pts_us`. These index the frames actually written, not merely camera callbacks. Keep PTS and recording time separate. Frames dropped before encoding have no encoded index row; report those losses in quality metadata. Record exposure duration when available. Camera calibration is required for every included camera.

## Static scene and moving entities

`scene.json` defines stable entity IDs, human-readable names, roles, geometry, and motion. A static entity has one full world `pose`. A tracked entity has `pose: null`; timestamped samples supply its position. A missing sample is not a command to place the object at the origin. Use `type: none` for hands/headset whose geometry the viewer supplies.

`pose` records cover tracked objects and the headset. `input_camera_frame` links a vision estimate to the exact camera frame when applicable, using camera ID, video segment path and frame index. Its `t_us` equals that input frame’s recording time; `available_t_us` captures processing latency. Non-camera trackers use null. `confidence` is optional in meaning but represented as null when unavailable; algorithm scores are not automatically calibrated probabilities. `source_id` resolves to a versioned provider/method in the manifest. `estimate_type` identifies runtime estimates, vision estimates, predictions, manual annotations, and synthetic data. Source methods should name filters, smoothing, and retargeting when used.

A `location` contains nullable position/orientation plus OpenXR-compatible bit flags: 1 orientation valid, 2 position valid, 4 orientation tracked, 8 position tracked. Tracked requires the corresponding valid bit. Invalid components are null; valid components must be present. Valid-but-untracked components remain distinguishable from directly tracked ones. A complete valid pose has flags 3, a valid and tracked pose flags 15, complete loss flags 0. For non-OpenXR trackers, explicitly map their quality states without falsely asserting direct tracking.

`hand` records contain exactly 26 entries in OpenXR default joint order, palm through little-finger tip, each expressed in world. The schema fixes `joint_set: openxr-default-26`; an adapter maps other skeletons and preserves the source skeleton in extensions if needed. Each joint has location flags and nullable radius. On inactive hands set `active: false`, every joint location invalid/null, and preserve the fixed 26 entries. Do not synthesize zeros for missing joints. Rendering a reference humanoid body is optional and must not imply measured torso or robot motion.

Events are annotations, not physical evidence: grasp/release can be inferred, manual, runtime-generated, or synthetic. Include affected hand/object IDs and provenance. Object replay follows recorded object poses; a grasp event does not secretly attach an object to a hand. Physics simulation is a separate future feature. A real object tracker must estimate 3D pose; Quest room/scene meshes do not automatically track every movable object.

## LeRobot export contract

Use the official LeRobot writer on the computer, pinning and recording the exporter and LeRobot versions. Do not implement Parquet/video shard layout by hand. Generate a separate standard dataset directory (`meta/`, `data/`, `videos/`) suitable for publishing. Assets, scene files, native tracking streams and custom viewer requirements are excluded by default. Numeric object features may be included in an explicit alternative training profile; LeRobot can store additional typed features even though generic tools may not interpret them.

`human-observations-v1` is the default profile: 30 Hz; image observations for included cameras; separate float32 arrays `observation.hand_left.position` [26,3] and `.rotation` [26,4], likewise right; per-joint `observation.hand_left.location_flags` [26] and right flags; `observation.headset.position` [3], `.rotation` [4] and `.location_flags` [1]. Flatten with named components for tools that require vectors. Document component names/order, frames, missing values, units, source package hashes and schema version in the dataset card/export report. Quaternions remain xyzw. These human features do not automatically work with every off-the-shelf policy or URDF viewer.

Raw capture is observations, not robot commands: the observation-only profile does not invent `action`. A later robot-specific profile must define robot URDF, joint order/limits, hand/arm retargeting version, action semantics, horizon, frame and quality checks. Future-human-pose targets can also be defined in an explicit task profile, but must not be labeled measured robot actions. Human skeleton poses alone do not measure a robot's proprioceptive state.

For each export segment start t0, output times are `t0 + k/fps`, stopping before the segment end. Resample as follows:

- Positions: linear interpolation between valid bracketing samples. Rotations: shortest-path normalized SLERP. Never interpolate across a loss record, recenter discontinuity, or interval longer than 50 ms by default.
- Hand state: require the appropriate validity bits; record conservative flags (bitwise intersection of brackets) and validity masks. Strict training export omits/splits invalid intervals; an explicit masked profile may zero invalid numeric components with flags/masks zero. Do not silently forward-fill lost tracks. Do not smooth measurements in the archival package.
- Images: choose the nearest camera frame within 20 ms by default, log its time error, and split/omit if no match. This is an offline synchronization rule, not a claim of sensor simultaneity. Causal profiles use latest-at-or-before frames and must define maximum age. At 30 Hz export from 60 FPS capture, reuse original frames without blending pixels.
- Strict default export requires both hands' valid position/orientation and valid headset plus all selected camera streams. Recording packages may contain less; report missing modalities or no usable segments clearly. Object tracking loss does not discard training rows when objects are excluded. Empty or observation-only datasets are not magically compatible with action-conditioned training scripts.
- Record resampling settings and source-to-export frame mapping in a separate export report. Keep raw recording timestamps even though the LeRobot writer generates its regular FPS timeline. Do not imply export is merely deleting `scene.json`.

## Device-use limitation

Meta's current Unity hand-tracking overview says hand size/pose data may be used only to enable hand tracking within the app and is forbidden for other purposes. Clarify applicable permission/terms with Meta before treating its system hand poses as publishable robotics training data. This is a concrete source limitation, not a restriction imposed by this format. Keep provider/version/provenance so an independently permitted tracker or other hardware can use the same package. Camera access and any publication also require the applicable permissions and rights; packaging alone does not grant them.

## Sources verified 2026-10-23

- Meta hands modes, default 30 Hz / Fast Motion 60 Hz: https://developers.meta.com/vr/design/hands-technology/
- Frequency hint is advisory: https://developers.meta.com/vr/documentation/native/android/native-openxr-hand-tracking-frequency-hint/
- Camera API resolution/rate capabilities: https://developers.meta.com/vr/documentation/spatial-sdk/spatial-sdk-pca-overview/
- Unity camera timestamps/intrinsics/pose: https://developers.meta.com/vr/documentation/unity/unity-pca-documentation/
- Hand use limitation: https://developers.meta.com/vr/documentation/unity/unity-handtracking-overview/
- Joint ordering: https://registry.khronos.org/OpenXR/specs/1.1/man/html/XrHandJointEXT.html
- Location flags: https://registry.khronos.org/OpenXR/specs/1.1/man/html/XrSpaceLocationFlagBits.html
- OpenXR monotonic time conversion: https://registry.khronos.org/OpenXR/specs/1.1/man/html/xrConvertTimeToTimespecTimeKHR.html
- Camera timestamp sources: https://developer.android.com/reference/android/hardware/camera2/CameraCharacteristics#SENSOR_INFO_TIMESTAMP_SOURCE
- ROS axes: https://github.com/ros-infrastructure/rep/blob/master/rep-0103.rst
- LeRobot format: https://huggingface.co/docs/lerobot/lerobot-dataset-v3
- LeRobot action semantics: https://huggingface.co/docs/lerobot/action_representations
