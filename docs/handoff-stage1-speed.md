# Handoff: make the first step arrive much faster

> For the next agent. The user: "it's taking far too long to come up with the first step, we need
> to speed it up a ton without losing quality." This page is where that work stands, what was
> measured, and what is left. Read [coach-plan.md](coach-plan.md) ("Who writes the first draft"),
> [robotics-er.md](robotics-er.md) and [planner-bench.md](planner-bench.md) first.

## Where things are

| Branch                         | State                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `feat/coach-plan-robotics-er2` | Green (852 tests). Robotics-ER 2 everywhere, two-stage plans, step watcher, voice bridge |
| `er2/stage1-card`              | This work: the first stage writes a short "card". **4 server tests fail**; see below     |
| `er2/fast-start`               | Another agent's headset-side work (may still be in progress); see "The headset path"     |

Nothing is pushed. The user is about to merge these with changes on Peter's laptop.

## Where the time goes (measured)

Today the lesson starts on the planner's stage `first` (Robotics-ER 2, thinking low). Streamed,
on the two saved bench scenes (`data/bench/scenarios`, pH and fridge):

| Stage 1 answer                       | Thinking | Thinks for | First step starts | Done       | Output tokens |
| ------------------------------------ | -------- | ---------- | ----------------- | ---------- | ------------- |
| as on `feat/coach-plan-robotics-er2` | low      | 1.9-5.0 s  | 4.6-8.3 s         | 6.2-10.1 s | 1,140-1,410   |
| fewer fields, full objects and step  | low      | 1.6-3.8 s  | 3.7-6.7 s         | 5.1-8.1 s  | 950-1,300     |
| fewer fields, full objects and step  | minimal  | 0.9-1.5 s  | 2.3-4.5 s         | 3.3-6.4 s  | 600-1,350     |
| **the card (`er2/stage1-card`)**     | minimal  | 0.9-1.4 s  | 2.1-3.8 s         | 2.5-4.7 s  | 400-850       |

Two things cost about the same: the model's thinking (up to 970 thought tokens at low) and the
length of the answer (Robotics-ER writes about 250-300 tokens a second). The old first stage
spent most of its answer on full object specs (a quarter to a third) and a step written in full,
before the first step even started. On the headset, more waits stack on top (next section).

## What the card is (`er2/stage1-card`, uncommitted ideas included)

`plan-schema.ts` (`kind === 'first'`), `plan-build.ts` (`buildFirstStageCandidate`, `cardObject`,
`cardStep`, `outlineStep`), `plan-prompt.ts` (`firstStageText`). The answer is now:
- `title`, `summary`;
- `outline`: every step as `{ id, instruction }` only (no done-when, no targets);
- `objects`: only the first step's objects and look-alikes, each `{ id, label, look, moves }`;
- `sightings` (as before), `warnings` (hazards first, as before);
- `firstStep` as a card: `id, instruction, doneWhen, targets, action, show: [object ids],
  mistakes: [{ kind, message, object }]`.

`plan-build.ts` expands it into an ordinary `Procedure` (the shared contract and the Python JSON
Schema are unchanged): an object's `look` becomes `tracking.query` and the description of every
outline that shows it, kind `item`, placement `detect`, default radius; a mistake becomes a
`hand_near` rule on its object (dropped if that object isn't declared); the step is confirmed by
its done-when; outline lines become steps confirmed by their instruction. Stage `rest` then writes
steps 2..n in full and declares their objects, as before.

What the card gives up, to check: step-specific outline descriptions (it uses each object's one
look), `coachNotes`, `detail`, `hand`, real `kind`/`radius`, and success checks other than
confirm (under a Gemini coach they only ever see trusted positions anyway).

## Left to do on `er2/stage1-card`

1. **Fix the 4 failing server tests** (they assert the old first-stage shape):
   `test/plan-schema.test.ts` ("asks a first stage for the whole lesson in outline…"),
   `test/plan-build.test.ts` (`buildFirstStageCandidate`), `test/plans.test.ts` ("POST /api/plans
   in two stages…"), `test/gemini-planner.test.ts` ("asks a first stage…"). Update the fixture
   `modelFirstStage()` in `test/plan-fixtures.ts` to the card shape; `test/bench.test.ts` uses it
   too. Add tests for `cardObject`/`cardStep` (look → query and outlines; mistake on an
   undeclared object dropped; confirm by done-when).
2. **Pick stage first's thinking level by judged quality**, not only speed. Two judged runs were
   started (both scenes, 3 runs each, stage rest at medium, judged by gemini-pro-latest):
   `pnpm bench --staged --thinking first=minimal --repeat 3` and the same with `first=low`. Their
   output: `/private/tmp/claude-501/-Users-owengregson-Documents-Clio/b022adb0-b040-4909-a791-5410763b7cda/scratchpad/card-minimal.txt`
   and `card-low.txt` (also saved as runs under `data/bench/scenarios/*/runs` in this worktree,
   newest first: read them on the bench page or in the JSON). First results, fridge scene: at
   minimal, step 1 in 2.7 and 3.2 s and the final plans judged 5/5 twice; at low, 6.0 and 4.6 s
   and 4/5 twice. The pH runs were still going at handoff. The bar to beat:
   before the card, staged plans passed 4 of 4 (18/18 expectations) with lessons starting at
   8.7 s median (and 68/81 over the planning agent's wider runs). Also read the first-stage runs
   themselves: the first step must pick the yogurt drink, not the milk, carry a mistake for the
   milk, not redo cup A, and the warnings should name the knife. Then set
   `PLAN_THINKING.first` in `gemini-planner.ts` (low today) and update the table in
   coach-plan.md.
3. **Docs**: coach-plan.md ("Who writes the first draft"), planner-bench.md if the bench text
   changes, robotics-er.md's numbers.
4. **Measure again**: `apps/server/scripts/stage1-timing.ts` (streamed timing and token counts;
   run from `apps/server` with `npx tsx --env-file=../../.env scripts/stage1-timing.ts minimal`).

## More ideas, roughly by gain

- **The headset path (`er2/fast-start`)**: today, after the plan arrives, `run()` in
  `lesson-controller.ts` waits for a locate of every object (1.5-2.5 s on Robotics-ER) before the
  coach hears step 1, and planning first captures 2 frames 400 ms apart. That branch starts the
  lesson without waiting for the locate and keeps recent planning frames ready. Merge it, check
  its tests, and measure on the headset (it records a `lesson.first_step` annotation).
- **Drop `sightings` from stage 1** unless something uses them early (only the bench overlay
  does today): about 80 tokens, ~0.3 s.
- **One camera view for stage 1** instead of two: ~1,000 fewer input tokens (small, maybe 0.2 s).
- **Stream stage 1 and start on the first step** as soon as `firstStep` closes: the card puts it
  last, so this gains little now; worth it only if the card grows again.
- **Start stage rest sooner**: it waits for stage 1's answer (it revises that plan). Fine while
  stage 1 is ~3 s.
- **Cache the planner's system instruction** (1,645 tokens): cuts cost, not time (measured).

## How to check quality quickly

```bash
pnpm bench --staged --thinking first=minimal --repeat 3   # judged, both scenes
pnpm bench --checks --repeat 3                            # the milk watcher test still says "wrong"
pnpm check
```

Open the bench at http://127.0.0.1:5183/bench.html (the Robotics-ER branch's dev server, from the
worktree `/Users/owengregson/Documents/Clio/.claude/worktrees/agent-a934202d5531222ab`; the
user's own checkout serves the older `feat/coach-plan` on 5173), tick "Plan in two stages", and
watch the "step 1 ready in X s" line.
