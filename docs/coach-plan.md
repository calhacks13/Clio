# The coach's plan

> The coach decides what the lesson is. The app keeps track of where it stands.

Any lesson starts from a goal ("help me fix my windshield wiper", "help me do the acid-base
titration"). The coach turns the goal and what the camera sees into a list of steps, changes the
list as the lesson goes, and judges when each step is done. The tracker, the segmenter, jev and
the action focus help the learner see (outlines, ghost hands, what to touch next) and label the
dataset. They never feed a Gemini coach, which judges from the camera. The scripted coach can't
see, so it is still told about missing and pinched objects.

A Gemini coach is two models at once: the voice (`gemini-3.8-live-extended-thinking`), which talks
with the learner, and the smart model (Robotics-ER 2), which plans, watches the steps and takes a
closer look when the voice asks. Only the voice speaks; the smart model's results reach it as text
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

### Starting, and changing course

The voice starts lessons itself. When the learner says or shows what they are about to do (a
streaky wiper, a jug of washer fluid in hand at an open hood), it infers the goal and calls
`start_lesson` at once, saying in one short sentence what it starts. It asks one short question
only when there is no plausible goal.

A new `start_lesson` replaces whatever came before, at once: a lesson being planned (its plan is
dropped when it lands), one the coach is writing, or the one running. The running one is aborted
before the call answers, so its episode ends `aborted`, its steps leave the HUD and its lights go
out before the new plan exists; the new lesson is a new episode. The result names what it
replaced (`replaced`). The same goal again while it is being planned (a replay after a reconnect)
answers `already` and changes nothing.

That is how the voice takes "no". On "no", "that's not what I want", "stop" or "wrong thing" it
stops, acknowledges in a few words and acts on what they do want: a new goal is a new
`start_lesson`; a wrong step is `update_step`, or `revise_plan` when much is wrong. If they don't
say what they want, it calls `end_lesson` and asks in a few words.

`end_lesson(reason)` ends the lesson at once without starting another. A running lesson is
aborted with the reason, so its episode ends `aborted`, its steps leave the HUD, every light goes
out and the action focus stops; a lesson being planned or written is dropped. The HUD then asks
what they want to do, and the result names what ended (`ended`). With no lesson it answers ok,
with a note.

### Who writes the first draft

`start_lesson` answers at once and the draft arrives as an `[app]` message. Three sources, in order:
1. **A curated lesson** (`template_id`, one of `procedures/*.json`). The system instruction lists
   them. When the workspace isn't calibrated, `adaptTemplate()` turns `layout` placements into
   `detect` for items, containers and tools (it keeps points and regions, which only exist on the
   taped mat). After that the coach adapts it like any other plan.
2. **The planner** (`POST /api/plans`), in two stages. It sees sharper frames than the coach (2
   at 1024 px) and writes the AR fields the coach shouldn't have to think about: outline
   descriptions, action verbs, objects, mistakes. Its schema requires `doneWhen`.
   - **Stage `first`** writes a short card, because every token of it is time the learner waits:
     first a reading of the scene (`done`, the parts of the goal the views show done and what shows
     it; `todo`, the parts left, in the goal's order), which stays out of the plan; then the whole
     lesson as an `outline` (an id and an instruction per step) that does only the parts left; only
     the objects the first step uses and the look-alikes it guards against, each with a spoken
     label, a short phrase for the object detector, a one-sentence `look` that finds it in a frame
     and whether it moves; where it saw them (`sightings`); every hazard in view (`warnings`); and
     last, the first step as a card: instruction, done-when, targets, action, the ids of the objects
     it shows, and up to two mistakes, each naming the object it is made with. `plan-build.ts`
     expands the card into an ordinary `Procedure`, so the contract and its JSON Schema stay as they
     are: an object's look becomes its `tracking.query` and the description of every outline that
     shows it; a mistake becomes a `hand_near` rule on its object (dropped when that object isn't
     declared or is one the step itself uses); the first step is confirmed by its done-when; and the
     other outline lines become steps confirmed by their instruction, which outline nothing yet. The
     lesson starts on it 3 to 4 s (median) after the request on the bench. The server gives it 40 s,
     a retry included, and the headset gives up at 45 s.
   - **Stage `rest`** is asked at once, with fresh frames, while the lesson starts: a revision
     of the first stage's plan from `outlineFrom` that writes steps 2 to n in full (60 s on the
     server, as nobody waits for it). It is written in parallel (`plan-rest.ts`), in calls that
     each do one thing:
     - a **review** of the outline against the scene and the goal (thinking low): what the views
       show done, what is left, and in an experiment the sample kept as the control, then the
       lines as they should be (no looking-only step, no part done twice, nothing added that a
       thing already has), the objects each line uses, the new objects as cards, and a new
       summary;
     - at the same time, the card's **objects** written again in full, with the warnings
       (thinking low): their kind, size, description and where to look replace the card's
       defaults, and their ids and labels stay, as the learner may have heard them;
     - once the review is in, every line written in full **at once**, each by its own call
       (thinking minimal), from the whole checked outline, the review's reading and one table of
       objects, so the steps fit together and share ids; each new object is declared by the
       first line that uses it.

     Each written step is checked as a plan of its own and asked again once with its errors; one
     that still fails stays an outline line, confirmed by its done-when. A mistake on an object the
     step itself uses is dropped, as on the card. Without a usable review (two tries, 30 s), one
     call writes the rest as it did before. The answer is one plan, as before. When it lands it
     replaces the outline steps nobody has started; the focused step and finished ones stay as they
     are, so nothing restarts, and a step skipped meanwhile stays skipped. The coach hears "Plan
     refined" with the recital, without being asked to speak. It is dropped when the plan moved on
     without it: a new lesson, a `revise_plan`, or the coach adding or rewording a step.
   - `stage: full` (the default) writes the whole plan in one call, for the bench and
     `revise_plan`.

   What the planner is told for Robotics-ER 2: plan from the scene as it is (a part of the goal
   already done is not planned again, there or elsewhere); cover every part of the goal, in the
   order it names them, and keep any control the setup implies (a spare cup stays untouched);
   declare only what is in view and never point at what isn't; write done-when states that name
   how the right object looks, never actions ("cup C has turned green", not "baking soda is
   added"), so a look-alike can't pass them; make a look-alike mix-up (the milk beside the yogurt
   drink) one of the step's `mistakes`; and start `warnings` with a checklist of hazards in view
   (sharp, hot, electrical, glass, chemicals, machinery), each named by how it looks and where it
   is, because hazard labels alone are unreliable.

   Thinking per stage (`PLAN_THINKING` in `gemini-planner.ts`, and `REST_PART_THINKING` for the
   parts of stage rest) was picked with `pnpm bench` ([planner-bench.md](planner-bench.md)) on
   two synthetic scenes, the pH lesson with cup A already pink and a knife on the table and a
   fridge with a yogurt drink beside the milk, 3 runs each per setting, judged by
   `gemini-pro-latest` against 9 expectations (the last rows: four scenes, below). Medians;
   directional:

   | Robotics-ER 2                                 | Lesson starts | Plan complete | Met       |
   | --------------------------------------------- | ------------- | ------------- | --------- |
   | before: one whole plan, default thinking      | 16.4 s        | 16.4 s        | 16/27     |
   | whole plan, minimal                           | 5.8 s         | 5.8 s         | 18/27     |
   | whole plan, low (`full`, also `revise_plan`)  | 11.1 s        | 11.1 s        | 43/54     |
   | whole plan, medium                            | 19.6 s        | 19.6 s        | 20/27     |
   | first low, rest medium (first step in full)   | 8.1 to 8.8 s  | 20 to 21.5 s  | 68/81     |
   | first low, rest high                          | 8.8 to 9.0 s  | 24 s          | 49/54     |
   | first medium, rest high                       | 16.1 s        | 32.5 s        | 23/27     |
   | first high, rest high                         | 22.5 s        | 39.5 s        | no better |
   | the card's first version: first minimal       | 3.4 s         | 15.0 s        | 22/27     |
   | the card's first version: first low           | 6.2 s         | 21.0 s        | 24/27     |
   | the card, before the whole-goal rule: minimal | 3.8 s         | 20.1 s        | 23/27     |
   | the card, before the whole-goal rule: low, pH | 6.5 s         | 24.4 s        | unjudged  |
   | the card: first minimal, rest in one call     | 3.5 s         | 18.7 s        | 24/27     |
   | four scenes: the card, rest in one call       | 4.1 s         | 20.6 s        | 48/60     |
   | four scenes: the card, rest in parallel       | 4.1 s         | 21.5 s        | 34/40     |
   | four scenes: the card reads, rest in parallel | 3.9 s         | 13.1 s        | 37/40     |

   Most of the gain is the prompt; more thinking is not better on its own. The first stage at
   high takes over 20 s for no better plan. The rest at high was no better than medium here, but
   took up to 45 s, and a refinement that lands after the first step is done leaves the second
   step an outline.

   The card's rows were measured later on recreated scenes: generated headset-like photos of the
   same two setups (the original frames stayed on the laptop that captured them), with 9
   expectations written again, so compare them with each other rather than with the rows above;
   directional. On the card's first version, the first step was right at minimal in every card
   (streamed, it started after 2.6 to 3.4 s, against 5.3 to 9.1 s at low), so stage first
   thought at minimal. With a detector phrase per object, the reworded prompt and stage rest
   writing the card's objects again, the first step at minimal started after 2.7 to 3.9 s (no
   thought tokens, 505 to 897 output tokens) and was still right: the yogurt drink with a
   mistake for the milk (3 of 3), cup A left alone and the knife first in the warnings (10 of 10
   pH cards). But 4 of those 10 pH outlines only tested the acid and never used the base, and
   stage rest kept them that way; at low all 7 used it, as did all 12 on the first version at
   either level. So stage first thought at low for a while.

   The prompt now says to cover the whole goal, in the order it names its parts, and to keep any
   control the setup implies, and stage first's outline must reach the end of the goal; the pH
   scene has a tenth expectation, that the plan tests the base too. Measured again at minimal
   (3 judged staged runs a scene, plus 4 stage-first calls alone on pH): every pH outline tested
   the base (7 of 7); the first step was still right (the yogurt drink with a milk mistake 3 of
   3, cup A left alone and the knife first in the warnings 7 of 7); and the judge met 27 of 30,
   that is 24 of the 9 older expectations' 27 (as at low on the first version, and 23 before
   the rule) plus the base 3 of 3. The lesson started after 3.5 s (2.9 to 4.9 s) and the plan
   completed after 18.7 s, against 6.5 s and 24.4 s for pH at low, and no stage rest took over
   23 s. So stage first thinks at minimal again. The control is still not kept: every pH plan
   puts vinegar in cup B and the base in cup C, reading cup A's pink as setup rather than as the
   acid already tested, and no level kept cup C before the rule either.

   The last rows are on four scenes, 20 expectations, judged as above: the fridge and the photo
   pH scene made again from written specs (`apps/server/scripts/bench-scenes/`), this laptop's
   drawn pH scene (cup C empty) and a half-done TV remote with a look-alike battery; 2 or 3 runs
   a scene, so compare them with each other; directional. Two changes made the difference:
   - **The card reads the scene first.** Asked on its own what the views show done (2 s at
     minimal), Robotics-ER 2 said "the acid test: cup A is already pink" and left only the base
     to do; asked for a plan, it planned both tests anyway. With `done` and `todo` written before
     the outline, the photo pH plans put the base in cup B and kept cup C as the control in 8 of
     9 runs, against 0 of 3 before (and 7 of 7 cards in the handoff). The lesson still starts
     after 4.0 s (median of 32 cards, p90 5.4 s), against 4.2 s (p90 5.1 s); the remote's
     longer reading takes about 1 s more.
   - **Stage rest in parallel.** The plan is complete 13.1 s after the request (p90 20.6 s)
     against 20.6 s (p90 29.5 s, up to 49 s), so step 2 is written about 9 s after the lesson
     starts. On the old card, the parallel rest with the review at medium was no faster (21.5
     s): the review is the one part that waits for another, and at medium it took 5 to 15 s.
     After the review was told that its `todo` leaves out what is done and that nothing gets
     what it already has, it met as many expectations at low as at medium on the two pH scenes
     (19 of 20 each) in 13.1 s against 20.5 s, so it thinks at low. The step writers at minimal
     take 2 to 8 s each, all at once. Placing each hazard by the nearest object of the task got
     the knife "left of cup A" in 7 of 9 photo pH plans, against 0 of 3.

   The judge also names other serious problems beside the expectations: 0.75 a plan now (6 in 8),
   against 1.0 (12 in 12). What is left: no planner model sees the remote's loose battery as the
   thinner one (0 of 10 in all), steps that need a cap off or a bottle picked up first, and on the
   drawn pH scene the base sometimes poured into the empty cup before the indicator. A lesson
   now makes 5 planner calls (4 to 7) instead of 2, with about 23k input tokens instead of 9.7k
   (each call sends the views again) and about 3.8k output and thought tokens instead of 4.6k.

   Tried and not kept, measured on the same scenes: two identical stage-first calls at once,
   taking the first answer, would start the lesson at 3.9 s (p90 4.4 s) instead of 4.1 s (p90
   5.1 s), estimated from 22 single calls, for twice the stage-first tokens, and the first answer
   is the shorter card. Several cards to choose from with a critic would choose among the same
   mistake: the pH cards put vinegar in cup B every time. Writing the steps before the review
   lands, to keep those it leaves alone, would rarely pay: the review rewords most lines.
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
| `end_lesson(reason)`                                               | ends the lesson without starting another                 |
| `revise_plan(reason)`                                              | re-plans the steps not done yet through the planner      |
| `add_step(text, done_when, after_step_id?, objects?)`              | adds a step, at the end by default                       |
| `update_step(step_id, text?, done_when?, note?, status?, reason?)` | rewrites, notes, skips, reopens or refocuses a step      |
| `complete_step(step_id, reason, evidence)`                         | a step is done; `evidence` is `seen` or `heard`          |
| `add_material(label, look_for?)`                                   | something the plan didn't list, e.g. a funnel            |
| `highlight(object_id, style?, look_for?)`                          | lights an object; `look_for` adds one the plan lacks     |
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

