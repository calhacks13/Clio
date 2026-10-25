# Clio integration notes

Read [GOALS.md](GOALS.md) first. This document describes the Clio interfaces this folder reuses and how the Clio episode viewer (`/clio`) is wired to them. The implementation plan and its end-to-end checks are in `../docs/plans/visualizer.md`.

## Contracts and ownership

Clio's zod definitions in `../packages/protocol/src/` are the source of truth for production capture. JSON Schemas in `../packages/protocol/schema/` are generated with `pnpm gen:schema`. The root `../docs/data-format.md` and Python pipeline describe current meaning and export behavior. `docs/capture-v1/` is an earlier independent proposal and must not override these sources.

Production timestamps are milliseconds, positions are meters in the Y-up calibrated workspace, quaternions are xyzw, and hand arrays are 25 joints × 8 fields. Use `meta.hands.joints` and `jointFields` rather than guessing component order. Do not parse a 200-number hand as robot motor positions or as the draft's 26-joint skeleton.

### Optional object fields in `clio.episode/1`

`clio.episode/1` has an optional, backward-compatible extension for object state. The schema id is unchanged, and older episodes stay valid. `../docs/data-format.md` has the full rules.

- `meta.features` lists what a recording uses: `"object.flags"` (object states carry `locationFlags` and `heldBy`, plus `observedT` when it differs from `t`) and `"object.grasp"` (grasps and releases are recorded as events). Unknown strings are accepted.
- `ObjectState.locationFlags` uses the OpenXR/Capture v1 bits (`LOCATION_FLAG`): 1 orientation valid, 2 position valid, 4 orientation tracked, 8 position tracked. A tracked bit needs its valid bit, and `orientation` is non-null exactly when bit 1 is set. Without position valid, `position` still holds the last valid estimate. Absent means a legacy record whose flags are derived from `source`.
- `ObjectState.heldBy` is the hand carrying the object, or null.
- `ObjectState.observedT` is when the estimate was measured (the camera frame or tracked hand frame), in episode milliseconds. It can be negative and is left out within 1 ms of `t`.
- `object.grasped {objectId, hand, grip: pinch|fist, position}` and `object.released {objectId, hand, reason: opened|hand_lost|plan_changed, position}` events.

A Clio server still running the old protocol drops the new fields and answers 400 to the new events, and the uploader then loses about 1 s of data per rejected batch. Restart the server whenever the protocol or headset changes.

## Existing local API

The Clio server defaults to `127.0.0.1:8787`. The headset Vite server uses port 5173 and proxies API requests. Existing routes include:

- `POST /api/episodes` to create an episode.
- `POST /api/episodes/:id/batches` with `{seq, frames, events, objects, observations}`; duplicates are acknowledged without appending twice.
- `POST /api/episodes/:id/finish` with duration, outcome, step counts and batch count.
- `PUT /api/episodes/:id/media/:name` for optional media.
- `GET /api/episodes` for discovery. `GET /api/episodes/:id` for detail, which also reports batch integrity as `batches: {received, gaps, lastSeq}`, read from the episode's `batches.json`. The field is left out when that file is missing or unreadable; treat that as unknown, not as 0 received. An episode is complete when `finish.batches === batches.received` and `gaps` is empty.
- `GET /api/episodes/:id/derived/<name>` serves a compiled file from `../data/derived/<id>/` (`manifest.json`, `tracks.json`, `environment.json`, `shapes.json`, `retarget-<profile>.json`, and `room.glb`, the Quest room scan, as `model/gltf-binary`; names match `DERIVED_FILE_NAME` in `@clio/protocol`). The server compiles each episode in the background when it finishes (`clio compile`, see `../docs/data-pipeline.md`), and the detail response reports `derived: {state, manifest, error}` with state `none`, `queued`, `running`, `ok`, `stale` or `failed`. `POST /api/episodes/:id/compile` compiles again by hand; the viewer never calls it.
- `GET /api/episodes/:id/scene/<name>` serves the rebuilt scene from `../data/scenes/<id>/` (`scene.json`, `model-<objectId>.glb`, `cad-<objectId>.json`, `crop-<objectId>-<n>.jpg`; names match `SCENE_FILE_NAME`), JSON, `model/gltf-binary` or `image/jpeg`, never cached. The server builds it after each successful compile (`clio scene`, `../docs/room-scene.md`), and the detail reports `scene: {state, scene, error}` with the compile's states; `ok` means the SceneDoc was built from the current compile. `POST /api/episodes/:id/scene` rebuilds it by hand; the viewer never calls it.
- `GET /api/episodes/:id/{frames|events|objects|observations}?from=<byte offset>` streams the file from that offset and returns `x-next-from`. That offset is always at the end of a whole line, so a trailing partial line (a crash mid-append) is never sent until it is complete. `?from=9007199254740991` answers nothing but the file's end, which the viewer uses to join a long live episode near its tail. If the file shrank below `from`, the body is empty and `x-next-from` is smaller than `from`.

