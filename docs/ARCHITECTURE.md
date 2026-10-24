# Clio architecture

> Every lesson trains two students: you, and a robot.

Clio is a WebXR app for Meta Quest 3 that can teach **anything**. You say what you want to learn.
An LLM plans the lesson from your goal and what the headset camera sees. Clio then works out how
to _show_ each step: it finds the objects, highlights them, and synthesizes a ghost-hand
demonstration. A voice coach talks you through it. Every session is recorded as an intent-labeled,
robot-ready dataset.

This is the map of the system. Read it before you write code, and update it when you change a
boundary. The exact data formats are in [data-format.md](data-format.md), the plan language is in
[procedures.md](procedures.md), and setup is in [dev-setup.md](dev-setup.md).

---

## 1. Goals

| #   | Goal                        | What it means in practice                                                                                                                                             |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Teach anything              | The planner (an LLM) writes the lesson at runtime from a spoken goal plus camera snapshots; Clio grounds the plan in the real scene and demonstrates each step.       |
| G2  | Show, don't just tell       | Each step's action primitive (`twist`, `pour`, `pick_up`, …) becomes highlights, arrows and a synthesized ghost-hand demo anchored to the real objects.               |
| G3  | Every session is data       | Hand joints, head pose, object tracks, step intents (language), action labels, coach tool calls, transcripts and mistakes, all on **one clock** and in **one frame**. |
| G4  | Robot-ready output          | Episodes export to LeRobot v3 and replay in Rerun.                                                                                                                    |
| G5  | Four people, one headset    | The desktop emulator (IWER), the scripted coach and synthetic episodes mean nobody waits for the Quest.                                                               |
| G6  | The demo survives the venue | No Gemini? Use the scripted coach. Bad Wi-Fi? USB to the laptop, which relays. No camera? Register objects by pinching.                                               |

## 2. System at a glance

```
 "teach me to add wiper fluid"
            │ voice
┌───────────▼──────────────── Quest 3 · Quest Browser · WebXR immersive-ar ─────────────────────┐
│ apps/headset                                                                                  │
│                                                                                               │
│  CoachSession ◄═══════► Gemini Live (voice, tools)            ┌───────── LessonController ───┐│
│   │ start_lesson ──────────────────────────────────────────►  │ plan ─► locate ─► run ─► record│
│   │ highlight / show_demo / advance_step / flag_mistake ───►  │   ▲        │        │         ││
│   │◄── [app] narrations (step briefings, mistakes, …) ◄────── │   │        ▼        ▼         ││
│                                                               │ Planner  Grounder  ProcedureRunner
│  Sensing ─► Workspace ─► Pinch/Grasp ─► ObjectRegistry ◄──────┴───────────────────────────────┘│
│  (hands 90 Hz, head)       (held objects ride the wrist)   ▲ camera detections                 │
│        ════════════════════ typed event bus · one clock ═══╪═════════════════════              │
│        │                                │                  │                                   │
│   OverlayModel ─► three.js presenters  EpisodeRecorder ─► EpisodeUploader                      │
│   (instruction, outlines, highlights,  (frames, events, object tracks)                         │
│    synthesized ghost hands, glyphs)                                                            │
└──────────┬─────────────────────────────────────┬──────────────────────┬───────────────────────┘
           │ /gemini WS relay                    │ /api/plans,          │ /api/episodes
           ▼                                     ▼ /api/vision/locate   ▼
┌──────────────────────────────────── Laptop: apps/server (Node · Hono) ────────────────────────┐
│ relay → Google (injects key) · planner LLM (structured output) · object finder (Gemini / jev) │
│ data/episodes/<id>/ · data/plans/<id>.json · data/clips/                                       │
│ pipeline/ (Python · uv): validate · Rerun replay · LeRobot export                              │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
 packages/protocol (TypeScript · zod): every contract above, exported as JSON Schema for Python.
```

## 3. Principles

