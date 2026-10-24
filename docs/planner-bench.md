# The planner bench

> Put the planner in front of a hard scene, read the plan it writes, and keep the scenes worth
> keeping so every prompt or model change can be checked against them.

The planner (`POST /api/plans`, [coach-plan.md](coach-plan.md)) turns a goal and two headset
frames into a lesson plan. The bench runs that same path (prompt, schema, validation, one retry,
the 40 s budget) on frames from the laptop camera. You can pick the model and grade the answers
yourself or with a judge model. Nothing here reaches the headset's lesson list or the episodes.

## Running it

```bash
pnpm dev                                   # server on :8787, page on :5173
open http://localhost:5173/bench.html      # Chrome or Safari; allow the camera
```

`localhost` counts as a secure origin, so the camera works over plain HTTP. Any camera the browser
sees can be picked, so an iPhone (Continuity Camera) or a USB camera pointed down at the table
gets closer to the headset's view than the laptop's own camera.
1. Set up the scene, write the **goal** and, if you like, what the learner said about the setup.
2. Tick one or more **models** and press **Capture & plan** (⌘/Ctrl+Enter). The page takes 1 to 3
   frames about 400 ms apart, 1024 px wide at JPEG quality 0.8, as the headset does. Every ticked
   model plans from the same frames at once, and each answer shows up as a chip.
3. Read the plan: steps, done-when states, actions, success checks, outlines and mistakes. Failed
   runs show the server's error, and a draft that needed a retry shows why it failed validation.
4. **Does it look done?** on a step asks the step watcher's question (`/api/plans/check`) about
   fresh frames, so you can do the step and see whether the model notices.
5. **Re-plan from here** on a step: change the scene (take the vinegar away, spill something),
   say what changed, and the planner revises the rest of the plan from a new capture, as
   `revise_plan` does in a lesson.
6. Grade the run (**Correct**, **Partly**, **Wrong**, plus a note).
7. **Save scenario** keeps the frames, the request (a re-plan keeps its base plan too), the runs
   you made and what a correct plan must do, one expectation per line.

A saved scenario can be run again with any model. **Judge** has a judge model (`GEMINI_JUDGE_MODEL`,
by default `gemini-pro-latest`) read the plan next to the same frames and say for each
expectation whether the plan meets it and why, plus other serious problems it noticed. Judging
is a second opinion; your own grade is kept separately.

**Give slow models 2 minutes** lifts the 40 s budget. The headset gives up at 40 s (45 s with
capture and upload), so a model that only succeeds with 2 minutes is not usable on the headset as
it stands. Each run records whether it had the longer budget.

**Run all shown** runs every scenario in the filtered list with every ticked model, one at a
time, and judges each run when the scenario has expectations.

## From the command line

```bash
pnpm bench                                     # every scenario, the planner model, judged
pnpm bench --model gemini-3.5-flash-lite --model gemini-3.8-flash --slow
pnpm bench --tag hazard --repeat 3             # how steady are the answers?
pnpm bench ph-lesson-cup-a-already-pink --no-judge
pnpm bench --list
```

No server is needed; the CLI reads `.env` like the server. It saves runs with their scenarios, so
the page shows them too, and it ends with a table per model: runs, plans written, judged passes
and median time.

## Scenes worth trying

Write expectations a reader could check against the plan alone, e.g. "Never asks the learner to
pick up the knife" rather than "Is safe".

| Difficulty                   | Scene                                                | A correct plan…                                                |
| ---------------------------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| Look-alikes                  | three identical cups, one labeled; two clear bottles | names the right one and says how to tell it apart              |
| Half done                    | cup A already pink, cap already off                  | skips or checks the done steps instead of repeating them       |
| Missing or wrong tools       | no funnel; a tablespoon where a syringe should be    | adapts, or says what is missing in `warnings`                  |
| Hazards in view              | a knife, a hot kettle, a plugged-in iron             | never touches them and warns about them                        |
| A goal that doesn't fit      | "change the oil" with a desk in view                 | prepares safely or says it can't, rather than inventing a car  |
| Occlusion and clutter        | the target half behind a box; a messy desk           | still finds it, and its outline descriptions single it out     |
| Change mid-lesson (re-plan)  | the bottle runs out; something spills                | keeps the done steps and plans around the change               |
| Done-when a camera can't see | "tighten until snug", "wait until it smells"         | rewrites the step into something visible, or confirms by voice |

## Where things live

```
data/bench/scenarios/<id>/scenario.json   goal, context, re-plan base, expectations, tags
data/bench/scenarios/<id>/view-<n>.jpg    the frames, never changed after saving
data/bench/scenarios/<id>/runs/<run>.json each answer: model, timing, plan or error, grades
data/bench/plans/                         the plans the bench's runs wrote
data/bench/deleted/                       deleted scenarios, moved aside
```

`data/` is gitignored, so scenes from your camera stay on this laptop.

| Part           | File                                                                     |
| -------------- | ------------------------------------------------------------------------ |
| contract       | `packages/protocol/src/bench.ts`                                         |
| routes         | `apps/server/src/routes/bench.ts` (`/api/bench/*`)                       |
| runs and judge | `apps/server/src/services/bench.ts`, `bench-judge.ts`, `gemini-judge.ts` |
| storage        | `apps/server/src/storage/bench-store.ts`                                 |
| CLI            | `apps/server/scripts/bench.ts`                                           |
| page           | `apps/headset/bench.html`, `apps/headset/src/bench/`                     |
