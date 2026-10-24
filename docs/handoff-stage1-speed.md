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

The integration starts from `a45a84e` and is merged by its coordinator. Its streams for this work:
s1 finishes the card on the server (tests and bugs), s2 the headset's start path, s3 measured and
set stage first's thinking (this page, the timing script, the docs).

## Where the time goes (measured)

The lesson starts on the planner's stage `first` (Robotics-ER 2, thinking minimal). Streamed, on
the two bench scenes, pH and fridge (`data/bench/scenarios`):

| Stage 1 answer                       | Thinking | Thinks for | First step starts | Done       | Output tokens |
| ------------------------------------ | -------- | ---------- | ----------------- | ---------- | ------------- |
| as on `feat/coach-plan-robotics-er2` | low      | 1.9-5.0 s  | 4.6-8.3 s         | 6.2-10.1 s | 1,140-1,410   |
| fewer fields, full objects and step  | low      | 1.6-3.8 s  | 3.7-6.7 s         | 5.1-8.1 s  | 950-1,300     |
| fewer fields, full objects and step  | minimal  | 0.9-1.5 s  | 2.3-4.5 s         | 3.3-6.4 s  | 600-1,350     |
| the card (`er2/stage1-card`)         | minimal  | 0.9-1.4 s  | 2.1-3.8 s         | 2.5-4.7 s  | 400-850       |
| **the card, recreated scenes**       | minimal  | 1.1-1.6 s  | 2.6-3.4 s         | 3.0-4.0 s  | 495-673       |
| the card, recreated scenes           | low      | 3.1-5.3 s  | 5.3-9.1 s         | 5.9-10.1 s | 589-1,289     |

The first four rows are on the original scenes, the last two on recreated ones (below), 3 runs a
scene; "thinks for" is the time to the first answer text, round trip included. At minimal the
card uses no thought tokens; at low it thinks for 490 to 1,020 of them.

Two things cost about the same: the model's thinking (up to 1,020 thought tokens at low) and the
length of the answer (Robotics-ER writes about 250-300 tokens a second). The old first stage
spent most of its answer on full object specs (a quarter to a third) and a step written in full,
before the first step even started. On the headset, more waits stack on top (next section).

## What the card is

`plan-schema.ts` (`kind === 'first'`), `plan-build.ts` (`buildFirstStageCandidate`, `cardObject`,
`cardStep`, `outlineStep`), `plan-prompt.ts` (`firstStageText`). The answer is:
- `title`, `summary`;
- `outline`: every step as `{ id, instruction }` only (no done-when, no targets);
- `objects`: only the first step's objects and look-alikes, each `{ id, label, look, moves }`
  (s1 adds a short detector `phrase`);
- `sightings` (as before), `warnings` (hazards first, as before);
- `firstStep` as a card: `id, instruction, doneWhen, targets, action, show: [object ids],
  mistakes: [{ kind, message, object }]`.

`plan-build.ts` expands it into an ordinary `Procedure` (the shared contract and the Python JSON
Schema are unchanged): an object's `look` becomes `tracking.query` and the description of every
outline that shows it, kind `item`, placement `detect`, default radius; a mistake becomes a
`hand_near` rule on its object (dropped if that object isn't declared); the step is confirmed by
its done-when; outline lines become steps confirmed by their instruction. Stage `rest` then writes
steps 2..n in full and declares their objects; with s1 it also writes the card's objects again,
which upgrades their kind, size and description.

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

1. **The 4 failing server tests and the card's bugs**: stream s1 (the fixture in card shape,
   tests for `cardObject`/`cardStep`, the outline line matched by the card's id, mistakes on the
   step's own objects dropped, `show` deduped, the detector `phrase`, stage rest upgrading the
   card's objects, only `action` left in `$defs`). The coordinator confirms what landed.
2. **Stage first's thinking, by judged quality**: `PLAN_THINKING.first` is now `minimal` (s3).
   Measured on the card's first version (before s1's changes), on the recreated scenes, stage rest
   at medium, judged by `gemini-pro-latest`, 3 runs a scene and setting:

   | Scene, stage first | Lesson starts     | Plan complete | Judged (met, plans passed) |
   | ------------------ | ----------------- | ------------- | -------------------------- |
   | fridge, minimal    | 2.8-3.9 s (3.2 s) | 14.2 s        | 14/15, 2 of 3              |
   | fridge, low        | 4.7-6.4 s (5.2 s) | 16.1 s        | 15/15, 3 of 3              |
   | pH, minimal        | 3.4-4.9 s (3.4 s) | 15.1 s        | 8/12, 0 of 3               |
   | pH, low            | 6.0-8.0 s (6.4 s) | 23.3 s        | 9/12, 0 of 3               |
   | both, minimal      | 3.4 s median      | 15.0 s        | 22/27                      |
   | both, low          | 6.2 s median      | 21.0 s        | 24/27                      |

   Read from the first stages themselves (the judged runs plus 3 more pH runs a level), the first
   step was right at both levels: it took the yogurt drink with a mistake for the milk in all 6
   fridge cards, never touched cup A in all 12 pH cards, and those warnings named the knife first 12
   of 12. The judged gap is one minimal pH outline that added vinegar to cup A again, which stage
   rest kept (1 of 6 at minimal, 0 of 6 at low), and one judge misreading a correct milk mistake
   ("Grab the bottle with the pink cap instead of the one with the blue cap", on the milk) as
   backwards. Neither level met "cup C stays the control": none of the 12 pH plans kept it, and 11
   put vinegar in cup B and the base in cup C. Minimal starts the lesson about 2.8 s sooner, well
   under the 8.7 s median from before the card.
