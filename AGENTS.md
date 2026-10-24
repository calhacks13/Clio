# Clio agent context

Clio's headset app records lesson episodes; the local server stores them; the Python pipeline
validates, replays and exports them. Start with `README.md`, `docs/ARCHITECTURE.md` and
`docs/data-format.md`. Shared production contracts live in `packages/protocol/src/`; generated
JSON Schemas are not edited by hand.

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
