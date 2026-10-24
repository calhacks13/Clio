import {
  type StepCheckRequest,
  type StepCheckResponse,
  StepCheckVerdictSchema,
} from '@clio/protocol';
import type { Content, Part } from '@google/genai';
import { isRecord, parseModelJson } from './model-json';
import type { JsonSchema } from './plan-schema';

// Pure: the step check (POST /api/plans/check). The headset's step watcher sends fresh camera
// views of one step, and the planner's model says whether the step's done-when state is visible.
// The watcher only passes a `done` on to the coach as a suggestion; it never completes a step.

export type StepCheckAnswer = Pick<StepCheckResponse, 'verdict' | 'observation'>;

/** The observation goes to the coach as part of a narration, so it stays short. */
export const MAX_OBSERVATION_CHARS = 160;

const VERDICTS = StepCheckVerdictSchema.options;

export const STEP_CHECK_INSTRUCTION = [
  'You judge one step of a hands-on task from headset camera views. The learner wears the ' +
    'headset, so the views show what they see, newest last. You get the goal, the step, and ' +
    'its done-when state: how the work looks once the step is finished.',
  '',
  '- `verdict`:',
  '  - done: only when the done-when state is clearly visible in the views.',
  '  - not_done: when it is visibly not yet true.',
  '  - unsure: when you cannot tell, for example the place is out of view, hands are in the ' +
    'way, or the view is blurred or dark.',
  '- `observation`: what you see that decides it, in at most 15 words.',
  '',
  'Never guess. Judge only what the views show, not what the learner has probably done by now.',
].join('\n');

function checkText({ goal, step, images }: StepCheckRequest): string {
  const doneWhen = step.doneWhen?.trim();
  const count = images.length;
  return [
    `Goal: ${goal}`,
    `Step: ${step.instruction}`,
    doneWhen
      ? `Done when: ${doneWhen}`
      : 'Done when: not given. Judge whether the step itself has visibly been carried out.',
    `Attached: ${count} camera view${count === 1 ? '' : 's'} from the learner's headset, newest last.`,
    'Is the step done?',
  ].join('\n');
}

/** One user turn: the views first, then the goal, the step and its done-when state. */
export function stepCheckContents(request: StepCheckRequest): Content[] {
  const parts: Part[] = request.images.map((image) => ({
    inlineData: { mimeType: image.mimeType, data: image.data },
  }));
  parts.push({ text: checkText(request) });
  return [{ role: 'user', parts }];
}

/** Structured output for the answer. Gemini has no maxLength, so the limit is in words. */
export function stepCheckJsonSchema(): JsonSchema {
  return {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: [...VERDICTS] },
      observation: {
        type: 'string',
        description: `What you see that decides it, in at most 15 words (${MAX_OBSERVATION_CHARS} characters)`,
      },
    },
    required: ['verdict', 'observation'],
  };
}

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
  return {
    verdict: verdict.data,
    observation: answer.observation.trim().slice(0, MAX_OBSERVATION_CHARS),
  };
}