The server only sends CORS headers to the browser origins in `CLIO_CORS_ORIGINS`, a comma-separated list of exact origins. The default is `http://127.0.0.1:3001,http://localhost:3001` (this viewer), and `x-next-from` is exposed to them. Requests from any other website get no CORS headers, and those a browser marks cross-site or same-site get 403, so a page open on the laptop cannot read recordings or mint coach tokens. Requests without an `Origin` (curl, the pipeline, the replay script) and the headset's same-origin requests through Vite are unchanged. The setting is parsed in `../apps/server/src/config.ts`, but `../apps/server/src/index.ts` does not pass `config.corsOrigins` to `createApp` yet, so the default list applies until it does. The viewer itself does not need CORS: it reads through the proxy below.

Do not add a general arbitrary-URL or server-filesystem proxy. Merely copying an episode directory or configuring `DATASET_URL` does not make it a valid LeRobot dataset for the existing HF parser.

For USB, Clio already uses `adb reverse tcp:5173 tcp:5173` (`pnpm quest:reverse`); the headset opens localhost:5173 and talks to the server through Vite's proxy. Do not add a competing capture receiver on 8787. A direct API tunnel (`adb reverse tcp:8787 tcp:8787`) would be an explicit alternative, not a second receiver. These are user-controlled Quest-to-computer links, not Supabase/cloud uploads. The viewer adds no receiver and no `adb reverse` of its own.

## Clio episode viewer

### Routes

| URL               | Behavior                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/clio`           | Episode list, newest first, with a status per row (live if it grew in the last 15 s, otherwise stopped or finished) and missing batches when there are any. "Follow live" opens `/clio/live`. |
| `/clio/live`      | Follows the newest episode and switches to a newer one when it appears, keeping the URL. Pin replaces the URL with `/clio/<id>`.                                                              |
| `/clio/<id>`      | Pinned to one episode. It is followed while it grows and never switches. Server ids look like `ep-YYYYMMDD-HHMMSS-xxxx`, so `live` cannot collide.                                            |
| `/clio/dev/scene` | Dev only (a 404 in production builds): the 3D scene on the generated fixture, without a server.                                                                                               |
| `/clio/dev/lanes` | Dev only: the object lanes and panels on the generated fixture.                                                                                                                               |
| `/api/clio/...`   | The loopback proxy for episode reads and explicit dataset exports (below).                                                                                                                    |

The home page links to `/clio`. The HF/G1 dataset routes (`/[org]/[dataset]/[episode]`) are a separate mode; the Clio viewer does not extend `EpisodeViewer` or `URDFViewer`. A dataset org literally named `clio` is shadowed by the `/clio` routes. Add `?debug=1` (or press Debug) for ids, lag figures, duplicate and rejected counts, and the table-corner and floor labels.

### Proxy

`src/app/api/clio/[...path]/route.ts` forwards to the Clio server; its rules are in `src/lib/clio/proxy-rules.ts` and tested in `src/lib/clio/__tests__/proxy-rules.test.ts`.

- GET and HEAD for reads; POST is permitted only for the dataset export described below. All episode writes get 405.
- Paths: `episodes`, `episodes/<id>`, `episodes/<id>/(frames|events|objects|observations)`, `episodes/<id>/derived/<name>` (name matching `DERIVED_FILE_NAME`) and `episodes/<id>/scene/<name>` (name matching `SCENE_FILE_NAME`), mapped to the same `/api/...` paths. The id must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. Everything else is 404, so coach, plans, vision, clips, Gemini and every write are never reachable.
- Only a digits-only `from` is forwarded, to the channel paths; another or repeated `from` gets 400. Other query parameters are dropped.
- The upstream is `CLIO_SERVER_URL` (default `http://127.0.0.1:8787`), read per request. It must be a bare loopback http(s) origin, otherwise 500. A `Host` that is not loopback gets 403, which blocks DNS rebinding.
- Upstream request headers are built from scratch (only `accept`: JSON and NDJSON first, anything else after), so the `hf_access_token` cookie, authorization, origin and referer are never forwarded. Redirects are refused, and the fetch aborts with the browser request.
- Responses carry only `content-type`, `x-next-from`, `content-disposition` and `cache-control: no-store`, and the body is streamed unchanged, binary GLBs, JPEGs and dataset ZIPs included (`proxy-route.test.ts`). Upstream status and JSON errors pass through. An unreachable server gives 502, and headers slower than 10 s give 504.

