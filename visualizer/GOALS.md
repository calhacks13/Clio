# Visualizer goals and agent handoff

Updated 2026-10-24. Read this before changing this folder or integrating it with the rest of Clio.

## What Peter is building

Clio is a Meta Quest 3 lesson/AR coaching app. A person performs a real task while the app records hands, headset pose, object estimates, camera/media where available, lesson instructions, step outcomes and interactions. The long-term goal is to inspect those recordings locally, understand exactly what was measured versus estimated, and turn selected recordings into useful LeRobot training datasets. Completing a lesson should leave an inspectable episode; explicit export and publication are separate actions.

`visualizer/` is the imported browser visualizer and format-design workspace for that goal. The name covers inspection, validation, adapters and export tooling; it does not mean we need another database, another headset recorder or a competing episode contract.

Peter specifically asked to put the entire existing visualizer and its context into this regular subfolder so another agent can take over. He clarified that “Supabase folder” meant “subfolder.” **Do not add Supabase.** Private recordings should stay local by default. SQLite may later index a local library if useful, while video, model and tracking payloads remain regular local files. A database is not required to start.

## Architecture decisions that take precedence over the imported draft

1. **Clio's existing contract is authoritative:** `../packages/protocol/src/episode.ts`, `hand.ts`, generated schemas, and `../docs/data-format.md`. The earlier Quest Capture v1 proposal is included for context and potential interchange; it is not a command to migrate Clio or replace its zod schemas.
2. **Reuse Clio's recorder and local ingest:** the headset recorder, HTTP episode sink, uploader, server episode routes/store and Python pipeline already exist. Prefer adding a reader/adapter to this viewer rather than building duplicate infrastructure.
3. **Local inspection is the default target.** A user-selected Quest-to-computer USB or LAN transfer is distinct from cloud upload. Do not silently upload recordings, call a model with recording content, publish a dataset or start a cloud service from the visualizer. A completely headset-local recorder is also compatible with this goal, but browser-persistent recording is not implemented by this import.
4. **Keep raw capture immutable and export separately.** Preserve the full lesson/context data. A LeRobot export selects/resamples training features without requiring GLB meshes or room context. Reuse and extend `../pipeline/src/clio_pipeline/lerobot_export.py` rather than maintaining a second independent exporter.
5. **Do not invent measurements.** Tracking loss, unknown orientation, confidence, detector latency, model reference poses, simulated motion and manually reconstructed props must stay distinguishable.
6. **Do not infer a robot from a human.** Human WebXR hands are the source motion. Rendering or training a humanoid needs an explicit retargeting profile. Next-frame human wrist/pinch targets are not measured G1 motor commands.
7. **Keep this import independently runnable.** Clio uses pnpm; this inherited Next.js project uses Bun. It intentionally sits outside the pnpm `apps/*` / `packages/*` workspace globs and has separate formatting/type/test checks. Clio's Biome config excludes this folder. Do not replace either lockfile strategy during a narrow integration. One deliberate exception: the Clio viewer imports `@clio/protocol` and shared viewer modules from the parent through `tsconfig.json` paths, and the protocol needs zod from the parent workspace, so the root `pnpm install` must have run before `/clio` or the visualizer checks work. The HF demo does not need it.

## What exists today

### In Clio, before this import

- `../apps/headset/src/domain/session/lesson-controller.ts`: starts/stops recording for lessons and emits lesson/step events.
- `../apps/headset/src/domain/recording/recorder.ts`, `uploader.ts`, `sink.ts`, and `../apps/headset/src/adapters/net/http-episode-sink.ts`: record and batch frames, events and object updates into the existing episode API, retrying deliveries.
- `../apps/server/src/routes/episodes.ts` and `storage/episode-store.ts`: local episode create, append, finish, media and read routes. The server defaults to computer loopback port 8787 and stores episodes under `../data/episodes/<episodeId>/` (gitignored).
- `../packages/protocol/src/episode.ts`: `clio.episode/1` metadata, frames, events, object tracks, batch and finish schemas.
- `../pipeline/`: validation, resampling, Rerun replay and LeRobot export. The current exporter writes wrist pose plus pinch per hand, a hand mask, next-frame human targets, language labels and optional object-position features; it currently skips video. Its gap-fill/export semantics differ from the stricter independent draft. Preserve those facts and review changes explicitly.
- `../fixtures/episodes/synthetic-shirt-fold`: an existing synthetic Clio episode for adapter work without a Quest.
- `../apps/headset/src/viewer/`: the headset's laptop episode viewer (`../apps/headset/viewer.html`, frozen as a fallback that runs on `pnpm dev` alone) and the framework-free modules the Clio viewer here shares: the Capture model and Clio adapter (`capture/model.ts`, `capture/from-clio.ts`, `capture/clio-events.ts`), the incremental reader (`api.ts`), `event-log.ts` and `detection-outline.ts`.

