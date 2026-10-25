# Always something lit: jev, the ER2 action focus, boxes and the desk lab

Branch `feat/jev-coach` (worktree `../Clio-jev`), off `origin/main` at a28f4d6.

## What the learner should get

1. **Something is always lit while there is something to do.** While a lesson runs and a step is
   focused, at least one object glows for the learner to touch, move or operate, followed live by
   the tracker (jev + YOLOE-26). Today a step with no show items lights nothing, and the coach's
   `highlight` lasts 5 s and is seldom called.
2. **jev is told what to find in sharper words.** The planner's and the coach's descriptions name
   one particular thing precisely, and Gemini Robotics-ER 2 (minimal thinking) looks at a sharp
   frame every few seconds, boxes the step's objects and the next action item, and rewrites what
   jev is told about each one. Its boxes outrank jev's.
3. **The boxes are visible.** Every lit object shows its bounding box with a label, in its role
   color, next to the glow.
4. **The voice is proactive and takes "no" at once.** It infers the goal from what the learner
   says and shows and starts the lesson without an interview; "No, that's not what I want" stops
   the lesson it started and turns to what they do want, at once.
5. **The voice is a little sharper:** `gemini-3.8-live-extended-thinking` at LOW (done, e6828b2;
   `apps/headset/src/adapters/gemini/live-model.ts` says what it refuses).
6. **A desk lab:** the whole lesson (voice, planner, step watcher, tracker, ER focus, boxes) on the
   laptop's camera and microphone, without the headset.

