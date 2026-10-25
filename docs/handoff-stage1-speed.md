# Handoff: make the first step arrive much faster

> For the next agent. The user: "it's taking far too long to come up with the first step, we need
> to speed it up a ton without losing quality." This page is where that work stands, what was
> measured, and what is left. Read [coach-plan.md](coach-plan.md) ("Who writes the first draft"),
> [robotics-er.md](robotics-er.md) and [planner-bench.md](planner-bench.md) first.

## Where things are

| Branch                             | State                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `feat/coach-plan-robotics-er2`     | Green (852 tests). Robotics-ER 2 everywhere, two-stage plans, step watcher, voice bridge |
| `er2/stage1-card`                  | The first stage writes a short "card" (WIP commit 46d2696, now in `feat/coach-plan`)     |
| integration (`int/*` streams)      | `feat/coach-plan` merged with `feat/tracking-and-viewer`, finished in parallel streams   |
| `worktree-agent-a97f24cb49b733494` | From `feat/coach-plan` at 82c5666: stage rest in parallel, the card reads the scene      |

The integration started from `a45a84e` and its coordinator merged the streams: s1 finished the
card on the server, s2 the headset's start path, s3 measured stage first's thinking (this page,
the timing script, the docs), a follow-up took stage rest's upgraded objects to the headset, and
another made the outline cover the whole goal, so stage first thinks at minimal again. Then the
planner's work was split into calls that run at once (Done, item 6).

## Where the time goes (measured)

The lesson starts on the planner's stage `first` (Robotics-ER 2, thinking minimal). Streamed, on the
two bench scenes, pH and fridge (`data/bench/scenarios`):

| Stage 1 answer                           | Thinking | Thinks for | First step starts | Done       | Output tokens |
| ---------------------------------------- | -------- | ---------- | ----------------- | ---------- | ------------- |
| as on `feat/coach-plan-robotics-er2`     | low      | 1.9-5.0 s  | 4.6-8.3 s         | 6.2-10.1 s | 1,140-1,410   |
| fewer fields, full objects and step      | low      | 1.6-3.8 s  | 3.7-6.7 s         | 5.1-8.1 s  | 950-1,300     |
| fewer fields, full objects and step      | minimal  | 0.9-1.5 s  | 2.3-4.5 s         | 3.3-6.4 s  | 600-1,350     |
| the card (`er2/stage1-card`)             | minimal  | 0.9-1.4 s  | 2.1-3.8 s         | 2.5-4.7 s  | 400-850       |
| the card's first version, recreated      | minimal  | 1.1-1.6 s  | 2.6-3.4 s         | 3.0-4.0 s  | 495-673       |
| the card's first version, recreated      | low      | 3.1-5.3 s  | 5.3-9.1 s         | 5.9-10.1 s | 589-1,289     |
| the card after s1, recreated             | minimal  | 1.1-1.5 s  | 2.7-3.9 s         | 3.2-4.5 s  | 505-897       |
| the card after s1, pH only, not streamed | low      |            |                   | 5.2-8.7 s  | 664-1,116     |
| **the card now, pH only, not streamed**  | minimal  |            |                   | 3.6-4.9 s  | 673-825       |

The first four rows are on the original scenes, the others on recreated ones (below), 3 runs a
scene; "thinks for" is the time to the first answer text, round trip included. At minimal the
card uses no thought tokens; at low it thinks for 490 to 1,020 of them. The last two rows are 7
calls each (4 alone, 3 in staged bench runs), timed whole; the last row's tokens are from the 4
alone. "Now" is after the whole-goal prompt rule (below), which adds about 90 words to the
prompt; it wasn't streamed again.

Two things cost about the same: the model's thinking (up to 1,020 thought tokens at low) and the
length of the answer (Robotics-ER writes about 250-300 tokens a second). The old first stage
spent most of its answer on full object specs (a quarter to a third) and a step written in full,
before the first step even started. The card now writes 3.2 to 4.5 s at minimal against 3.0 to
4.0 s for its first version: pH cards declared up to 4 objects with up to 5 outline lines, and
each object has a phrase.