### Added in Clio for the viewer

- `clio.episode/1` gained optional, backward-compatible object fields: `locationFlags`, `heldBy` and `observedT` on object states, `object.grasped` and `object.released` events, and `meta.features`. New recordings use them; older episodes stay valid. See [INTEGRATION.md](INTEGRATION.md) and `../docs/data-format.md`.
- The server reports batch integrity on episode detail, keeps `?from=` reads on whole lines, and sends CORS headers only to the origins in `CLIO_CORS_ORIGINS` (default: this viewer on port 3001).
- `../fixtures/episodes/synthetic-ph-syringe`: a synthetic pH lesson with a carried syringe, a hand dropout, detector answers with latency and misses, and the new object fields.
- `../apps/headset/scripts/replay-live.ts`: replays an episode directory into a server batch by batch, as if it were being recorded, for testing live follow without a Quest.

### In this folder

- The Clio episode viewer: `/clio` lists local episodes, `/clio/live` follows the newest one while it records, and `/clio/<id>` replays or follows one episode. It reads the local Clio server through a GET-only loopback proxy (`/api/clio/...`) and replays the headset pose, the 25-joint hands, tracked objects (trail, held ring, unknown orientation), detector outlines, per-object lanes (updates by source, held spans, detector answers with latency, misses, position lost), an object inspector, the event list and the current step on one timeline. Scrubbing back never shows later state. No upload is needed. [INTEGRATION.md](INTEGRATION.md) describes the routes, proxy, shared code and limits.
- A complete source snapshot of the custom Apache-2.0 Hugging Face LeRobot Dataset Visualizer fork, including tests, public GLBs, Docker configuration, optional annotation backend and original attribution/license.
- Browser replay for supported LeRobot datasets with video, telemetry plots and URDF robot models.
- Default public demo: Unitree G1 Dex3 block stacking, episode 0. The G1 URDF has 43 movable joints; that dataset records 14 arm and 14 finger joints. Unrecorded joints use the model reference pose. The articulated Dex3 fingers are mapped by joint name.
- Scene editor: import self-contained GLB models or static scene JSON, add boxes, edit transforms, show axes, fit the scene, save per-dataset scenes in browser IndexedDB and export portable JSON.
- A separate `world` and robot-root placement. The public G1 demo's pelvis is raised by 0.7918637524 m so the reference feet meet the floor. This is model-based reference alignment, not measured recording localization and not Clio's workspace origin.
- Demo table, colored cubes and tape marker are procedural GLBs with hand-estimated sizes and locations. They are static. There is **no physics, contact response, tracked-object playback or automatic object reconstruction** in this imported 3D scene editor; tracked objects are replayed only by the Clio viewer, from the recording. Robot geometry can pass through props. The scene editor has a Clio variant (table-corner wording, no robot placement) that the Clio viewer does not mount yet.
- `docs/SCENES.md`: exact current static scene format and coordinate rules. `public/examples/` includes sample scenes and self-contained models.
- `docs/capture-v1/`: earlier complete recording-package proposal, JSON Schema, synthetic fixture, validator and validator tests. It describes timestamped objects/hands/headset, camera synchronization, static scene context and a proposed transfer API. Its recorder, receiver, motion player and exporter were design work, not delivered implementations. Clio's existing equivalents now take precedence.

