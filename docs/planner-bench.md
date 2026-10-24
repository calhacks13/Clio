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
   When the planner says where it saw the plan's objects (`sightings`), **Show where the plan saw
   its objects** under the frames draws a labeled box and point for each one on the frame shown.
4. **Does it look done?** on a step asks the step watcher's question (`/api/plans/check`) about
   fresh frames, with what the step's objects look like and its likely mix-ups, so you can do the
   step and see whether the model notices.
5. **Re-plan from here** on a step: change the scene (take the vinegar away, spill something),
   say what changed, and the planner revises the rest of the plan from a new capture, as
   `revise_plan` does in a lesson.
6. Grade the run (**Correct**, **Partly**, **Wrong**, plus a note).
7. **Save scenario** keeps the frames, the request (a re-plan keeps its base plan too), the runs
   you made and what a correct plan must do, one expectation per line.

## Plans in two stages

**Plan in two stages** asks as the headset will, to start a lesson sooner: stage `first` writes the
lesson as an outline and step 1 as a short card ([coach-plan.md](coach-plan.md)), and as soon as it
is in, stage `rest` writes the outline in full from the same frames (a re-plan of the stage-1 plan
from `outlineFrom`, "Refine the outline while the learner does step 1"). Each stage is a run of its
own; their chips sit together with an arrow, the outline steps are drawn dashed, and the run says
"Step 1 ready in X s, the rest refined Y s later". When the rest comes in, the page shows it instead
of stage 1. If you are already watching stage 1 live, the refined steps replace the ones not done
yet: the done steps, the focused step's clock and the looks so far are kept. A model that answers
stage 1 with a whole plan (no `outlineFrom`) is told so, and nothing is refined. Saving a scenario
keeps both stages, and a saved scenario runs in two stages too while the box is ticked.

## Watching live

**Watch me do it live** on a plan follows it while you do the steps in front of the camera. It
asks the step watcher's question (`/api/bench/check`, the headset's `/api/plans/check` with a model
of your choice) about the focused step over and over, from one fresh 1024 px frame. Each look also
sends:
- `before`: a frame kept from the moment the step got focus, so the model can compare then and now;
- `objects`: what the step's objects look like, from its outlines' descriptions and then the
  declared objects it targets (their `tracking.query`, description or label);
- `confusions`: the step's mistake messages, which are often mix-ups that look like success;
- `criteria`: the step's done-when split into things a camera can confirm, asked once when the
  step gets focus, with the `before` frame (`/api/bench/criteria`, as the headset's
  `/api/plans/criteria`). Looks go without them if asking fails.

The live watch always asks careful looks, one at a time; the headset's quick looks and its second
look in flight near the end ([coach-plan.md](coach-plan.md)) are measured from the command line.

The panel:
- shows the step, its done-when, the last answer with the frame it judged (and the point that
  decided it, when the answer has `evidence`), how far along the step looks (`progress`), and the
  time on this step and in all;
- shows an answer with `wrong` in red ("Wrong: picked up the milk, not the yogurt drink"), counts
  the wrong answers in the header and the log, and never counts a wrong answer as done;
- shows each criterion as the look judged it: ✓ met, ✗ not met with what the model saw instead,
  ? when it could not see it;
- with **Move on by itself** (on by default) completes a step after 1, 2 or 3 answers of "done" in
  a row (2 by default); turn it off to see the headset's behavior, where the watcher only suggests
  and the coach or **Mark done** decides;
- **Look** sets the cadence: **as fast as it answers** (the default: the next look starts 0.5 s
  after the last answer, about one look every 2 s on Robotics-ER 2; the headset waits 1 s) or every
  2, 3, 6 or 10 s. After a failed look it waits at least 3 s;
- **Mark done**, **Skip**, **Back a step** and the numbers on the progress bar move the focus by
  hand; **Look now** asks at once; the cadence and the judging model can change while it runs;
- **Every look** lists each answer with its frame and latency, and the end shows how long each
  step took and whether the watcher saw it done or you marked it.

A plan from a re-plan starts with its kept steps done. Looks pause while the page is hidden. The
new answer fields (`progress`, `wrong`, `evidence`) are optional: without them the panel works as
before.

## Watcher tests

**Save as test** on any look in **Every look** keeps it as a watcher test: the frame from when the
step started and the frame it judged, the goal, the step (id, instruction, done-when), the objects
and mix-ups it was asked with, what the watcher answered, and the answer it should have given:
- **done**: it must say done;
- **not done**: it must not say done (unsure passes);
- **wrong**: it must not say done, and must say what the learner did instead (`wrong`);
- **unsure**: the frame can't tell (a hand hides the result, it is out of view, blurred or dark):
  it must say unsure.

This is how a failure seen live, like the milk taken for the yogurt drink and called done, becomes
a regression test. **Watcher tests** under the scenarios lists them with their passes per model.
Open one to see its frames and answers, change the answer it should get, or run it with the ticked
models; **Run all tests** runs every test with every ticked model. Each answer is saved with the
test, with how it was asked when that was not the headset's way (its `variant`, e.g. "quick,
criteria seen") and its criteria as judged.

