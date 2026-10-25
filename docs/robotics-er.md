# Gemini Robotics-ER 2 in Clio

> Clio's eyes and plans run on Gemini Robotics-ER 2, an embodied-reasoning model. This page is
> what it can do, what we measured on our own prompts, and why each call is set up the way it is.

Measured in October 2026 on the project's key, mostly on the planner bench's pH scene and a few
generated photoreal scenes (a desk with look-alike mugs, a half-done pour-over, an engine bay).
The stage 1 card's numbers are on generated copies of the bench's pH and fridge scenes. One scene
type is not a benchmark: treat the quality numbers as directional and re-check them on the bench
([planner-bench.md](planner-bench.md)) with real scenes.

## Two models at once

The coach is two models working side by side. The voice is a realtime native-audio Live model
(`gemini-3.8-live-extended-thinking`): it sees the camera, listens and talks, and never waits on the other one.
Robotics-ER 2 is the smart model: it plans, watches each step, finds objects and answers the
questions the voice hands it. The voice delegates through tools that answer at once, and
Robotics-ER reports back as `[app]` messages when it has something: a plan, a refined plan, a step
that looks done or wrong, an answer.

| Model                               | API               | What Clio uses it for                                                      |
| ----------------------------------- | ----------------- | -------------------------------------------------------------------------- |
| `gemini-3.8-live-extended-thinking` | Live (bidi)       | the voice: conversation, with the camera in view                           |
| `gemini-robotics-er-2-preview`      | `generateContent` | planning, the step watcher, the object finder, the action focus, questions |
| `gemini-pro-latest`                 | `generateContent` | the bench's judge: a different model grades the planner                    |

`gemini-robotics-er-2-streaming-preview` is Robotics-ER 2 on the Live API. It answers in text
only (audio output is rejected with close code 1007), so it can't be the voice; it could watch in
the background beside it.

Robotics-ER 2 is built on Gemini 3.5 Flash. Input: text, images, video, audio, up to 131,072
tokens (flash-lite takes 1M). Output: text, up to 65,536 tokens. It supports structured output
(`responseJsonSchema`, including our planner schema with `$defs`, `$ref` and `anyOf`), function
calling, code execution, Search and URL grounding, caching and batch. It does not support several
candidates or logprobs.

## Thinking

Thinking is set per call with `thinkingConfig.thinkingLevel` (`minimal`, `low`, `medium`, `high`;
the default is `high`) or the older `thinkingBudget`, never both (400). `thinkingConfig()` in
`apps/server/src/services/gemini.ts` sets a level only on models that take one.

More thinking was not better for our calls:

| Call (median)               | minimal / budget 0  | low          | default (high) | flash-lite  |
| --------------------------- | ------------------- | ------------ | -------------- | ----------- |
| step check, clear case      | 1.0-1.4 s           | 1.1 s        | 1.6-1.9 s      | 0.9-1.0 s   |
| step check, 12 hard cases   | 9/12 right          | 6-7/12       | 6-7/12         | 9/12        |
| step check, 30 painted      | 56/60, 1.3 s        | 29/30, 1.7 s |                |             |
| ... with criteria           | 29/30, 1.4 s        | 30/30, 2.0 s |                |             |
| object finder (2 objects)   | 2.3 s               |              | 4.9 s          | 1.7 s       |
| action focus (0-5 objects)  | 2.4 s (1.7-3.1 s)   |              |                |             |
| full plan                   | 6.4 s, 8/12 met     | 10.1 s       | 18.8 s, 7/12   | 5.6 s, 4/12 |
| stage 1 card, step 1 starts | 2.7-3.9 s           | 5.3-9.1 s    |                |             |
| staged plan from the card   | 3.5 s, 24/27 met    | 6.2 s, 24/27 |                |             |
| pH outline tests the base   | 6 of 10, now 7 of 7 | 7 of 7       |                |             |

With thinking on, the step check repeatedly invented "the dropper is held in the learner's hand"
when no hand was in view. On the planner bench's 30 painted watcher tests (October 2026, see
below) the step check was right on every done, not done and wrong case at minimal and at low; what
both got wrong was the frames they could not read. Minimal more so: for a cup hidden behind a
hand it said "not done, cup A is still purple", and for one out of view, not done. Pointing, boxes, yes/no state, counting and spatial relations were as
accurate at minimal as at high. Trajectories, polygons and custom multi-image JSON were better
with some thinking. Whole plans need low or more. The planner's short first stage (the card) gets
its first step as right at minimal as at low, 2 to 3 s sooner, but at minimal 4 of 10 pH
outlines left out the base, half the lesson's goal, which none did at low. Once the prompt said
the outline covers every part of the goal, 7 of 7 tested the base at minimal and the judged
score matched low's, so it thinks at minimal ([coach-plan.md](coach-plan.md)). The low column
of the card's rows is from its first version.