The source snapshot was imported from `peterjzhao/lerobot-dataset-visualizer` commit `afd282331a6b5215a2b4bdeaa860561a0061de0d`, derived from `huggingface/lerobot-dataset-visualizer`. There is no nested Git checkout or submodule. Imported `.github/` workflows are historical files inside this subdirectory and are not active Clio CI workflows. Do not run the upstream HF deployment workflow as a Clio publishing operation.

## Coordinate, skeleton and timing integration

| Concern             | Clio capture contract                                                                                                                         | Current viewer / earlier proposal                                    | Required approach                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Episode entry       | `meta.json`, `frames.ndjson`, `events.ndjson`, `objects.ndjson`, optional media, `finish.json`                                                | HF LeRobot metadata/data/video, or proposed `recording.json` package | Detect the input kind; use an explicit adapter                                                                 |
| Time                | `t` is milliseconds since start on `performance.now()`                                                                                        | Playback seconds; draft `t_us` integer microseconds                  | Convert units once at the boundary; do not use network arrival time                                            |
| Hand skeleton       | 25 WebXR joints, no palm joint; 8 values per joint                                                                                            | Robot joint angles; draft 26-joint OpenXR skeleton                   | Render the actual 25-joint human skeleton or document any derived palm; never invent a measured joint          |
| Spatial frame       | Y-up workspace `W`, origin at calibrated table corner                                                                                         | ROS X forward, Y left, Z up; renderer itself Y-up                    | Reuse Clio pipeline conversion, then the viewer's renderer adapter once                                        |
| Position conversion | `(x_W,y_W,z_W)`                                                                                                                               | ROS `(-z_W,-x_W,+y_W)`                                               | Same basis conversion as `../pipeline/src/clio_pipeline/frames.py`; rotate orientations with basis composition |
| Origin              | Workspace surface; `worldFromWorkspace` relates it to WebXR local-floor                                                                       | Demo G1 origin on floor between feet                                 | Preserve Clio calibration and label it; never apply G1 pelvis/floor offsets to human captures                  |
| Missing hand        | Whole hand sample is `null`                                                                                                                   | Draft has per-joint validity flags                                   | Preserve missingness; richer validity needs a reviewed Clio schema extension                                   |
| Objects             | Sparse updates with ID, position, nullable orientation, confidence and source; new recordings add location flags, holder and observation time | Static scene placements today; draft per-object timestamped poses    | Reconstruct from initial placements plus updates; retain confidence/source and unknown rotation                |
| Camera/media        | Optional uploads and `media.started` event                                                                                                    | Draft native intrinsics/extrinsics and per-frame index               | Use available metadata honestly; do not fabricate native calibration or sensor timestamps from browser data    |

For detailed adapter decisions and exact source paths, read [INTEGRATION.md](INTEGRATION.md). Note that positions convert the same way in the viewer and the pipeline, but rotations do not: the viewer uses `B·R·Bᵀ`, the pipeline `q_B ⊗ q_W` (INTEGRATION.md, "Quaternion convention differs from the pipeline"). The draft's 60 Hz targets are design goals; they are not guarantees of Quest Browser sensor rate. Clio logs XR frames at the runtime's rate; pose queries can repeat/predict underlying tracking estimates. Keep native recorded times and quality information.

## Desired user workflow

1. Complete a Clio lesson or deliberately record a free/expert session.
2. Keep the recording locally. If it is still on the Quest, explicitly copy/export it or transfer it over USB/LAN to the user's computer.
3. Open that local episode in the inspection viewer; see hands, head, scene, objects, media, step language and event provenance on one timeline.
4. Scrub backward/forward without object state leaking from later times. Inspect missing tracking, unknown orientations and camera timing errors.
5. Optionally associate GLB models or simple primitives with object IDs and store stationary table/floor context separately. Asset shape/scale/pivot and measured trajectory are separate data.
6. Validate the recording; export selected, documented features to LeRobot through the existing pipeline. Keep a provenance report linking export rows to original capture times.
7. Publish only through an explicit user action with the necessary data rights. This import does not add publication or cloud-storage behavior.

## Next implementation priorities