To view a scratch server, start the visualizer with `CLIO_SERVER_URL=http://127.0.0.1:8788`.

### Dataset downloads

`/clio` adds a checkbox beside each recording and Select finished / Clear selection controls. Only finished recordings with frames and no known missing batches can be selected. The inline Download dataset form takes a safe local name and a frame rate (30 fps by default). It starts a background export, polls its state, and offers a ZIP attachment. The last export id is saved in sessionStorage so leaving the list and coming back in the same tab restores progress or its download; transport errors offer Retry status and Start again.

The proxy has one write exception: `POST /api/clio/datasets/exports`. It requires JSON, checks the browser origin against the loopback Host, bounds the body to 16 KiB and validates it with `DatasetExportRequestSchema`. It forwards no browser credentials. `GET`/`HEAD` can read `datasets/exports/<id>` and `datasets/exports/<id>/download`; the latter streams the ZIP and preserves Content-Disposition. All other writes remain forbidden.

The Clio server validates the complete selection (1–100 distinct finished episodes, with frames and no known missing batches) before creating a job. `ProcessDatasetExporter` runs the existing `clio export-lerobot` command serially, with an isolated uv environment, Python 3.12 and the lerobot extra, independent of automatic compiling. `--archive` packages a finalized v3.0 dataset with paths rooted at `meta/` and `data/`; its profile remains `human_hands`, with no video or implied robot commands. The exporter validates source schemas and preserves its regular Clio provenance sidecar. The server streams the archive from `data/exports/<export-id>/dataset.zip`; ready/failed jobs expire after one hour, old directories are swept, and a restart forgets job status. Exports have a 30-minute timeout; at most four pending and twenty retained jobs are accepted. Missing uv produces an actionable 503. The first export may download Python dependencies, but no recording content leaves the computer.

### Data flow and time

1. The headset records a batch at 90 frames or 1000 ms and uploads it through 5173 to the server, which appends frames, then events, then objects.
2. `src/lib/clio/source.ts` polls the followed episode every 500 ms through the proxy (the list and detail every 2 s). It reads frames first, then events, objects and (when `meta.features` lists `object.observations`) observations, and applies them to `ClioCaptureBuilder` in that order. Observations keep no image geometry in the viewer and change no pose; the inspector's Camera row shows the newest one (Seen, Predicted, Lost, Not in view), a predicted box in the inferred look. Offsets come only from `x-next-from`. Failures back off from 0.5 s to 5 s; a shrunk file resets and rebuilds; a 404 goes back to the list; a finish triggers one final read.
3. `ClioCaptureBuilder` (`../apps/headset/src/viewer/capture/from-clio.ts`) drops duplicates (counted in `duplicates`), converts milliseconds to microseconds and W to ROS once, and bumps the revision.
4. `src/lib/clio/live-clock.ts` chooses one `tUs`. The edge is the newest received frame time, advanced by laptop time since that read; while following, the playhead sits 1.5 s behind the edge, never passes it, and snaps forward when the backlog exceeds 3 s. In replay it clamps to the end of the capture. `src/components/clio/clio-clock.tsx` advances it every animation frame; the panels get it as props and the 3D scene through `useSceneClock` (`clio-scene.tsx`), so the scene does not re-render on every frame.
5. The 3D layers, lanes, inspector, event list and step banner all query that same `tUs`. They are mounted once per capture (`src/lib/clio/capture-key.ts`): a newer episode on `/clio/live`, or a rebuild of the same one, unmounts them whole, so the old capture is released and its three.js objects are disposed. Drawing a new capture into the mounted canvas kept the old one reachable, about 100 MB for a 10-minute episode.