The perception boundary stays (docs/coach-plan.md): the tracker's detections and the ER focus's
boxes feed the learner's view and the recording, never a Gemini coach. ER is the smart model, so
when it names an action item the plan never declared, that item may join the lesson's objects
(as the planner's would); its boxes and the tracker's never reach the voice.

## Contracts

### `POST /api/vision/focus` (`packages/protocol/src/api.ts`, done)

`FocusRequestSchema` → `FocusResponseSchema`: one sharp frame (about 1024 px), the goal, the step
(instruction, done-when) and up to 8 objects (`{id, label, phrase?, query}`, the step's show items
first in rank order, then the lesson's other followed objects). The answer: one `FocusDetection`
per request object, in its order (`found`, `box`, `point`, `confidence`, and `description`: a
sharper standalone description of that one object as it looks now), and `action`: the one thing the
learner should touch next (`id` of a request object, or `null` with its own label, phrase and
description when the request omits it), or `null` when the step needs nothing touched. The server
always asks Robotics-ER 2 (`config.visionModel`) at minimal thinking, whatever `CLIO_VISION_URL`
says, and answers 503 without a Gemini key, 504 past its deadline (8 s).

### Tracker: `anchor` (objects mode, `tracker/TRACK.md`)

Headset to tracker, text JSON:

```json
{ "type": "anchor", "id": "cup_a", "t": 123456.7, "box": [0.31, 0.42, 0.58, 0.77], "source": "er", "query": "clear plastic cup on the left, half full of pink liquid" }
```

- `id`: an object of the current set (any other id: logged and skipped). `box`: `[left, top,
  right, bottom]` normalized 0..1, on the frame captured at `t` (the page's `performance.now()`
  clock, like a frame's `t`). `source`: who boxed it, `"er"` for now. `query` (optional): what jev
  is told about the object from now on; the phrase stays, so the track goes on.
- The tracker places the object from the box as it places it from a jev answer: on the streamed
  frame whose `t` is nearest (within 120 ms), else carried to the newest frame by the camera's
  motion since, else applied to the next frame as if measured on it. An object jev has not placed
  yet (`unknown`) is placed at once.
- **It outranks jev.** For 6 s after an anchor, a jev answer for that object that disagrees with
  the anchored track (IoU below 0.3 and neither box inside the other) is ignored, and jev saying
  the object is absent does not mark it lost; a jev answer that agrees applies as usual.
- In target mode an anchor is logged and skipped. A malformed one is logged and skipped, like any
  message, and the connection stays open.

Tracker to headset: each `detections` entry gains `"source": "jev" | "er" | null`, the finder that
last placed the object (null before any). Pages that ignore it keep working.

### Headset domain: `ActionFocus` (`apps/headset/src/domain/session/action-focus.ts`)

```ts
/** Port: Robotics-ER 2's action focus (POST /api/vision/focus). */
export interface FocusFinder {
  focus(request: FocusRequest): Promise<FocusResponse>;
}
/** Port: one sharp current camera frame and when it was captured (performance.now ms). */
export interface FocusFrames {
  grab(): Promise<{ image: ImagePayload; t: number } | null>;
}
/** Port: where ER's boxes go: the live tracker, which follows the object from them. */
export interface FocusAnchors {
  anchor(anchor: FocusAnchor): void;
}
export interface FocusAnchor {
  id: string;
  box: NormalizedBox;
  /** Capture time of the frame ER saw (performance.now ms). */
  t: number;
  /** ER's words for the object, for jev from now on. */
  query?: string;
}
```

It looks when a step is entered and then every 5 s while the step stays focused (never two looks
at once; a look for a step that is over is dropped, and so is one for a lesson that is over), and
once more soon after a coach highlight. It sends `LiveTracking`'s objects (lit first) and the
step; found boxes go to `FocusAnchors` (confidence 0.5 or more), each found object's description
goes to `LiveTracking.refine(id, query)`, and the action item is lit for the rest of the step (a
declared object, or one the lesson declares from ER's words when the plan lacks it). Every answer
is emitted on the bus as `focus.answered` (frame time, step, detections, action, model, latency)
for the displays.

`LiveTracking` (same folder) gains:

```ts
/** ER's words for an object as it looks now: its query from now on, until the plan rewrites it. */
refine(id: string, query: string): void;
```

and lights, while a step is focused: its show items in rank order; else its targets, then its
action's objects; plus the action focus's item and the coach's highlights. A coach `target`
highlight stays lit until the step changes or another `target` replaces it; `attention` lasts 5 s,
`warning` as today.

### Displays

- **AR (headset):** every lit object (every followed one with `?debug=1`) shows its bounding box:
  the tracker's `box`, lifted onto the same camera-facing plane as its outline (the frame's head
  pose, the object's measured distance), drawn as a thin rectangle with corner accents in the
  object's accent color, with a label tag at its top-left corner (the object's label; with
  `?debug=1` also its state, `source` and score). ER's boxes from `focus.answered` are drawn dashed
  for 1.5 s with `?debug=1`. Colors come from `domain/overlay/accents.ts` (role colors).
- **Desk lab:** the same on the webcam image in 2D (outline, box, tag), plus ER's boxes.

## Who owns what

| Workstream | Worktree, branch | Owns |
| --- | --- | --- |
| Tracker (Python) | `../Clio-jev-tracker`, `jev/tracker` | `tracker/**` |
| Server | `../Clio-jev-server`, `jev/server` | `apps/server/**` (focus endpoint, planner descriptions) |
| Coach + domain | `../Clio-jev-coach`, `jev/coach` | `apps/headset/src/domain/**`, `packages/protocol/src/coach-tools.ts`, coach docs |
| AR display + wiring | `../Clio-jev-ar`, `jev/ar` | `apps/headset/src/adapters/{net,render,camera}/**`, `apps/headset/src/app/**` |
| Desk lab | `../Clio-jev-desk`, `jev/desk` | `apps/headset/desk.html`, `apps/headset/src/desk/**`, its vite entry and docs |

Another agent is building the Gemini generative UI cards at the same time (branch
`feat/coach-widgets`, worktree `../Clio-widgets`). Leave its ground alone: the instruction panel
(`adapters/render/presenters/instruction-panel.ts`), panel cards and motion, the gallery
(`src/gallery/**`, `gallery.html`), `apps/headset/DESIGN.md`/`PRODUCT.md`, fonts and the headset's
global styles. Edits to shared coach files (`prompt.ts`, `coach-tools.ts`) are surgical: change
the lines that need it, never reorder or reformat the rest.
