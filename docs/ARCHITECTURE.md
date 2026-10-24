# Clio architecture

> Every lesson trains two students: you, and a robot.

Clio is a WebXR app for Meta Quest 3. A voice coach walks a person through a hands-on task with AR
targets and "ghost hand" demonstrations, and every session is recorded as an intent-labeled,
robot-ready dataset.

This is the map of the system. Read it before you write code, and update it when you change a
boundary. The exact data formats are in [data-format.md](data-format.md), the task-script language
is in [procedures.md](procedures.md), and setup is in [dev-setup.md](dev-setup.md).

---

## 1. Goals

| #   | Goal                        | What it means in practice                                                                                                                                 |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Coach a real task           | A learner finishes the shirt fold or the pH protocol with voice coaching, AR targets, ghost-hand demos and mistake correction.                            |
| G2  | Every session is data       | Hand joints, head pose, object positions, step intents, coach tool calls, transcripts and mistakes, all on **one clock** and in **one coordinate frame**. |
| G3  | Robot-ready output          | Episodes export to LeRobot and replay in Rerun.                                                                                                           |
| G4  | Four people, one headset    | Everyone can build from hour one. The desktop emulator, the scripted coach and synthetic episodes mean no one waits on the Quest.                         |
| G5  | The demo survives the venue | No Gemini? Use the scripted coach. Bad Wi-Fi? Tether over USB and relay through the laptop. Server hiccup? Batches buffer and retry.                      |

**Not this weekend:** camera-based object detection (designed for in §8, not built), accounts or cloud
deployment, other headsets or glasses.

## 2. System at a glance

```
┌────────────────────── Quest 3 · Quest Browser · WebXR "immersive-ar" ───────────────────────┐
│ apps/headset                                                                                 │
│                                                                                              │
│  Sensing ─► World ─► SessionController ─► ProcedureRunner ◄─tools─ CoachSession ◄─► Gemini   │
│  (hands,    (work-    (calibrate → place   (step checks,            (voice, tools,    Live   │
│   head)      space,     → lesson → done)    mistake rules)           narration)       ▲      │
│              objects)          │                                         │            │      │
│        ═══════════════════ typed event bus · one clock ══════════════════════         │      │
│                 │                                   │                                 │      │
│           OverlayModel ─► three.js presenters    EpisodeRecorder ─► EpisodeSink       │      │
└─────────────────────────────────────────────────────────────────────────┼─────────────┼──────┘
                                       HTTP /api/episodes (batched)        │   WS relay  │
┌────────────────────────────────── Laptop ───────────────────────────────▼─────────────┴──────┐
│ apps/server (Node · Hono)  /api/coach/*  /api/procedures  /api/episodes  /api/clips          │
│                            data/episodes/<id>/ meta.json · frames.ndjson · events.ndjson     │
│ pipeline/ (Python · uv)    validate · Rerun replay · LeRobot export                          │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
 packages/protocol (TypeScript · zod): the contracts all of the above share, exported as JSON
 Schema so Python validates against the same definitions.
```

## 3. Principles

1. **Code owns task state; the LLM owns the conversation.** `ProcedureRunner` is the only source
   of truth for which step the learner is on. The coach requests changes through tool calls. The
   runner validates and applies them, and records who decided.
2. **The LLM never tracks hands.** It sees about one camera frame per second. Hands come from
   WebXR hand tracking at headset frame rate (72–120 Hz). The coach gets short text narrations of
   what happened, such as "right hand pinched 2 cm from the shoulder point".
3. **Hands are the measuring instrument.** The browser gives us no calibrated camera, so we use
   the hands to calibrate the world. Pinch two corners to define the workspace. Pinch an object to
   register it, or let the procedure's layout place it. Camera detection plugs in later behind
   the same port (§8).
4. **Everything that matters is an event on one clock.** Anything the dataset needs goes through
   the typed event bus with a timestamp from the same `performance.now()` timeline that XR frames
   use. The recorder subscribes to the bus, so nothing gets logged on the side.