Every sample time is the recording's own `t`. Laptop arrival time (`performance.now()`) only paces the live clock and the Debug lag figures; it never reaches a sample. Expect the screen to run about 2 s behind the headset (estimated 2.3 s; 1.8 s on average in a simulated replay).

Limits:

- Joining a live episode whose frames file is longer than 2 MB starts 2 MB before its end and skips the first partial line; earlier time shows as "Not loaded". Events and objects are still read from byte 0.
- While live, hand samples are kept for the last 5 minutes behind the newest frame; earlier time shows as "Hands not kept". Head samples are all kept.
- A finished or stopped episode replays from the start, up to 128 MB of frames (about 10 minutes at 90 Hz); the rest shows as "Not loaded".

### Shared code and the three.js guard

The viewer imports framework-free modules from the headset viewer instead of copying them:

- `visualizer/tsconfig.json` `paths`: `"@clio/protocol"` to `../packages/protocol/src/index.ts`, and `"@clio-viewer/*"` to `../apps/headset/src/viewer/*`. Bun tests resolve the same paths.
- Allowed `@clio-viewer` modules: `capture/model`, `capture/from-clio`, `capture/clio-events`, `capture/from-package`, `api`, `event-log` and `detection-outline` (its pure dependencies come along). Never import `capture` (the index re-exports three.js code), `capture/object-tracks-view`, `scene`, `panel`, `main` or `episode-data`, nor any `apps/headset/` path directly.
- `eslint.config.mjs` (`no-restricted-imports`) catches direct imports from visualizer files. `src/lib/clio/__tests__/import-graph.test.ts` walks every allowed module's runtime imports transitively and fails if any reaches `three`, a forbidden file or a package other than `zod`. To allow another module, change the test's `ALLOWED` list and the lint rule together.
- `next.config.ts` sets `experimental.externalDir: true` and aliases `three` (and `three/addons`, `three/webgpu`, `three/tsl`) to `visualizer/node_modules/three`, so the bundle has exactly one three.js (0.182) even if shared code imported it. The headset has its own, newer copy.
- Webpack only. Never run `next dev --turbopack`: Turbopack cannot compile the files outside `visualizer/`.
- `@clio/protocol` needs zod from `../packages/protocol/node_modules`, so the root `pnpm install` must have run before `/clio` or the visualizer checks work. The HF demo itself does not need it.

The headset's `../apps/headset/viewer.html` (`src/viewer/{main,scene,panel}.ts`) still runs on `pnpm dev` alone and is frozen as a fallback; the pure modules stay shared either way.

### Compiled episodes

`src/lib/clio/derived.ts` (`ClioDerivedSource`, through `use-clio-derived.ts`) runs beside the raw source and never touches it. It reads the detail's `derived` field on its own slow cadence and, whenever it carries a manifest (the compile on disk, also while a recompile is queued or running, since a compile is swapped in whole), fetches the manifest's environment and retarget artifacts once per `compiledAt` and parses them with the `@clio/protocol` schemas. A 404 or a document that fails its schema means "not compiled" for that file, never "episode gone".

- Compiled documents are in W like the raw episode; `src/lib/clio/derived-display.ts` places them and converts with `rosFromW` exactly once.
- The environment layer draws compiled planes (floor, walls, a detected table) as context geometry, and the compiled table and floor when they exist; otherwise the calibrated floor and workspace box as before. Plane labels show only in Debug.
- `layers/robot.tsx` draws each retargeted arm as a dashed joint chain in the inferred look, at the grid frame at or before the clock time, hidden where its joints are null, labelled "Retargeted" with the profile's robot name. The Robot toggle in the header shows or hides it. It is never drawn as measured.
- Once the episode is no longer live, the playback bar shows a compile state that needs attention (Compiling, Not compiled, Compile stale, Compile failed, including a failed stage or a failed recompile) and "Not usable" with the quality verdict's first reason as a tooltip. A healthy compile adds no text.
- `tracks.json` and `shapes.json` are read too (`src/lib/clio/compiled-objects.ts`). Once an episode is compiled, the objects layer takes each object's position, rotation, held state and tracked color from the compiled grid (the frame at or before the clock time; hidden where the compile has no position), draws the estimated `extent` as a wireframe box around the position and the measured shape as the fused depth points with their yaw box riding on the position. The inspector shows "Size (estimated)" and "Shape (measured)" when they exist. Live and uncompiled episodes still draw from the raw estimates. Either way an object no hand could reach is drawn still (below).

