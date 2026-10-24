import { describe, expect, it } from 'vitest';
import {
  parseStepCheck,
  STEP_CHECK_INSTRUCTION,
  stepCheckContents,
  stepCheckJsonSchema,
} from '../src/services/step-check';

// The step watcher's question to the planner's model: is this step's done-when state visible?

const IMAGE = { mimeType: 'image/jpeg' as const, data: '/9j/4AAQSkZJRgABAQ' };
const NEWER = { mimeType: 'image/webp' as const, data: 'UklGRiQAAABXRUJQ' };
const STEP = {
  id: 'acid-to-a',
  instruction: 'Add vinegar to cup A.',
  doneWhen: 'Cup A has turned pink.',
};

describe('STEP_CHECK_INSTRUCTION', () => {
  it.each([
    'You judge one step of a hands-on task from headset camera views',
    'done: only when the done-when state is clearly visible',
    'not_done: when it is visibly not yet true',
    'unsure: when you cannot tell',
    'out of view',
    'hands are in the way',
    'in at most 15 words',
    'Never guess.',
  ])('covers %j', (phrase) => {
    expect(STEP_CHECK_INSTRUCTION).toContain(phrase);
  });
});

describe('stepCheckContents', () => {
  it('sends the views first, newest last, then the goal, the step and its done-when state', () => {
    expect(
      stepCheckContents({ goal: 'Test an acid and a base', step: STEP, images: [IMAGE, NEWER] }),
    ).toEqual([
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRgABAQ' } },
          { inlineData: { mimeType: 'image/webp', data: 'UklGRiQAAABXRUJQ' } },
          {
            text: [
              'Goal: Test an acid and a base',
              'Step: Add vinegar to cup A.',
              'Done when: Cup A has turned pink.',
              "Attached: 2 camera views from the learner's headset, newest last.",
              'Is the step done?',
            ].join('\n'),
          },
        ],
      },
    ]);
  });

  it('judges by the instruction when the step has no done-when state', () => {
    const step = { id: 'acid-to-a', instruction: 'Add vinegar to cup A.', doneWhen: '  ' };
    const [content] = stepCheckContents({ goal: 'Test an acid', step, images: [IMAGE] });
    expect(content?.parts?.at(-1)?.text).toBe(
      [
        'Goal: Test an acid',
        'Step: Add vinegar to cup A.',
        'Done when: not given. Judge whether the step itself has visibly been carried out.',
        "Attached: 1 camera view from the learner's headset, newest last.",
        'Is the step done?',
      ].join('\n'),
    );
  });
});

describe('stepCheckJsonSchema', () => {
  it('asks for a verdict and a short observation, in the subset Gemini supports', () => {
    expect(stepCheckJsonSchema()).toEqual({
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['done', 'not_done', 'unsure'] },
        observation: {
          type: 'string',
          description: 'What you see that decides it, in at most 15 words (160 characters)',
        },
      },
      required: ['verdict', 'observation'],
    });
  });
});

describe('parseStepCheck', () => {
  it('reads a verdict and an observation, fenced or not', () => {
    expect(parseStepCheck('{"verdict":"done","observation":"Cup A is pink."}')).toEqual({
      verdict: 'done',
      observation: 'Cup A is pink.',
    });
    expect(
      parseStepCheck('```json\n{"verdict":"unsure","observation":" A hand covers cup A. "}\n```'),
    ).toEqual({ verdict: 'unsure', observation: 'A hand covers cup A.' });
  });

  it('cuts an observation longer than 160 characters', () => {
    const long = 'the cup is still purple '.repeat(10);
    const { observation } = parseStepCheck(
      JSON.stringify({ verdict: 'not_done', observation: long }),
    );
    expect(observation).toHaveLength(160);
    expect(long.startsWith(observation)).toBe(true);
  });

  it('throws a readable error on text that is not JSON', () => {
    expect(() => parseStepCheck('Yes, it looks done.')).toThrow(/^The response was not valid JSON/);
  });

  it('throws a readable error on a verdict it does not know', () => {
    expect(() => parseStepCheck('{"verdict":"maybe","observation":"Hard to say."}')).toThrow(
      'The step check verdict "maybe" is not one of done, not_done, unsure',
    );
    expect(() => parseStepCheck('{"observation":"Hard to say."}')).toThrow(
      'The step check verdict (missing) is not one of done, not_done, unsure',
    );
  });

  it('throws a readable error without an observation or an object', () => {
    expect(() => parseStepCheck('{"verdict":"done"}')).toThrow(
      'The step check answer has no observation',
    );
    expect(() => parseStepCheck('["done"]')).toThrow('The step check answer is not an object');
  });
});
