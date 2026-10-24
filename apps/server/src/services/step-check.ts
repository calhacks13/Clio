import {
  type StepCheckRequest,
  type StepCheckResponse,
  StepCheckVerdictSchema,
} from '@clio/protocol';
import type { Content, Part } from '@google/genai';
import { isRecord, parseModelJson } from './model-json';
import type { JsonSchema } from './plan-schema';
import { fromGeminiPoint } from './vision';

// Pure: the step check (POST /api/plans/check). The headset's step watcher sends fresh camera
// views of one step, and the planner's model says whether the step's done-when state is visible.
// The watcher only passes answers on to the coach as suggestions; it never completes a step.
//
// A look-alike must not pass for the real thing (the learner takes the milk when the step wants
// the yogurt drink), so the model is told what the step's objects look like and which mistakes
// look like success. It finds the object the learner is acting on, points at it, and says what
// they did instead when it is the wrong one. With views from when the step started it compares
// them with now, the way Robotics-ER is trained to detect success. Every look also names a hazard
// near the hands, whatever the step: Robotics-ER only reliably mentions a knife when asked
// (docs/robotics-er.md), and this way the watcher keeps an eye out at no extra cost.

export type StepCheckAnswer = Pick<
  StepCheckResponse,
  'verdict' | 'observation' | 'progress' | 'wrong' | 'evidence' | 'hazard'
>;

/** The observation goes to the coach as part of a narration, so it stays short. */
export const MAX_OBSERVATION_CHARS = 160;
/** What the learner did instead also goes to the coach. */
export const MAX_WRONG_CHARS = 120;
/** And so does a hazard. */
export const MAX_HAZARD_CHARS = 100;
const MAX_LABEL_CHARS = 60;

const VERDICTS = StepCheckVerdictSchema.options;

export const STEP_CHECK_INSTRUCTION = [
  'You judge one step of a hands-on task from headset camera views. The learner wears the ' +
    'headset, so the views show what they see, newest last. You get the goal, the step, its ' +
    'done-when state (how things look once the step is finished), and often what the ' +
    "step's objects look like and mistakes that look like success.",
  '',
  'How to judge:',
  "1. Find the step's object in the newest view and what the learner is doing with it. Tell " +
    'it apart from look-alikes by how it looks (color, shape, label, cap), not by what kind of ' +
    'thing it is: a white bottle of vinegar is not a white bottle of water.',
  '2. If the learner is holding or using a different object, or doing a listed mistake, they ' +
    'did something else: the step is not done.',
  '3. With views from the start of the step, compare them with now: what changed, and is that ' +
    'change the step being done?',
  '4. Count a hand only where you see it. Never assume one is holding something.',
  '',
  'Answer:',
  '- `hazard`: first, whatever the step, a danger in view where the learner works, even when it ' +
    'has nothing to do with the step and no hand is near it yet: a knife, blade or other sharp ' +
    'tool, something hot (a kettle, a stove, an iron), a live wire, broken glass, a spill. What ' +
    'it is and where, in at most 10 words. An empty string if none.',
  '- `evidence`: the object that decides it, in the newest view: its `label` and its `point`, ' +
    '[y, x] normalized to 0-1000, on the object itself, not on the hand. null when no object ' +
    'in view decides it.',
  '- `observation`: what you see that decides it, in at most 15 words.',
  '- `wrong`: when the learner did something else instead (the wrong object, a listed ' +
    'mistake), what they did in at most 12 words, e.g. "opened the red cap, not the blue ' +
    'one". Otherwise an empty string.',
  '- `progress`: how far along the step is, from 0 (not started) to 100 (done).',
  '- `verdict`:',
  '  - done: only when the done-when state is clearly visible in the newest view, with the ' +
    'right object.',
  '  - not_done: when it is visibly not yet true, or the learner did something else.',
  '  - unsure: when you cannot tell, for example the place or object the step is about is out ' +
    'of view, cut off by the edge or hidden, hands are in the way, or the view is blurred or ' +
    'dark. What you cannot see is unsure, not not_done.',
  '',
  'Never guess. Judge only what the views show, not what the learner has probably done by now.',
].join('\n');

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function checkText({ goal, step, images, before, objects, confusions }: StepCheckRequest): string {
  const doneWhen = step.doneWhen?.trim();
  const lines = [
    `Goal: ${goal}`,
    `Step: ${step.instruction}`,
    doneWhen
      ? `Done when: ${doneWhen}`
      : 'Done when: not given. Judge whether the step itself has visibly been carried out.',
  ];
  if (objects?.length) {
    lines.push("The step's objects look like this:");
    for (const { label, look } of objects) {
      const seen = look.trim();
      lines.push(seen && seen !== label.trim() ? `- ${label}: ${seen}` : `- ${label}`);
    }
  }
  if (confusions?.length) {
    lines.push('Mistakes that look like success (not done):');
    for (const c of confusions) lines.push(`- ${c.trim()}`);
  }
  const now = plural(images.length, 'camera view');
  lines.push(
    before?.length
      ? `Attached: ${plural(before.length, 'view')} from the start of the step, then ${now} from now, newest last.`
      : `Attached: ${now} from the learner's headset, newest last.`,
    'Is the step done?',
  );
  return lines.join('\n');
}

