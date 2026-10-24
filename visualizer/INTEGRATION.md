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
- `POST /api/episodes/:id/batches` with `{seq, frames, events, objects}`; duplicates are acknowledged without appending twice.
- `POST /api/episodes/:id/finish` with duration, outcome, step counts and batch count.
- `PUT /api/episodes/:id/media/:name` for optional media.
- `GET /api/episodes` for discovery. `GET /api/episodes/:id` for detail, which also reports batch integrity as `batches: {received, gaps, lastSeq}`, read from the episode's `batches.json`. The field is left out when that file is missing or unreadable; treat that as unknown, not as 0 received. An episode is complete when `finish.batches === batches.received` and `gaps` is empty.
- `GET /api/episodes/:id/{frames|events|objects}?from=<byte offset>` streams the file from that offset and returns `x-next-from`. That offset is always at the end of a whole line, so a trailing partial line (a crash mid-append) is never sent until it is complete. `?from=9007199254740991` answers nothing but the file's end, which the viewer uses to join a long live episode near its tail. If the file shrank below `from`, the body is empty and `x-next-from` is smaller than `from`.

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
| `/api/clio/...`   | The read-only proxy to the Clio server (below).                                                                                                                                               |

The home page links to `/clio`. The HF/G1 dataset routes (`/[org]/[dataset]/[episode]`) are a separate mode; the Clio viewer does not extend `EpisodeViewer` or `URDFViewer`. A dataset org literally named `clio` is shadowed by the `/clio` routes. Add `?debug=1` (or press Debug) for ids, lag figures, duplicate and rejected counts, and the table-corner and floor labels.

### Proxy

`src/app/api/clio/[...path]/route.ts` forwards to the Clio server; its rules are in `src/lib/clio/proxy-rules.ts` and tested in `src/lib/clio/__tests__/proxy-rules.test.ts`.

- GET and HEAD only; any other method gets 405.
- Paths: `episodes`, `episodes/<id>` and `episodes/<id>/(frames|events|objects)`, mapped to the same `/api/...` paths. The id must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. Everything else is 404, so coach, plans, vision, clips, Gemini and every write are never reachable.
- Only a digits-only `from` is forwarded, to the channel paths; another or repeated `from` gets 400. Other query parameters are dropped.
- The upstream is `CLIO_SERVER_URL` (default `http://127.0.0.1:8787`), read per request. It must be a bare loopback http(s) origin, otherwise 500. A `Host` that is not loopback gets 403, which blocks DNS rebinding.
- Upstream request headers are built from scratch, so the `hf_access_token` cookie, authorization, origin and referer are never forwarded. Redirects are refused, and the fetch aborts with the browser request.
- Responses carry only `content-type`, `x-next-from` and `cache-control: no-store`, and the body is streamed. Upstream status and JSON errors pass through. An unreachable server gives 502, and headers slower than 10 s give 504.

To view a scratch server, start the visualizer with `CLIO_SERVER_URL=http://127.0.0.1:8788`.

### Data flow and time

1. The headset records a batch at 90 frames or 1000 ms and uploads it through 5173 to the server, which appends frames, then events, then objects.
2. `src/lib/clio/source.ts` polls the followed episode every 500 ms through the proxy (the list and detail every 2 s). It reads frames first, then events and objects, and applies them to `ClioCaptureBuilder` in that order. Offsets come only from `x-next-from`. Failures back off from 0.5 s to 5 s; a shrunk file resets and rebuilds; a 404 goes back to the list; a finish triggers one final read.
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

### Where things live

- `src/lib/clio/`: `types.ts`, `proxy-rules.ts`, `source.ts`, `live-clock.ts`, `capture-key.ts`, `object-display.ts` (per-object state at `tUs`), `detection-geometry.ts` (detector outlines in ROS) and `lanes.ts` (the per-object lane model), with tests in `__tests__/` and a deterministic generated episode in `__fixtures__/synthetic-episode.ts`.
- `src/components/clio/`: `clio-replay-viewer.tsx` (the shell for all three pages), `clio-clock.tsx`, `clio-scene.tsx` with `layers/{environment,hands,head,objects,detections}.tsx`, and the panels `object-lanes.tsx`, `object-inspector.tsx`, `event-list.tsx`, `step-banner.tsx` and `clio-playback-bar.tsx`.
- `src/app/clio/`: the pages above.
- `src/components/scene-workspace.tsx` has a `variant: "robot" | "clio"` for `SceneEditor` and `SceneObjects` (no robot placement, table-corner wording). The Clio viewer does not mount the scene editor yet.
- `DESIGN.md`, section "Clio episode viewer", sets the visual rules for these pages.

## Existing lesson completion