`highlight` lights one object. The voice calls it every time it asks the learner to touch, move or
operate something, in the same turn and before it says it. Its `target` stays lit until the step
changes or another `target` replaces it; `attention` lasts 5 s and `warning` is a 600 ms pulse. With
`look_for` during a lesson, an `object_id` the plan doesn't have is added as a material (under that
id when it is a free, valid one) and lit, and the result gives its `material_id` and `added: true`;
without `look_for`, an unknown id is an error that lists the lesson's objects. A coach's `look_for`,
here and in `add_material`, describes one particular instance: color, material, shape, size,
markings and where it is relative to its neighbors. When it leaves out what the thing is, the app
puts the name in front ("funnel, white plastic, on the fender"), so the words jev and the outlines
go by stand alone.

`revise_plan` keeps every done and skipped step and replaces the steps still to do, including ones
the coach added. While it runs, `add_step` is refused, and so is `update_step` with text,
`done_when` or a status, with a message to wait for the new plan. A note is accepted only on a done
or skipped step, because the others are about to be replaced. `complete_step` still works, and a
step completed meanwhile stays done. A new `start_lesson` replaces a re-plan that is still running.

`complete_step` replaces `advance_step`. Its `step_id` is required, so the coach always says which
step it means. Work the learner did off camera is a completion with evidence `heard`, not a skip.
Errors list the valid ids so the coach can correct itself.

