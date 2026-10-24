# Clio

**Every lesson trains two students: you, and a robot.**

Clio is an AR tutor for Meta Quest 3, built with WebXR, that can teach you anything. Say what you
want to learn ("refill the windshield washer fluid"). An LLM plans the lesson from your goal and
what the headset camera sees, including a description of what to point out in each step. An
object finder (Gemini, or jev) finds those things in the camera view and Clio outlines them, then
shows each step with translucent ghost hands while a voice coach walks you through it and catches
mistakes. Every
session is recorded as intent-labeled hand, object and language data that robots can learn from,
and it exports straight to LeRobot.

```bash
pnpm install
cp .env.example .env     # add GEMINI_API_KEY
pnpm dev                 # server :8787 + headset app :5173
```

- Desktop, no headset: http://localhost:5173/?emulate=1&debug=1
- Quest 3: `pnpm quest:reverse`, then open http://localhost:5173 in Quest Browser
  ([setup](docs/dev-setup.md), including the camera-permission workaround)

|                                                |                                                   |
| ---------------------------------------------- | ------------------------------------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)   | how it works and why: start here                  |
| [docs/procedures.md](docs/procedures.md)       | the plan language (checks, actions, what to show) |
| [docs/object-finder.md](docs/object-finder.md) | plugging in jev or another object finder          |
| [tracker/README.md](tracker/README.md)         | real-time tracking: YOLOE-26 + ByteTrack + jev    |
| [docs/data-format.md](docs/data-format.md)     | episodes on disk                                  |
| [docs/dev-setup.md](docs/dev-setup.md)         | laptop, emulator, Quest, data, demo day           |

```
packages/protocol   shared contracts (zod → TS types + JSON Schema)
apps/headset        the WebXR app (three.js); domain logic is framework-free and unit-tested
apps/server         Gemini relay, planner, vision, episode ingest (Node + Hono)
pipeline            validate, Rerun replay, LeRobot export (Python + uv)
tracker             real-time object tracking for the finder: YOLOE-26 + ByteTrack + jev (Python + uv)
procedures          curated golden lessons (shirt fold, pH indicator)
```

## Visualizer / desktop dataset inspection

The imported browser visualizer lives in [`visualizer/`](visualizer/README.md). Read
[`visualizer/GOALS.md`](visualizer/GOALS.md) for the product intent and agent handoff, and
[`visualizer/INTEGRATION.md`](visualizer/INTEGRATION.md) for how it should adapt to Clio's existing
lesson recorder, local episode API and Python LeRobot exporter. The draft recording format is
included as design context; `@clio/protocol` remains the source of truth.

```sh
pnpm visualizer:install
pnpm visualizer:dev        # loopback :3001, currently the public G1 LeRobot demo
pnpm visualizer:check      # independent Bun/Next.js checks
```

Private episode inspection is intended to stay local. This import adds no Supabase, cloud ingest
or automatic publishing. A Clio episode reader for this particular viewer is future work; existing
headset/server/viewer work is preserved. The visualizer has its own Bun dependencies and checks,
separate from the pnpm workspace.
