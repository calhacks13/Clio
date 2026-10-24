# Clio architecture

> Every lesson trains two students: you, and a robot.

Clio is a WebXR app for Meta Quest 3 that can teach **anything**. You say what you want to learn.
An LLM plans the lesson from your goal and what the headset camera sees. Clio then works out how
to _show_ each step: it finds the objects, highlights them, and synthesizes a ghost-hand
demonstration. A voice coach talks you through it. Every session is recorded as an intent-labeled,
robot-ready dataset.

This is the map of the system. Read it before you write code, and update it when you change a
boundary. The exact data formats are in [data-format.md](data-format.md), the plan language is in
[procedures.md](procedures.md), how the coach keeps the plan is in [coach-plan.md](coach-plan.md),
and setup is in [dev-setup.md](dev-setup.md).

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
│   │ start_lesson / revise_plan ────────────────────────────►  │ plan ─► locate ─► run ─► record│
│   │ add_step / update_step / complete_step / add_material ─►  │   ▲        │        │         ││
│   │ highlight / show_demo / flag_mistake ──────────────────►  │   │        │        │         ││
│   │ look_closer (non-blocking) ─► smart model, /api/scene/ask │   │        │        │         ││
│   │◄── [app] narrations, look_closer answers (in words) ◄─    │   │        ▼        ▼         ││
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
           │                                     │ /api/vision/locate   │
           ▼                                     ▼ /api/scene/ask       ▼
┌──────────────────────────────────── Laptop: apps/server (Node · Hono) ────────────────────────┐
│ relay → Google (injects key) · planner LLM (structured output) · object finder (Gemini / jev) │
│ closer looks for the voice (the smart model, Robotics-ER 2)                                   │
│ data/episodes/<id>/ · data/derived/<id>/ · data/plans/<id>.json · data/clips/                  │
│ pipeline/ (Python · uv): validate · compile (on finish) · Rerun replay · LeRobot export        │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
 packages/protocol (TypeScript · zod): every contract above, exported as JSON Schema for Python.
```

## 3. Principles

1. **The coach decides; the app keeps the plan.** A curated lesson, the planner or the coach
   itself writes the first draft (data). The coach then edits it through tool calls and judges when
   each step is done. The `ProcedureRunner` is the only source of truth for the plan and progress.
   It validates every change and records who decided and whether the check passed. The app repeats
   the plan back to the coach after every change, so the coach's notes live in the app, not in the
   model's context ([coach-plan.md](coach-plan.md)).
2. **Perception helps the learner, never a Gemini coach.** Hands come from WebXR hand tracking
   at 72–120 Hz, and object positions from the mat, markers, pinches and the camera. They drive
   outlines, ghost hands, checks and the dataset. The coach sees about one camera frame every 4 s
   and hears the plan and lesson events as short `[app]` narrations. When it needs a sharp look it
   asks the smart model and hears the answer in words. A Gemini coach never hears positions,
   pinches or detections, and its checks ignore camera detections (§5.7). The scripted coach can't
   see, so it is still told about missing and pinched objects.
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
│   │   ├── plan/             the coach's view of the plan: recital, step briefings
│   │   ├── recording/        recorder, uploader (ordered, retrying), sinks
│   │   ├── overlay/          presentation model
│   │   └── session/          LessonController (plan → locate → run → record → revise),
│   │                         step watcher, curated-lesson templates, Spotlight, closer look
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
domain/     hands · world · procedure · demo · coach · plan · recording · overlay · session
core/       clock · emitter · math · log          @clio/protocol (schemas, types)
```