## What is lit

While a step is focused, something glows whenever there is something to do. `overlay/lights.ts`
holds the rules, and the live tracker (`LiveTracking`) and the fallback while it is down
(`OverlayModel`'s rings around Spotlight's outlines) light the same set:
- the step's show items, in rank order; a step that shows nothing lights its targets, then its
  action's objects (what the action moves is what to act on, where it goes is the destination);
- the action focus's item, for the rest of the step, until it names another
  ([The smart model](#the-smart-model));
- the coach's highlights: a `target` for the step, `attention` for 5 s, `warning` as a pulse.

Each lit object's color comes from its role (`stepRole` in `overlay/accents.ts`, for every
renderer): the plan's own role for a show item, else what the step's hands do with it (what the
action moves is what to act on, where it goes is the destination, whatever its kind: a mug picked
up by its handle is cyan, not yellow), else its place and kind (a container or region is a
destination, the first other item is what to act on).

The tracker follows the plan's other objects too, unlit, for the recording. A step with no
objects at all lights nothing until the action focus names one.

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
   failed is not reported. A `highlight` counts only when its result says it added a material
   (`added: true`).

## The smart model

The voice decides what to say; the smart model, Gemini Robotics-ER 2, does the slow looking and
thinking. Each part runs on its own and never makes the voice wait:

| Work                   | How the voice starts it       | How the result reaches the voice                    |
| ---------------------- | ----------------------------- | --------------------------------------------------- |
| a plan, a revised plan | `start_lesson`, `revise_plan` | an `[app]` narration ("Plan ready", "Plan revised") |
| is the step done?      | nothing: the step watcher     | an `[app]` narration ("Step watcher: … looks done") |
| a closer look          | `look_closer(question)`       | the call's result, which it says when it is idle    |
| what to touch next     | nothing: the action focus     | never: it feeds the learner's view and the data     |

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

**The action focus** (`domain/session/action-focus.ts`). jev, the tracker's finder, answers about
once a second but goes by words alone, and often picks the wrong one of two look-alikes; the smart
model sees better. While a step is focused, `ActionFocus` sends it one sharp frame
(`POST /api/vision/focus`, minimal thinking) with the goal, the step and what the tracker follows
(lit first, 8 at most): as the step is entered, every 5 s from the start of the last look, and
once more 0.5 s after a coach highlight. One look runs at a time, and an answer for a step or a
lesson that is over is dropped. The answer boxes each object, describes it again as it looks now,
and names the one thing to touch next:
- a box it is sure of (found, confidence 0.5 or more) anchors the tracker (`anchor`,
  tracker/TRACK.md), which prefers it to jev's answers for 6 s;
- the sure object's description becomes the words jev gets for it (`LiveTracking.refine`) until
  the plan's words for it change; its phrase stays, so the track goes on;
- the action item is lit for the rest of the step. When the plan lacks it and the smart model saw
  it surely, the lesson declares it in the smart model's words, once
  (`LessonController.declareObject`, a material added by the app), as the planner would have.

Three failures in a row (503 without a Gemini key) pause it for 30 s. The voice hears none of it;
a declared object reaches it only as one of the plan's materials.

## Completion

A step is done when one of these says so:

| Who             | How                                                             | `by`    |
| --------------- | --------------------------------------------------------------- | ------- |
| the coach       | `complete_step` on any step, from what it saw or heard          | `coach` |
| the learner     | the Done button, on the focused step                            | `user`  |
| a trusted check | the step's success check passes using only trusted data (below) | `check` |

**The step watcher** is the coach's second pair of eyes. Gemini Live only takes a turn when the
learner speaks; camera frames never prompt it. So a step finished in silence would go unnoticed.
While a step has focus and nobody has spoken for 1 s, the watcher asks `POST /api/plans/check`
(the planner's model, Robotics-ER 2) about it, and asks again after each answer. Each question
carries:
- a fresh 1024 px frame, and the frame taken when the step gained focus, so the model compares
  the start with now (how Robotics-ER is trained to detect success);
- the step's text and `doneWhen`;
- what the step's objects look like (each show item's description, else the object's detector
  query, else its name) and its mistake rules' messages, as mix-ups that look like success;
- the step's criteria.

**Criteria.** When a step gains focus, the watcher asks `POST /api/plans/criteria` once, with the
frame from the step's start: the done-when split into 2 to 4 things a camera can confirm in one
view. Together they say what the done-when says and nothing more: the end state on the right
object ("cup B's liquid is blue-green"), which object it must be when a look-alike is near ("the
bottle in hand has a pink cap, not a blue one"), and what the step must leave as it was ("cup C
is still purple"). Never an amount from the instruction or where the tools are: a learner may
still hold the bottle once the step is done. They take about 1.5 s; the first look waits for them
(at most 4 s) and looks go without them if asking fails. Every look judges each criterion (yes,
no or unsure, and what it saw), and the server holds a `done` back unless all are met: one not
met makes it `not_done`, one it could not see makes it `unsure`. Criteria never turn another
answer into a done. One set left out "off the shelf", and the model's own verdict caught it.

The model points at the object the learner is acting on and checks it is the right one, so the
milk doesn't pass for the yogurt drink. It answers `done`, `not_done` or `unsure` (unsure when the
object is out of view, blurred or hidden, whatever other clues say), a short observation,
`progress` (0 to 100), `wrong` when the learner did something else ("picked up the milk, not the
yogurt drink"), the criteria as judged, and the object that decided it.

**Quick and careful looks.** While the step looks far from done, looks are quick: the request says
`quick`, the model thinks at minimal (about 1.5 s with criteria), and the next look starts 1 s
after each answer. Once an answer says the step is close (`progress` 50 or more) or finds it
done or wrong, looks turn careful (thinking low, about 2 s), and a second one starts 1 s after
the first, before it answers: a fresh answer arrives about every 1.2 s instead of every 2.5 to
3 s. A look that finds something starts the next one at once. Answers count in the order their
looks started; a late answer from an older look is recorded but not counted. On our 30 hard
cases minimal was as right as low on done, not done and wrong, but it filled in what a hand hid
("cup A is still purple") and once took the dropper for the knife and called that step done, so
a quick look only notices; it never confirms.

Two answers in a row must agree before the coach hears anything, and the second is always a
careful one. Two `done`s: the coach gets the frame and the criteria it saw met ("[app] Step
watcher: … looks done: cup B's liquid is blue-green; cup C's liquid is still purple"), and
decides; the watcher then leaves the step alone for 20 s. Two answers that say the learner did
something else: the coach gets the frame, what went wrong and the criteria not met with what was
seen ("Not met: cup C's liquid is still purple (saw: blue-green)"), and decides whether to correct
them (once per 20 s a step). The watcher suggests; it never completes a step. After 3 failures in
a row it pauses for 30 s. Every answer is recorded, with its progress, what went wrong, the
criteria and the deciding object's point.

Measured on the planner bench's 30 hard watcher tests ([planner-bench.md](planner-bench.md)),
directional: the old watcher (low, no criteria) passed 87 of 90 looks, the careful look now 30 of
30 and the quick look 29 of 30; none ever said done when it wasn't. Simulated on the measured
latencies, a done reaches the coach a median 4.1 to 5.2 s after it shows, against 6.6 s before:
4.1 s when the step is visibly under way for a few seconds first (pouring, carrying), 5.2 s when
the done state appears between two looks. It costs a fifth more looks a minute (23 against 19),
most of them quick ones.

Every look also names any hazard in view, whatever the step: a knife, something hot, broken glass.
One answer is enough: the coach gets the frame and "[app] Step watcher: a possible hazard …", and
warns the learner only if it sees it too, at most once a minute. Robotics-ER names a hazard on only
some looks (2 of 8 on a drawn knife) and invented none in our tests; the plan's warnings name the
hazards in view at the start.

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
- the step watcher, which looks at raw frames only, as text and the frame it judged (never its
  points);
- a closer look's hazard and answer, in words, and the names of the objects it highlighted.

It never hears positions, distances, pinches, detections, missing or registered objects, or whether
an object has been found. It is told only what the learner can see: whether a highlight or a
demonstration is showing, so it doesn't point at an outline that isn't there. `highlight` answers
`shown: false` while the object has no position yet. Under local authority (the scripted coach, no
coach, `record_demo`, or a Gemini connection that is down), checks see everything, as on main. A
Gemini coach isn't told rule mistakes then, because those rules saw untrusted positions.

The AR side still reads the focused step to know what to outline, so the dependency runs one way:
the plan feeds perception, and perception never feeds a Gemini coach. The live tracker works the
same way: it is told what to follow (every declared object for the whole lesson, with what is lit
first: [What is lit](#what-is-lit)) and nothing it sees comes back. So does the action focus: its
boxes and words go to the tracker, and its action item only to the lights. Their positions reach
the registry as `detector` estimates, they add no narrated events, and `highlight` still answers
only `shown` (and `material_id` for an object it added). The scripted coach can't see, so it still
hears about missing objects and pinches, as on main.

## Recording

Version 1 leaves `packages/protocol/src/episode.ts` alone, because the tracking branch is still
changing it.
- Every plan change is an `annotation` with label `plan.updated` and data
  `{ rev, op, by, stepId?, reason?, callId?, plan }`, where `plan` is a full snapshot. Rev 0 is
  recorded when the lesson starts. A refined outline is op `refine`, next to a `plan.refined`
  annotation (`{ from, to, kept }`); a dropped one is a `plan.refine_dropped` with the reason.
- Every step-watcher answer is an `annotation` with label `step.watch` and data `{ stepId,
  verdict, observation, model, latencyMs, progress?, wrong?, evidence?, hazard?, criteria?,
  quick? }`, where `evidence` is `{ label, point }` with the point in 0..1 of the newest frame,
  `criteria` is `[{ text, met, seen? }]` (`met` is `yes`, `no` or `unsure`) and `quick` marks a
  quick look. A failed look records `error`.
- A step's criteria are an `annotation` with label `step.criteria` and data `{ stepId, criteria,
  model, latencyMs }`, recorded when they arrive; when asking fails, `{ stepId, error }`.
- Every narration is a `coach.narration` event, recorded when it reaches the model, not when it's
  queued. A stale briefing dropped at delivery is an `annotation` with label
  `coach.narration_dropped`.
- How fast `start_lesson` got to step 1 is an `annotation` with label `lesson.first_step`, recorded
  as the step starts, with data `{ stepId, source, frames, captureMs, planMs, totalMs, locate }`.
  `source` is `planner` or `template`. `frames` says where the planner's frames came from:
  `buffered` (at most a second old, kept every 450 ms for 8 s after the learner speaks while no
  lesson runs, topped up at once if short), `fresh` (taken then, 0.4 s apart) or `none`.
  `captureMs` is the time to get them, `planMs` the planner's answer (or loading the curated
  lesson), and `totalMs` the time from `start_lesson` to the step-1 briefing being queued; its
  `coach.narration` says when it reached the model. `locate` is `background`: the lesson starts on
  the plan, and its objects are found while the coach briefs step 1.
- When that first look has answered, and the same lesson is still on, an `annotation` with label
  `lesson.first_locate` records `{ locateMs, sinceStartMs, located, missing }` (ids; at once and
  empty when every object had a position). A lesson that ends sooner has only `lesson.first_step`.
  Because the look comes after the recording starts, its `object.detected` events are in the
  episode, and the objects it places are not in `meta.objects` but arrive as `object.registered`.
- Every action focus answer is an `annotation` with label `focus.answered` and data `{ stepId,
  model, latencyMs, frameAgeMs, detections, action, actionId }`: the detections and the action as
  the smart model gave them, boxes in 0..1 of a frame `frameAgeMs` older than the annotation, and
  the lesson object lit for the action. A failed look records `{ stepId, error }`. An object it
  declared is a `plan.updated` with op `material` and by `app`.
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
| Action focus failing            | the step's own lights stay; after 3 failures in a row it pauses for 30 s   |
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
