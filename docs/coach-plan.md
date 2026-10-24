# The coach's plan

> The coach decides what the lesson is. The app keeps track of where it stands.

Any lesson starts from a goal ("help me fix my windshield wiper", "help me do the acid-base
titration"). The coach turns the goal and what the camera sees into a list of steps, changes the
list as the lesson goes, and judges when each step is done. The tracker, the segmenter and jev help
the learner see (outlines, ghost hands) and label the dataset. They never feed a Gemini coach,
which judges from the camera. The scripted coach can't see, so it is still told about missing and
pinched objects.

A Gemini coach is two models at once: the voice (`gemini-3.8-live`), which talks with the learner,
and the smart model (Robotics-ER 2), which plans, watches the steps and takes a closer look when
the voice asks. Only the voice speaks; the smart model's results reach it as text
([The smart model](#the-smart-model)).

This document is the design. [ARCHITECTURE.md](ARCHITECTURE.md) is the map, and
[procedures.md](procedures.md) is the plan language.

## Why the list lives in the app

The coach keeps a step list as notes to itself, but the notes live in the app, not in Gemini Live's
context:
- **Context doesn't last.** The adapter compresses the context from 25k tokens to 12k by dropping
  the oldest turns. Camera frames and the microphone fill it in minutes, so a plan the coach wrote
  early is gone. A reconnect brings back only the system instruction.
- **The app needs the list anyway.** The HUD shows the current step, outlines follow it, ghost hands
  demonstrate it, and every frame of the dataset is labeled with it.

So the coach edits the list through tools, the app stores it, and the app repeats it back to the
coach after every change. To the coach it behaves like its own notes.

## The plan

The plan is still a `Procedure` (`packages/protocol/src/procedure.ts`), held by the
`ProcedureRunner`, plus progress the runner tracks per step:

```ts
Step.doneWhen?: string        // the finished state, as a camera or the learner would see it
StepStatus = 'todo' | 'done' | 'skipped'
RunnerState.statuses: Record<stepId, StepStatus>
RunnerState.step              // the focused step: the one the HUD shows and the dataset labels
```

- **`doneWhen`** is one sentence (3 to 200 characters) describing an end state: "cup A has turned
  pink", "the wiper arm clicks onto the hook". Steps are written as outcomes, not motions. The coach
  and the step watcher judge completion against it. When it's missing, they use the instruction.
- **Focus** is the first `todo` step in list order, unless the coach moves it with `update_step`.
  Finishing or skipping the focused step moves focus to the first `todo` step again.
- **Any order.** The coach can complete any `todo` or `skipped` step, not just the focused one,
  because people do steps out of order. `complete_step` names the step by its id. The Done button
  completes the focused step.
- **The lesson completes** when no `todo` step remains.
- **Ids are stable.** A step keeps its id when its text changes, and an id is never reused within a
  lesson, even after its step is dropped.

The coach's own notes are kept beside the plan, one optional note per step. They appear in the
recital and in the recorded snapshots, not in the `Procedure`.

### Who writes the first draft

`start_lesson` answers at once and the draft arrives as an `[app]` message. Three sources, in order:
1. **A curated lesson** (`template_id`, one of `procedures/*.json`). The system instruction lists
   them. When the workspace isn't calibrated, `adaptTemplate()` turns `layout` placements into
   `detect` for items, containers and tools (it keeps points and regions, which only exist on the
   taped mat). After that the coach adapts it like any other plan.
2. **The planner** (`POST /api/plans`). It sees sharper frames than the coach (2 at 1024 px) and
   writes the AR fields the coach shouldn't have to think about: outline descriptions, action
   verbs, objects. Its schema now requires `doneWhen`. The server gives it 40 s, a retry included,
   and the headset gives up at 45 s.
3. **The coach itself.** If the planner fails or times out, the coach is told to write the steps
   with `add_step`. The lesson starts on the first `add_step`, and until then the HUD keeps its
   planning text. New steps go at the end of the list unless the coach says otherwise.

A lesson picked on the boot page (`?procedure=<id>`) skips `start_lesson`, but the coach still
hears "Plan ready" with the recital.

After 12 s without a plan, the coach is told planning is slow, so it can keep the learner company.

## The coach's tools

All arguments are flat, and every tool but `look_closer` answers in milliseconds. Slow work
(planning, re-planning) reports back as an `[app]` message; `look_closer` is non-blocking, so the
voice keeps going until its answer arrives. Plan tools return `plan`, the recital, and tools that
move the focus also return `now`, the briefing for the new focused step, so the coach never hears a
step twice.

| Tool                                                               | What it does                                             |
| ------------------------------------------------------------------ | -------------------------------------------------------- |
| `start_lesson(goal, context?, template_id?)`                       | starts a lesson; the draft arrives as an `[app]` message |
| `revise_plan(reason)`                                              | re-plans the steps not done yet through the planner      |
| `add_step(text, done_when, after_step_id?, objects?)`              | adds a step, at the end by default                       |
| `update_step(step_id, text?, done_when?, note?, status?, reason?)` | rewrites, notes, skips, reopens or refocuses a step      |
| `complete_step(step_id, reason, evidence)`                         | a step is done; `evidence` is `seen` or `heard`          |
| `add_material(label, look_for?)`                                   | something the plan didn't list, e.g. a funnel            |
| `highlight(object_id, style?)`                                     | emphasizes an object in AR                               |
| `show_demo(step_id?)`                                              | plays the ghost-hand demonstration                       |
| `flag_mistake(kind, message)`                                      | a correction, shown and labeled                          |
| `look_closer(question)`                                            | asks the smart model about a fresh frame (non-blocking)  |

`update_step` with `status`:
- `skipped`: the step isn't needed or can't be done;
- `current`: work on it now, reopening it if it was done or skipped;
- `todo`: reopen it without moving the focus.

Text and `done_when` can change only on steps that aren't done; a note can go on any step. A
rewording keeps the step's outlines, demonstration and checks, so it must keep the step's intent.
To change what a step does, the coach skips it and adds a new one.

`revise_plan` keeps every done and skipped step and replaces the steps still to do, including ones
the coach added. While it runs, `add_step` is refused, and so is `update_step` with text,
`done_when` or a status, with a message to wait for the new plan. A note is accepted only on a done
or skipped step, because the others are about to be replaced. `complete_step` still works, and a
step completed meanwhile stays done. A new `start_lesson` replaces a re-plan that is still running.

`complete_step` replaces `advance_step`. Its `step_id` is required, so the coach always says which
step it means. Work the learner did off camera is a completion with evidence `heard`, not a skip.
Errors list the valid ids so the coach can correct itself.

## Keeping the coach in sync

1. **The recital.** `recitePlan()` renders the plan in about 1,200 characters or fewer:

   ```
   Goal: Test an acid and a base with red-cabbage indicator (plan rev 3)
   Done: draw-indicator, dispense-indicator
   Now: acid-to-a: Now add vinegar to cup A. Done when: cup A has turned pink. Note: left-handed.
   Next: base-to-b: Add baking-soda water to cup B. Done when: cup B has turned blue-green.
   Later: compare
   Notes: compare: they want to keep cup C for later
   Materials: cup_a (cup A), cup_b (cup B), cup_c (cup C), indicator (indicator bottle), vinegar (vinegar bottle), base (baking-soda bottle), syringe (syringe)
   ```

   The `Now` and `Next` lines carry their steps' notes. Notes on any other step go on the `Notes`
   line. Every plan tool result carries the recital, and so do "Plan ready", "Plan revised", the
   reconnect recap and cancellation notices. A step briefing is shorter: the step, its done-when,
   what it uses, its notes and the next step.
2. **The system instruction** ends with the recital, labeled as a snapshot that newer `[app]`
   messages override. `RealtimeAgent.updateInstruction()` stores the new text, rebuilt 1.5 s after
   the plan or the lesson phase changes and again on every reconnect, so each new connection and
   resumption starts with the current plan.
3. **Reconnects.** While the connection is down, `CoachSession` holds narrations (the Gemini
   adapter also queues any that reach it in the gap). When it's back, they go out in one message
   that ends with "[app] Reconnected." plus the recital.
4. **One gate for narrations.** Every message to the model interrupts what it's saying, so
   `CoachSession` holds narrations while the coach is speaking or calling tools, or the learner is
   talking, and merges what piled up into one message. A hold ends after 6 s at most while the
   connection is up. A briefing for a step that lost focus while it waited is dropped, and so is
   a briefing that arrives together with "Plan revised", whose recital already has the new step.
5. **Cancelled calls.** When the learner barges in and Gemini cancels a tool call that already
   changed the plan, the coach is told the call was applied, with the recital. A call that had
   failed is not reported.

## The smart model

The voice decides what to say; the smart model, Gemini Robotics-ER 2, does the slow looking and
thinking. Each part runs on its own and never makes the voice wait:

| Work                   | How the voice starts it       | How the result reaches the voice                    |
| ---------------------- | ----------------------------- | --------------------------------------------------- |
| a plan, a revised plan | `start_lesson`, `revise_plan` | an `[app]` narration ("Plan ready", "Plan revised") |
| is the step done?      | nothing: the step watcher     | an `[app]` narration ("Step watcher: … looks done") |
| a closer look          | `look_closer(question)`       | the call's result, which it says when it is idle    |

Narrations go through the gate above, so they never cut the learner off. Nothing the smart model
returns is spoken by anyone but the voice.

**A closer look.** The voice's frames are small and blurry, and it is confident anyway: asked "is
it safe to work here?" over a table with a large knife on it, it said yes. Its instructions open
with the rule that safety, which-is-which, where, what-went-wrong and how-to-hold questions go to
`look_closer`. It says "Let me take a closer look", calls the tool, and keeps listening. The
headset takes a fresh 1024 px frame and sends it to `POST /api/scene/ask` with the question, the
goal, the focused step and the materials. The smart model answers through structured output with
minimal thinking:
- `hazard`: a danger near the hands or the work, whatever the question was. As a field it must
  fill, it named the knife 4 times in 4; as a line of the prompt, 1 in 4;
- `answer`: at most two short sentences, as the learner sees things (left, right, in your hand);
- `refs`: what the answer points out, as points and boxes, with the material id when it is one.

The voice gets `{ hazard?, answer, highlighted? }` as the call's result, scheduled `WHEN_IDLE`: it
finishes its filler, waits for the learner to stop, and then answers in its own words. The refs
that are lesson objects are lifted into the scene with the head pose of the frame the smart model
saw, and highlighted; `highlighted` names them, so the voice can say "the one I've highlighted".
Thinking stays minimal, a median of about 1.9 s with the hazard field: low was no more accurate
on which and where questions and took about 0.5 s longer.

## Completion

A step is done when one of these says so:

| Who             | How                                                             | `by`    |
| --------------- | --------------------------------------------------------------- | ------- |
| the coach       | `complete_step` on any step, from what it saw or heard          | `coach` |
| the learner     | the Done button, on the focused step                            | `user`  |
| a trusted check | the step's success check passes using only trusted data (below) | `check` |

**The step watcher** is the coach's second pair of eyes. Gemini Live only takes a turn when the
learner speaks; camera frames never prompt it. So a step finished in silence would go unnoticed.
While a step has focus and nobody is talking, the watcher sends a fresh 1024 px frame plus the
step's text and `doneWhen` to `POST /api/plans/check` (the planner's model) every 6 s. When it
answers `done`, the coach gets the frame and "[app] Step watcher: … looks done (what it saw)", and
decides. The watcher suggests; it never completes a step. Every answer is recorded.

`forced` keeps its meaning on main: the step's full success check, with every position, had not
passed when it was completed. Under coach authority the runner evaluates the check twice: once on
trusted positions, which may complete the step, and once on everything, which only sets `forced`.
Each has its own check tree, with its own dwell timers and latches, so the one on everything never
completes a step. A step completed while another one had focus was never checked, so it is always
`forced`.

## The perception boundary

The line is drawn by how reliable a signal is, not by which part produces it.
- **Trusted:** hand tracking, and object positions from a printed marker, a manual placement, the
  taped mat (`layout`) on a calibrated workspace, or a learner's pinch when exactly one object was
  missing.
- **Untrusted:** camera detections (`detector`), which include the object finder, the segmenter and
  jev, and layout positions on a workspace that was never calibrated, which are only a guess. So is
  a pinch that registered one of several missing objects, because the app guessed which one was
  meant. Its position still draws outlines.

A held object keeps the trust of where its position was measured. Picking up something the camera
found doesn't make it trusted, even though it then rides the hand.

When the coach is Gemini in learn mode (coach authority), success checks and mistake rules see only
trusted positions, and the coach hears only:
- the plan, step briefings, and plan changes;
- step completions, the Done button, and the stuck timer;
- mistakes from rules, which saw only trusted positions;
- the step watcher, which looks at raw frames only;
- a closer look's hazard and answer, in words, and the names of the objects it highlighted.

It never hears positions, distances, pinches, detections, missing or registered objects, or whether
an object has been found. It is told only what the learner can see: whether a highlight or a
demonstration is showing, so it doesn't point at an outline that isn't there. `highlight` answers
`shown: false` while the object has no position yet. Under local authority (the scripted coach, no
coach, `record_demo`, or a Gemini connection that is down), checks see everything, as on main. A
Gemini coach isn't told rule mistakes then, because those rules saw untrusted positions.

The AR side still reads the focused step to know what to outline, so the dependency runs one way:
the plan feeds perception, and perception never feeds a Gemini coach. The scripted coach can't
see, so it still hears about missing objects and pinches, as on main.

## Recording

Version 1 leaves `packages/protocol/src/episode.ts` alone, because the tracking branch is still
changing it.
- Every plan change is an `annotation` with label `plan.updated` and data
  `{ rev, op, by, stepId?, reason?, callId?, plan }`, where `plan` is a full snapshot. Rev 0 is
  recorded when the lesson starts.
- Every step-watcher answer is an `annotation` with label `step.watch`.
- Every narration is a `coach.narration` event, recorded when it reaches the model, not when it's
  queued. A stale briefing dropped at delivery is an `annotation` with label
  `coach.narration_dropped`.
- Every closer look is an `annotation` with label `coach.look_closer` and data
  `{ callId, model, latencyMs, refs }`, refs with their points. Refs on lesson objects are also
  `object.detected` events, with the question as the description.
- Skips are `step.completed` with `by: 'skip'`, which the schema already allows.
- Out-of-order completions are `step.completed` for that step. The pipeline keeps labeling frames
  with the focused step.
- `finish.json` counts done steps against the steps that weren't skipped.

## Failures

| Failure                         | What happens                                                               |
| ------------------------------- | -------------------------------------------------------------------------- |
| Planner slow                    | after 12 s the coach is told, so it can keep the learner company           |
| Planner fails or times out      | the coach writes the steps with `add_step`                                 |
| Step watcher down or not set up | no suggestions; the coach and the Done button still complete steps         |
| Closer look slow or failing     | after 8 s the voice is told there was no closer look, and asks the learner |
| Connection drops during a look  | the answer goes to the next connection as an `[app]` narration             |
| Gemini reconnecting             | local authority until it's back; queued narrations and a recap on return   |
| Gemini gives up reconnecting    | local authority for the rest of the lesson: checks and the Done button     |
| No Gemini at all                | the scripted coach, curated lessons, checks and the Done button, as today  |

## Later

After the tracking branch merges:
- typed `plan.updated` and `step.verified` events behind an episode feature flag;
- pipeline segments for reworded, reordered and out-of-order steps;
- saving the frames the coach and the watcher judged by;
- Skip and Back buttons on the panel.

Later still: seeding the planner from the closest curated lesson, a slimmer planner schema, a
per-step annotator for the AR fields of steps the coach adds, and measured tuning of frame cadence
and compression.
