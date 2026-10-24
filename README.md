# Clio

**Every lesson trains two students: you, and a robot.**

Clio is an AR tutor for Meta Quest 3, built with WebXR, that can teach you anything. Say what you
want to learn ("refill the windshield washer fluid"). An LLM plans the lesson from your goal and
what the headset camera sees. Clio finds the objects, highlights them, and shows each step with
translucent ghost hands while a voice coach walks you through it and catches mistakes. Every
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

|                                              |                                               |
| -------------------------------------------- | --------------------------------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | how it works and why: start here              |
| [docs/procedures.md](docs/procedures.md)     | the plan language (checks, action primitives) |
| [docs/data-format.md](docs/data-format.md)   | episodes on disk                              |
| [docs/dev-setup.md](docs/dev-setup.md)       | laptop, emulator, Quest, data, demo day       |

```
packages/protocol   shared contracts (zod → TS types + JSON Schema)
apps/headset        the WebXR app (three.js); domain logic is framework-free and unit-tested
apps/server         Gemini relay, planner, vision, episode ingest (Node + Hono)
pipeline            validate, Rerun replay, LeRobot export (Python + uv)
procedures          curated golden lessons (shirt fold, pH indicator)
```