3. **Docs**: coach-plan.md ("Who writes the first draft" and its table), robotics-er.md,
   planner-bench.md (the card, the timing script).
4. **Measured again** with `apps/server/scripts/stage1-timing.ts`, which now runs on any checkout:
   `cd apps/server && npx tsx --env-file-if-exists=../../.env scripts/stage1-timing.ts
   [scenario-id ...] [--thinking minimal] [--repeat 3]`. It reads the key and `CLIO_DATA_DIR`
   like the server and times every saved scenario by default.
5. **The headset path**: stream s2 (start the runner and brief step 1 as soon as the plan arrives
   and locate in the background, joining a find already in flight; a buffer of recent planning
   frames so capture is off the clock). The coordinator confirms what landed.

## Left to do

1. **Measure the card again after s1's changes** (reworded prompt, the `phrase`, pruned `$defs`):
   `stage1-timing.ts --thinking minimal`, then `pnpm bench --staged --repeat 3` (judged). The
   first step must stay right (yogurt drink with a milk mistake, cup A left alone, the knife in
   the warnings); if minimal slips, set `PLAN_THINKING.first` back to `low`.
2. **The pH control cup** (both levels, so a prompt matter, not thinking): when the scene is half
   done, the plan should finish the lesson's design from there (the acid is done in cup A, so the
   base goes in cup B and cup C stays purple), not redo the acid in a fresh cup.
3. **Stage rest keeps a done step**: it was told to change the outline only where the views show
   it is wrong, and kept "add vinegar to cup A" with cup A already pink. Tell it to drop or
   rewrite outline steps whose outcome is already in view.
4. **Real scenes**: the two scenes here are generated. Capture them on bench.html (or copy the
   original folders) and run the bench again.
5. **The headset end to end**, once s2 is in: time `start_lesson` to the step-1 briefing on the
   Quest, with the plan and locate split out.

## More ideas, roughly by gain

- **Drop `sightings` from stage 1** unless something uses them early (only the bench overlay
  does today): they are 18 to 24% of the card's characters at minimal (about 90 to 160 tokens,
  0.3 to 0.6 s), more than the 80 tokens first estimated.
- **One camera view for stage 1** instead of two: ~1,000 fewer input tokens (small, maybe 0.2 s).
- **Stream stage 1 and start on the first step** as soon as `firstStep` closes: the card puts it
  last, so this gains little now; worth it only if the card grows again.
- **Start stage rest sooner**: it waits for stage 1's answer (it revises that plan). Fine while
  stage 1 is ~3 s.
- **Cache the planner's system instruction** (1,645 tokens): cuts cost, not time (measured).

## How to check quality quickly

```bash
pnpm bench --staged --repeat 3                            # judged, both scenes, stage first minimal
pnpm bench --staged --thinking first=low --repeat 3       # the same at low, to compare
pnpm bench --checks --repeat 3                            # the milk watcher test still says "wrong"
pnpm check
```

Open the bench at http://localhost:5173/bench.html (`pnpm dev`), tick "Plan in two stages", and
watch the "step 1 ready in X s" line.