1. **The LLM plans; code owns the state.** The planner writes the procedure (data). The
   `ProcedureRunner` is the only source of truth for progress. The coach requests changes through
   tool calls, and the runner validates them and records who decided and whether the check passed.
2. **The LLM never tracks hands.** It sees at most one camera frame per second. Hands come from
   WebXR hand tracking at 72–120 Hz. The coach learns what happened from short `[app]` narrations.
3. **Hands are the measuring instrument.** Pinch two corners to calibrate the table. Pinch an
   object the camera couldn't find to register it. Grip an object and it rides with your wrist
   (§5.6).
4. **Everything that matters is an event on one clock.** The recorder subscribes to the typed
   bus, so nothing is logged on the side. Timestamps come from the `performance.now()` timeline
   that XR frames and camera frames use.
5. **One episode, one frame.** All spatial data in an episode is in that episode's workspace
   frame. That's what makes ghost-hand clips portable and the exported dataset coherent.
6. **Ports and adapters.** `domain/` is plain TypeScript: no three.js, WebXR, DOM or SDK
   imports. `test/architecture.test.ts` enforces it. Gemini, the camera, the server and the
   renderer are adapters, so each can be swapped (scripted coach, emulator, memory sink).
7. **Degrade, don't die.** Every external dependency has a fallback (§10).

## 4. Repository layout

```
Clio/
├── packages/protocol/        @clio/protocol: zod contracts (procedures + checks + actions,
│   │                         episodes, clips, coach tools, HTTP API) → schema/*.json for Python
├── apps/headset/             @clio/headset: the WebXR app (Vite + three.js + TypeScript)
│   ├── src/core/             clock, typed emitter, tuple math, logging
│   ├── src/domain/           pure logic, unit-tested in Node:
│   │   ├── hands/            joint features, pinch detection
│   │   ├── world/            workspace frame, calibration, object registry, camera model,
│   │   │                     grounding (2D detections → 3D), grasp tracking, pose history
│   │   ├── procedure/        check evaluators, ProcedureRunner
│   │   ├── demo/             hand-shape kinematics, keyframes, verb choreographies, clip player,
│   │   │                     demo library (recorded clip, else synthesized)
│   │   ├── coach/            RealtimeAgent port, toolbox, narrator, prompt, session
│   │   ├── recording/        recorder, uploader (ordered, retrying), sinks
│   │   ├── overlay/          presentation model
│   │   └── session/          LessonController (plan → locate → run → record → revise)
│   ├── src/adapters/         xr, render, audio, camera, gemini, scripted, net
│   ├── src/app/              config, boot page, ClioApp (composition root + frame pipeline)
│   └── scripts/              synth-episode.ts: synthetic episodes from the real domain
├── apps/server/              @clio/server: relay, tokens, planner, vision, procedures, episodes, clips
├── pipeline/                 Python: validate, Rerun, LeRobot export (`clio …`)
├── procedures/               curated lessons: golden demos, planner examples, test fixtures
├── fixtures/episodes/        synthetic episodes for tests and pipeline work
└── docs/
```

## 5. Headset app

### 5.1 Layers and the dependency rule

```
app/        composition root · config · boot page        ← may import anything
adapters/   xr · render · audio · camera · gemini · scripted · net   ← implement domain ports
domain/     hands · world · procedure · demo · coach · recording · overlay · session
core/       clock · emitter · math · log          @clio/protocol (schemas, types)
```

Imports only point downward. Ports are declared next to the code that needs them: `RealtimeAgent`
(coach), `EpisodeSink` (recording), `LessonPlanner` / `PlanImageSource` (session),
`CameraFrameSource` / `VisionLocator` / `Grounder` (world), `ClipSource` (demo).

### 5.2 The frame pipeline (`app/clio-app.ts`)

Once per XR frame:
1. **Sample.** `FrameSampler` reads the viewer pose and 25 joints per hand (world space) and pushes
   the head pose into `PoseHistory`, so camera frames can be paired with where the head was.
