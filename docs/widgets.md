# Coach widgets

> The voice says it once. The widget keeps it in view while the learner's hands are busy.

The voice coach (Gemini Live) can put small cards beside the step card: a countdown, a count toward
a target, a short checklist, the answers to a question it just asked, a number to keep in mind, or
a lasting hazard. It shows them through seven tools. The app owns everything else: how long each
one stays, where it goes, how it looks, and what the coach hears back. Two kinds answer a
fingertip: touching an answer or ticking a checklist item reaches the voice as an `[app]` message,
as does a timer running out. The voice never learns where anything is drawn.

This is the reference. How the coach uses widgets alongside the plan (scopes, caps, narrations,
the voice match) is also summed up in [coach-plan.md](coach-plan.md#widgets);
[ARCHITECTURE.md](ARCHITECTURE.md) is the map. The widgets' visual rules live here ([How they
look](#how-they-look)), with every value in `theme.ts`; the Coach widgets section of
`apps/headset/DESIGN.md`, beside the step card's own rules, sums up the few a designer needs and
points here.

| Where                                       | What                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/protocol/src/coach-tools.ts`      | the seven tools, `WIDGET_KINDS`, `WIDGET_TOOL_NAMES`, `isWidgetTool`                                  |
| `apps/headset/src/domain/widgets/`          | `WidgetBoard` and its rules, the `on_screen` line, what is recorded                                   |
| `apps/headset/src/domain/coach/`            | narrations (`narrator.ts`), sync (`session.ts`), prompt item 7                                        |
| `apps/headset/src/adapters/render/widgets/` | theme, text, shapes, placement, layout, touch, the dock and the chips                                 |
| `apps/headset/src/app/`                     | wiring (`clio-app.ts`), `?widgets=` and friends (`config.ts`), `window.__widgets` (`widget-debug.ts`) |
| `apps/headset/widgets-preview.html`         | the desktop preview                                                                                   |

## The catalogue

| Kind        | For                                               | When the coach uses it                        | The learner can            | Scope                               | Ends by itself                                              |
| ----------- | ------------------------------------------------- | --------------------------------------------- | -------------------------- | ----------------------------------- | ----------------------------------------------------------- |
| `timer`     | a wait or a timed hold                            | "let it sit 2 minutes", "hold for 30 seconds" | nothing                    | lesson (and outlives it)            | at 0:00: shows done for 10 s, and the voice is told         |
| `progress`  | a count or amount toward a target within a step   | "3 of 4 screws", "120 of 250 mL poured"       | nothing                    | step                                | 4 s after reaching the target, or when the step changes     |
| `checklist` | 2 to 5 things to gather or check within a step    | "Gather: funnel, rag, washer fluid"           | tick or untick an item     | step                                | 4 s after all are ticked, or when the step changes          |
| `choices`   | 2 or 3 answers to a question the voice just asked | "Which screwdriver do you have?"              | touch an answer, or say it | step                                | 1.5 s after an answer, after 90 s, or when the step changes |
| `value`     | one number or setting to keep in view             | "Torque 25 N m", a reading from `look_closer` | nothing                    | step, or lesson with `whole_lesson` | when its scope ends                                         |
| `caution`   | a hazard that lasts, after it was said out loud   | "The pan stays hot for 10 minutes"            | nothing                    | lesson                              | when the lesson ends                                        |

Not in the catalogue: a step list (the card owns steps), free text (captions own it), arrows
(highlights and ghost hands own them), images, and count-up or paused timers (see [Later](#later)).

## The tools

Each kind has one show tool, which **upserts**: calling it again updates the widget on screen
rather than adding another, so a repeat after a barge-in or after the context was compressed never
doubles one up. A repeat still counts as a call: a timer's restarts it and a question's reopens it,
which is why the coach is told when a cancelled call was applied. A widget is named by
its kind (`timer-2` for a second timer); that name is the `widget_id` results give and
`clear_widget` takes, so the voice has nothing to remember. No widget tool is non-blocking, and
every handler answers synchronously.

| Tool                                        | Arguments (hard limits)                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `show_timer(seconds, label, object_id?)`    | `seconds` whole, 5 to 3600; `label` 1 to 16 characters; `object_id` an id from the plan                       |
| `show_progress(label, value, total, unit?)` | `label` 1 to 18; `value` 0 to 9999; `total` above 0, at most 9999; `unit` 1 to 8 characters, for amounts only |
| `show_checklist(title, items, done?)`       | `title` 1 to 11; 2 to 5 `items` of 1 to 24; `done` up to 5 entries naming items                               |
| `show_choices(question, options)`           | `question` 3 to 52; 2 or 3 `options` of 1 to 14                                                               |
| `show_value(label, value, whole_lesson?)`   | `label` 1 to 18; `value` 1 to 16 characters, the number with its unit                                         |
| `show_caution(text)`                        | `text` 3 to 60, one short sentence                                                                            |
| `clear_widget(widget_id)`                   | 1 to 60, so a caution can be named whole: an id, a kind, a label, or `all`                                    |

Each text limit (`WIDGET_TEXT_MAX`) is as much realistic English as its card draws whole (see
[Long text](#long-text)). Past it the call fails and the coach writes it shorter, which beats a
question or a hazard cut to an ellipsis the learner never reads whole. The descriptions also ask
for words ("1 to 3 words", "up to 8 words"), which keeps most text well inside. `toGeminiTools`
keeps only types, descriptions, enums, items and required fields, so every description states its
limit in characters too. `value` is capped at 16 characters because a value is never cut off on
screen, and 3600 s keeps the clock at `m:ss` (`60:00`).

### Results

All results are snake_case, as for the other tools, and all carry `on_screen` (below).

```ts
type ShowTimerResult = {
  widget_id: string;
  ends_in: string;
  on_screen: string;
  restarted?: true;
  replaced?: string;
  note?: string;
};
type ShowProgressResult = {
  widget_id: 'progress';
  progress: string;
  done: boolean;
  on_screen: string;
  replaced?: string;
  note?: string;
};
type ShowChecklistResult = {
  widget_id: 'checklist';
  done: string;
  on_screen: string;
  unmatched?: string[];
  replaced?: string;
};
type ShowChoicesResult = { widget_id: 'choices'; on_screen: string; replaced?: string };
type ShowValueResult = { widget_id: 'value'; on_screen: string; replaced?: string };
type ShowCautionResult = { widget_id: 'caution'; on_screen: string; replaced?: string };
type ClearWidgetResult = { cleared: string[]; on_screen: string };
```

- `ends_in` is the duration as the clock shows it, e.g. `"2:00"`.
- `progress` is the count as shown, `"3 of 4"` or `"120 of 250 mL"`; `done` on a checklist result
  is `"1 of 3"`.
- `replaced` is the `on_screen` line of a widget that was closed to make room, e.g.
  `value "Torque" 25 N m`.

Other outcomes worth knowing:
- `show_timer` with an `object_id` not in the plan succeeds without the object, with
  `note: 'No object "cup_z" in the plan, so it shows without one. Objects: cup_a, cup_b.'`
  (`Objects: none.` outside a lesson).
- A progress `value` above `total` shows the total, with
  `note: 'value was more than total, so it shows 4 of 4.'` Both are kept to one decimal, as the
  count shows them, and done is judged on that: a total of 1.33 reads 1.3, and a value of 1.33
  finishes it rather than leaving `1.3 of 1.3` unfinished. The least total is 0.1.
- Checklist `done` entries that match no item are listed in `unmatched`.
- `show_timer` with the label of a timer on screen restarts that timer (`restarted: true`).

Errors come back as `{ ok: false, error }`, with this exact text:

| When                                                          | Error                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| a third timer with a new label while two are running          | `Two timers are running ("Glue sets", "Paint"). Clear one with clear_widget first.`                     |
| a fourth widget and nothing can make room                     | `Three widgets are on screen and none can go yet (<on_screen>). Clear one with clear_widget first.`     |
| duplicates once cleaned                                       | `The items must be different.` or `The options must be different.`                                      |
| a text field with nothing readable left once cleaned          | `<field> needs letters or numbers.` (`label`, `title`, `items`, `question`, `options`, `value`, `text`) |
| `clear_widget` matching nothing                               | `Nothing called "<x>" is on screen. On screen: <on_screen>.`                                            |
| a text past its limit (`WIDGET_TEXT_MAX`)                     | `Invalid arguments for <name>: ✖ Too big: expected string to have <=<max> characters`, then the field   |
| a widget call with no board (`?widgets=0`, stale declaration) | the toolbox's usual `<name> is not available on this headset.`                                          |

`clear_widget("all")` always succeeds, even with nothing showing (`cleared: []`). Otherwise the
first rule that matches wins: an exact id; a kind, which closes every widget of that kind; one
widget whose label, title, question or text is the same once case and punctuation are ignored.

## How the board runs them

`WidgetBoard` (`domain/widgets/board.ts`) is plain TypeScript on the coach's side of the perception
rule (`test/architecture.test.ts`): it reads plan ids, the focus and labels through `LessonView`,
never positions. Its state is a map of immutable records in insertion order. Every change replaces
the record, then the snapshot presenters read (so they compare by identity), then records a
`widget.updated` annotation, and only then emits the bus event the narrator words. Two changes are
not recorded: an unbound widget binding to a step, and a finished one starting to leave at a step
change, its close brought forward to the step-change grace (records keep no times). Handlers use
the clock's time; `tick` and the bus listeners use the event's `t`.

### Caps

| Limit            | Value                       |
| ---------------- | --------------------------- |
| Widgets in all   | 3                           |
| Timers           | 2 (`timer`, then `timer-2`) |
| Every other kind | 1, kept by the upsert       |

A widget that would be the fourth closes the one that can go and changed least recently, and the
result names it in `replaced`. A value, a progress, a checklist, a finished timer or an answered
question can go. A running timer, an open question and the caution never do, so with only those up
the call fails. A third timer closes a finished one, else fails.

### Lifecycle

| Trigger                                                                       | Effect                                                                                                                       | Close reason                      |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `step.entered` for step S                                                     | each step widget with no step binds to S; one of another step closes, or, if finished, leaves and closes 1.2 s later at most | `step`, or `done` after the grace |
| `step.entered` for the step a leaving widget belongs to                       | it stays: no longer leaving, with the close it had before the grace; recorded as an `update` by `app`                        | none                              |
| `plan.changed`                                                                | step widgets whose step left the plan close                                                                                  | `step`                            |
| `procedure.completed`, `procedure.aborted`, `plan.requested` (not a revision) | everything closes except running timers: nothing silently stops the learner's clock                                          | `lesson`                          |
| `tick(t)`: a running timer reaches its end                                    | done at its exact end time even on a late frame, closes 10 s later; the voice is told                                        | none                              |
| `tick(t)`: an unanswered question's 90 s are up                               | closes                                                                                                                       | `expired`                         |
| `tick(t)`: a finished widget's linger is over                                 | closes (timer 10 s, progress and checklist 4 s, answered question 1.5 s)                                                     | `done`                            |
| `tick(t)`: a step widget still unbound after 10 minutes                       | closes (a backstop outside lessons)                                                                                          | `stale`                           |
| a final learner transcript that answers the open question                     | chosen by voice, closes 1.5 s later; the voice is not told, it heard it                                                      | none                              |
| a touch on an answer                                                          | chosen by touch, closes 1.5 s later; the voice is told                                                                       | none                              |
| a touch on a checklist item                                                   | ticks or unticks it; all ticked is done (4 s), an untick makes it active again; the voice is told                            | none                              |
| a touch on a widget in the step-change grace                                  | ignored, like a touch on a stale id                                                                                          | none                              |
| a show call matching a widget in the step-change grace                        | binds it to the step now in focus, where it starts afresh, and the grace's close is gone                                     | none                              |
| `clear_widget`, or room made for another widget                               | closes                                                                                                                       | `coach`, `evicted`                |

**The step-change grace.** For the 1.2 s a finished step widget stays after its step loses focus,
it is on its way out, and its record says so (`leaving: true`, a new record and snapshot like any
change) so the dock can show it inert. A touch on it is ignored, so an untick can't make it active
again and carry it into the next step. A second step change meanwhile keeps the first one's close.
Two things keep it after all:
- **Its own step takes focus again** (focus went A to B to A): it is no longer leaving, takes
  touches again, and has the close it had before the grace, its own linger from when it finished.
  That is recorded as an `update` by `app`.
- **A show call updates it** (by the upsert rule, the one of its kind): that is the coach's update
  for the new step. It binds to the focused step and starts afresh there, as that step's widget: a
  checklist's items are unticked unless the call's `done` names them, and a checklist or count
  done by the call is done from the call, with a whole linger. A question is reopened by any show
  call anyway. The call's close replaces the grace's, so it closes when that step loses focus, or
  when its linger ends. The call's `update` annotation carries the new `stepId`. With no step in
  focus, the call leaves its step and what it carries as they were.

XR frames stop while the headset is off the face, so a timer that ended meanwhile finishes on the
first frame back, with its exact end time. The app ticks the board in the frame's decide step,
before the coach session, so a timer's narration goes out the same frame
([ARCHITECTURE.md §5.2](ARCHITECTURE.md#52-the-frame-pipeline-appclio-appts)).

**Text.** Every string the coach writes is cleaned before it shows (`domain/widgets/rules.ts`):
line breaks become spaces; `·`, `•`, `∙` and `⋅` become a space, `→` (and `⟶`, `➜`) "to" and `≈`
"about"; check marks, emoji, control characters and variation selectors go; a character the fonts
lack has a stand-in or what it decomposes to (below); spaces collapse; shouting
(`CUP A IS FULL`) becomes sentence case while a lone all-caps word (`PH`) stays; labels, titles,
items and options lose one trailing period. Matching ignores case and punctuation: a checklist
`done` entry can be the item's text, its position (`"2"`) or the only item it shares whole words
with.

A character the fonts lack keeps what it decomposes to that the fonts have (`ř` reads `r`, `ﬁ`
`fi`, `℃` `°C`), else it is dropped. Where that would change a number, a unit or a comparison, it
has a stand-in instead:

| Written                              | Shows                                         | Rather than                 |
| ------------------------------------ | --------------------------------------------- | --------------------------- |
| `⅓ cup`, `1⅓`, `1⁄4`, `1∕2`          | `1/3 cup`, `1 1/3`, `1/4`, `1/2`              | `13 cup`, `113`, `14`, `12` |
| `2⁵`, `10⁻³` (`m²` and `cm³` stay)   | `2^5`, `10^−3`                                | `25`, `10−3`                |
| `5 μL` (Greek mu)                    | `5 µL`                                        | `5 L`                       |
| `220Ω`, `10 kΩ`                      | `220 ohm`, `10 kohm`                          | `220`, `10 k`               |
| `5‰`, `5‱`                           | `5 per 1000`, `5 per 10000`                   | `5`                         |
| `≥ 5`, `≤ 5`, `≠ 5`, `∼5`            | `at least 5`, `at most 5`, `not 5`, `about 5` | `5`, `5`, `= 5`, `5`        |
| `⩾ 5`, `⩽ 5` (and `≧`, `≦`)          | `at least 5`, `at most 5`                     | `5`, `5`                    |
| `≱ 5`, `≯ 7`, `≉ 5` (struck through) | `not at least 5`, `not > 7`, `not about 5`    | `at least 5`, `> 7`, `5`    |
| `1‒2`, `1‐2`, `1∶2`                  | `1–2`, `1-2`, `1:2`                           | `12`                        |
| `20˚C`, `20⁰C`, `3′ 4″`              | `20°C`, `20°C`, `3' 4"`                       | `20 C`, `20^0C`, `3 4`      |

Greek letters other than μ and Ω, signs such as `√` and `∞`, and arrows other than `→`, `⟶` and
`➜` have no stand-in yet, so they are still dropped (`2π` reads `2`).

Cleaning can make a text longer than its limit (`a→b` is `a to b`, `ﬁ` two letters, `≥ 5` is
`at least 5`). Such a call fails with the contract's own error for a text too long (see [Results](#results)),
naming each field past its limit (`label`, `items[1]`), so the coach writes it shorter as it
would its own long text.

**The voice match** is conservative: a final transcript of at most 8 words, begun after the
question went up, that names exactly one option (by its words, or "the second one", "last") with
no negation before it. The reasons are in [coach-plan.md](coach-plan.md#widgets).

## What the coach hears

### Narrations

They go through the session's gate like any narration (held while either side talks, at most 6 s,
merged). They are not perception, so a Gemini coach hears them.

| Event                      | `kind`       | Text                                                                                                              | `reply` |
| -------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------- | ------- |
| a timer ran out            | `timer_done` | `[app] Timer "Glue sets" is up (2:00). Tell them in a few words, then carry on.`                                  | true    |
| an answer touched          | `choice`     | `[app] They touched "Phillips" for your question "Which screwdriver do you have?". Reply as if they had said it.` | true    |
| an answer said             | none         | not narrated: the voice heard it                                                                                  |         |
| an item ticked or unticked | `checklist`  | `[app] They ticked "funnel" on "Gather" (2 of 3).` or `[app] They unticked "funnel" on "Gather" (1 of 3).`        | false   |
| everything ticked          | `checklist`  | `[app] They ticked everything on "Gather". Acknowledge it in a few words and go on.`                              | true    |

**The stuck nudge waits for timers.** A two-minute wait is not being stuck, so the step runner's
stuck nudge (one per step) is held when it comes while a timer runs. Once no timer has run for
20 s (`STUCK_AFTER_WAIT_MS` in `narrator.ts`), it goes out once, in the same words with the time
they have now been on the step, if that step still has focus. A timer starting meanwhile restarts
the 20 s. Entering a step (the same one too, as that restarts the runner's count), the lesson
ending or aborting, or another starting drops it. The narrator asks the board's `waiting()` from
`CoachSession.tick`, so a timer the coach clears ends the wait as one that runs out does.

### The `on_screen` line

Every widget result carries it, and so do the reconnect recap (`[app] Reconnected. <recital> On
screen: ...`) and the notice for a cancelled widget call (`[app] Your show_timer call was already
applied. On screen: timer "Glue sets" 2:00 left.`), so calling it again doesn't restart a timer.
Widget tools are sticky when Gemini cancels them, as plan tools are. Lines are joined with `; ` in
snapshot order (oldest first), capped at 600 characters with `…`, and read `nothing` when nothing
shows. No banned symbol ever appears. A widget leaving after a step change is still on screen, so
the line names it until it closes.

| Widget            | Line                                                           |
| ----------------- | -------------------------------------------------------------- |
| timer, running    | `timer "Glue sets" 1:52 left`                                  |
| timer, done       | `timer-2 "Paint" done`                                         |
| progress          | `progress "Screws out" 3 of 4`, then ` done` once it is        |
| checklist         | `checklist "Gather" 1 of 3 done, left: rag, washer fluid`      |
| choices, open     | `choices "Which screwdriver do you have?" waiting`             |
| choices, answered | `choices "Which screwdriver do you have?" answered "Phillips"` |
| value             | `value "Torque" 25 N m`                                        |
| caution           | `caution "The pan stays hot for 10 minutes"`                   |

Clocks read `m:ss`, rounded up, so a running timer never reads `0:00`; counts are whole numbers or
one decimal (`domain/widgets/format.ts`, shared with the renderer).

The system instruction has no widget section and is not rebuilt when a widget changes, so the plan
stays its last section. Standing item 7, before the style paragraph, describes the tools and asks
the coach to keep at most two up, one fewer than the board's cap. The coach is never told whether
or where a widget is drawn: the dock always shows everything, so there is no failure to report.

With `?widgets=0` the app builds no board and no presenters, the session is given every tool but
the widgets', and item 7 is left out. That is the switch for comparing the voice's plan-tool
accuracy with and without widgets ([Checks](#device-and-voice-checks)).

## Where they appear

**Scale.** One design pixel is 1 mm at 0.65 m. 1 mm subtends 0.088 degrees, about 2.2 Quest 3
pixels at 25 pixels per degree. Sizes below are in mm; the theme stores metres. The smallest text
is 13 mm (the floor is 12).

### The dock

The dock is a column of cards beside the step card, in the world frame. It hangs off the real
card: `WidgetDockOptions.anchor` is a `DockAnchor` (`object`, `panelWidth`), which
`InstructionPanelPresenter` satisfies as is. The app passes the card presenter and registers the
dock right after it in `worldPresenters`, so the card has already moved and resized this frame.
Each frame the dock's `follow` group copies the card group's position and quaternion (both live in
`worldRoot`, so no matrix maths), and the `column` inside it sits at `dockOffset(side, yaw)`. The
card is anchored in the room (`panel-motion.ts`): it keeps its world pose through ordinary head
motion, makes one damped catch-up after 800 ms out of reading reach, and relocates at once when it
would cover an object. The dock does all of that with it. While the card's group is hidden (before
its first placement it sits at the origin), the dock hides too, and so it does during calibration.
Shown again, it is the column as it is now: a widget that closed meanwhile is simply gone, never
flashing back to fade out, and the others are already in their slots.
- The card is sized to its content: 0.20 to 0.38 m wide (`panelWidth`) with its Done button, and
  as narrow as 0.16 m for a message without it (a phase line), centred on its group's x = 0, its
  top edge `PANEL_TOP` (0.15 m) above the group's origin. It is placed `PANEL_DISTANCE` (0.65 m) in
  front of the eye with the head's orientation at that moment, so it leans back when it was placed
  while the learner looked down.
- The column is 180 mm wide, tangent to the 0.65 m cylinder around an eye straight in front of the
  card, facing that eye. It turns about the card's own up axis, so it leans as the card does.
- Its inner edge is a 2 degree gutter past the card's actual edge, which clears the Done button.
  Its centre turns `dockYaw(width)` off the card's centre line: 18.63 degrees beside a 0.20 m card
  (16.90 beside a 0.16 m message), 26.18 beside the widest; its outer edge reaches 26.5 to 34.1
  degrees beside a step card.
- Its top is level with the card's top edge, and it grows downward. Above the card would sit in the
  forward view at eye level and below it would cover the work; the side covers neither. It starts
  on the right, near the right hand, unless the head faces the left ([Choosing a
  side](#choosing-a-side)).

**A new width.** When a new step resizes the card, the column eases to its new offset: its turn
lerps toward `dockYaw(width)` by `min(1, dt / 200)` a frame and settles within 0.002 rad. It is
never left over a card that grew: the turn never drops below `dockYawFloor(width)`, the inner edge
on the card's edge, so a card that grows by more than the gutter pushes the column out and it eases
the rest. A resize that comes with a move of the card's group is the card relocating for its new
size, and the column takes the new offset at once.

The constants are in `adapters/render/widgets/placement.ts`:

| Constant              | Value                                               | Meaning                                                                                   |
| --------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `PANEL_TOP`           | 0.15 m                                              | the card's top edge above its group's origin (`instruction-panel.ts`)                     |
| `PANEL_DISTANCE`      | 0.65 m                                              | how far the card is placed from the eye (`panel-placement.ts`)                            |
| `DOCK.side`           | 1                                                   | the side the column starts on (right; -1 is left); a tie keeps the side it is on          |
| `DOCK.gutterDeg`      | 2 degrees                                           | gap to the card's edge                                                                    |
| `DOCK.budget`         | 0.30 m                                              | column height below the card's top edge before cards collapse to pills                    |
| `DOCK.gap`            | 8 mm                                                | between stacked widgets                                                                   |
| `dockYaw(width)`      | 18.63 to 26.18 degrees                              | card half-angle `atan(width / 2 / 0.65)` + gutter + column half-angle `atan(0.09 / 0.65)` |
| `dockYawFloor(width)` | 16.63 to 24.18 degrees                              | the same without the gutter: the least turn while easing                                  |
| `DOCK_ORDER`          | caution, timer, value, progress, checklist, choices | top to bottom                                                                             |

In `dock.ts`: `SWITCH_DWELL_MS` (300 ms), `MOVED_DISTANCE` and `MOVED_ANGLE` (3 cm and 4 degrees:
how far the card must go to be somewhere new, and how far a held column may glide back) and
`FACING_MARGIN` (4 degrees).

`dockOffset(side, yaw)` places the column's origin (its top centre) in the card group's frame (+z
toward the eye): `[side * 0.65 * sin(yaw), PANEL_TOP, 0.65 * (1 - cos(yaw))]`, turned
`-side * yaw` about +y. It writes into an offset it is given, so a frame allocates nothing.
`angularBounds(side, width)` gives the yaw spans of card and column from that eye, which the
placement test checks at every width from 0.16 to 0.38 m, on both sides.

**Keeping clear of objects.** Like the card, the column keeps 6 cm (`PANEL_MASK_GAP`) from every
known object at its own depth. Each frame the dock checks the column's actual box, 180 mm wide by
the stacked height of what it shows, its top at the column's origin, at its world pose, with
`isInstructionPanelClear` from `panel-placement.ts`: every followed mask, estimates without a mask
by their radius, nearby furniture, both eyes.
- Clear: it stays. That is one check a frame; the other side is checked only while this one is
  blocked.
- Blocked, with the mirrored place on the card's other side clear for 300 ms (`SWITCH_DWELL_MS`,
  so tracker jitter does not flap it): it fades out (`exitMs`, 160 ms, ease-in), moves, and fades
  in on that side (`enterMs`, 200 ms). It never sweeps across the card. Nothing in it can be touched
  until it has faded in, and its targets settle again after that (500 ms).
- Blocked on both sides: it stays where it is.
- A column nobody has seen yet (its first widget is still entering, or the dock was hidden) moves
  to the clear side at once.

No check runs while the column is empty, frozen under a finger, or moving unseen. The dock
allocates nothing per frame for this; `isInstructionPanelClear` builds its obstacle list each call,
as it does for the card. Measured in the preview on a Mac, a dock update takes about 0.025 ms with
a tracked object in view and 0.005 ms with none (0.005 to 0.010 ms in headless Chrome after the
side choice below, at its 5 microsecond timer resolution).

#### Choosing a side

The column also looks at where the learner looks, but only at three moments, because a column that
hops whenever the head turns is worse than one a little off to the side:
1. **Its first widget shows** (the column was empty or the dock hidden): it takes a side at once,
   unseen.
2. **The card relocates**: the card's pose jumps from rest by `MOVED_DISTANCE` (3 cm) or
   `MOVED_ANGLE` (4 degrees) in one frame. The column jumps with it, so it takes a side in that same
   frame, with no fade.
3. **The card settles somewhere new**: the first still frame (less than 0.1 mm and 0.1 mrad since
   the frame before, with time moving) once it is 3 cm or 4 degrees from where the column last
   chose. A catch-up that ends, and a relocation from mid-glide, count. If the side changes, the
   column fades out and in as for a blocked side. A card that goes somewhere new while the column
   is already moving unseen (changing sides, or fading back after a touch) is chosen for as the
   column arrives, so it fades once, not twice.

At those moments it checks both sides' boxes, then takes the clear one; of two clear ones, the one
whose middle is nearer the head's forward direction, by more than `FACING_MARGIN` (4 degrees),
else the side it is on; with neither clear, it stays. A card placed straight ahead leaves both sides
within the margin, so the column keeps its side. Between those moments it keeps its side unless it
is blocked: stability beats optimising. The per-frame cost is one distance and one angle between
the card's last two poses, and one more pair against where it last chose while the card is still;
the clearance and facing checks run only at the three moments.

**Stacking** (`layout.ts`, pure). Cards go in `DOCK_ORDER`, ties by creation (`timer` above
`timer-2`), so places are learnable. The lead (an open question, else the newest finish still
lingering, else the newest change) is always expanded; the others stay expanded while the column
fits the budget, then collapse to 34 mm pills, least recently changed first. An open question never
collapses, and nor does the caution: its text is the hazard, and a pill cut to "The pan stays ho…"
says none of it. Layout runs only when membership, the lead or a card's height changes, and cards
never move when one is added below them.

**Past the budget.** A column too tall even with every other card a pill runs on downward from
the card's top edge, as tall as it needs; nothing is cut or hidden. `widget-layout.test.ts`
measures the worst columns the board allows (three widgets) with the tallest cards the tools'
limits give (a question of four lines over three answers is 250 mm, a five-line caution 119 mm, a
checklist of five two-line items 300 mm):

| Column (top to bottom)                                        | Height |
| ------------------------------------------------------------- | ------ |
| two pills, a checklist of five one-line items                 | 294 mm |
| two pills, a four-line question with three answers            | 334 mm |
| two pills, a checklist of five two-line items                 | 384 mm |
| a five-line caution, a timer pill, the four-line question     | 419 mm |
| a five-line caution, a timer pill, five two-line items (lead) | 469 mm |

At 469 mm the column is about 36 degrees tall at 0.65 m: with the card resting at its usual height
its bottom is about 35 degrees below eye level, over the top of the work beside the card. That lasts
only while both stay: the question closes when answered (1.5 s later) or after 90 s, and the
checklist is the lead only until another widget changes, when it collapses. The column's
clearance check covers its whole height, so a tall column moves away from objects beside it like
any other.

**Freeze while touching.** The card holds still while a fingertip is near it, but the column is
touched beside the card, and the card still relocates when it would cover an object and catches up
when it is out of reading reach. So the dock holds still on its own: while an expanded touchable
widget shows and an index fingertip is inside the column's box (local x within 0.14 m, y from
0.05 m above the top to 0.05 m below the bottom, z from -0.05 to +0.12 m), the `follow` group stops
copying the card, and the column keeps its offset and its side. 400 ms after the last fingertip
leaves, it eases back (lerp and slerp `min(1, dt / 200)`) until within 1 mm and 0.002 rad, then
copies exactly again. If the card went far meanwhile (`MOVED_DISTANCE` or `MOVED_ANGLE`: 3 cm or 4
degrees), a glide back would sweep across the card or an object, so the column instead fades out
where it was held (160 ms), takes the card's pose and a side as in [Choosing a
side](#choosing-a-side), and fades in (200 ms), like a side switch; a card that jumps that far
during a glide back does the same. Nothing in it can be touched until it has faded in. If the card
moves while the column is held, a brief overlap during a touch is possible; the hand is usually in
front of both.

### Retuned for the restyled card

The step card was restyled (merged into `feat/coach-widgets` at `90606ea`): content-sized,
anchored in the room, kept clear of objects and drawn on top. The dock was fitted to it:
1. `CARD` (a fixed 0.44 x 0.17 m card 0.17 m below the eye) is gone. The dock reads the card's
   actual width every frame and its top from `PANEL_TOP`; `dockYaw` replaced the fixed
   `DOCK_YAW_DEG` (28.58 degrees).
2. A new width eases the column; a relocation is followed at once; the dock hides with the card.
3. The column keeps clear of objects like the card, and changes sides when it is blocked.
4. Widgets and chips draw on top like the card, and the fingertip occluder became a hole punch
   ([Rendering notes](#rendering-notes)).
5. The progress pill's mini bar went from 44 to 20 mm, so a two-word label fits beside its count.
6. The column takes the side the head faces when it first shows and when the card goes somewhere
   new, fades back to a card that went far under a finger, and never collapses the caution.
7. The timer's digits (24 mm) and a value's figure (22 mm) came down beside the card's 23 mm
   instruction; a long progress amount takes a row of its own; a finished checklist and a timer
   chip draw their text whole.

Still to do: the foveation and touch checks on the device ([Device and voice
checks](#device-and-voice-checks)). The visual rules stay on this page; `apps/headset/DESIGN.md`
has a short Coach widgets section that sums them up for the headset's designers and points here.

### Chips beside objects

A timer with an `object_id` also gets a small chip beside that object (`WidgetChipsPresenter`, in
the workspace frame), whenever the object's estimate exists, isn't lost and isn't held. The dock
shows the timer too, so the chip needs no fallback.

| Property    | Rule                                                                                                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Size        | 30 mm tall, as wide as its content: the label draws whole up to the tool's 16 characters ("Woodscrews dried", 117 mm), so a chip is at most about 207 mm wide; only runs like WWWW are cut                  |
| Anchor      | the object's position + 10 mm up + `max(radius, 0.03) + 0.03` m to the learner's right, perpendicular to the line from the eye; the glow and markers put names above the object, so the chip sits beside it |
| Orientation | turns toward the eye, with world up (no roll)                                                                                                                                                               |
| Stacking    | two timers about one object stack downward, the older on top, one chip height and 8 mm apart at the chip's scale; the lower one moves up once the upper one has faded                                       |
| Scale       | `distance / 0.65`, clamped to 0.8 to 1.6                                                                                                                                                                    |
| Smoothing   | exponential, `1 - exp(-dt / 120)`                                                                                                                                                                           |
| Presence    | appears after 300 ms of a valid estimate and hides after 300 ms of an invalid one; fades in 200 ms, out 160 ms; hidden during calibration, and gone after it if its timer closed meanwhile                  |
| Layering    | on top, like the names over objects: never hidden by a hand or the glow; under the step card and the dock, so the card covers a chip it meets                                                               |

### Touch

Fingertips (`index-finger-tip`, workspace frame) are brought into the column's frame. The targets
are the checklist rows and the answer pills of expanded widgets, grown by 4 mm (`touch.ts`):

| `TOUCH`      | Value  | Meaning                                                                  |
| ------------ | ------ | ------------------------------------------------------------------------ |
| `nearZ`      | 60 mm  | hover: within this in front, inside a target                             |
| `armZ`       | 20 mm  | armed: at least this in front, inside a target                           |
| `pressZ`     | 8 mm   | pressed: armed, then between `behindZ` and this, same target; fires once |
| `behindZ`    | -30 mm | deepest a press counts                                                   |
| `inflate`    | 4 mm   | targets grow by this                                                     |
| `cooldownMs` | 600    | per widget                                                               |
| `settleMs`   | 500    | a target is inert this long after it appears or moves                    |

A fingertip arriving from behind or the side never fires; it re-arms above `armZ` or 10 mm outside
the target. Feedback is optimistic: the pressed style shows at once, and the dock calls
`onIntent({ type, widgetId, index, hand })`, which the app routes to `board.touch`.

A widget whose record says `leaving` (its step lost focus and it is closing, `domain/widgets/`)
has no targets: no hover, no pressed look and no intent, so a checklist circle never flips only to
flip back when the board ignores the touch. A hover it had when it started leaving goes, and it
never holds the column still.

The **hole punch** (`fingertip-occluder.ts`) keeps a white card from painting over the real finger
poking it. Widgets draw on top of everything, so a depth-only occluder can no longer hide them;
instead two capsules per hand (index intermediate to distal, distal to tip, radius 9 mm) draw after
the widgets and the card and write transparent black, which in immersive-ar shows passthrough: the
real finger. Only the part of the finger in front of the column's plane punches (behind it the
widget is nearer). A hand's capsules show while its fingertip is within 0.15 m of a target and no
deeper behind the column than a press counts (`behindZ`), so the finger stays visible through a
press that pushes through the card.

## How they look

Small Clio cards: white surfaces, ink type, navy hairlines, sunken tracks and a soft shadow, with
signal colour only for state. Every value is in `adapters/render/widgets/theme.ts`; if this page
and the theme disagree, the theme wins. Views read only `WIDGET_THEME`, and a night variant would
change one line (`export const WIDGET_THEME = NIGHT;`).

### Tokens

| Token            | Value            | Used for                                                     |
| ---------------- | ---------------- | ------------------------------------------------------------ |
| `ink`            | `#0F1117`        | type, arcs, filled segments, ticked circles, pressed answers |
| `inkMuted`       | `#5B6472`        | eyebrow labels, ticked rows                                  |
| `inkFaint`       | `#8A94A4`        | an unticked circle's ring                                    |
| `onInk`          | `#FFFFFF`        | text on ink                                                  |
| `surface`        | `#FFFFFF`        | cards, pills, chips                                          |
| `sunken`         | `#F1F3F7`        | tracks, empty segments                                       |
| `sunkenSoft`     | `#F4F6FA`        | hover tiles and fills                                        |
| `citrus`         | `#FF7B3D`        | a running timer's end-dot, the caution                       |
| `citrusText`     | `#B94A00`        | reserved                                                     |
| `mint`           | `#6FD3A0`        | done dots                                                    |
| `mintStrong`     | `#2AC48A`        | done rings, fills and checks                                 |
| `mintText`       | `#007D4D`        | "Done", "Time's up"                                          |
| `shadow`         | `#0F1117`        | shadow colour                                                |
| `hairline`       | `#0E2A52` at 10% | inner dividers, empty segments                               |
| `hairlineStrong` | `#0E2A52` at 16% | the outer ring of cards, pills and answers                   |

| Shadow | Layers (mm, y down; sigma = blur / 2)                          |
| ------ | -------------------------------------------------------------- |
| `card` | y 2, blur 3, alpha 0.08; y 18, blur 20, spread -4, alpha 0.075 |
| `xs`   | y 1, blur 2, alpha 0.06                                        |

| Size         | mm  |     | Size         | mm  |
| ------------ | --- | --- | ------------ | --- |
| `dockWidth`  | 180 |     | `pillHeight` | 34  |
| `padX`       | 16  |     | `hairline`   | 1   |
| `padY`       | 14  |     | `ring`       | 1.5 |
| `cardRadius` | 18  |     | `dot`        | 6   |
| `tileRadius` | 8   |     | `gap`        | 8   |
| `floor`      | 12  |     | `chipHeight` | 30  |

`surfaceLevel` (1 by default) multiplies the surface and sunken fills on the device: the glare knob.

Rules:
- `ar-blue` and `ar-deep` are deliberately absent: blue means AR guidance, and widgets are
  information.
- Signal colours appear only on dots, rings, strokes and small state text, never on a fill larger
  than a progress segment.
- Citrus appears only on a running timer's end-dot and on the caution. Mint appears only in done
  states, which are transient.

### Type roles

At 0.65 m, 13 mm type has a 9.5 mm cap height: 0.83 degrees, about 21 pixels. The step card's
23 mm bold instruction is the one loud thing in view (design principle 1), so nothing beside it
outweighs it: a timer's digits are 24 mm in a lighter weight (600) and a value's figure 22 mm.

| Role        | Face            | Size (mm)            | Line height | Tracking              | Colour           | Used for                            |
| ----------- | --------------- | -------------------- | ----------- | --------------------- | ---------------- | ----------------------------------- |
| `display`   | Inter Tight 600 | 24                   | 1.0         | fixed digit cells     | ink              | timer digits                        |
| `figure`    | Inter Tight 600 | 22, then 20, then 18 | 1.1         | -0.02 em              | ink              | a value                             |
| `state`     | Inter Tight 600 | 20                   | 1.1         | -0.01 em              | mintText         | "Time's up"                         |
| `title`     | Inter Tight 600 | 16                   | 1.25        | -0.01 em              | ink              | checklist title, question           |
| `pillValue` | Inter Tight 600 | 16                   | 1.0         | digit cells for times | ink              | values in pills and chips           |
| `strong`    | Inter 500       | 14                   | 1.3         | -0.005 em             | ink              | answers, caution text, pill labels  |
| `body`      | Inter 400       | 14                   | 1.35        | -0.005 em             | ink              | checklist items                     |
| `status`    | Inter 600       | 14                   | 1.3         | 0                     | ink, or mintText | counts ("3 of 4"), "Done"           |
| `label`     | Inter 500       | 13                   | 1.3         | 0                     | inkMuted         | eyebrow labels, the checklist count |

Copy: sentence case everywhere ("Done", "Time's up"); no middle dot or bullet, parts are
separated by spacing and weight; no emoji. The fonts are the bundled `@fontsource` woffs (Inter 400,
500 and 600, Inter Tight 600), imported as `?url` like `text.ts` does; Inter Tight 700 stays
installed but unused.

### Cards

Every dock card is 180 mm wide, with content from x 16 to 164: a `surface` card of radius 18, a
1 mm inset `hairlineStrong` ring (the caution has a 2 mm `citrus` ring instead, a full ring and
never a left border), `shadow.card`, 1 mm `hairline` dividers, and no coloured containers or cards
inside cards. A collapsed widget is a 180 by 34 mm pill (radius 17, `hairlineStrong` ring,
`shadow.xs`); a chip is the pill style at 30 mm tall, as wide as its content (about 207 mm at
most).

| Kind      | Card                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Done, chosen and touch states                                                                                                                                                                                                | Pill                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| timer     | 180 x 74 (91 with a two-line label). A 40 mm ring (stroke 4, `sunken` track) at (36, middle); an `ink` arc for the time left, clockwise from 12 o'clock, with a 7 mm `citrus` end-dot riding its end. At x 72: the label (2 lines), then the digits in `display`, without a leading zero ("4:12")                                                                                                                                                                                                                                                | the arc fills to a full `mintStrong` ring (300 ms), the end-dot fades, a 16 mm `mintStrong` check draws on, the digits cross-fade to "Time's up"; one pulse; no blinking in the last seconds                                 | 22 mm ring, digits at x 36, then the label; done reads "Done" in `mintText`. The chip has an 18 mm ring and 14 mm digits                                              |
| progress  | 180 x 62: the label left, the count right in `status`, a bar at y 40 to 48. A count too wide to leave the label its row: the label alone, then the count right beside a bar at least 40 mm long (`MIN_BAR`). Wider still: the count on a row of its own, left under the label, over a full-width bar (180 x 83; 102 when the count is wider than the row and breaks before its unit). Segments (3 mm gaps, `ink` filled, `sunken` empty) when the total is a whole number up to 12 with no unit, else a continuous `ink` fill at least 8 mm wide | fill and segments turn `mintStrong`; the count becomes a `mint` dot and "Done", where the count was; the fill tweens over 300 ms                                                                                             | a 20 x 6 mini bar, the count, then the label. A count too long for its place after the bar starts at the pad without the bar; the label shows only with 30 mm of room |
| checklist | 180 x (40 + rows + 10). The title in `title` and "1 of 3" in `label`; rows 32 mm (50 for two lines) with an 18 mm circle and the item in `body` at x 44, `hairline` dividers between rows                                                                                                                                                                                                                                                                                                                                                        | ticked: an `ink` disc with a white check, the text `inkMuted`; hover: the ring turns `ink` on a `sunkenSoft` tile; all done: "Done" in `mintText` (`status`) in place of the count, with no dot, so the title keeps its room | the title, then the count, or "Done"                                                                                                                                  |
| choices   | 180 x (14 + question + 12 + answers + 14), never collapsed while open. The question in `title` (4 lines), then stacked 148 x 38 answer pills 8 mm apart; two columns of 70 only for exactly two answers that both fit 42 mm; 250 mm at most                                                                                                                                                                                                                                                                                                      | rest: `surface` with a `hairlineStrong` ring; hover: 1.5 mm `ink` ring on `sunkenSoft`; pressed and chosen: `ink` with `onInk` text and a white check, the others fade to 40%                                                | once answered: the question, then the answer                                                                                                                          |
| value     | 180 x 74 at one line. The label in `label`, then the value in `figure` at 22 mm, stepping to 20 and 18 and then two lines at 18 (89 mm); a value is never cut off                                                                                                                                                                                                                                                                                                                                                                                | a change cross-fades over 160 ms with one pulse; no signal colour                                                                                                                                                            | the label, then the value (never cut)                                                                                                                                 |
| caution   | 180 x (14 + max(20, lines x 18.2) + 14), 119 mm at five lines. A 20 mm `citrus` disc with a white "!" at the left, the text in `strong` at x 46 (5 lines)                                                                                                                                                                                                                                                                                                                                                                                        | static                                                                                                                                                                                                                       | none: it never collapses (a pill would cut its text)                                                                                                                  |

A progress card and its pill each take their form from the widest the count gets (any count up to
the total, or "Done"), so a bar, a row or a label never comes or goes as it counts: "3 of 1000
grams" is laid out as "1000 of 1000 grams" will be.

### Motion

All motion is a function of `t` minus a timestamp (`motion.ts`); nothing loops or blinks, and text
changes only by cross-fade.

| Event                    | Motion                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| enter                    | opacity 0 to 1 and a 6 mm rise over 200 ms (easeOutCubic), once every text is laid out or after 300 ms, so a blank card never flashes |
| exit                     | opacity to 0 and scale to 0.98 over 160 ms (easeInCubic), then disposed                                                               |
| reflow (a slot moves)    | 200 ms, easeInOutCubic                                                                                                                |
| collapse or expand       | 160 ms cross-fade between card and pill                                                                                               |
| a coach update, and done | one pulse: scale 1 to 1.03 to 1 over 280 ms                                                                                           |
| fills, arc colour        | 300 ms, easeOutCubic                                                                                                                  |
| hover, press             | 100 ms, 80 ms                                                                                                                         |

### Long text

Wrapping is ours, not troika's: lines are broken in TypeScript against generated font metrics,
checked against 97% of the box to leave room for kerning, joined with `\n`, and troika gets
`maxWidth: Infinity`, so its lines equal ours and heights are exact on the first frame.

| Field           | Drawn in                                                        | Drawn             | Limit |
| --------------- | --------------------------------------------------------------- | ----------------- | ----- |
| timer label     | `label`, 92 mm                                                  | 2 lines, then `…` | 16    |
| progress label  | `label`, beside the count, else a 148 mm row of its own         | 1 line, then `…`  | 18    |
| value label     | `label`, 148 mm                                                 | 1 line, then `…`  | 18    |
| checklist title | `title`, beside its widest count or "Done", 8 mm between (~104) | 1 line, then `…`  | 11    |
| checklist items | `body`, 120 mm                                                  | 2 lines, then `…` | 24    |
| the question    | `title`, 148 mm                                                 | 4 lines, then `…` | 52    |
| answers         | `strong`, 120 mm; chosen, centred together with the check       | 1 line, then `…`  | 14    |
| caution         | `strong`, 118 mm                                                | 5 lines, then `…` | 60    |
| value           | `figure` at 22, 20 or 18 mm, then wrapped at 18                 | never cut         | 16    |
| chip label      | `label`, up to 122 mm (the chip grows with it)                  | 1 line, then `…`  | 16    |

Each limit is as much realistic English as its box holds: `widget-layout.test.ts` lays out the
widest and worst-wrapping texts found at each limit (capitals, w and m, and long words that leave a
line short) and checks every word is drawn. Greedy wrapping loses most of a line before a long
word, so a limit sits well below lines times characters per line: "Do the measurements match the
drawing now?" (42 characters) takes four lines of the question's 148 mm, and "Hydrogen peroxide
bleaches clothes, so wear an old shirt now" (60) five of the caution's 118. One line has no slack,
so W and m set its limit: "Wood screws removed" (19) is 143.9 mm, past 97% of a label's 148 mm
row, and "Woodscrews removed" (18) is 140.4. Measured on the bundled fonts with each role's
tracking, real text runs about 0.47 em per character: "Washer fluid bottle" is 124 mm in Inter 400
at 14 mm, and "Which screwdriver do you have?" 230 mm in Inter Tight 600 at 16 mm, two lines in a
148 mm box.

The ellipsis stays a backstop for glyph runs no lesson writes (WWWW), and where one line is all
there is: pills. A finished checklist's "Done" is no wider than its widest count, so its title
keeps one room throughout; the dot of the progress card's done mark would make the mark 47.5 mm
and leave the title 92.5 mm, cutting the widest 11-character titles ("Woodworking", 99.9 mm), so a
checklist shows the word alone. A timer chip grows with its label. A word wider than its line,
such as "Waterproofing" in the timer's 92 mm, breaks between characters.

## Rendering notes

- **One quad per element** (`ui-quad.ts`). Each shape is one mesh on a shared unit plane with one
  `ShaderMaterial` (all share one compiled program), sized to the shape plus its shadow margin.
  Sizes and radii are clamped at zero, so a layout that came out negative can never hand the
  shader an inside-out shape. Five modes: a rounded box with its shadows, a ring arc with its
  end-dot, a check, segments, and the caution's "!". Edges use `fwidth`, so 1 mm lines (about 2.2
  pixels) stay crisp. Per frame only uniforms change (a running arc's sweep and end-dot, tween
  values); geometry is never created after a view is built.
- **Colour in sRGB.** Uniforms carry token values as sRGB, premultiplied, and shapes composite in
  sRGB as CSS does: no `colorspace_fragment`, `toneMapped: false`. The framebuffer holds
  sRGB-encoded values, so the output is the token's hex, and shadows match the site's CSS. Troika
  text goes through three's colour management and comes out exact too. The preview's pixel probe
  checks card white is `#FFFFFF` and ink `#0F1117`, within 1.
- **On top, like the card.** Widgets are panels beside the step card, so they draw the way it does
  (`on-top.ts`): transparent, premultiplied, normal blending, no depth test or write, in the
  transparent pass after everything else, so a raised hand or the glow never hides them. Quads and
  text get those materials where they are made (`ui-quad.ts`, `text-port.ts`; troika's derived
  material inherits them from its base).
- **Group order.** three's `projectObject` takes each Group's `renderOrder` as the group order of
  what is under it and resets it at every Group (a plain Object3D passes it on), and the pass is
  sorted by group order first. So every Group under the dock and the chips, including the view,
  pivot, face and tabular-clock groups built when a widget first shows, is made by `onTopGroup()`
  (`layering.ts`) with `ON_TOP_ORDER` (50), the card's. `Face.setOrders` sets only meshes and
  text, never a group.
- **Render order** inside that group order: the step card 0 to 4, the dock 40 to 42 (card quad,
  inner quads, text, plus 0.01 per slot so a lower card draws over an upper one's shadow), chips
  -12 to -10, so the card covers a chip it meets and the dock draws after the card.
- **Hole punch** (`fingertip-occluder.ts`). Its group order is `ON_TOP_ORDER + 1`, after the
  widgets and the card. Its capsules write (0, 0, 0, 0) with `NoBlending` and no depth test, and
  discard what lies behind the column's plane (a world-space plane uniform, set each frame it
  shows). In immersive-ar a framebuffer alpha of 0 shows passthrough, so the real finger appears
  through the white card; in the desktop preview the hole shows the page behind the canvas.
- **Glyph coverage.** Widget text is cleaned to `FONT_COVERAGE` (`domain/widgets/types.ts`), the
  code points all four faces have: U+0020 to 007E, U+00A0 to 00AC, U+00AE to 00FF, U+0131,
  U+0152 to 0153, U+2013 to 2014, U+2018 to 201A, U+201C to 201E, U+2026, U+20AC, U+2122 and
  U+2212. troika fetches any missing glyph from a CDN, which the headset must never do; arrows
  (U+2192) are missing, `…` is there.
- **Font metrics** (`font-metrics.ts`) are generated from the four bundled woffs by
  `apps/headset/scripts/font-metrics.py`: run
  `uv run --with fonttools --with brotli python -I apps/headset/scripts/font-metrics.py` after a
  font update. Pinned values the text test checks: Inter Tight 600 `0` 0.630 em, `1` 0.385 em,
  colon 0.282 em; Inter 400's widest digit `4` 0.646 em.
- **Tabular digits.** Inter's digits are proportional and troika 0.52.5 applies no `tnum`, so a
  timer's digits sit in fixed cells (`tabular.ts`): each cell is the face's widest digit (15.1 mm
  for `display` at 24 mm), the colon its own advance, each slot a one-character text centred in
  its cell. A timer recomputes its string only when the whole seconds change, and re-sets only the
  slots that changed. `60:00` is 67 mm wide, so the digits always fit the 92 mm column.
- **Text port** (`text-port.ts`). Views make text through a `TextFactory`: `troikaText` in the app,
  `fakeText` (ready at once) in tests. Views are built lazily, so constructing the presenters makes
  only empty groups.
- **Budget on Quest 3.** About 9 draw calls for a timer card, 17 for a checklist of five, 9 for
  three answers, 3 to 8 per pill, 8 per chip and 2 for the hole punch while it shows; at most 60
  for the dock and chips together, measured in the preview (`renderer.info.render.calls`). If that
  is exceeded, troika's `BatchedText` is the lever. CPU per frame is a pose copy, two distances and
  two angles for the card's stillness, one identity comparison of the snapshot, one clearance check
  (two while the column is blocked, and two plus two facing angles at a side choice), uniform
  writes and a few one-character text syncs per second: under 0.3 ms.

## Debugging and the preview

### On the headset

| Parameter                 | Effect                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `?widgets=0`              | no board, no dock or chips, no widget tools, no prompt item 7                                           |
| `?widgetDemo=all`         | shows sample widgets once the workspace has settled (with or without a coach, e.g. with `?coach=off`)   |
| `?widgetDemo=timer,value` | the kinds listed, in that order; unknown kinds are dropped                                              |
| `?foveation=0..1`         | fixed foveation for the session (0 none, 1 full; three's default is 1); anything else keeps the default |
| `?debug=1`                | also installs `window.__widgets`                                                                        |

`window.__widgets` (`app/widget-debug.ts`) is installed with `?debug=1` or `?widgetDemo=`, while
widgets are on. Its calls validate their arguments exactly as the coach's tools do and go straight
to the board, past `CoachToolbox`, so nothing is recorded as a `coach.tool_call` the coach never
made; the board records them with `by: 'debug'`. The coach still hears what they cause (a timer
running out, a touch).

```js
__widgets.show('timer'); // SAMPLE_ARGS: 120 s, "Glue sets"
__widgets.show('value', { label: 'Torque', value: '25 N m', whole_lesson: true });
__widgets.touch('choices', 1); // a learner's touch, right hand by default
__widgets.touch('checklist', 0, 'left');
__widgets.list(); // what is on screen, oldest first
__widgets.clear('timer'); // an id, a kind, a label; 'all' by default
__widgets.demo(['timer', 'checklist', 'value']); // every kind by default
```

The board's caps still apply: `demo()` with every kind ends with the three that cannot be replaced
(the timer, the question and the caution), so list the kinds you want to see together. A demo
step widget belongs to the first step that takes focus, and a lesson started from a goal closes
everything but the timer, as any new lesson does; run a demo without a goal or with `?procedure=`.

### Desktop preview

`apps/headset/widgets-preview.html` (logic in `apps/headset/src/widgets-preview/main.ts`, so it is
type-checked) renders the real `WidgetDockPresenter` and `WidgetChipsPresenter` from the eye at
(0, 1.6, 0) with a fixed head pose, in front of a passthrough stand-in 1.2 m away. The dock hangs
off the real `InstructionPanelPresenter`, fed a lesson snapshot, so the card is sized and placed by
its own code and the two are seen side by side as on the headset. The widgets are fed by fixtures
(`fixtures.ts`: every kind in every state, with progress amounts long enough to take a row of their
own and to break before their unit), or by a real `WidgetBoard` on a manual clock. Buttons
choose kinds, states, backgrounds, the step and the objects (live, without a reload, so the column
can be seen changing sides), and in live mode call each tool.

| Parameter                                                                   | Effect                                                                                                                                                                            |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `view=dock`, `grid` or `chip`                                               | the true pose beside the real step card; every fixture face-on at true size; timer chips beside an object at 0.5, 0.8 and 1.1 m (the middle one with a 16-character label)        |
| `card=short` or `long`                                                      | the dock view's step: "Now add vinegar to cup A." (the default), or a long step that wraps, with a detail                                                                         |
| `block=right`, `left` or `both`                                             | a tracked object (its mask and glow) behind where the column hangs on that side, clear of the card: with `right` the column moves left; with `both` it stays                      |
| `kinds=timer,choices`                                                       | only these kinds                                                                                                                                                                  |
| `state=running`, `done`, `hover`, `pressed`, `chosen`, `collapsed` or `all` | fixture state                                                                                                                                                                     |
| `t=<ms>`                                                                    | freezes the clock, for deterministic pixels; the dock view pre-rolls once the card's text is laid out                                                                             |
| `bg=photo`, `bright` or `dark`                                              | `/demo/caliper.jpg`; `#EEF0F2`, the worst case for white cards; `#1A1D22`                                                                                                         |
| `px=25`                                                                     | canvas and field of view set to 25 pixels per degree (40 degrees wide), upscaled 2x: what a Quest 3 shows; the dock view turns to show the whole column and what fits of the card |
| `orbit=1`                                                                   | the eye orbits 10 degrees each way, to check parallax and billboarding                                                                                                            |
| `touch=<widgetId>:<i>`, `near=<widgetId>:<i>`                               | a fake fingertip pressing or hovering; its hole punch shows the page behind the canvas                                                                                            |
| `live=1`                                                                    | a real board, with a button per tool; `speed=10` runs its clock faster                                                                                                            |

`window.__preview` has `ready` (a promise: fonts loaded, the step card and every widget text laid
out, two frames drawn), `set(widgets)` and `probe(x, y)`, which reads a pixel back as `[r, g, b]`.
A widget that `set` adds under `?t=` never fades in, as the clock does not move; leave `t` off to
watch one enter.
The **Measure** button stores `window.__cost = { updateMs, calls }`: the median of 200 `update()`
calls with three dock widgets beside the card, clearance check included, and the draw calls.

## What is recorded

Nothing new in `episode.ts`, so `pnpm gen:schema` shows no drift. Every widget call is a
`coach.tool_call` and `coach.tool_result` pair like any tool, and every board change is an
`annotation` with label `widget.updated` carrying the whole widget after the change, as
`plan.updated` does for the plan. A timer running out, as recorded:

```json
{
  "t": 183250,
  "type": "annotation",
  "label": "widget.updated",
  "data": {
    "op": "done",
    "id": "timer",
    "seq": 4,
    "kind": "timer",
    "by": "app",
    "stepId": "acid-to-a",
    "widget": {
      "id": "timer",
      "seq": 4,
      "kind": "timer",
      "status": "done",
      "scope": "lesson",
      "stepId": "acid-to-a",
      "label": "Colour develops",
      "durationMs": 120000,
      "remainingMs": 0,
      "objectId": "cup_a"
    }
  }
}
```

| Field                 | Meaning                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `op`                  | `show`, `update`, `done`, `choose`, `tick`, `untick` or `close`                                |
| `id`, `seq`, `kind`   | the widget's name, its instance number and its kind                                            |
| `by`                  | `coach`, `learner`, `app` or `debug`                                                           |
| `stepId`              | the step it belongs to, or null                                                                |
| `callId`              | the coach call behind it, when there is one                                                    |
| `reason`              | close only: `coach`, `step`, `lesson`, `done`, `expired`, `evicted` or `stale`                 |
| `item`, `hand`, `via` | choose, tick and untick only: the option or item index, the hand (a touch), `touch` or `voice` |
| `widget`              | the widget after the change (`RecordedWidget`), null after a close                             |

Reading them:
- `seq` is a board-wide instance number, never reused, so it tells instances apart (`timer` is a
  new timer after the old one closed). Folding the annotations by `seq` gives what the learner saw
  at any frame.
- The data has no absolute times, because the recorder rebases only the event's `t`. A timer
  records `remainingMs` as of the annotation's `t`.
- A choice said out loud is `op: "choose"` with `via: "voice"` and no hand, at the same `t` as the
  learner's `transcript` that answered it.
- A widget shown before the episode started (the demo, or a timer still running from the last
  lesson) appears from its next change. A step widget shown with no step in focus records
  `stepId: null`, and binding it to the next step is not recorded, so its step shows from its next
  change.
- Drop `by: "debug"` changes to keep only what the coach and the learner did.
- Narrations that reach the model are `coach.narration` events, as always.

The viewer's event log (`apps/headset/src/viewer/event-log.ts`) reads widget calls by their label,
question, title, `widget_id` or a caution's text ("show timer: Glue sets", "show caution: The pan
stays hot for 10 minutes"), and lists only what the learner did and a timer running out:
`Chose "Phillips"`, `Ticked "Funnel"`, `Unticked "Funnel"`, and `Timer: "Glue sets" is up`.

## Device and voice checks

These are manual, on a Quest 3, and recorded here when done.
1. **Foveation.** Open `?widgetDemo=timer,checklist,value&debug=1` with `?foveation=1`, `0.5` and
   `0`. Judge whether the 13 mm labels are soft at about 11 to 34 degrees off centre, the column's
   span beside a step card (its inner edge 10.7 degrees out beside the narrowest card, its outer
   edge 34.1 beside the widest). If they are, change the default in `config.ts`, or reduce
   `gutterDeg` or the dock width.
2. **Glare.** White cards over dim passthrough: tune `surfaceLevel` in the theme.
3. **Touch.** Reach at about 0.65 m: false presses, misses, and whether the freeze holds the dock
   still under a finger.
4. **Draw calls and frame time.** At most 60 calls, and no frame-time regression with three
   widgets, a chip and live glows.
5. **Voice bench.** About 20 scripted learner turns through the real instruction and
   declarations, three runs each, with `?widgets=1` and `?widgets=0`. The gate: plan-tool accuracy
   does not drop. If it does, cut `show_caution` first, then `show_progress`.

What the widget tools cost the voice, measured on the declarations (`toGeminiTools`, as JSON): the
seven tools add about 5.2 k characters (11.8 k for all 17 tools, 6.6 k without them), and item 7
adds 655 characters to the system instruction (3147 with it, 2492 without, before any plan).

## Later

- Plan-derived timers: a `wait` action or an `elapsed` check shows a timer for any coach, the
  scripted one included.
- Paused and count-up timers.
- An earcon when a timer ends.
- The `NIGHT` theme.
- `?dock=left`: the side the column starts on and a tie keeps (`DOCK.side`).
- A Rerun `events/widgets` track and derived widget intervals in `clio compile`.
- Widget states in the 3D replay viewer.
- Let `live-highlights.ts` hide a glow's name while a chip is beside the same object.