const imagePart = ({ mimeType, data }: StepCheckRequest['images'][number]): Part => ({
  inlineData: { mimeType, data },
});

/**
 * One user turn: the views first, then the goal, the step and its done-when state. With views
 * from the start of the step, each group gets a heading, the start first.
 */
export function stepCheckContents(request: StepCheckRequest): Content[] {
  const { images, before } = request;
  const parts: Part[] = before?.length
    ? [
        { text: 'Start of the step:' },
        ...before.map(imagePart),
        { text: 'Now:' },
        ...images.map(imagePart),
      ]
    : images.map(imagePart);
  parts.push({ text: checkText(request) });
  return [{ role: 'user', parts }];
}

/**
 * Structured output for the answer. Gemini has no maxLength, so limits are in words. The model
 * writes the fields in this order, so it points at the object and says what it sees before it
 * gives the verdict.
 */
export function stepCheckJsonSchema(): JsonSchema {
  return {
    type: 'object',
    properties: {
      hazard: {
        type: 'string',
        description: 'A danger in view where the learner works, in at most 10 words; empty if none',
      },
      evidence: {
        type: ['object', 'null'],
        description: 'The object that decides it, in the newest view',
        properties: {
          label: { type: 'string' },
          point: {
            type: 'array',
            items: { type: 'integer' },
            minItems: 2,
            maxItems: 2,
            description: '[y, x] on the object, 0 to 1000',
          },
        },
        required: ['label', 'point'],
      },
      observation: {
        type: 'string',
        description: `What you see that decides it, in at most 15 words (${MAX_OBSERVATION_CHARS} characters)`,
      },
      wrong: {
        type: 'string',
        description: 'What the learner did instead, in at most 12 words; empty if nothing',
      },
      progress: { type: 'integer', description: 'How far along the step is, 0 to 100' },
      verdict: { type: 'string', enum: [...VERDICTS] },
    },
    required: ['hazard', 'evidence', 'observation', 'wrong', 'progress', 'verdict'],
  };
}

/** Words a model writes in `wrong` when nothing went wrong. */
const NOTHING_WRONG = /^(?:none|nothing|n\/?a|null|no|-)?\.?$/i;
/** And in `hazard` when it sees none: "None visible", "No hazards." */
const NO_HAZARD =
  /^(?:none|nothing|n\/?a|null|no|-)?\.?$|^(?:no|none)\b.*\b(?:hazard|danger|visible|seen)/i;

/** Reads the model's answer. Throws a readable Error when it is not JSON or has a bad value. */
export function parseStepCheck(text: string): StepCheckAnswer {
  const json = parseModelJson(text);
  if (!json.ok) throw new Error(json.error);
  const answer = json.value;
  if (!isRecord(answer)) throw new Error('The step check answer is not an object');
  const verdict = StepCheckVerdictSchema.safeParse(answer.verdict);
  if (!verdict.success) {
    const given = answer.verdict === undefined ? '(missing)' : JSON.stringify(answer.verdict);
    throw new Error(`The step check verdict ${given} is not one of ${VERDICTS.join(', ')}`);
  }
  if (typeof answer.observation !== 'string') {
    throw new Error('The step check answer has no observation');
  }
  const wrong = typeof answer.wrong === 'string' ? answer.wrong.trim() : '';
  const hazard = typeof answer.hazard === 'string' ? answer.hazard.trim() : '';
  const progress = answer.progress;
  const evidence = parseEvidence(answer.evidence);
  const somethingElse = !NOTHING_WRONG.test(wrong);
  return {
    // The learner did something else: whatever the model concluded, that step is not done.
    verdict: somethingElse && verdict.data === 'done' ? 'not_done' : verdict.data,
    observation: answer.observation.trim().slice(0, MAX_OBSERVATION_CHARS),
    ...(typeof progress === 'number' && Number.isFinite(progress)
      ? { progress: Math.round(Math.min(100, Math.max(0, progress))) }
      : {}),
    ...(somethingElse ? { wrong: wrong.slice(0, MAX_WRONG_CHARS) } : {}),
    ...(NO_HAZARD.test(hazard) ? {} : { hazard: hazard.slice(0, MAX_HAZARD_CHARS) }),
    ...(evidence === undefined ? {} : { evidence }),
  };
}

/** `{ label, point: [y, x] in 0..1000 }` → ours, [x, y] in 0..1. Null for none or a bad one. */
function parseEvidence(raw: unknown): StepCheckAnswer['evidence'] {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || typeof raw.label !== 'string') return null;
  const point = fromGeminiPoint(raw.point);
  const label = raw.label.trim().slice(0, MAX_LABEL_CHARS);
  return point && label ? { label, point } : null;
}