1. Done: the Clio viewer here shares the headset viewer's episode model and adapter through `@clio-viewer/*` instead of keeping a second contract or replay implementation.
2. Done: `/clio` loads local Clio episodes through `@clio/protocol` and the existing read routes; public LeRobot demos stay a separate mode. Still open: a local folder/file picker for episodes that are not on a running server, and a live session on the Quest (plan check C) before `../apps/headset/viewer.html` is retired.
3. Done: hands, head and tracked objects replay against one timestamp, with regression tests for reverse seeks, missing hands, sparse updates, unknown orientation and frame/unit conversion. Still open: the media track (the headset records none yet), reading frame windows around the playhead for episodes over 128 MB, and an SSE feed if the about 2 s live delay is too long.
4. Measured 3D first (done in part): compiled `tracks.json` drives object playback once an episode is compiled, each object shows its estimated metric `extent` and the depth-map shape fused in `shapes.json` (`../docs/data-pipeline.md`, "Measured 3D for objects"), both labelled as estimated or measured. Still open: an optional local scene/asset sidecar keyed by existing object IDs for generated or authored meshes, scaled by the extent and placed by the shape's box. Decide schema ownership in `@clio/protocol` before adding production fields, and keep generated appearance distinct from measurement.
5. Implement local durable recording/recovery if needed: the current in-memory upload queue survives network retries while the tab lives, not necessarily headset tab/process termination. An IndexedDB/file export design needs a deliberate implementation and tests.
6. Reuse Clio's ingest. Add checksums/resumability only where needed; do not stand up the draft's second service on port 8787 (already occupied by Clio).
7. Extend the existing Python exporter for camera video, selected hand features, object masks/quality and documented retargeting/export profiles as required. Review the current hold-last-known and next-frame-target semantics, rather than silently switching profiles.
8. Consider a local SQLite library index only after there is a real indexing/search need. Large payloads remain local files. Cloud services/Supabase are not a requirement.

## Privacy and network inventory

The intended visualizer episode workflow is local-file/local-computer inspection with explicit transfers. That does not mean all inherited code is already an offline viewer:

- The imported app currently defaults to a **public Hugging Face demo** and downloads public metadata, videos and URDF/mesh assets. Its fonts/environment assets can also involve remote resources. That is public asset loading, not a private Clio episode upload. The Clio viewer reads episodes only from the local server through its loopback proxy; a truly offline mode still needs bundled assets.
- HF auth and the optional annotation backend exist in upstream code; the latter can rewrite/push datasets only when separately configured and invoked. This merge does not configure it, copy tokens or start it. Do not route private Clio recordings there implicitly.
- Existing Clio coaching/planning/vision can send audio/images/text to Gemini or a configured vision service. That predates this import. Do not claim that turning the visualizer local makes those separate lesson features offline. Explain and honor the user's chosen local/cloud mode at each boundary.
- Do not put real recordings, tokens, operator identifiers or camera footage in Git, synthetic fixtures or `public/`. `../data/` is the local gitignored storage location.
- The earlier research found a Meta system-hand-data reuse limitation in Unity documentation. Check the applicable Quest Browser/SDK terms and data rights before publishing system-derived tracking as training data. Keep source provenance; do not treat the format as granting permission or as requiring one vendor's tracker.

## Definition of done for the next integration

A synthetic Clio episode loads from local storage, hands and objects replay correctly at matching times, reverse seeks are deterministic, missing data stays visible as missing, lesson labels/events remain inspectable, and no cloud upload is needed. Existing Clio tests and imported viewer checks pass. Exported LeRobot datasets load through the official reader with documented feature/action semantics. Hardware validation remains separate from synthetic correctness.

Status: the viewer half is in place and was checked against both synthetic fixtures, a recorded emulator episode and simulated live sessions (plan checks A, B and S in `../docs/plans/visualizer.md`). The live Quest session (check C) and the LeRobot export half are still open.

For the original handoff, the scope was source import, runnable project isolation and durable context. A root `../AGENTS.md` points future agents here automatically. Clio's recorder/contract work stays intact. The Clio runtime adapter has since been added as described above; a database and a publication workflow are intentionally not implemented.