## What the card is

`plan-schema.ts` (`kind === 'first'`), `plan-build.ts` (`buildFirstStageCandidate`, `cardObject`,
`cardStep`, `outlineStep`), `plan-prompt.ts` (`firstStageText`). The answer is:
- `done`, `todo` (added in item 6): what the views show done and what is left, read before the
  outline; they stay out of the plan;
- `title`, `summary`;
- `outline`: every step as `{ id, instruction }` only (no done-when, no targets), 1 to 10 lines;
- `objects`: only the first step's objects and look-alikes, at most 8, each `{ id, label,
  phrase, look, moves }`; the `phrase` is a 2 to 5 word name for the object detector;
- `sightings` (as before), `warnings` (hazards first, as before);
- `firstStep` as a card: `id, instruction, doneWhen, targets, action, show: [object ids],
  mistakes: [{ kind, message, object }]`.

Its JSON Schema keeps only `action` in `$defs` (4,505 characters, from 10,296). `plan-build.ts`
expands it into an ordinary `Procedure` (the shared contract and the Python JSON Schema are
unchanged): an object's `look` becomes `tracking.query` and the description of every outline
that shows it, its phrase the outline's phrase, kind `item`, placement `detect`, default radius; a
mistake becomes a `hand_near` rule on its object (dropped if that object isn't declared, or is
one the step itself uses); the step is confirmed by its done-when; the outline line with the
card's id (or, failing that, a first line that says the same) is dropped, and the other lines
become steps confirmed by their instruction. Stage `rest` then writes steps 2..n in full,
declares their objects and writes the card's objects again, which upgrades their kind, size,
description, placement hint and tracking (`mergeRevision`'s `upgrade`); their ids and labels stay.

What the card gives up, to check: step-specific outline descriptions (it uses each object's one
look), `coachNotes`, `detail`, `hand`, and success checks other than confirm (under a Gemini coach
they only ever see trusted positions anyway).

## The bench scenes on this laptop

The original pH and fridge scenes (and their judged runs) stayed on the laptop that captured
them. Two scenes with the same ids were recreated for this work: two headset-like views each
(first person, looking slightly down, 1024 px JPEG, 4:3), generated with `gemini-3-pro-image`, the
second view from the first so both show the same scene. They live in `data/bench/scenarios`
(gitignored) of the worktree that made them, `~/Desktop/Clio-int/s3-bench`.
- `ph-lesson-cup-a-already-pink-knife-on-the-table`, goal "Test an acid and a base with
  red-cabbage indicator": three white paper cups A, B, C (A pink, B and C purple), squeeze bottles
  INDICATOR, VINEGAR and BASE, a syringe, and a chef's knife left of cup A. Expectations: doesn't
  add anything to cup A again; base into cup B with cup C left purple as the control; tests the
  base too (added after s3, so the judge sees an outline that stops at the acid); never asks for
  the knife; the warnings name the knife, left of cup A.
- `fridge-yogurt-drink-beside-the-milk`, goal "Get a yogurt drink from the fridge": an open fridge,
  a white YOGURT DRINK bottle with a pink cap touching a slightly taller MILK bottle with a blue
  cap. Expectations: step 1 takes the yogurt drink, not the milk; says how to tell them apart; a
  mistake for the milk; doesn't ask to open the fridge; done-when states are looks, not actions.

The parallel-planning work (Done, item 6) ran in a worktree with a different set, made again with
`apps/server/scripts/bench-scene.ts` from the specs in `apps/server/scripts/bench-scenes/`
([planner-bench.md](planner-bench.md), "Synthetic scenes"), 5 expectations each:
- `fridge-yogurt-drink-beside-the-milk`, as above.
- `ph-photo-cup-a-pink-cups-b-and-c-purple`: the photo pH scene above (its base expectation now
  reads "a step adds the base to a cup of purple indicator", as a judge read "tests the base too,
  not only the acid" as testing the acid again).
- `ph-lesson-cup-a-already-pink-knife-on-the-table`, the main checkout's drawn scene with the same
  id: one view, cups A pink, B purple, C empty, labeled bottles, and "I already started this
  earlier".
- `tv-remote-one-old-battery-still-in-aaa-look`, goal "Replace the batteries in the TV remote":
  the cover off, one old black-and-gold battery still in, the other on the desk, two new blue
  batteries in a tray and a loose blue one meant to be a thinner AAA.

## Done

1. **The card on the server** (s1): the 4 failing server tests pass and the suite is green. Its
   bugs are fixed: the outline line matched by the card's id, mistakes on the step's own objects
   dropped, `show` deduped, a show item's phrase falling back to the label. It has the detector
   `phrase`, bounds on the outline and objects, and only `action` in `$defs`. Stage rest writes
   the card's objects again and upgrades them. The prompt has the user's parts guidance: `tool`
   or `container` only for the whole thing, otherwise `item`, and an attached component is its
   own object, described alone.
2. **The headset's start path** (s2): the runner starts and step 1 is briefed as soon as the plan
   arrives; the objects are located in the background, joining a find already in flight, with
   one look per object at a time; a synthesized demo that had no positions yet plays once the
   look has answered; a buffer keeps the last two planning frames (one every 450 ms, used when at
   most 1 s old) so capture is off the clock; stage rest captures after the lesson has started.
   Recorded as `lesson.first_step` (`frames`, `captureMs`, `planMs`, `totalMs`) and
   `lesson.first_locate` annotations ([coach-plan.md](coach-plan.md), "Recording").
3. **Stage first's thinking** (s3): measured at minimal and low on the card's first version,
   then again after s1, which put it back at low, and after the whole-goal rule (item 5), which
   put it at minimal again (below). `scripts/stage1-timing.ts` runs on any checkout: `cd
   apps/server && npx tsx --env-file-if-exists=../../.env scripts/stage1-timing.ts
   [scenario-id ...] [--thinking minimal] [--repeat 3]`.
4. **Upgraded objects on the headset** (the follow-up): stage rest's upgraded specs reach the
   headset's object registry under the same ids, so the glow mode follows the kind, the locate
   the new `tracking.query` and the grip the radius.
5. **The whole goal in the prompt**: the shared system instruction says to cover the whole goal,
   each part in the order it names them, unless the views show it done; to keep the control the
   setup implies (a spare sample stays untouched, the others are used in order); and that a part
   already done is not planned again, in the same place or a new one. Stage first's outline must
   reach the end of the goal, not only the part step 1 starts. The pH scene got its base
   expectation.

### Measured on the card after s1

Robotics-ER 2, stage rest at medium, judged by `gemini-pro-latest`, 3 runs a scene (6 for pH at
minimal, 3 of them unjudged). Ranges, with the median in brackets; "lesson starts" is the bench's
whole stage first call, not streamed:

| Scene, stage first            | Thinks for | Step 1 starts | Done      | Output tokens | Lesson starts     | Plan complete | Judged        |
| ----------------------------- | ---------- | ------------- | --------- | ------------- | ----------------- | ------------- | ------------- |
| fridge, minimal               | 1.1-1.3 s  | 2.7-2.8 s     | 3.2-3.4 s | 505-511       | 2.9-3.9 s (3.2 s) | 15.6 s        | 15/15, 3 of 3 |
| pH, minimal                   | 1.2-1.5 s  | 3.2-3.9 s     | 3.8-4.5 s | 664-897       | 3.8-5.6 s (4.6 s) | 25.2 s        | 8/12, 0 of 3  |
| pH, low                       |            |               |           |               | 5.2-8.6 s (6.5 s) | 24.4 s        | unjudged      |
| both, minimal                 |            |               |           |               | 3.8 s             | 20.1 s        | 23/27         |
| first version: fridge minimal | 1.1-1.5 s  | 2.6-3.1 s     | 3.2-3.6 s | 495-535       | 2.8-3.9 s (3.2 s) | 14.2 s        | 14/15, 2 of 3 |
| first version: pH minimal     | 1.3-1.6 s  | 2.7-3.4 s     | 3.0-4.0 s | 504-673       | 3.2-4.9 s (3.6 s) | 18.0 s        | 8/12, 0 of 3  |
| first version: both, low      |            |               |           |               | 6.2 s             | 21.0 s        | 24/27         |

Read from the cards themselves (13 at minimal, 7 at low, 8 of them asked alone):
- **Step 1 is right at both levels.** The fridge card took the yogurt drink with a mistake for
  the milk (3 of 3). No pH card added anything to cup A (17 of 17), and the first warning named
  the knife every time (17 of 17). Two minimal pH cards started by picking up the syringe and
  declared the knife with a "do not touch the knife" mistake.
- **But at minimal, 4 of 10 pH outlines only test the acid**: vinegar into cup B, then stir or
  observe, never the base. Stage rest kept them so. At low all 7 used the base, as did all 12 on
  the card's first version. The judge didn't see it, as no expectation asked for the base (the
  control-cup one fails either way). So `PLAN_THINKING.first` went back to `low`, 2 to 3 s
  later than at minimal, until the whole-goal rule (below).
- **The phrases are short nouns**: 2 to 4 words, never a position or a verb, mostly the label's
  word and a category noun ("vinegar bottle", "paper cup B", "strawberry yogurt drink"). A few
  spell the label out ("plastic bottle labeled VINEGAR") and one has a colour-like word ("clear
  plastic syringe").
- **Stage rest's upgrade works**: in 12 of 12 rest runs it wrote every card object again. Bottles
  and cups became `container`, the syringe and knife `tool`, with radii of 0.05 to 0.18 m (from
  0.03), and their query became a shorter look with the position moved into `placement.hint`
  (11 of 12). Before s1 they stayed `item` at 0.03 m with the card's look.
- **Stage rest is slower**: fridge 10.1-13.7 s (12.4 s) against 10.3 s before, pH 15.4-46.6 s
  (19.9 s) against 11.5-18.3 s (14.1 s) after stage first at minimal, and 15.8-20.4 s (17.0 s)
  against 16.9 s after low. Writing 2 to 4 objects again costs up to about 2 s. The two slowest (39 and 47 s) both
  followed the acid-only syringe cards, which left 4 new objects to declare, so at minimal the
  pH plan completes no sooner than at low.

### Measured after the whole-goal rule

Stage first at minimal and stage rest at medium, judged as above: `pnpm bench --staged
--thinking first=minimal --repeat 3` (18 calls), plus 4 stage-first pH calls alone. The pH scene is judged against 5
expectations now, so "on the 9" counts only the ones the rows above had:

| Scene, stage first | Lesson starts     | Stage rest           | Plan complete | Judged                     |
| ------------------ | ----------------- | -------------------- | ------------- | -------------------------- |
| fridge, minimal    | 2.9-3.3 s (3.2 s) | 10.7-17.5 s (13.6 s) | 16.5 s        | 15/15, 3 of 3              |
| pH, minimal        | 3.7-4.9 s (3.8 s) | 11.8-22.4 s (17.5 s) | 21.2 s        | 12/15, 0 of 3; base 3 of 3 |
| both, minimal      | 3.5 s             |                      | 18.7 s        | 27/30; 24/27 on the 9      |

Read from the cards (3 fridge, 7 pH):
- **Every pH outline tests the base** (7 of 7, against 6 of 10 before the rule), and stage rest
  kept it. All go vinegar into cup B, then base into cup C; two pick up each bottle first.
- **Step 1 is still right**: the yogurt drink with a milk mistake (3 of 3); nothing added to cup
  A and the knife first in the warnings (7 of 7).
- **The judged score is as good as low's**: 24/27 on the 9 expectations, as low scored on the
  first version (minimal before the rule: 23/27), and the new base expectation 3 of 3. The only
  pH miss is the control cup, every time. So `PLAN_THINKING.first` is `minimal` again: the
  lesson starts 3.5 s after the request (median), and no stage rest took over 23 s.
- **The control is still not kept**: every pH plan puts vinegar in cup B and the base in cup C.
  The model reads cup A's pink as setup ("indicator has already been added", "leave Cup A
  untouched as a reference"), not as the acid already tested, so it sees two cups for two tests
  and no spare. A further sentence ("a sample that already shows a result counts as used")
  changed nothing in 4 calls (one called cup A the control) and was dropped.
- **Looking steps are back in outlines**: 5 of 7 pH outlines have an "observe" or "compare the
  colors" step, which the system instruction says is not a step, and stage rest wrote them in full
  with a done-when like "the learner has observed all three cups". One pH plan had only 2 steps.

6. **Planner work in parallel** (this branch): stage rest is split into calls that run at once,
   and the card reads the scene before its outline ([coach-plan.md](coach-plan.md), "Who writes
   the first draft"):
   - `plan-rest.ts`: a review of the outline (thinking low) reads what is done and left and the
     control, fixes the lines and names the new objects; meanwhile the card's objects are written
     in full with the warnings; then every line is written in full at once (thinking minimal),
     each checked alone and retried once, a failed one kept as its outline line. Without a
     review, the single call. `planRest: 'single'` in the server deps, or `pnpm bench --rest
     single`, keeps the old way.
   - The card starts with `done` and `todo`; the outline does the todo parts only.
   - The bench counts calls and tokens a lesson, p90 times and the judge's other issues, prints
     each part's time and the review's reading, and `scripts/bench-scene.ts` makes scenes.

### Measured with the planner in parallel

Four scenes, 5 expectations each, judged by `gemini-pro-latest`; "start" is the whole stage
first call, "complete" adds stage rest; median / p90; directional (2 or 3 runs a scene):

| Four scenes                                           | Runs | Met   | Start         | Complete        | Calls, tokens a lesson              |
| ----------------------------------------------------- | ---- | ----- | ------------- | --------------- | ----------------------------------- |
| before: the card, rest in one call                    | 12   | 48/60 | 4.1 s / 5.3 s | 20.6 s / 29.5 s | 2; 9.7k in, 2.3k out, 2.3k thought  |
| the card, rest in parallel (medium review, low steps) | 8    | 34/40 | 4.1 s / 4.7 s | 21.5 s / 27.7 s | 5; 19.7k in, 2.3k out, 3.6k thought |
| reading card, parallel (low review, minimal steps)    | 12   | 53/60 | 4.1 s / 5.2 s | 14.5 s / 23.1 s | 5; 25k in, 2.8k out, 1.1k thought   |
| the same, review told to keep its reading (now)       | 8    | 37/40 | 3.9 s / 6.1 s | 13.1 s / 20.6 s | 5; 23k in, 2.7k out, 1.1k thought   |

By scene, before and now: fridge 15/15 and 10/10; photo pH 9/15 and 10/10; drawn pH 12/15 and
9/10; remote 12/15 and 8/10. Read from the plans and the judge:
- **The control cup is kept**: the photo pH plans put the base in cup B and leave cup C purple in
  8 of 9 runs with the reading card, against 0 of 3. The card's `done` says "the acid test: cup A
  is already pink", which it said when asked alone (2.2 s at minimal) but not when planning.
- **The knife is placed**: "left of cup A" in 7 of 9 photo pH plans, against 0 of 3, since the
  objects call places each hazard by the nearest object of the task.
- **No looking-only steps** in the parallel plans' later steps: the review drops "observe the
  color change" lines, which every pH plan before had.
- **The review at low first contradicted its own reading** (the acid test both done and to do,
  indicator into a cup already purple). Told that `todo` leaves out what is done and nothing gets
  what it already has, it met 19 of 20 on the two pH scenes at low, as at medium, in 13.1 s
  against 20.5 s.
- **Not fixed**: no model here sees the remote's loose battery as the thinner one (0 of 10;
  gemini-3.8-flash doesn't either); a remote card once read two old batteries in the remote; and
  steps that need a cap off or a bottle picked up first still go missing. The judge names 0.75
  other issues a plan now, against 1.0.
- **Hedging stage first** (two identical calls, the first answer wins) was estimated from 22
  single calls: 3.9 s / 4.4 s instead of 4.1 s / 5.1 s, for twice the stage-first tokens, and it
  takes the shorter card. Not kept.

## Left to do

1. **Real scenes**: the scenes here are generated. Capture them on bench.html (or copy the
   original folders) and run the bench again, `--rest single` beside the default.
2. **A critic after the merge**: the review fixes the outline, but the written steps are not
   read together again. The judge's issues left are cross-step ones (a bottle poured from before
   it is picked up or uncapped, the base poured into an empty cup before the indicator). A call
   that reads the merged plan and sends the steps it flags back to their writers would cost about
   5 to 8 s more; nobody waits for stage rest, but step 2 should still land before step 1 ends.
3. **Start stage rest on the server**: the headset asks for it after the lesson has started and
   it has captured new frames. The server could start it the moment stage first is saved, with
   the same frames, and the headset's request join it when its base is the same plan. The bench
   asks for stage rest at once, so it can't show the gain; time it on the Quest first (item 8).
4. **Look-alikes the planner can't see**: on the remote, every plan used the loose blue battery.
   Asking about look-alikes alone didn't help either. Try a real scene with a clear AAA, or a
   closer look (`look_closer`-style crop) at the candidates before the step that takes them.
5. **Cost**: each call sends the views again, so a lesson reads about 23k input tokens instead
   of 9.7k. Gemini's implicit cache already served 6.4k of 30k in the one lesson metered for it
   (the bench prints cached input in brackets). One view for the step writers, or explicit
   caching of the views and the system instruction across the parallel calls, would cut more.
6. **Drop `sightings` from stage 1** unless something uses them early (only the bench overlay
   does today): they are 18 to 22% of the card's characters at minimal (about 90 to 190 tokens,
   0.3 to 0.7 s).
7. **One camera view for stage 1** instead of two: ~1,000 fewer input tokens (small, maybe 0.2 s).
8. **On the Quest**: time `start_lesson` to the step-1 briefing with `lesson.first_step` and
   `lesson.first_locate`, and measure the 1024 px encode and what the planning-frame buffer costs
   (the synchronous `toDataURL` took about 17 ms at 640x480 there; the asynchronous encoders take
   about 4 s at any size).
9. **The live tracker on a Quest**: test `/track` following each step's objects on the headset.

## More ideas, roughly by gain

- **Stream stage 1 and start on the first step** as soon as `firstStep` closes: the card puts it
  last, so this gains little now; worth it only if the card grows again.
- **Reuse the card's phrase in stage rest's show items**: tracking restarts when an object's
  phrase changes from step to step.
- **Cache the planner's system instruction** (1,645 tokens): cuts cost, not time (measured).

## How to check quality quickly

```bash
pnpm bench --staged --repeat 3                          # judged, every scene, as the headset plans
pnpm bench --staged --rest single --repeat 3            # stage rest in one call, to compare
pnpm bench --staged --thinking first=low --repeat 3     # stage first at low, to compare
pnpm bench --checks --repeat 3                          # the milk watcher test still says "wrong"
pnpm check
```

The pH scene's base expectation catches an outline that drops half the goal, but only in this
worktree's copy of the scene: add it to any other copy, and read the pH plans' steps too (which
cup is the control?). Open the bench at http://localhost:5173/bench.html (`pnpm dev`), tick
"Plan in two stages", and watch the "step 1 ready in X s" line.