2. **Localize.** It establishes the `Workspace` (calibration, a restored anchor, or a default in
   front of the user), refines it from the anchor, and converts the frame into workspace space.
3. **Perceive.** `PinchDetector` emits start/end with hysteresis. `GraspTracker` attaches and
   detaches held objects. The registry's changes go out as `objects.updated`.
4. **Decide.** `LessonController.update` runs the runner's checks and mistake rules, and
   `CoachSession.tick` sends camera frames to the model when they're due.
5. **Record.** `EpisodeRecorder.recordFrame`.
6. **Present.** Presenters read an `OverlaySnapshot` plus the active demonstration.

### 5.3 The "teach anything" flow (`domain/session/lesson-controller.ts`)

```
 coach hears the goal ─► start_lesson(goal)          [non-blocking tool: the coach keeps talking]
   ├─ plan:    camera snapshots + goal ─► POST /api/plans ─► validated Procedure (+ warnings)
   ├─ locate:  every unplaced object ─► Grounder (camera → /api/vision/locate → 3D) ─► registry
   │           still missing? announced once → coach asks the learner to look or pinch it
   ├─ run:     ProcedureRunner + EpisodeRecorder (the episode embeds the full plan)
   ├─ per step: briefing narration · show items found and outlined (Spotlight, refreshed every
   │            few seconds) · missing targets located · demo auto-played
   └─ revise_plan(reason) ─► POST /api/plans {revise: {planId, fromStepIndex}} ─► runner.replacePlan
```

Curated procedures (`procedures/*.json`, or `?procedure=<id>`) skip planning and go straight to
locate and run. They are the golden demos and the planner's examples.

### 5.4 Procedure engine (`domain/procedure`)

A procedure is objects plus steps. Each step has an instruction (the language label), targets, an
optional **action** primitive, a **success** check, optional mistake rules and coach notes. Checks
are composable _state_ checks (`pinch_near`, `hand_near`, `lift`, `object_near`, `confirm`,
`elapsed`, `all`, `any`, `sequence`) with dwell gates that bridge one-frame tracking dropouts. The
runner:
- auto-advances on success;
- fires mistakes on rising edges with cooldowns;
- reports stuck steps once;
- accepts coach and user advances, labeling `forced` when the check hadn't passed;
- swaps in revised plans without losing progress.

### 5.5 Showing a step (`domain/demo`)

AI-planned steps have no expert recording, so demonstrations are **synthesized** from the step's
action and the objects' live positions:
- **Hand shapes:** `open`, `flat`, `relaxed`, `point`, `pinch` and `grasp`, built with finger
  forward kinematics (left hand mirrored). Each shape has a grip point.
- **Choreographies:** each verb has one, a short keyframe track placed relative to the real
  objects. `pick_up` approaches, grips and lifts; `pour` carries the object over the target and
  tilts it about 100°; `twist` grips from above and rotates in strokes; `place`, `insert`,
  `press`, `pull`, `wipe` and `fold` have their own.
- **Glyphs:** arrows, twist arcs, press and sweep cues are drawn alongside the hands.
- **Playback:** `ClipPlayer` plays synthesized and recorded clips identically.

`DemoLibrary` prefers an expert recording when one exists: every good `record_demo` episode can be
sliced into clips by the server, and that is the flywheel.

### 5.6 Finding and tracking objects (`domain/world`, `domain/session/spotlight.ts`)

Every step says what to **show**: the objects to outline, each with a short phrase and a
standalone visual description written by the planner (see procedures.md). `Spotlight` is the
lesson's only use of the camera:

```
 step.entered ─► Spotlight.enterStep: show items (in the step's words) + targets not found yet
    ─► ObjectGrounder: camera frame + words ─► VisionLocator (POST /api/vision/locate)
         └─ server: Gemini (points, boxes) or any HTTP finder at CLIO_VISION_URL (jev: outlines)
    ─► lift the point into 3D (registry) and the outline onto a camera-facing plane
    ─► object.detected (recorded label) + overlay.outline ─► OutlinesPresenter
 every ~3 s while the step runs: the show items again, never two looks at once, skipping
 objects in hand; answers for a step that is over are recorded but not drawn
```

Outlines hang on the object's current estimate, so they follow carried objects, and turn toward
the learner every frame. A contour is drawn just outside the object; a box-only answer (Gemini)
gets corner brackets.

Tracking is layered. Each layer covers the others' blind spots:

| Layer                  | When                                                                                                  | How                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Accuracy                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Camera grounding**   | plan start, step start and every few seconds for what the step shows, after a release, on `highlight` | A passthrough camera frame and each object's words (the step's show description, else its tracking query) go to `/api/vision/locate` (Gemini spatial understanding → 2D point + box, or an HTTP finder such as jev → outline). `liftDetection` casts camera rays using the head pose at capture time: depth comes from where the box's bottom meets a real surface (WebXR plane detection, falling back to the workspace plane), height from the detection point. | ±1–2 cm for static props when calibrated (see dev-setup) |
| **Held objects**       | while pinched or fist-gripped                                                                         | `GraspTracker` attaches the object to the wrist with the grip offset, so it rides the 90 Hz hand tracking with no camera latency                                                                                                                                                                                                                                                                                                                                  | hand-tracking accuracy                                   |
| **Pinch registration** | the camera can't find something                                                                       | The next free-space pinch registers the next missing object (current step's targets first)                                                                                                                                                                                                                                                                                                                                                                        | fingertip accuracy                                       |
| **Layout**             | curated demos on a taped mat                                                                          | Fixed workspace positions; camera detections don't overwrite them until the object has been carried                                                                                                                                                                                                                                                                                                                                                               | as good as the tape                                      |

Camera facts that shaped this (October 2026):
- Quest Browser exposes the passthrough cameras via `getUserMedia` at 1280×960, 30 fps. Ask for
  `facingMode: environment` and never the avatar "facing front" camera.
- Permission prompts must happen before entering XR.
- Lens calibration comes from experimental `getSettings()` fields, with XR Blocks–derived
  defaults when they're absent.
- On current builds the headset-camera permission must be granted over `adb` (dev-setup).

### 5.7 Coach (`domain/coach`, `adapters/gemini`, `adapters/scripted`)

`CoachSession` wires a `RealtimeAgent` to:
- the mic (16 kHz PCM) and the speaker (24 kHz PCM, barge-in flush);
- the `CoachToolbox`, which validates and records the six tools;
- the `Narrator`, which turns events into `[app]` facts;
- the camera, at an ambient 4 s cadence, or 1 s while a step waits on a visual confirmation.

Tools:

| Tool                           | Behavior     | What it does                                |
| ------------------------------ | ------------ | ------------------------------------------- |
| `start_lesson(goal, context?)` | non-blocking | plan + locate + run                         |
| `revise_plan(reason)`          | non-blocking | re-plan the remaining steps                 |
| `highlight(object_id, style?)` | blocking     | emphasize an object (locates it if unknown) |
| `show_demo(step_id?)`          | blocking     | play the step's demonstration               |
| `advance_step(reason)`         | blocking     | complete a step that needs judgment         |
| `flag_mistake(kind, message)`  | blocking     | a coach-noticed mistake, shown and labeled  |

**Gemini Live** (`gemini-3.8-live`):
- **Relay transport (default):** the SDK connects to the laptop, which injects the key, so the
  headset needs no key and no internet.
- **Direct transport:** ephemeral tokens.
- **Session limits:** context-window compression is always on (audio+video sessions die at
  2 minutes without it). Resumption handles survive `goAway` and connection drops, and
  `connect()` races a timeout.