Imports only point downward. Ports are declared next to the code that needs them: `RealtimeAgent`
(coach), `EpisodeSink` (recording), `LessonPlanner` / `PlanImageSource` / `StepChecker` /
`WatchFrameSource` / `TemplateSource` (session), `CameraFrameSource` / `VisionLocator` /
`Grounder` (world), `ClipSource` (demo).

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
 coach hears the goal ─► start_lesson(goal, template_id?)   [answers at once; coach keeps talking]
   ├─ draft:   a curated lesson (template_id), else camera snapshots + goal ─► POST /api/plans
   │           {stage: first} ─► validated Procedure: step 1 in full, the rest an outline
   │           (+ warnings); slow (12 s)? the coach is told;
   │           failed or timed out (40 s)? the coach writes the steps with add_step
   ├─ ready:   [app] "Plan ready." + the recital
   ├─ refine:  at once, fresh snapshots ─► POST /api/plans {stage: rest, revise} ─► the outline
   │           steps nobody started are replaced; [app] "Plan refined." + the recital
   ├─ locate:  every unplaced object ─► Grounder (camera → /api/vision/locate → 3D) ─► registry
   │           still missing? shown on the HUD; the scripted coach asks the learner to look or pinch
   ├─ run:     ProcedureRunner + EpisodeRecorder (the episode embeds the full plan)
   ├─ per step: briefing (in the tool result that moved the focus, else narrated) · show items found
   │            and outlined (Spotlight, refreshed every few seconds) · demo auto-played
   ├─ edit:    add_step / update_step / complete_step / add_material ─► runner ─► plan.changed
   │           (recorded as plan.updated); each result repeats the plan
   ├─ watch:   step watcher: frames from the step's start and now + step, looks, mix-ups
   │           ─► POST /api/plans/check, again 1 s after each answer ─► "looks done" or "did
   │           something else" twice in a row? the coach gets the frame and decides
   └─ revise_plan(reason) ─► POST /api/plans {revise: {planId, fromStepIndex, base}}
                             ─► runner.replacePlan (by step id)