5. **One episode, one frame.** All spatial data in an episode is expressed in that episode's
   workspace frame, and recalibrating starts a new episode. This is why ghost-hand clips replay
   correctly on a different table, and why robot teams can map our frame to theirs once.
6. **Ports and adapters.** `domain/` is plain TypeScript with no three.js, WebXR, DOM or SDK
   imports. Adapters implement its ports. That keeps logic testable in Node, and it lets us swap
   Gemini for a scripted coach, the headset for an emulator, or the server for an in-memory sink.
   `test/architecture.test.ts` enforces this rule.
7. **Degrade, don't die.** Every external dependency has a fallback (§10).

## 4. Repository layout

```
Clio/
├── packages/protocol/        @clio/protocol: zod schemas + types (single source of truth)
│   ├── src/                  geometry, hand, checks, procedure, episode, clip, coach-tools, api
│   └── schema/               generated JSON Schema (committed; consumed by pipeline/)
├── apps/headset/             @clio/headset: the WebXR app (Vite + three.js + TypeScript)
│   ├── src/core/             clock, typed emitter, math, logging (no dependencies)
│   ├── src/domain/           pure logic: hands, world, procedure, coach, recording, demo, overlay, session
│   ├── src/adapters/         xr, render, gemini, scripted, audio, camera, net
│   ├── src/app/              composition root, config, boot screen, frame loop
│   ├── scripts/              synth-episode.ts (synthetic episodes from the real domain code)
│   └── test/                 domain unit tests + architecture fitness test
├── apps/server/              @clio/server: Node + Hono (Gemini relay/tokens, procedures, episodes, clips)
├── pipeline/                 Python (uv): load/validate episodes, Rerun replay, LeRobot export
├── procedures/               task scripts (JSON), e.g. shirt-fold.json, ph-indicator.json
├── fixtures/episodes/        small synthetic episodes for tests and for building the pipeline early
└── docs/                     this file, data-format.md, procedures.md, dev-setup.md
```

Workspace packages are consumed **from source** (`"exports": "./src/index.ts"`). There is no build
step between packages: Vite bundles the headset, `tsx` runs the server, and `tsc` only typechecks.

## 5. Headset app (`apps/headset`)

### 5.1 Layers and the dependency rule

```
app/        composition root · config · boot UI · frame loop   ← may import anything
  │
adapters/   xr · render · gemini · scripted · audio · camera · net   ← implement domain ports
  │
domain/     hands · world · procedure · coach · recording · demo · overlay · session
  │
core/       clock · emitter · math · log            @clio/protocol (schemas, types)
```

Imports only point downward. `domain/` and `core/` must not import `three`, `@google/genai`,
`iwer`, browser globals, or anything from `adapters/` or `app/`. The ports that `domain/` needs are
defined next to the code that uses them, for example `domain/coach/agent.ts` (`RealtimeAgent`) and
`domain/recording/sink.ts` (`EpisodeSink`).

### 5.2 The frame loop (`app/frame-loop.ts`)

These steps run once per XR frame, in order:
1. **Sample.** `adapters/xr/frame-sampler` reads the viewer pose and both hands' 25 joints (pose and
   radius) in the `local-floor` space, giving a `SensorFrame` in world coordinates.
2. **Localize.** `domain/world/Workspace` converts it into the workspace frame, giving a
   `WorkspaceFrame`.
3. **Perceive.** `domain/hands` computes the pinch distance and pinch point per hand, and
   `PinchDetector` emits `hand.pinch` start/end events (with hysteresis).
4. **Decide.** `domain/session/SessionController` advances the current phase. During the lesson,
   `ProcedureRunner` evaluates the step's success check and its mistake rules.
5. **Record.** `domain/recording/EpisodeRecorder` appends a quantized `FrameRecord`.
6. **Present.** `domain/overlay/OverlayModel` produces a snapshot, and the presenters in
   `adapters/render` draw it.

Coach I/O (mic audio worklet, Gemini WebSocket) is asynchronous. It reaches the same bus, stamped
with the same clock.

### 5.3 Session phases (`domain/session`)