**Scripted coach:** the same port with no network. It speaks briefings and corrections through
text-to-speech, and learners confirm steps with the panel's touchable **Done** button.

### 5.8 Recording (`domain/recording`)

Three channels on one rebased clock:
- **frames:** quantized to 0.1 mm;
- **events:** recordable bus events, validated, so a bad event is dropped instead of the batch;
- **objects:** estimate changes.

`EpisodeUploader` creates the episode eagerly, then delivers batches strictly in `seq` order with
exponential-backoff retries, dropping only batches the server rejects as invalid. The episode's
`meta.plan` holds the full plan snapshot. Generated plans exist nowhere else.

## 6. Server (`apps/server`)

| Route                                                                 | Purpose                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /api/health`                                                     | liveness; whether a Gemini key is set; live model                                          |
| `WS /gemini/*`                                                        | Gemini Live relay (allowlisted path, injects `GEMINI_API_KEY`)                             |
| `POST /api/coach/token`                                               | ephemeral Live token (direct transport)                                                    |
| `POST /api/plans`, `GET /api/plans/:id`                               | the planner: goal + images (+ revision) → validated `Procedure`, stored in `data/plans/`   |
| `POST /api/vision/locate`                                             | the object finder: Gemini, or any HTTP finder at `CLIO_VISION_URL` (docs/object-finder.md) |
| `GET /api/procedures[/:id]`                                           | curated (`procedures/`) + generated (`data/plans/`)                                        |
| `POST /api/episodes` → `…/batches` → `…/finish`, `PUT …/media/:name`  | ingest (idempotent by `seq`)                                                               |
| `GET /api/episodes[/:id[/frames\|events\|objects]]`                   | browse / replay                                                                            |
| `POST /api/clips/from-episode`, `GET /api/clips/:procedureId/:stepId` | expert demos → ghost-hand clips                                                            |
| `GET /*`                                                              | the built headset app (`apps/headset/dist`), once there is one; unknown pages get the app  |

In dev, Vite proxies `/api` and `/gemini`, so the headset talks to a single origin (and to
`localhost` over `adb reverse`). Once the app is built, the server serves it too: still one origin,
so any HTTPS front (`pnpm live`, Render; see [deploy.md](deploy.md)) gives the headset one link.
With `CLIO_ACCESS_KEY` set, the relay and every `/api` route except health need the access cookie
(set by opening any page with `?key=`) or a bearer token.

## 7. Data pipeline (`pipeline/`)

`clio validate | info | view | export-lerobot` (uv, Python 3.12):
- **Validation:** against `packages/protocol/schema`.
- **Rerun replay:** skeletons, head, objects, object-finder detections, aperture, steps, mistakes,
  tools, transcripts.
- **LeRobot v3 export:** 16-d wrist pose + aperture state, next-frame action, hand mask, object
  environment state, the per-frame language `task`, and the `step.action_verb`.
- **Coordinates:** the export converts y-up to robotics z-up.

## 8. Extension points

| Want to...             | Do this                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Better object tracking | Serve the HTTP contract in docs/object-finder.md and set `CLIO_VISION_URL` (no headset change), or implement `VisionLocator` (on-device ArUco via js-aruco2, YOLO via ONNX Runtime Web/WebGPU, or a laptop detector) or a `Grounder` with depth/hit-test lifting; self-calibrate the camera from a marker (see Google XR Blocks' ArUco add-on) |
| Another realtime model | Implement `RealtimeAgent`                                                                                                                                                                                                                                                                                                                      |
| A new action verb      | Add it to `ACTION_VERBS` (protocol) and a choreography in `domain/demo/synthesizer.ts`                                                                                                                                                                                                                                                         |
| A new check type       | Add it to `@clio/protocol/checks.ts` and an evaluator in `domain/procedure/checks/`                                                                                                                                                                                                                                                            |
| A new coach tool       | Add it to `@clio/protocol/coach-tools.ts` and a handler in `LessonController.handlers()`                                                                                                                                                                                                                                                       |
| A new recorded signal  | Add the event to `@clio/protocol/episode.ts`, emit it on the bus, then run `pnpm gen:schema`                                                                                                                                                                                                                                                   |

## 9. Frames, units, time

- **Units:** meters and milliseconds. Quaternions are `[x, y, z, w]`.
- **World:** WebXR `local-floor`.
- **Workspace W:** origin on the surface at the first calibration corner (or a level default
  ~45 cm in front of and below the head); +x along the edge; +y up; +z toward the user.
- **Time:** `t` is ms since episode start on the `performance.now()` timeline.
- **Export:** z-up, converted only in the pipeline.

## 10. Failure modes and fallbacks

| Failure                             | Fallback                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| Gemini down, slow, or out of quota  | Scripted coach (`?coach=scripted`, automatic if connecting fails) plus the Done button |
| Planner fails                       | `plan.failed` → the coach apologizes and asks again; curated lessons still work        |
| Venue Wi-Fi                         | Phone hotspot on the laptop + USB `adb reverse`; the coach relays through the laptop   |
| Venue blocks the `pnpm live` tunnel | Laptop on the phone hotspot (the headset can stay on venue Wi-Fi), or the Render link  |
| Camera permission missing or broken | Grant over adb (dev-setup); otherwise pinch-to-register and layouts                    |
| Detection misses an object          | Announced once; the learner looks at or pinches it; `highlight` re-locates             |
| Object finder slow or rate-limited  | Outlines appear later; `?showRefresh=<ms>` looks less often (0: only at step start)    |
| Server down mid-session             | The uploader retries with backoff; nothing is lost while the tab lives                 |
| Tracking flicker (crossed hands)    | Dwell gates bridge dropouts; looser radii on those steps                               |
| No headset                          | Desktop Chrome + IWER (`?emulate=1`); `pnpm synth` for data work                       |

## 11. Who owns what (four-way split)

| Track                        | Owns                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Headset** (XR + rendering) | `adapters/xr`, `adapters/render`, `adapters/camera`, `app/`, `domain/world`                             |
| **Coach + planning**         | `domain/coach`, `adapters/gemini`, `adapters/scripted`, `adapters/audio`, server relay, planner, vision |
| **Data**                     | `domain/recording`, `@clio/protocol/episode`, server episodes + clips, `pipeline/`                      |
| **Integration + pitch**      | `domain/session`, `domain/demo`, `procedures/`, demo script, `docs/`                                    |

Contracts live in `@clio/protocol`. Change them in a small PR everyone sees, then run
`pnpm gen:schema`.

## 12. Key decisions

1. **WebXR in Quest Browser, not Unity.** Deploying means opening a URL, hot reload works over
   USB, and the IWER emulator lets everyone build without the headset. The browser does expose the
   passthrough cameras (§5.6). What it lacks is official calibration, which we handle with lens
   metadata, defaults and hand-based fallbacks.
2. **LLM-generated plans in a constrained language.** The planner can write anything, but only in
   a validated vocabulary of checks and action verbs. That's what lets Clio both verify progress
   and show the step.
3. **Demonstrations are synthesized from action primitives** rather than recorded, so "learn
   anything" works on the first try. Recordings upgrade them over time.
4. **Layered object tracking** (camera, then held, then pinch, then layout), because no single
   source is reliable enough at a venue.
5. **The headset is the realtime edge, with the Gemini relay as the default transport.** State,
   hands and tools stay local. The key stays on the laptop.
6. **Plain three.js + TypeScript + Vite + zod.** One source of truth for the contracts (types,
   validation, Gemini schemas, JSON Schema for Python), and an explicit frame loop for precise
   capture.
7. **Append-only NDJSON episodes with batch sequence numbers.** Human-readable, streamable, safe to
   retry. LeRobot and Rerun are export targets, not the capture format.