## What it does well

- **Pointing**: `[{"point": [y, x], "label": …}]`, integers 0-1000, always y first, whatever the
  prompt asks for. Right every time on single objects and look-alikes ("the mug with the blue
  sticker", 18 of 18), within about 10 px. Parts work too: handles, caps, spouts (7 of 7).
- **Boxes**: `box_2d` `[ymin, xmin, ymax, xmax]` 0-1000, 0.92-0.99 IoU on hand-measured boxes.
- **State and success**: yes/no questions about a scene with a reason and a point on the evidence.
  It is trained to judge success by comparing frames from the start of a task with frames from
  now (Google reports 87.7% on images, 82.4% on video), and to classify progress.
- **Plans that see the scene**: it noticed that cup A was already pink in 18 of 18 plans and
  never reused it, where flash-lite often re-dosed cup A. The stage 1 card's first step left
  cup A alone 36 of 36 times at minimal and low thinking, but one outline at minimal added
  vinegar to it again.
- **Several images per request**: crops, mirrored views and two scenes were told apart correctly.
- **Trajectories**: points labeled "0" to "n" in `[y, x]`; pour paths started at the spout and
  ended over the target.

## What to guard against

- **Absent but plausible objects**: asked for "pH test strips" on the pH table, it pointed at the
  syringe 6 of 7 times. Saying that an absent object is an answer (return `[]`, or `found: false`)
  fixed it, 7 of 7. Every Clio prompt that points says so.
- **Hazards**: it called a kitchen knife a "pipette" every time it listed all objects, and plans
  never warned about the knife until the prompt carried an explicit hazard checklist (then 6 of 6;
  the stage 1 card named it first in its warnings 36 of 36).
  Ask about hazards directly; don't trust its free labels for safety. The step check asks on every
  look (it named a drawn knife on 2 of 8 looks, and invented none in the fridge scenes).
- **Half a goal at minimal thinking**: the quick stage 1 outline sometimes stopped after the
  goal's first part (4 of 10 pH outlines tested only the acid). Saying that the outline covers
  every part of the goal, in order, fixed it (7 of 7). Planning, it still didn't read cup A's
  pink as the acid test already done, so no pH plan kept the spare cup C as the control; asked
  alone what is done, it did. With that reading written first (`done`, `todo`), 8 of 9 photo pH
  plans put the base in cup B and kept cup C ([coach-plan.md](coach-plan.md)).
- **Out of view**: models answered `not_done` rather than `unsure` when the target was cropped
  out of the frame; the step check says that hidden or out-of-view means unsure. Behind a hand
  it still reasoned from other clues ("the vinegar bottle is untouched, so cup A has no vinegar"):
  at low it said unsure in 1 of 8 looks, and in 2 of 4 once the prompt said that a hidden object
  is unsure whatever other clues say.
- **Criteria it adds**: asked to split a done-when into criteria, it sometimes adds a condition the
  done-when doesn't state: an amount from the instruction ("about 5 mL"), or that the bottle is
  back on the table. The prompt forbids both; the amount still came back in 1 of 4 sets.

## The step watcher's measurements

On 30 watcher tests painted with `gemini-3-pro-image` (first-person views of the pH table, a fridge,
a desk and a basil pot: clearly done, not done, half done, the look-alike or wrong cup, a listed
mistake, a hand hiding the result, out of view, dark and blurred, a step back, a comparison with a
control cup), October 2026. Every configuration was right on every done, not done and wrong case
except where noted, and none said done when it wasn't. The scenes are clean, so treat the
differences as directional.

| Check                                  | Looks | Passed | Unsure right | Median | p90   |
| -------------------------------------- | ----- | ------ | ------------ | ------ | ----- |
| low, the old prompt (before)           | 90    | 87     | 6/9          | 1.8 s  | 2.5 s |
| low, the new prompt                    | 30    | 29     | 2/3          | 1.7 s  | 2.2 s |
| minimal                                | 60    | 56     | 2/6          | 1.3 s  | 1.5 s |
| low + criteria (first prompt)          | 60    | 59     | 5/6          | 2.1 s  | 2.7 s |
| low + criteria (careful look, final)   | 30    | 30     | 3/3          | 2.0 s  | 2.5 s |
| minimal + criteria (quick look, final) | 30    | 29     | 3/3          | 1.4 s  | 1.6 s |

Criteria cost about 0.3 s a look (their own call, about 1.4 s, is made once per step). The quick
look's one miss was a criterion that asked for the instruction's 5 mL. With the watcher's
schedule (quick looks while far, careful ones close, a confirming look at once), a simulation on
these latencies puts a done in front of the coach in 4.1 to 5.2 s instead of 6.6 s
([coach-plan.md](coach-plan.md)). Other models were not compared: on these scenes Robotics-ER 2 at
low left nothing to win.
- **Masks**: not supported. The documented mask prompt returned boxes or nothing, and base64 PNG
  masks came back corrupt, once looping to the output limit (260 s). Outlines stay boxes, or come
  from a segmenting finder (`CLIO_VISION_URL`). Polygons can be asked for at default thinking
  (4-12 s), too slow for live outlines.
- **JSON fences**: answers often come wrapped in ` ```json `; `parseModelJson` strips them,
  and structured output avoids them.
- **Preview limits**: no 429s in about 330 calls at two at a time; one 503, fine on retry.

## The action focus's measurements

While a step is focused, the headset asks `POST /api/vision/focus` about one sharp frame every 5 s:
Robotics-ER 2 at minimal thinking boxes the step's objects (up to 8, its show items first), writes
a new description of each, which is all jev is told about it from then on, and names the one thing
the learner should touch next. Measured on the first views of the four bench scenes (the fridge,
the photo and the drawn pH tables, the TV remote) with `apps/server/scripts/focus-look.ts`, which
asks about a step of each scene's saved plan, October 2026: 20 looks with 0 to 5 objects.
- **Latency**: median 2.4 s, 1.7 to 3.1 s: 1.7 to 2.0 s with 2 objects or none, 2.4 to 2.5 s with
  3, 2.3 to 3.1 s with 4 or 5. Each object costs its description, about 25 words. The server
  gives up at 8 s (504).
- **Boxes**: every listed object in view was found (confidence 0.95 to 0.99), the boxes tight on
  the bottles, cups, battery and cover, and within 0.01 of themselves from look to look. It boxed
  the battery still in the remote, never the black-and-gold look-alike on the desk; asked for pH
  test strips that weren't there, it said not found in 2 of 2 looks and never boxed the syringe
  (the thing to touch was then nothing once, cup B once).
- **The action item**: right in 12 of 12 looks where it was listed. For "Squeeze a few drops of
  BASE into cup B", whose show items put cup B first, it named the base bottle: what the hands
  act on, not where it goes. Left out of the request, the item was named on its own (`id: null`,
  a phrase of its own, the right box) in 4 of 6 looks; the other 2 named the listed remote that
  holds the missing battery, one of them after the prompt said "not what holds it".
- **Descriptions**: sharper than the plan's in every look. They add the neighbors that tell
  look-alikes apart ("to the left of the milk bottle", "between the purple indicator bottle and
  the base bottle") and the contents and state ("containing purple liquid"), and they correct the
  plan where the frame disagrees: step 2's plan had the base bottle "raised in the learner's
  hand", and the focus wrote "standing on the right behind cup C". The first prompt once placed
  the fridge door "on the left side of the frame", which is wrong as soon as the head turns; the
  prompt now says the frame moves with the head, and no description has done it since. They
  rarely give a size.

## Sources

Google's docs: [robotics overview](https://ai.google.dev/gemini-api/docs/robotics-overview),
[spatial understanding](https://ai.google.dev/gemini-api/docs/robotics-spatial),
[video and progress](https://ai.google.dev/gemini-api/docs/robotics-video-progress),
[streaming](https://ai.google.dev/gemini-api/docs/robotics-streaming),
[the model page](https://ai.google.dev/gemini-api/docs/models/gemini-robotics-er-2-preview);
the [Robotics-ER 2 notebook](https://github.com/google-gemini/robotics-samples/blob/main/Getting%20Started/gemini_robotics_er.ipynb)
and the [model card](https://deepmind.google/models/model-cards/gemini-robotics-er-2/).