```
 setup ──► calibrate ──► place objects ──► lesson ──► done
            pinch 2       layout: auto      runner + coach + recorder
            corners       register: pinch   (record_demo mode: expert, no mistake prompts)
            (or reuse a   each object
             persisted
             anchor)
```

`mode` is `learn` (a learner with coaching and mistakes) or `record_demo` (an expert performs the
task, and the episode is later sliced into ghost-hand clips). The phases are the same; only the
policies differ.

### 5.4 Procedure engine (`domain/procedure`)

A procedure is data (`procedures/*.json`, schema in `@clio/protocol`): objects with optional layout
positions, plus ordered steps. Each step has an `instruction`, `targets`, a `success` check, optional
`mistakes` (each a check plus a kind and message), an optional demo clip, and notes for the coach.

Checks are a small declarative language: `pinch_near`, `hand_near` (with dwell), `lift`, `confirm`,
`elapsed`, `all`, `any` and `sequence`. Each type has a stateful evaluator registered in
`domain/procedure/checks/`. The runner:
- evaluates the current step's `success` every frame. On success it emits `step.completed { by: "check" }` and enters the next step;
- evaluates `mistakes` every frame with a per-rule cooldown, and emits `mistake.detected` (a machine label) for the coach to react to;
- accepts `requestAdvance({ by: "coach" | "user", reason })` and `goTo(stepId)`. If the coach advances
  a step whose check hasn't passed, the step is still completed, but it's labeled `forced: true`
  so the dataset can filter it.

### 5.5 Coach (`domain/coach` + `adapters/gemini` + `adapters/scripted`)

`CoachSession` connects four things:

| In                                                                 | Out                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------- |
| mic PCM (16 kHz) from `MicSource`                                  | `agent.pushAudio`                                             |
| camera JPEG at ≤1 fps from `FrameSource` (optional)                | `agent.pushImage`                                             |
| bus events → `Narrator` → short `[app]` narrations                 | `agent.pushContext`                                           |
| agent tool calls → `CoachToolbox` (zod-validated) → runner/overlay | `agent.respondToTools`                                        |
| agent audio / text / transcripts                                   | `VoiceOutput`, and `transcript` + `coach.*` events on the bus |

**Tools** are defined once in `@clio/protocol/coach-tools` (name, description, zod args). The Gemini
adapter turns them into function declarations. There are four, and each one is both a visible action
and a timestamped label:
- `highlight(object_id, style?)`: emphasizes an object.
- `show_demo(step_id?)`: plays the ghost-hand clip.
- `advance_step(reason)`: asks the runner to move on.
- `flag_mistake(kind, message)`: shows a correction and labels it.

Tool handlers never throw at the model. Bad arguments come back as `{ ok: false, error }` so the
model can correct itself.

**Agents** implement the `RealtimeAgent` port:
- `GeminiLiveAgent` uses the `@google/genai` Live API in the browser. It has two transports:
  - **relay (default):** the SDK connects to the laptop server, which proxies the WebSocket to
    Google and injects the real API key. The headset never holds a key and needs no internet of
    its own; a USB cable to the laptop is enough.
  - **direct:** the server mints a short-lived ephemeral token (`POST /api/coach/token`), and the
    headset connects to Google itself.

  Sessions turn on context-window compression and session resumption, and handle `goAway` by
  reconnecting transparently.
- `ScriptedAgent` is a deterministic coach with no network. It speaks step instructions and
  corrections through `speechSynthesis`, and calls the same tools. It's the demo fallback and the
  coach that tests use.

### 5.6 Recording (`domain/recording`)

`EpisodeRecorder` has two channels that share one timebase (`t`, in ms since the episode started):
- **frames:** one quantized `FrameRecord` per XR frame (head pose, plus each hand's 25 × 8 joint
  values and pinch distance), in the workspace frame;
- **events:** every recordable bus event (`step.*`, `coach.tool_call/result`, `transcript`,
  `mistake.detected`, `hand.pinch`, `object.registered`, ...).

Batches carry a monotonic `seq`, so the server can drop duplicates and retries are safe.
`RetryingSink` buffers and backs off while the server is unreachable. `HttpEpisodeSink` posts to
`/api/episodes/:id/batches`, and `MemoryEpisodeSink` serves tests and synthetic generation.

