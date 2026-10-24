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
(`gemini-3.8-live`): it sees the camera, listens and talks, and never waits on the other one.
Robotics-ER 2 is the smart model: it plans, watches each step, finds objects and answers the
questions the voice hands it. The voice delegates through tools that answer at once, and
Robotics-ER reports back as `[app]` messages when it has something: a plan, a refined plan, a step
that looks done or wrong, an answer.

| Model                          | API               | What Clio uses it for                                    |
| ------------------------------ | ----------------- | -------------------------------------------------------- |
| `gemini-3.8-live`              | Live (bidi)       | the voice: conversation, with the camera in view         |
| `gemini-robotics-er-2-preview` | `generateContent` | planning, the step watcher, the object finder, questions |
| `gemini-pro-latest`            | `generateContent` | the bench's judge: a different model grades the planner  |

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
| object finder (2 objects)   | 2.3 s               |              | 4.9 s          | 1.7 s       |
| full plan                   | 6.4 s, 8/12 met     | 10.1 s       | 18.8 s, 7/12   | 5.6 s, 4/12 |
| stage 1 card, step 1 starts | 2.7-3.9 s           | 5.3-9.1 s    |                |             |
| staged plan from the card   | 3.5 s, 24/27 met    | 6.2 s, 24/27 |                |             |
| pH outline tests the base   | 6 of 10, now 7 of 7 | 7 of 7       |                |             |

With thinking on, the step check repeatedly invented "the dropper is held in the learner's hand"
when no hand was in view. Pointing, boxes, yes/no state, counting and spatial relations were as
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
  every part of the goal, in order, fixed it (7 of 7). It still doesn't read cup A's pink as the
  acid test already done, so no pH plan keeps the spare cup C as the control.
- **Out of view**: models answered `not_done` rather than `unsure` when the target was cropped
  out of the frame; the step check says that hidden or out-of-view means unsure.
- **Masks**: not supported. The documented mask prompt returned boxes or nothing, and base64 PNG
  masks came back corrupt, once looping to the output limit (260 s). Outlines stay boxes, or come
  from a segmenting finder (`CLIO_VISION_URL`). Polygons can be asked for at default thinking
  (4-12 s), too slow for live outlines.
- **JSON fences**: answers often come wrapped in ` ```json `; `parseModelJson` strips them,
  and structured output avoids them.
- **Preview limits**: no 429s in about 330 calls at two at a time; one 503, fine on retry.

## Sources

Google's docs: [robotics overview](https://ai.google.dev/gemini-api/docs/robotics-overview),
[spatial understanding](https://ai.google.dev/gemini-api/docs/robotics-spatial),
[video and progress](https://ai.google.dev/gemini-api/docs/robotics-video-progress),
[streaming](https://ai.google.dev/gemini-api/docs/robotics-streaming),
[the model page](https://ai.google.dev/gemini-api/docs/models/gemini-robotics-er-2-preview);
the [Robotics-ER 2 notebook](https://github.com/google-gemini/robotics-samples/blob/main/Getting%20Started/gemini_robotics_er.ipynb)
and the [model card](https://deepmind.google/models/model-cards/gemini-robotics-er-2/).