### Painted watcher tests

`apps/server/scripts/check-tests.ts` paints 30 hard watcher tests with `gemini-3-pro-image` and
saves them: first-person views of the pH table, a fridge, a desk and a basil pot, each "now" view
painted from its "before" view so both show the same scene. The specs, with what each view shows,
are in `scripts/check-test-specs.ts`: clearly done, not done, half done (two of three cups,
grasped but not lifted, mid-pour), the wrong cup or look-alike (milk for the yogurt drink, the red
cap for the blue, the grey mug), a listed mistake (base in the control cup too), unlabeled cups,
a step back from the table, readable but dim frames, a hand hiding the result, out of view, and a
dark blurred frame (the last two made with ffmpeg from a done view). 12 should say done, 7 not
done, 8 wrong and 3 unsure.

```bash
cd apps/server
npx tsx --env-file-if-exists=../../.env scripts/check-tests.ts            # paint what's missing, save
npx tsx --env-file-if-exists=../../.env scripts/check-tests.ts --redo ph-b-teal --no-save
```

Scenes are cached in `data/bench/check-scenes` with the prompt that made them, so a run paints only
what is missing or changed, and a scene painted again repaints those made from it. Look at every
scene before trusting its test: two measuring-jug tests were dropped because the milk stood above
500 mL in both. Needs ffmpeg.

## Scenarios and judging

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
pnpm bench --staged                            # as the headset plans: stage first, then rest
pnpm bench --staged --thinking first=low --thinking rest=high
pnpm bench --staged --thinking first=minimal --repeat 3   # how stage first was picked
pnpm bench ph-lesson-cup-a-already-pink-knife-on-the-table --no-judge
pnpm bench --list
pnpm bench --checks                            # every watcher test, the planner model
pnpm bench --checks --model gemini-robotics-er-2-preview --model gemini-3.8-flash --repeat 3
pnpm bench --checks milk-taken-for-the-yogurt-drink
pnpm bench --checks --criteria seen --parallel 2   # as the headset's careful look
pnpm bench --checks --criteria seen --quick        # as its quick look (minimal thinking)
pnpm bench --checks --thinking check=minimal --criteria words --thinking criteria=low
pnpm bench --checks --list
```

No server is needed; the CLI reads `.env` like the server. It saves runs with their scenarios (or
tests), so the page shows them too. For scenarios it ends with a table per model: runs, plans
written, judged passes, expectations met, and the median time until the lesson can start and until
the plan is complete. `--staged` saves both stages as runs and judges the plan the learner ends up
with: stage rest's steps, with the warnings of both stages, as the coach heard them.
`--thinking <stage>=<level>` tries another thinking level for a stage (`default` is the model's
own). With `--checks` the table has looks, passes, the pass rate, passes by expected answer (done,
not done, wrong, unsure), how often it said done when it wasn't (false done) and the median and
p90 time of a look. `--criteria seen` asks each test's criteria first, from its `before` frame, as
the headset does (`words`: from the step's words alone; `inline`: the model writes its own in
every answer), once per test and repeat, and reports their time on a line of their own.
`--thinking check=<level>` and `criteria=<level>` change the two calls' thinking, `--quick` asks
quick looks, and `--parallel <n>` asks n looks at a time (2 kept latencies steady).

`apps/server/scripts/stage1-timing.ts` times stage first alone, streamed, on the saved scenarios:
how long the model thinks before it writes, when the first step starts and when the answer ends, the
tokens, and each field's share of the answer. It saves nothing and needs no judge:

```bash
cd apps/server
npx tsx --env-file-if-exists=../../.env scripts/stage1-timing.ts --thinking minimal
npx tsx --env-file-if-exists=../../.env scripts/stage1-timing.ts fridge-yogurt-drink-beside-the-milk --thinking low --repeat 5
```

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
data/bench/checks/<id>/check.json         a watcher test: step, hints, expected answer
data/bench/checks/<id>/before-<n>.jpg     the frames from when the step started
data/bench/checks/<id>/now-<n>.jpg        the frames it judged
data/bench/checks/<id>/runs/<run>.json    each answer: model, variant, timing, answer or error, passed
data/bench/check-scenes/<name>.jpg        the painted scenes, each with the recipe that made it
data/bench/deleted/                       deleted scenarios and watcher tests, moved aside
```

`data/` is gitignored, so scenes from your camera stay on this laptop.

| Part           | File                                                                     |
| -------------- | ------------------------------------------------------------------------ |
| contract       | `packages/protocol/src/bench.ts`                                         |
| routes         | `apps/server/src/routes/bench.ts` (`/api/bench/*`)                       |
| runs and judge | `apps/server/src/services/bench.ts`, `bench-judge.ts`, `gemini-judge.ts` |
| watcher tests  | `apps/server/src/services/bench-checks.ts`, `scripts/check-tests.ts`     |
| storage        | `apps/server/src/storage/bench-store.ts`, `bench-check-store.ts`         |
| CLI            | `apps/server/scripts/bench.ts`                                           |
| page           | `apps/headset/bench.html`, `apps/headset/src/bench/`                     |