### Objects out of reach

A tracker's 3D estimate of an object nobody is touching still moves: the detector's depth jitters by centimeters, and a camera far from the object can put it a meter or more off for a frame or two. The viewer draws such an object still. This is display only: the recording, the compile, the lanes and the inspector's measured rows are unchanged. `src/lib/clio/object-rest.ts` works it out (`objectRest`, once per capture, revision and compiled documents, shared by the scene and the inspector) from the series the objects layer draws: the compiled one when `tracks.json` has the object, the raw estimates otherwise.

- **Reach**, checked every 1/30 s from the object's first position. A held span (recorded or inferred) is reach. A tracked hand reaches the object when any joint is within 10 cm of its volume: the sphere of its radius, plus its estimated extent and its measured shape box when the compile has them, riding on the position. 10 cm is the headset's 4 cm grasp reach plus slack for joint jitter (about 1 cm) and the detector's depth error (several cm). A hand that is not tracked might be touching the object out of view, so it reaches anything within 1.1 m of the head (the headset pose is at the eyes; 1.1 m is about eye to fingertip of a tall adult reaching out), unless it was last tracked farther from the object than 10 cm plus 3 m/s (a fast reach) times the time since. Without a current head pose (a frame gap, frames not loaded) only that second bound applies, and a hand never tracked is in reach. A head or hand sample more than 100 ms old (the compile's `maxFrameGapMs`) is not current. Where the compile has no position, the object counts as where it was last seen.
- **Hysteresis.** A gap in reach shorter than 0.5 s still counts as reach (a hand moving round what it handles); then a reach shorter than 0.2 s counts as none (a joint or a stray estimate brushing the margin). What is left out of reach is a rest stretch.
- **Pose.** Of the raw estimates in force during the stretch (the one at its start and every later one before its end), the one nearest their per-axis median, with its rotation. It is always a recorded estimate, and a minority of strays cannot move it. A compiled track uses the raw estimates the compile resampled, each counted once, so the raw and compiled views hold the object at the same place.
- **Edges.** Entering a stretch from a reach, the drawn position eases from the tracked one to the rest pose over 0.25 s, and back over the last 0.25 s before a reach, so an object that was still does not jump. A tracked position more than 20 cm from the rest pose is a stray: the rest pose is drawn at once rather than slid to. While in reach the tracked motion is drawn exactly.
- **Drawn.** The objects layer moves the object's group, so the dot, rings, label, extent box, shape points and generated model stay put together (`modelOriginAt` takes the plan too). The trail is the drawn path, so a resting object leaves none. Whether the object is drawn and its color are unchanged: a compiled object is still hidden where the compile has no position, and a lost one is still muted. The inspector adds "Shown: Still, out of reach" after Position, in the inferred look, with the stretch in its tooltip; Position keeps the newest estimate.
- **Cost.** About 5 ms per object per 10 minutes of capture, worked out again when records arrive while live (the open stretch's pose can then shift a little); a frame only looks it up.

Limits: an untracked hand keeps everything within arm's reach of the head in reach, so a recording where one hand is rarely tracked still shows the jitter of whatever the learner stands near. Jumps while in reach are drawn as recorded.

### Room scan and generated models

The room and a model of each object, `../docs/room-scene.md`. The same detail read gives the scene build's state and, while it is `ok` or `stale`, its SceneDoc (`DerivedState.sceneState`, `scene`, `sceneError`; a rebuild queued or running shows the SceneDoc on disk, or the one shown before while there is none; a status that does not parse, or a SceneDoc of another episode, is no scene). The binary files are read by the layers that draw them, only while their header toggle is on (`src/lib/clio/scene-files.ts`, `roomFile` and `modelFiles`), once per version (the compile's `compiledAt` for `room.glb`, the scene's `builtAt` for a model), with `ClioDerivedSource`'s failure semantics: a 404 or a body that does not parse means absent until the version changes, other failures retry from 2 s to 30 s, and an absent file never sends the viewer back to the list. `LazyFile` parses with three's `GLTFLoader` (Meshopt decoded, Draco not) and disposes geometries, materials and textures when its layer is hidden, the file is replaced or the capture unmounts.

- **Room** (`layers/room.tsx`): `environment.json`'s `room` names `room.glb`, one root node per mesh named by its id, its translation and rotation the mesh pose in W, `extras: {kind, label, global}`. The file sits in one group turned by `W_TO_ROS_QUAT` (B, the rotation `rosFromW` applies) inside the ROS group, so every node keeps its own transform; `scene-display.test.ts` and `room-scan.test.ts` check a node's vertices land where `rosFromW` puts them. Every surface is solid (`layers/solid.ts`): opaque, flat shaded, with a procedural grain laid on in world space. The global mesh is wound toward its middle and drawn front faces only, so the walls nearest a camera outside the room drop away while the far walls and the floor stay; furniture volumes are solid blocks, labelled in Debug ("scanned couch"). The room draws on its own layer (`BACKDROP_LAYER`), first, with the grid and the environment's context on the same layer, tested against the room's depth (written 3 cm behind each surface, so the grid on a scanned table still shows and a wall hides the grid beyond it); `BackdropPass` in `clio-scene.tsx` then draws everything measured over it with a cleared depth buffer, so the room never hides the hands, the objects or the robots. Without a room scan, the detected raised planes (`isRaisedSurface` in `lib/clio/solid-surfaces.ts`) are drawn as solid tops on the same backdrop. Camera framing is unchanged; the grid fades out nearer while the room shows.
- **Models** (`layers/model.tsx`): a SceneModel with a `model` file rides inside its object's group, at the compiled position plus `placement.offset`, turned by `placement.rotation`, both converted from W once (`modelPlacement`); the GLB (meters, +y up, origin at the bottom center) sits in the same W-to-ROS turn. It needs the compiled series, so live and uncompiled episodes draw none, and it hides where the compiled position is null. The dot, rings, trail, label, extent box and shape points stay. It takes the generated look (DESIGN.md), and its surfaces take clicks to select the object.
- **Header**: Room and Models toggles beside Robot, each shown only when there is something to draw (a `room` in the environment, a SceneDoc with at least one model), on by default and not persisted, like Robot.
- **Inspector**: an object with a SceneModel adds a "Model (generated)" block: backend and generator, "Sized by" and "Turned by" at the level of the measurement used (a view-facing turn is inferred), the note, and the first keyframe crop through the proxy (hidden if it does not load).
- **Transport**: once the episode is no longer live, Building scene, Scene stale or Scene failed (a failed run or stage, in the problem color, with the detail as tooltip) follow the compile state. A healthy or never-built scene adds no text: a server can run with `CLIO_SCENE=off`.

### Where things live

- `src/lib/clio/`: `types.ts`, `proxy-rules.ts`, `source.ts`, `live-clock.ts`, `capture-key.ts`, `object-display.ts` (per-object state at `tUs`), `detection-geometry.ts` (detector outlines in ROS), `lanes.ts` (the per-object lane model), `derived.ts` (compiled files and the scene's state), `derived-display.ts` (planes and arms in ROS), `compiled-objects.ts`, `object-rest.ts` (where an object out of reach is held still), `scene-files.ts` (which binary files to read, and `LazyFile`) and `scene-display.ts` (model placement and inspector rows), with tests in `__tests__/` and deterministic generated data in `__fixtures__/synthetic-episode.ts`, `__fixtures__/synthetic-derived.ts` and `__fixtures__/synthetic-scene.ts` (hand-written GLBs: a room scan and three models).
- `src/components/clio/`: `clio-replay-viewer.tsx` (the shell for all three pages), `clio-clock.tsx`, `use-clio-derived.ts`, `use-scene-file.ts`, `clio-scene.tsx` with `layers/{environment,room,hands,head,objects,model,detections,robot}.tsx` and `layers/gltf.ts`, and the panels `object-lanes.tsx`, `object-inspector.tsx`, `event-list.tsx`, `step-banner.tsx` and `clio-playback-bar.tsx`.
- `src/app/clio/`: the pages above.
- `src/components/scene-workspace.tsx` has a `variant: "robot" | "clio"` for `SceneEditor` and `SceneObjects` (no robot placement, table-corner wording). The Clio viewer does not mount the scene editor yet.
- `DESIGN.md`, section "Clio episode viewer", sets the visual rules for these pages.

## Existing lesson completion

`lesson-controller.ts` calls `recorder.start(...)` when a lesson starts, and `recorder.stop(...)` with outcome/totals when it ends. `EpisodeRecorder` flushes pending frames/events/object changes and the uploader sends the finish record after queued batches. This lifecycle already exists. The viewer observes an episode's completion state (`finish.json`) and batch integrity (`batches`) rather than adding another lesson-end serialization format. Finishing also triggers the server's background compile into `../data/derived/<id>/`, which the viewer reads as described above.

An episode can be inspected while recording, but finishing a lesson and exporting a training dataset are distinct operations. A retained file snapshot or durable browser recorder needs additional work; the retrying upload queue alone is not crash recovery.

## Human/object replay adapter

`ClioCaptureBuilder` and `buildCaptureFromClio` in `../apps/headset/src/viewer/capture/from-clio.ts` implement these rules, with lookups in `capture/clio-events.ts` (`stepAt`, `detectionsFor`, `detectionsAt`, `headWAt`, `clioEvents`) and the model in `capture/model.ts` (held spans, `heldSpanAt`). Their tests are in `../apps/headset/test/viewer/capture/`.

- Initialize object state from `meta.objects`, then apply timestamped `objects.ndjson` deltas. Reverse seeking must reconstruct state from the beginning or an indexed snapshot, never keep a later pose. Initial object placements have position/radius/method, not an exact model mesh or known orientation. Hidden objects (such as shirt-fold's `middle_low_zone`) keep their entity and are not drawn.
- Object orientation may be null; do not call identity orientation a measurement. A renderer may choose a neutral display orientation with an explicit unknown state.
- Preserve object `source`, `confidence`, tracking/update time and detector latency. Held-object motion and pinch events can be estimates; do not label them measured physical contact. Confidence is kept only for detector and marker estimates; the headset's other values are fixed placeholders.
- Held spans come from `object.grasped`/`object.released` (origin `runtime`, shown as "Recorded") when `meta.features` includes `object.grasp`. Older episodes infer them from pinches near a movable object and from frame-rate runs of `pinch` estimates (origin `inferred`, shown as "Inferred from pinch").
- A detector or marker estimate whose position is valid but not tracked (location flags 2 or 3: a tracker coasting, a reused depth) is typed `predicted`, never `vision_estimate`.
- An estimate is placed at `observedT` when it has one, otherwise at its line's `t`, so a detector answer appears at its camera frame's time, before the answer arrived. Changes of the position-valid flag add `tracking_lost` and `tracking_recovered` events. Episodes without location flags show no loss gaps, because loss was not recorded.
- For hands, `left`/`right` null means untracked. Draw only recorded joints, infer no palm/body measurement. A decorative humanoid or retargeted robot must be labeled separately.
- Read media only with available timestamps. `media.started` aligns a clip start, but does not provide native per-frame exposure metadata or full camera calibration. The headset records no media today, the server has no GET media route, and current LeRobot export explicitly skips media.
- Convert Clio workspace to ROS with `p_ROS = (-z_W,-x_W,+y_W)` only at the chosen boundary. Its rotation matrix B is `[[0,0,-1],[-1,0,0],[0,1,0]]`; use `R_ROS=B*R_W*inverse(B)`. The renderer separately converts ROS `(x,y,z)` to Three.js `(x,z,-y)`. Do not apply either conversion twice.
- `meta.space.worldFromWorkspace` places the table-corner workspace in WebXR local-floor. Preserve that calibration if adding floor context; the viewer draws the floor from it, labeled "floor from calibration". There is no justified G1 pelvis translation for these human recordings.

### Quaternion convention differs from the pipeline

Positions match, but rotations do not. The viewer converts a rotation with `B·R·Bᵀ` (`rosQuatFromW` in `from-clio.ts`): the object's own axes are re-expressed in ROS too, so an identity rotation in W stays identity. The pipeline's `workspace_to_robot_quaternion` in `../pipeline/src/clio_pipeline/frames.py` computes `q_B ⊗ q_W` (`Q_ROBOT_FROM_WORKSPACE`): only the frame changes, and the joint's local axes stay WebXR's. The two differ by a constant rotation on the right (`q_B⁻¹`), so orientations from the viewer and from a LeRobot export are not interchangeable. Pick one convention explicitly before comparing them or sharing code between them.

## Existing LeRobot exporter

`../pipeline/src/clio_pipeline/lerobot_export.py` creates a normal dataset through `LeRobotDataset.create` and finalizes it. Its current profile is `human_hands`: two wrists (position + quaternion + pinch), float32[16] state; next-frame state as float32[16] action; float32[2] hand tracking mask; step instruction task labels; optional positions for all object IDs; extra Clio provenance. Hands use hold-last-known filling and never-seen fallbacks with a separate mask. These are human imitation targets, not robot proprioception/commands.

`clio export-lerobot --robot-profile <profile.json>` adds a second, explicit profile: the state and action are the joint values the IK retargeting solves for that robot profile (the same solver `clio compile` runs) (URDF joint names, plus one gripper value per arm), with `observation.retarget.valid` and `.residual_pos` per arm (unreachable frames hold the last reachable joints with valid 0, and the residual is the error of the joints actually exported). It is derived from the human hands, not robot proprioception, and the dataset's provenance sidecar names the profile and URDF hash.

The proposed observation-only/full-skeleton and strict-gap profiles in `docs/capture-v1/FORMAT.md` are different export designs. Add named profiles and compatibility tests rather than silently replacing the working Clio default. Video support and publication are separate planned work. The writer's regular FPS timestamps do not erase the need to preserve original capture times.

## Running and checks

From the Clio root:

```sh
pnpm install               # once: @clio/protocol needs zod from the parent workspace
pnpm visualizer:install
pnpm visualizer:dev        # http://127.0.0.1:3001; /clio reads the server on 8787
pnpm visualizer:check
```

Or in this folder:

```sh
bun install --frozen-lockfile
bun install --cwd docs/capture-v1 --frozen-lockfile
bun dev --hostname 127.0.0.1 --port 3001
bun run format
bun run type-check
bun run lint
bun test
bun run build
```

The dev server and the build run on Node. Node 25 defines a `localStorage` global without its methods, which breaks server rendering of every page ("localStorage.getItem is not a function"); use Node 24 (`../.nvmrc`) or set `NODE_OPTIONS=--no-experimental-webstorage`.

`bun run type-check` runs `tsc` twice: once for the app, and once with `tsconfig.test.json` for the tests. The base `tsconfig.json` excludes `**/__tests__/**`, so `tsconfig.test.json` sets its own `exclude` to type-check every test file, and it keeps the base `lib`.

A second dev server or build (for example while the user's dev server runs on 3001) must write to another directory, or it overwrites that server's `.next`:

```sh
NEXT_DIST_DIR=.next-e2e bun run dev --hostname 127.0.0.1 --port 3002
```

`tsconfig.json` already includes `.next-e2e/types/**/*.ts`. Next appends any other directory name to `tsconfig.json`'s `include`, so revert that if it happens. `/.next-*/` is gitignored, and Prettier skips it.

To try the viewer without a Quest, run a scratch server and replay a fixture into it as if it were live. Never point the replay at a server using the real `../data` directory: replays are marked `emulated` with a `clio-replay` user agent, but they are still stored as episodes.

```sh
CLIO_SERVER_PORT=8788 CLIO_DATA_DIR=/path/to/scratch pnpm --filter @clio/server start
pnpm --filter @clio/headset exec tsx scripts/replay-live.ts --from ../../fixtures/episodes/synthetic-ph-syringe --base http://127.0.0.1:8788
```

`replay-live.ts` also takes `--speed`, `--batch-ms`, `--repeat-minutes N`, `--stall-after-s S` and `--no-finish`. `pnpm synth -- --scenario ph-syringe --hz 90 --out <dir>` generates a longer or faster source. To list a fixture without replaying it, copy it into `<data dir>/episodes/` under its `meta.episodeId` (for example `ep-synthetic-ph-syringe`).

Clio's existing `pnpm check` remains separate. The imported Bun tests are excluded from root Vitest projects, and the inherited Prettier/ESLint code is excluded from root Biome. No pnpm dependency/workspace migration or database migration is part of this handoff. Port 3001 avoids the original standalone demo on 3000 and Clio's existing ports.

Preserve `LICENSE` and upstream attribution. Imported deployment workflows under `visualizer/.github/` do not run as root GitHub Actions. The optional Python annotation backend is retained source; don't start or configure it just to view local Clio data.