`lesson-controller.ts` calls `recorder.start(...)` when a lesson starts, and `recorder.stop(...)` with outcome/totals when it ends. `EpisodeRecorder` flushes pending frames/events/object changes and the uploader sends the finish record after queued batches. This lifecycle already exists. The viewer observes an episode's completion state (`finish.json`) and batch integrity (`batches`) rather than adding another lesson-end serialization format.

An episode can be inspected while recording, but finishing a lesson and exporting a training dataset are distinct operations. A retained file snapshot or durable browser recorder needs additional work; the retrying upload queue alone is not crash recovery.

## Human/object replay adapter

`ClioCaptureBuilder` and `buildCaptureFromClio` in `../apps/headset/src/viewer/capture/from-clio.ts` implement these rules, with lookups in `capture/clio-events.ts` (`stepAt`, `detectionsFor`, `detectionsAt`, `headWAt`, `clioEvents`) and the model in `capture/model.ts` (held spans, `heldSpanAt`). Their tests are in `../apps/headset/test/viewer/capture/`.

- Initialize object state from `meta.objects`, then apply timestamped `objects.ndjson` deltas. Reverse seeking must reconstruct state from the beginning or an indexed snapshot, never keep a later pose. Initial object placements have position/radius/method, not an exact model mesh or known orientation. Hidden objects (such as shirt-fold's `middle_low_zone`) keep their entity and are not drawn.
- Object orientation may be null; do not call identity orientation a measurement. A renderer may choose a neutral display orientation with an explicit unknown state.
- Preserve object `source`, `confidence`, tracking/update time and detector latency. Held-object motion and pinch events can be estimates; do not label them measured physical contact. Confidence is kept only for detector and marker estimates; the headset's other values are fixed placeholders.
- Held spans come from `object.grasped`/`object.released` (origin `runtime`, shown as "Recorded") when `meta.features` includes `object.grasp`. Older episodes infer them from pinches near a movable object and from frame-rate runs of `pinch` estimates (origin `inferred`, shown as "Inferred from pinch").
- An estimate is placed at `observedT` when it has one, otherwise at its line's `t`, so a detector answer appears at its camera frame's time, before the answer arrived. Changes of the position-valid flag add `tracking_lost` and `tracking_recovered` events. Episodes without location flags show no loss gaps, because loss was not recorded.
- For hands, `left`/`right` null means untracked. Draw only recorded joints, infer no palm/body measurement. A decorative humanoid or retargeted robot must be labeled separately.
- Read media only with available timestamps. `media.started` aligns a clip start, but does not provide native per-frame exposure metadata or full camera calibration. The headset records no media today, the server has no GET media route, and current LeRobot export explicitly skips media.
- Convert Clio workspace to ROS with `p_ROS = (-z_W,-x_W,+y_W)` only at the chosen boundary. Its rotation matrix B is `[[0,0,-1],[-1,0,0],[0,1,0]]`; use `R_ROS=B*R_W*inverse(B)`. The renderer separately converts ROS `(x,y,z)` to Three.js `(x,z,-y)`. Do not apply either conversion twice.
- `meta.space.worldFromWorkspace` places the table-corner workspace in WebXR local-floor. Preserve that calibration if adding floor context; the viewer draws the floor from it, labeled "floor from calibration". There is no justified G1 pelvis translation for these human recordings.

### Quaternion convention differs from the pipeline

Positions match, but rotations do not. The viewer converts a rotation with `B·R·Bᵀ` (`rosQuatFromW` in `from-clio.ts`): the object's own axes are re-expressed in ROS too, so an identity rotation in W stays identity. The pipeline's `workspace_to_robot_quaternion` in `../pipeline/src/clio_pipeline/frames.py` computes `q_B ⊗ q_W` (`Q_ROBOT_FROM_WORKSPACE`): only the frame changes, and the joint's local axes stay WebXR's. The two differ by a constant rotation on the right (`q_B⁻¹`), so orientations from the viewer and from a LeRobot export are not interchangeable. Pick one convention explicitly before comparing them or sharing code between them.

## Existing LeRobot exporter

`../pipeline/src/clio_pipeline/lerobot_export.py` creates a normal dataset through `LeRobotDataset.create` and finalizes it. Its current profile is `human_hands`: two wrists (position + quaternion + pinch), float32[16] state; next-frame state as float32[16] action; float32[2] hand tracking mask; step instruction task labels; optional positions for all object IDs; extra Clio provenance. Hands use hold-last-known filling and never-seen fallbacks with a separate mask. These are human imitation targets, not robot proprioception/commands.

The proposed observation-only/full-skeleton and strict-gap profiles in `docs/capture-v1/FORMAT.md` are different export designs. Add named profiles and compatibility tests rather than silently replacing the working Clio default. Video support, robot-specific retargeting and publication are separate planned work. The writer's regular FPS timestamps do not erase the need to preserve original capture times.

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