### 5.7 Presentation (`domain/overlay` + `adapters/render`)

`OverlayModel` is a presentation model reduced from bus events: the current instruction, highlights
(automatic for step targets, plus any the coach requests), the active ghost clip, toasts, coach
status and recording status. Presenters are dumb: each frame they read a snapshot and update the
three.js objects.

| Presenter                   | Draws                                                              |
| --------------------------- | ------------------------------------------------------------------ |
| `WorkspacePresenter`        | the workspace outline and axes (calibration feedback)              |
| `ObjectMarkersPresenter`    | object dots, with target and warning highlight rings               |
| `GhostHandsPresenter`       | translucent hands driven by `domain/demo/ClipPlayer`               |
| `InstructionPanelPresenter` | the step text panel (troika SDF text), placed beside the workspace |
| `HudPresenter`              | coach, recorder and tracking status (debug)                        |

## 6. Server (`apps/server`)

The server is a small Node app, built with Hono and typed end to end with `@clio/protocol/api`.

| Route                                                                                     | Purpose                                                                                    |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET  /api/health`                                                                        | liveness, plus whether a Gemini key is configured                                          |
| `WS   /gemini/*`                                                                          | transparent Gemini Live relay that injects `GEMINI_API_KEY` server-side                    |
| `POST /api/coach/token`                                                                   | mints an ephemeral Gemini Live token (direct transport)                                    |
| `GET  /api/procedures`, `GET /api/procedures/:id`                                         | serves validated `procedures/*.json`                                                       |
| `POST /api/procedures/draft`                                                              | "learn anything": an LLM drafts a procedure for a named task, validated by the same schema |
| `POST /api/episodes` → `POST /api/episodes/:id/batches` → `POST /api/episodes/:id/finish` | episode ingest (idempotent by `seq`)                                                       |
| `PUT  /api/episodes/:id/media/:name`                                                      | optional media (video, audio)                                                              |
| `GET  /api/episodes`, `GET /api/episodes/:id`, `GET /api/episodes/:id/{frames,events}`    | browse and replay                                                                          |
| `POST /api/clips/from-episode`, `GET /api/clips/:procedureId/:stepId`                     | slice a good episode into per-step ghost-hand clips (the flywheel)                         |

Storage is plain files under `CLIO_DATA_DIR` (default `./data`, gitignored). The layout is described
in [data-format.md](data-format.md). Vite proxies `/api` and `/gemini` to the server, so the headset
only ever talks to one origin.

## 7. Data pipeline (`pipeline/`)

The pipeline is Python, managed with `uv`. It reads the episode directories the server writes:
- `clio validate <episode>` checks the files against `packages/protocol/schema/*.json`.
- `clio view <episode>` replays it in Rerun: hand skeletons, head frustum, objects, step timeline,
  transcript, and the gripper-proxy scalar.
- `clio export-lerobot <episodes...>` builds a LeRobot dataset. Each frame's `task` is the active
  step instruction (language-conditioned), the state and action are wrist poses plus aperture per
  hand, and frames are resampled to a fixed fps. Coordinates are converted from WebXR's y-up frame
  to the robotics z-up convention at export time.

## 8. Extension points

| Want to...                   | Do this                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find objects with the camera | Implement `ObjectLocator` (`domain/world/object-registry.ts`) in an adapter (on-device model, Gemini 2D boxes, or a laptop detector). Return workspace-frame positions with `method: "detector"`. |
| Use another realtime model   | Implement `RealtimeAgent` (`domain/coach/agent.ts`).                                                                                                                                              |
| Add a check type             | Add it to the `Check` union in `@clio/protocol/checks.ts` and register an evaluator in `domain/procedure/checks/`.                                                                                |
| Add a coach tool             | Add it to `@clio/protocol/coach-tools.ts` and add a handler to `CoachToolbox`.                                                                                                                    |
| Add a recorded signal        | Add the event to `@clio/protocol/episode.ts`, emit it on the bus, and run `pnpm gen:schema`.                                                                                                      |

## 9. Coordinate frames, units, time

- **Units:** meters, milliseconds. Quaternions are `[x, y, z, w]`. Poses are `[px, py, pz, qx, qy, qz, qw]`.
- **World:** WebXR `local-floor` (right-handed, y up, −z forward at session start).
- **Workspace (`W`):** set by calibration. The origin is the first pinched corner (on the table
  surface), +x points along the table edge toward the second corner, +y is up (gravity), and
  +z points toward the user. The table area is z < 0. Every episode stores `worldFromWorkspace`,
  and every spatial value in the episode is in `W`.
- **Time:** `t` is milliseconds since the episode started, on the `performance.now()` timeline (the
  same one XR frames use). `meta.clock.startEpochMs` anchors it to wall time.
- **Export:** robotics tools expect z-up, so the pipeline converts at export time and never at
  capture time.

## 10. Failure modes and fallbacks

| Failure                                   | Fallback                                                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Gemini unreachable, slow, or out of quota | `?coach=scripted`: deterministic coach, same tools, local TTS                                                                             |
| Venue Wi-Fi dies                          | Tether the laptop to a phone hotspot; connect the headset to the laptop over USB (`adb reverse`); coach traffic relays through the laptop |
| Server down mid-session                   | `RetryingSink` buffers batches in memory and retries with backoff                                                                         |
| Anchors unsupported or lost               | The workspace pose is kept in `local-floor` space; re-pinch to recalibrate (new episode)                                                  |
| No camera access                          | The coach runs on narration plus voice; no video gets recorded                                                                            |
| No headset available                      | Desktop Chrome + IWER emulator (`?emulate=1`); synthetic episodes for pipeline work                                                       |
| Hand tracking flickers (crossed hands)    | Checks use hysteresis and dwell; demo steps get looser radii                                                                              |

## 11. Who owns what (four-way split)

| Track                        | Owns                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Headset** (XR + rendering) | `adapters/xr`, `adapters/render`, `app/`, calibration UX in `domain/world`                                                           |
| **Coach** (agent)            | `domain/coach`, `adapters/gemini`, `adapters/scripted`, `adapters/audio`, server `/gemini` relay + `/api/coach` + procedure drafting |
| **Data** (logging + export)  | `domain/recording`, `@clio/protocol/episode`, server `/api/episodes` + `/api/clips`, `pipeline/`                                     |
| **Integration + pitch**      | `procedures/*.json`, check tuning, `domain/session`, demo script, `docs/`                                                            |

Contracts live in `@clio/protocol`. Change them in a small PR that everyone sees, then run
`pnpm gen:schema`.

## 12. Key decisions

1. **WebXR in Quest Browser, not Unity.** Deploying is just opening a URL, hot reload works over
   USB, nobody needs a multi-gigabyte install, and everyone can develop in desktop Chrome with an
   emulator. The cost is that there are no calibrated camera frames, which principle 3 works
   around.
2. **Plain three.js + TypeScript + Vite** rather than React Three Fiber, A-Frame, or a framework
   layered on top. Data capture needs an explicit, inspectable frame loop and precise timestamps,
   and three.js has the largest WebXR ecosystem.
3. **The headset is the realtime edge, with the Gemini relay as the default transport.** Task state,
   hand data and tool execution stay on the device, where latency matters. The relay keeps the key
   on the laptop and lets a USB cable stand in for venue Wi-Fi.
4. **The scripted coach is a first-class adapter**, not a mock. It's the demo insurance and the test
   double.
5. **Contracts are written in zod and exported to JSON Schema.** One definition gives TypeScript
   types, runtime validation, Gemini tool and structured-output schemas, and validation for Python.
6. **Episodes are append-only NDJSON with batch sequence numbers.** The format is human-readable,
   streamable and safe to retry. LeRobot and Rerun are export targets, not the capture format.
7. **Node server, Python only offline.** The online path is one language and shares types. Python
   is used only where its ecosystem is the point (LeRobot, Rerun).
8. **pnpm workspaces with source-consumed internal packages, Biome, Vitest.** It's quick to set up
   and enforces boundaries.
