# Handoff: make the first step arrive much faster

> For the next agent. The user: "it's taking far too long to come up with the first step, we need
> to speed it up a ton without losing quality." This page is where that work stands, what was
> measured, and what is left. Read [coach-plan.md](coach-plan.md) ("Who writes the first draft"),
> [robotics-er.md](robotics-er.md) and [planner-bench.md](planner-bench.md) first.

## Where things are

| Branch                         | State                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `feat/coach-plan-robotics-er2` | Green (852 tests). Robotics-ER 2 everywhere, two-stage plans, step watcher, voice bridge |
| `er2/stage1-card`              | The first stage writes a short "card" (WIP commit 46d2696, now in `feat/coach-plan`)     |
| integration (`int/*` streams)  | `feat/coach-plan` merged with `feat/tracking-and-viewer`, finished in parallel streams   |

The integration started from `a45a84e` and its coordinator merged the streams: s1 finished the
card on the server, s2 the headset's start path, s3 measured stage first's thinking (this page,
the timing script, the docs), and a follow-up took stage rest's upgraded objects to the headset.

## Where the time goes (measured)

The lesson starts on the planner's stage `first` (Robotics-ER 2, thinking low). Streamed, on the
two bench scenes, pH and fridge (`data/bench/scenarios`):

| Stage 1 answer                          | Thinking | Thinks for | First step starts | Done       | Output tokens |
| --------------------------------------- | -------- | ---------- | ----------------- | ---------- | ------------- |
| as on `feat/coach-plan-robotics-er2`    | low      | 1.9-5.0 s  | 4.6-8.3 s         | 6.2-10.1 s | 1,140-1,410   |
| fewer fields, full objects and step     | low      | 1.6-3.8 s  | 3.7-6.7 s         | 5.1-8.1 s  | 950-1,300     |
| fewer fields, full objects and step     | minimal  | 0.9-1.5 s  | 2.3-4.5 s         | 3.3-6.4 s  | 600-1,350     |
| the card (`er2/stage1-card`)            | minimal  | 0.9-1.4 s  | 2.1-3.8 s         | 2.5-4.7 s  | 400-850       |
| the card's first version, recreated     | minimal  | 1.1-1.6 s  | 2.6-3.4 s         | 3.0-4.0 s  | 495-673       |
| the card's first version, recreated     | low      | 3.1-5.3 s  | 5.3-9.1 s         | 5.9-10.1 s | 589-1,289     |
| the card now, recreated                 | minimal  | 1.1-1.5 s  | 2.7-3.9 s         | 3.2-4.5 s  | 505-897       |
| **the card now, pH only, not streamed** | low      |            |                   | 5.2-8.7 s  | 664-1,116     |

The first four rows are on the original scenes, the others on recreated ones (below), 3 runs a
scene; "thinks for" is the time to the first answer text, round trip included. At minimal the
card uses no thought tokens; at low it thinks for 490 to 1,020 of them. The last row is 7 calls
(4 alone, 3 in staged bench runs), timed whole.

Two things cost about the same: the model's thinking (up to 1,020 thought tokens at low) and the
length of the answer (Robotics-ER writes about 250-300 tokens a second). The old first stage
spent most of its answer on full object specs (a quarter to a third) and a step written in full,
before the first step even started. The card now writes 3.2 to 4.5 s at minimal against 3.0 to
4.0 s for its first version: pH cards declared up to 4 objects with up to 5 outline lines, and
each object has a phrase.

## What the card is

`plan-schema.ts` (`kind === 'first'`), `plan-build.ts` (`buildFirstStageCandidate`, `cardObject`,
`cardStep`, `outlineStep`), `plan-prompt.ts` (`firstStageText`). The answer is:
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
  add anything to cup A again; base into cup B with cup C left purple as the control; never asks
  for the knife; the warnings name the knife, left of cup A.
- `fridge-yogurt-drink-beside-the-milk`, goal "Get a yogurt drink from the fridge": an open fridge,
  a white YOGURT DRINK bottle with a pink cap touching a slightly taller MILK bottle with a blue
  cap. Expectations: step 1 takes the yogurt drink, not the milk; says how to tell them apart; a
  mistake for the milk; doesn't ask to open the fridge; done-when states are looks, not actions.

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
   then again on the card now, which put it back at low (below). `scripts/stage1-timing.ts` runs
   on any checkout: `cd apps/server && npx tsx --env-file-if-exists=../../.env
   scripts/stage1-timing.ts [scenario-id ...] [--thinking minimal] [--repeat 3]`.
4. **Upgraded objects on the headset** (the follow-up): stage rest's upgraded specs reach the
   headset's object registry under the same ids, so the glow mode follows the kind, the locate
   the new `tracking.query` and the grip the radius.

### Measured on the card now

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
  the card's first version. The judge doesn't see it, as no expectation asks for the base (the
  control-cup one fails either way). So `PLAN_THINKING.first` is `low` again: the lesson starts
  2 to 3 s later than at minimal, still before the 8.7 s median from before the card.
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

## Left to do

1. **Real scenes**: the two scenes here are generated. Capture them on bench.html (or copy the
   original folders) and run the bench again.
2. **The pH plan in the prompt**: when the scene is half done, the plan should finish the
   lesson's design from there (the acid is done in cup A, so the base goes in cup B and cup C
   stays purple), not redo the acid in a fresh cup. No level keeps cup C as the control. The
   outline must also reach the whole goal (the base too), and stage rest should drop or rewrite
   outline steps whose outcome is already in view (one outline redid cup A, before s1). Add a
   pH expectation for the base, so the judge sees it. With those fixed, minimal may be worth
   measuring again for the 2 to 3 s.
3. **Drop `sightings` from stage 1** unless something uses them early (only the bench overlay
   does today): they are 18 to 22% of the card's characters at minimal (about 90 to 190 tokens,
   0.3 to 0.7 s).
4. **One camera view for stage 1** instead of two: ~1,000 fewer input tokens (small, maybe 0.2 s).
5. **On the Quest**: time `start_lesson` to the step-1 briefing with `lesson.first_step` and
   `lesson.first_locate`, and measure the 1024 px encode and what the planning-frame buffer costs
   (the synchronous `toDataURL` took about 17 ms at 640x480 there; the asynchronous encoders take
   about 4 s at any size).
6. **The live tracker on a Quest**: test `/track` following each step's objects on the headset.

## More ideas, roughly by gain

- **Stream stage 1 and start on the first step** as soon as `firstStep` closes: the card puts it
  last, so this gains little now; worth it only if the card grows again.
- **Start stage rest sooner**: it waits for stage 1's answer (it revises that plan).
- **Reuse the card's phrase in stage rest's show items**: tracking restarts when an object's
  phrase changes from step to step.
- **Cache the planner's system instruction** (1,645 tokens): cuts cost, not time (measured).

## How to check quality quickly

```bash
pnpm bench --staged --repeat 3                             # judged, both scenes, stage first low
pnpm bench --staged --thinking first=minimal --repeat 3    # the same at minimal, to compare
pnpm bench --checks --repeat 3                             # the milk watcher test still says "wrong"
pnpm check
```

The judge misses an outline that drops half the goal: read the pH plans' steps too (does each
test the base?). Open the bench at http://localhost:5173/bench.html (`pnpm dev`), tick "Plan in
two stages", and watch the "step 1 ready in X s" line.