```

Curated procedures (`procedures/*.json`) skip planning and go straight to locate and run: the
coach picks one with `template_id` (the system instruction lists them), or `?procedure=<id>`
starts one. Only `start_lesson` adapts the lesson: on a workspace that isn't calibrated,
`adaptTemplate()` has the camera look for its items instead of using the taped-mat positions.
`?procedure=<id>` runs it as written, and the coach hears "Plan ready" with the recital, as for any
other lesson. They are also the golden demos and the planner's examples.

The server gives the planner 40 s, a retry included, and the headset gives up at 45 s. When the
coach writes the steps itself, the HUD keeps its planning text until the first `add_step`. A new
`start_lesson` replaces a re-plan that is still running. The design, with the recital and the
failure cases, is in [coach-plan.md](coach-plan.md).

### 5.4 Procedure engine (`domain/procedure`)

A procedure is objects plus steps. Each step has an instruction (the language label), a
`doneWhen` end state, targets, an optional **action** primitive, a **success** check, optional
mistake rules and coach notes. Checks are composable _state_ checks (`pinch_near`, `hand_near`,
`lift`, `object_near`, `confirm`, `elapsed`, `all`, `any`, `sequence`) with dwell gates that bridge
one-frame tracking dropouts. The runner:
- keeps a status per step (`todo`, `done`, `skipped`) and a focus: the first `todo` step, unless
  the coach moves it;
- completes the focused step when its check passes or the learner presses Done;
- completes any step the coach names, in any order;
- labels a completion `forced` when the check hadn't passed. Under a Gemini coach it runs two
  check trees, one on trusted positions that may complete the step and one on every position that
  only sets `forced`;
- applies the coach's edits (add, reword, skip, reopen, refocus), keeping step ids stable;
- fires mistakes on rising edges with cooldowns;
- reports stuck steps once;
- swaps in revised plans by step id without losing progress.

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
| **Pinch registration** | the camera can't find something                                                                       | The next free-space pinch registers the next missing object (current step's targets first). It counts as trusted only when exactly one object was missing; otherwise it draws outlines, but a Gemini coach's checks don't use it                                                                                                                                                                                                                                  | fingertip accuracy                                       |
| **Layout**             | curated demos on a taped mat                                                                          | Fixed workspace positions; camera detections don't overwrite them until the object has been carried                                                                                                                                                                                                                                                                                                                                                               | as good as the tape                                      |

Camera facts that shaped this (October 2026):
- Quest Browser exposes the passthrough cameras via `getUserMedia` at 1280×960, 30 fps. Ask for
  `facingMode: environment` and never the avatar "facing front" camera.
- Permission prompts must happen before entering XR.
- Lens calibration comes from experimental `getSettings()` fields, with XR Blocks–derived
  defaults when they're absent.
- On current builds the headset-camera permission must be granted over `adb` (dev-setup).

### 5.7 Coach (`domain/coach`, `adapters/gemini`, `adapters/scripted`)

**Two models.** The coach is two models working at the same time:
- **The voice** is the realtime model (`gemini-3.8-live`, native audio in and out). It is the only
  one that talks with the learner. It sees one small frame every 4 s, listens, speaks, and calls
  the tools. It never waits on the smart model.
- **The smart model** is Gemini Robotics-ER 2 (`gemini-robotics-er-2-preview`). It plans and
  re-plans lessons (`/api/plans`), watches whether the step is done (`/api/plans/check`), finds
  objects (`/api/vision/locate`) and takes a closer look when the voice asks (`/api/scene/ask`). It
  never speaks to the learner.

They talk only in words. The voice hands work to the smart model through tools that never hold it
up: `start_lesson` and `revise_plan` answer at once and the plan arrives later as an `[app]`
narration, and `look_closer` is non-blocking (below). The smart model's results reach the voice
as narrations, through the narration gate, or as `look_closer`'s result, and the voice says them in
its own words. Coordinates and detections go only to the AR side.

**A closer look** (`domain/session/closer-look.ts`). The voice's frames are small and blurry, and
in tests it called a table with a large knife on it "safe". So whenever the learner asks whether
something is safe, which thing is which, where something is, what went wrong or how to hold
something, the voice says "Let me take a closer look" and calls `look_closer(question)`:

```
 voice: "Let me take a closer look" + look_closer(question)  [NON_BLOCKING: it keeps listening]
   ─► CloserLook: a fresh 1024 px frame + goal, step, materials ─► POST /api/scene/ask
        └─ server: Robotics-ER 2, minimal thinking, structured output:
           { hazard, answer (two short sentences), refs (points/boxes, lesson ids) }
   ─► AR: refs on the lesson's objects are lifted with the frame's head pose (ObjectGrounder.place)
          and highlighted; every ref is recorded
   ─► voice: the call's result { hazard?, answer, highlighted? }, scheduled WHEN_IDLE
        └─ it says the answer once neither it nor the learner is talking
```

`hazard` is its own field because the smart model named the knife 1 time in 4 when hazards were a
line of its prompt, and 4 in 4 as a field it must fill. Measured on a real key (October 2026):
the voice says its filler within about 0.1 s of the learner stopping, the smart model answers in
about 1.5 to 2 s (median; outliers to 8 s, the server's timeout), and the voice speaks the answer
about 1 s after it arrives, so 3 to 4 s after the question.

`CoachSession` wires a `RealtimeAgent` to:
- the mic (16 kHz PCM) and the speaker (24 kHz PCM, barge-in flush);
- the `CoachToolbox`, which validates and records the nine tools;
- the `Narrator`, which turns lesson events into `[app]` narrations. For a Gemini coach they wait
  while either side is talking (up to 6 s), then go out merged into one message. A briefing for a
  step that lost focus meanwhile is dropped;
- the camera, one frame every 4 s;
- the system instruction, which lists the curated lessons and ends with the current plan. It's
  refreshed after plan changes, so a reconnect starts from the current plan.

Tools:

| Tool                                                               | What it does                                             |
| ------------------------------------------------------------------ | -------------------------------------------------------- |
| `start_lesson(goal, context?, template_id?)`                       | starts a lesson; the draft arrives as an `[app]` message |
| `revise_plan(reason)`                                              | re-plans the steps not done yet through the planner      |
| `add_step(text, done_when, after_step_id?, objects?)`              | adds a step, at the end by default                       |
| `update_step(step_id, text?, done_when?, note?, status?, reason?)` | rewrites, notes, skips, reopens or refocuses a step      |
| `complete_step(step_id, reason, evidence)`                         | a step is done; `evidence` is `seen` or `heard`          |
| `add_material(label, look_for?)`                                   | something the plan didn't list, e.g. a funnel            |
| `highlight(object_id, style?)`                                     | emphasizes an object (locates it if unknown)             |
| `show_demo(step_id?)`                                              | plays the step's demonstration                           |
| `flag_mistake(kind, message)`                                      | a coach-noticed mistake, shown and labeled               |
| `look_closer(question)`                                            | asks the smart model; non-blocking, answers in 1 to 3 s  |

Arguments are flat, and every tool but `look_closer` answers at once. Planning and re-planning
report back later as `[app]` messages. Plan tools return `plan`, the recital, and, when the focus
moved, `now`, the new step's briefing, so the coach never hears a step twice. Details are in
[coach-plan.md](coach-plan.md).

**The step watcher** (`domain/session/step-watcher.ts`) is the coach's second pair of eyes.
Gemini Live only takes a turn when someone speaks, so a step finished in silence would go
unnoticed. While a step has focus and nobody is talking, the watcher sends a fresh 1024 px frame,
the frame from when the step gained focus, the step's text and `doneWhen`, what its objects look
like and its mistakes to `POST /api/plans/check`, and looks again 1 s after each answer (about
every 2.5 s). When two answers in a row say `done`, or that the learner did something else (took
the milk, not the yogurt drink), the coach gets the frame and a suggestion, and decides. The
watcher never completes a step itself. Every answer is recorded as a `step.watch` annotation.

**The perception boundary.** When the coach is Gemini in learn mode, it never hears positions,
distances, pinches, detections, or missing and registered objects. It is told only what the
learner can see: whether a highlight or a demonstration is showing, so it doesn't point at an
outline that isn't there. `highlight` answers `shown: false` while the object has no position yet.
Checks and mistake rules see only trusted positions: hand tracking, markers, manual placements, the
mat (`layout`) on a calibrated workspace, and a pinch that registered the only missing object. A
held object keeps the trust of where it was measured. The HUD and the recording still get
everything. Under local authority (the scripted coach, no coach, `record_demo`, or a Gemini
connection that is down), checks use every position, as before, and a Gemini coach isn't told rule
mistakes. The scripted coach can't see, so it still hears about missing objects and pinches.

**Gemini Live** (`gemini-3.8-live`):
- **Relay transport (default):** the SDK connects to the laptop, which injects the key, so the
  headset needs no key and no internet.
- **Direct transport:** ephemeral tokens.
- **Session limits:** context-window compression is always on (audio+video sessions die at
  2 minutes without it). Resumption handles survive `goAway` and connection drops, and
  `connect()` races a timeout.
- **Reconnects:** narrations sent while the connection is down are queued, and the coach gets
  `[app] Reconnected.` with the plan when it's back.
- **Barge-in:** when Gemini cancels a tool call that already changed the plan, the coach is told
  the call was applied.
- **Non-blocking calls:** `look_closer` is declared `NON_BLOCKING` and its result is sent with
  `scheduling: WHEN_IDLE`, which waits for the voice to finish its filler and for the learner to
  stop talking. (`INTERRUPT` cut the filler off mid-word; `SILENT` never says it.) Learner speech
  didn't cancel a pending non-blocking call in tests. An answer goes only to the connection that
  made the call, since Live speaks an answer to an id it never issued twice; when the connection
  changed meanwhile, the answer goes out as an `[app]` narration instead.

**Scripted coach:** the same port with no network. It speaks briefings and corrections through
text-to-speech, and learners confirm steps with the panel's touchable **Done** button.

### 5.8 Recording (`domain/recording`)

Three channels on one rebased clock:
- **frames:** quantized to 0.1 mm;
- **events:** recordable bus events, validated, so a bad event is dropped instead of the batch;
- **objects:** estimate changes.

`EpisodeUploader` creates the episode eagerly, then delivers batches strictly in `seq` order with
exponential-backoff retries, dropping only batches the server rejects as invalid. The episode's
`meta.plan` holds the full plan snapshot. Generated plans exist nowhere else. Every later change
to the plan is a `plan.updated` annotation with a full snapshot, and every step-watcher answer is
a `step.watch` annotation. A narration is recorded as `coach.narration` when it reaches the model.
A stale briefing dropped at that point is a `coach.narration_dropped` annotation.

## 6. Server (`apps/server`)

| Route                                                                 | Purpose                                                                                      |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /api/health`                                                     | liveness; whether a Gemini key is set; live model                                            |
| `WS /gemini/*`                                                        | Gemini Live relay (allowlisted path, injects `GEMINI_API_KEY`)                               |
| `POST /api/coach/token`                                               | ephemeral Live token (direct transport)                                                      |
| `POST /api/plans`, `GET /api/plans/:id`                               | the planner: goal + images (+ revision) → validated `Procedure`, stored in `data/plans/`     |
| `POST /api/plans/check`                                               | the step watcher: frames + step → `done`, `not_done` or `unsure`, progress, what was wrong   |
| `POST /api/vision/locate`                                             | the object finder: Gemini, or any HTTP finder at `CLIO_VISION_URL` (docs/object-finder.md)   |
| `GET /api/episodes[/:id[/frames\|events\|objects]]`                   | browse / replay                                                                              |
| `POST /api/scene/ask`                                                 | the voice's closer look: frames + question → hazard, answer in words, points (smart model)   |
| `GET /api/procedures[/:id]`                                           | curated (`procedures/`) + generated (`data/plans/`)                                          |
| `POST /api/episodes` → `…/batches` → `…/finish`, `PUT …/media/:name`  | ingest (idempotent by `seq`)                                                                 |
| `GET /api/episodes[/:id[/frames\|events\|objects\|observations]]`     | browse / replay; detail includes the compile state (`derived`)                               |
| `POST /api/episodes/:id/compile`, `GET …/derived/:name`               | compile again by hand; read compiled files from `data/derived/<id>/` (docs/data-pipeline.md) |
| `POST /api/clips/from-episode`, `GET /api/clips/:procedureId/:stepId` | expert demos → ghost-hand clips                                                              |

Vite proxies `/api` and `/gemini`, so the headset talks to a single origin (and to `localhost` over
`adb reverse`).

## 7. Data pipeline (`pipeline/`)

`clio validate | info | view | compile | export-lerobot` (uv, Python 3.12):
- **Validation:** against `packages/protocol/schema`.
- **Compile** (run by the server when an episode finishes; [data-pipeline.md](data-pipeline.md)):
  head, wrists and every object on one fixed-rate grid with validity masks and held spans, the
  environment (table, floor, detected planes), a quality verdict, and robot joint trajectories
  from each retargeting profile (damped least squares IK on a URDF, numpy only). Written to
  `data/derived/<id>/`; raw files are never changed.
- **Rerun replay:** skeletons, head, objects, object-finder detections, aperture, steps, mistakes,
  tools, transcripts.
- **LeRobot v3 export:** 16-d wrist pose + aperture state, next-frame action, hand mask, object
  environment state, the per-frame language `task`, and the `step.action_verb`. With
  `--robot-profile`, the state and action are the retargeted joint values instead.
- **Coordinates:** the export converts y-up to robotics z-up.

## 8. Extension points

| Want to...             | Do this                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Better object tracking | Built: [tracker/](../tracker/README.md) (YOLOE-26 + ByteTrack, jev about once a second) serves the HTTP contract in docs/object-finder.md behind `CLIO_VISION_URL` and paces the headset with `refreshMs`. Alternatives: serve that contract yourself, or implement `VisionLocator` (on-device ArUco via js-aruco2, YOLO via ONNX Runtime Web/WebGPU, or a laptop detector) or a `Grounder` with depth/hit-test lifting; self-calibrate the camera from a marker (see Google XR Blocks' ArUco add-on). To record a tracker's per-frame answers, convert them into `TrackedObjectSample` (`domain/world/tracked-object.ts`) and pass them to `ObjectTrackRecorder` (docs/data-pipeline.md) |
| A robot to retarget to | Add a profile (URDF, joints, base placement, tool offset, gripper mapping) to `pipeline/src/clio_pipeline/retarget/profiles/` and list it in `CLIO_RETARGET_PROFILES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Another realtime model | Implement `RealtimeAgent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| A new action verb      | Add it to `ACTION_VERBS` (protocol) and a choreography in `domain/demo/synthesizer.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| A new check type       | Add it to `@clio/protocol/checks.ts` and an evaluator in `domain/procedure/checks/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| A new coach tool       | Add it to `@clio/protocol/coach-tools.ts` and a handler in `LessonController.handlers()` (or, for a tool the coach answers itself such as `look_closer`, in `CoachOwnToolHandlers`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| A new recorded signal  | Add the event to `@clio/protocol/episode.ts`, emit it on the bus, then run `pnpm gen:schema`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

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
| Planner slow                        | After 12 s the coach is told, so it can keep the learner company                       |
| Planner fails or times out          | The coach writes the steps with `add_step`; curated lessons still work                 |
| Venue Wi-Fi                         | Phone hotspot on the laptop + USB `adb reverse`; the coach relays through the laptop   |
| Camera permission missing or broken | Grant over adb (dev-setup); otherwise pinch-to-register and layouts                    |
| Detection misses an object          | Shown on the HUD; the learner looks at or pinches it; `highlight` re-locates           |
| Step watcher down or not set up     | No suggestions; the coach and the Done button still complete steps                     |
| Closer look slow or failing         | The voice is told it got no closer look (8 s timeout) and asks the learner to describe |
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
8. **Record live, compile after the episode, keep files.** The headset records only what exists
   nowhere else (hands, head, live estimates, 2D observations, planes). Resampling, gap masks,
   environment fitting and IK run after finish in `pipeline/`, into rebuildable files beside the
   raw episode. No database: a local index can be built from the files later if search needs it.
