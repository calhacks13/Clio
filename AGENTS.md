# Clio agent context

Clio's headset app records lesson episodes; the local server stores them; the Python pipeline
validates, compiles, replays and exports them. Start with `README.md`, `docs/ARCHITECTURE.md`,
`docs/data-format.md` and `docs/data-pipeline.md` (what is recorded live, what `clio compile`
derives after an episode finishes into `data/derived/<id>/`, and where the object tracker and
robot retargeting plug in). Shared production contracts live in `packages/protocol/src/`; generated
JSON Schemas are not edited by hand.

## Lessons

The coach (Gemini Live for the voice, Gemini Robotics-ER 2 for planning, step checks and closer
looks) owns the step list through tools; `docs/coach-plan.md` is the design and
`docs/robotics-er.md` the measurements. A planned lesson starts on a short stage-1 "card" and is
refined in the background (`docs/handoff-stage1-speed.md` records the timing work and what is
left; `pnpm bench` and `docs/planner-bench.md` measure planner changes). Each step's `show` items
and the coach's `highlight` tell the tracker what to follow and glow; perception feeds only the
learner's view and the recorded data, never a Gemini coach. The voice can also show a fixed set of
widgets (timer, progress, checklist, choices, value, caution) beside the step card;
`docs/widgets.md` is the reference and `apps/headset/src/adapters/render/widgets/theme.ts` holds
their tokens.

## Visualizer handoff

The imported LeRobot/3D browser visualizer is in `visualizer/`. Before working on capture,
visualization, scene objects or dataset export, read `visualizer/GOALS.md` and
`visualizer/INTEGRATION.md`. They record the intended local workflow, existing implementation,
coordinate/skeleton/time differences and remaining work. `visualizer/docs/capture-v1/` is an
earlier independent proposal; it does not supersede `@clio/protocol` or the existing pipeline.

The user clarified that this is a regular subfolder, not Supabase. Keep private recording
inspection/storage local by default; make transfers and any publication explicit. SQLite is an
optional future local index, not a prerequisite. Reuse the existing recorder/API/exporter rather
than introducing a second production contract or a competing receiver on port 8787.

Clio uses pnpm (`pnpm check`). The independent imported visualizer uses Bun and its own
Prettier/ESLint/test checks (`pnpm visualizer:install`, `pnpm visualizer:dev`,
`pnpm visualizer:check`). It is outside the pnpm workspace globs and excluded from root Biome.
Read its own `AGENTS.md` when editing that folder. Preserve unrelated ongoing changes, including
the headset tracking/viewer and episode-server work.

## Tracker

`tracker/` is the object finder and live tracker on port 8790 (Python + uv, its own
`pyproject.toml`; outside the pnpm workspace and Biome, like `pipeline/`): `POST /locate` for
Clio's server, and `WS /track` (`tracker/TRACK.md`) in two modes: one target for
`apps/headset/primary.html`, and objects mode, where a lesson names its declared objects in words
(the focused step's show items first, lit; the rest recorded) and the tracker follows all of
them. It replaced
`services/jev-finder` (EdgeTAM and SAM 2.1) with YOLOE-26 and ByteTrack and kept its jev client
and `/track` protocol. Read `tracker/README.md` before changing how objects are found or
followed. It reaches into YOLOE-26's head, so Ultralytics is pinned to a narrow range and
`tracker/tests/test_vision.py` checks the split graph against Ultralytics' own forward pass.
