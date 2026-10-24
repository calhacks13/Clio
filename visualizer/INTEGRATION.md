# Clio integration notes

Read [GOALS.md](GOALS.md) first. This document describes interfaces to reuse, not an adapter already implemented by the import.

## Contracts and ownership

Clio's zod definitions in `../packages/protocol/src/` are the source of truth for production capture. JSON Schemas in `../packages/protocol/schema/` are generated with `pnpm gen:schema`. The root `../docs/data-format.md` and Python pipeline describe current meaning and export behavior. `docs/capture-v1/` is an earlier independent proposal and must not override these sources.

Production timestamps are milliseconds, positions are meters in the Y-up calibrated workspace, quaternions are xyzw, and hand arrays are 25 joints × 8 fields. Use `meta.hands.joints` and `jointFields` rather than guessing component order. Do not parse a 200-number hand as robot motor positions or as the draft's 26-joint skeleton.

## Existing local API

The Clio server defaults to `127.0.0.1:8787`. The headset Vite server uses port 5173 and proxies API requests. Existing routes include:

- `POST /api/episodes` to create an episode.
- `POST /api/episodes/:id/batches` with `{seq, frames, events, objects}`; duplicates are acknowledged without appending twice.
- `POST /api/episodes/:id/finish` with duration, outcome, step counts and batch count.
- `PUT /api/episodes/:id/media/:name` for optional media.
- `GET /api/episodes`, `GET /api/episodes/:id` for discovery and detail.
- In-progress `GET /api/episodes/:id/{frames|events|objects}?from=<byte offset>` with `x-next-from` supports incremental local reads. Inspect current route/store tests before depending on this new work.

The current Next.js visualizer does not proxy or consume these routes. A future adapter must deliberately add a loopback-only reader/proxy or use a file picker. Avoid creating a general arbitrary-URL/server-filesystem proxy. Merely copying an episode directory or configuring `DATASET_URL` does not make it a valid LeRobot dataset for the existing HF parser.

For USB, Clio already uses `adb reverse tcp:5173 tcp:5173`; the headset opens localhost:5173 and talks to the server through Vite's proxy. Do not add a competing capture receiver on 8787. A direct API tunnel (`adb reverse tcp:8787 tcp:8787`) would be an explicit alternative, not a second receiver. These are user-controlled Quest-to-computer links, not Supabase/cloud uploads.

## Existing lesson completion

`lesson-controller.ts` calls `recorder.start(...)` when a lesson starts, and `recorder.stop(...)` with outcome/totals when it ends. `EpisodeRecorder` flushes pending frames/events/object changes and the uploader sends the finish record after queued batches. This lifecycle already exists. A viewer should observe an episode's completion state and batch integrity rather than add another lesson-end serialization format.

An episode can be inspected while recording, but finishing a lesson and exporting a training dataset are distinct operations. A retained file snapshot or durable browser recorder needs additional work; the retrying upload queue alone is not crash recovery.

## Human/object replay adapter

- Initialize object state from `meta.objects`, then apply timestamped `objects.ndjson` deltas. Reverse seeking must reconstruct state from the beginning or an indexed snapshot, never keep a later pose. Initial object placements have position/radius/method, not an exact model mesh or known orientation.
- Object orientation may be null; do not call identity orientation a measurement. A renderer may choose a neutral display orientation with an explicit unknown state.
- Preserve object `source`, `confidence`, tracking/update time and detector latency. Held-object motion and pinch events can be estimates; do not label them measured physical contact.
- For hands, `left`/`right` null means untracked. Draw only recorded joints, infer no palm/body measurement. A decorative humanoid or retargeted robot must be labeled separately.
- Read media only with available timestamps. `media.started` aligns a clip start, but does not provide native per-frame exposure metadata or full camera calibration. Current LeRobot export explicitly skips media.
- Convert Clio workspace to ROS with `p_ROS = (-z_W,-x_W,+y_W)` only at the chosen boundary. Its rotation matrix B is `[[0,0,-1],[-1,0,0],[0,1,0]]`; use `R_ROS=B*R_W*inverse(B)`. The renderer separately converts ROS `(x,y,z)` to Three.js `(x,z,-y)`. Do not apply either conversion twice.
- `meta.space.worldFromWorkspace` places the table-corner workspace in WebXR local-floor. Preserve that calibration if adding floor context. There is no justified G1 pelvis translation for these human recordings.

Before writing another implementation, inspect the existing in-progress `../apps/headset/src/viewer/episode-data.ts`, `event-log.ts`, and `detection-outline.ts` and any newer viewer tests. Coordinate changes through shared contracts; this directory is an imported reference and richer dataset viewer, not permission to overwrite concurrent work.

## Existing LeRobot exporter

`../pipeline/src/clio_pipeline/lerobot_export.py` creates a normal dataset through `LeRobotDataset.create` and finalizes it. Its current profile is `human_hands`: two wrists (position + quaternion + pinch), float32[16] state; next-frame state as float32[16] action; float32[2] hand tracking mask; step instruction task labels; optional positions for all object IDs; extra Clio provenance. Hands use hold-last-known filling and never-seen fallbacks with a separate mask. These are human imitation targets, not robot proprioception/commands.

The proposed observation-only/full-skeleton and strict-gap profiles in `docs/capture-v1/FORMAT.md` are different export designs. Add named profiles and compatibility tests rather than silently replacing the working Clio default. Video support, robot-specific retargeting and publication are separate planned work. The writer's regular FPS timestamps do not erase the need to preserve original capture times.

## Running and checks

From the Clio root:

```sh
pnpm visualizer:install
pnpm visualizer:dev        # http://127.0.0.1:3001; existing public HF demo
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

Clio's existing `pnpm check` remains separate. The imported Bun tests are excluded from root Vitest projects, and the inherited Prettier/ESLint code is excluded from root Biome. No pnpm dependency/workspace migration or database migration is part of this handoff. Port 3001 avoids the original standalone demo on 3000 and Clio's existing ports.

Preserve `LICENSE` and upstream attribution. Imported deployment workflows under `visualizer/.github/` do not run as root GitHub Actions. The optional Python annotation backend is retained source; don't start or configure it just to view local Clio data.
