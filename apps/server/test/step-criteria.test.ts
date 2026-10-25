import { describe, expect, it } from 'vitest';
import {
  MAX_CRITERIA,
  parseStepCriteria,
  STEP_CRITERIA_INSTRUCTION,
  stepCriteriaContents,
  stepCriteriaJsonSchema,
} from '../src/services/step-criteria';

// A step's done-when state split into criteria a camera can confirm, asked once when the step
// gains focus, so every look judges each one.

const IMAGE = { mimeType: 'image/jpeg' as const, data: '/9j/START' };
const STEP = {
  id: 'base-to-b',
  instruction: 'Add a little base to cup B, and leave cup C as it is.',
  doneWhen: 'Cup B has turned blue-green while cup C stays purple.',
};

describe('STEP_CRITERIA_INSTRUCTION', () => {
  it.each([
    'Write 2 to 4 criteria',
    'something visible in a single view of the finished state',
    'say exactly what the done-when says',
    'Never add a condition the done-when does not state',
    'which one it must be and how to tell',
    'what the step must leave as it was',
    'Write end states, not actions',
    'a learner may still hold the bottle once the step is done',
    'no amounts or levels from the instruction',
    'Leave out what a camera cannot see',
  ])('covers %j', (phrase) => {
    expect(STEP_CRITERIA_INSTRUCTION).toContain(phrase);
  });
});

describe('stepCriteriaContents', () => {
  it('sends the views from the start of the step, then the step and its hints', () => {
    expect(
      stepCriteriaContents({
        goal: 'Test an acid and a base',
        step: STEP,
        images: [IMAGE],
        objects: [
          { id: 'cup_b', label: 'cup B', look: 'clear cup marked B' },
          { id: 'cup_c', label: 'cup C', look: 'cup C' },
        ],
        confusions: ['Base went into cup C too.'],
      }),
    ).toEqual([
      {
        role: 'user',
        parts: [
          { inlineData: IMAGE },
          {
            text: [
              'Goal: Test an acid and a base',
              'Step: Add a little base to cup B, and leave cup C as it is.',
              'Done when: Cup B has turned blue-green while cup C stays purple.',
              "The step's objects look like this:",
              '- cup B: clear cup marked B',
              '- cup C',
              'Mistakes that look like success:',
              '- Base went into cup C too.',
              'Attached: 1 view from the start of the step.',
              'Write the criteria.',
            ].join('\n'),
          },
        ],
      },
    ]);
  });

  it('works from the words alone, and from the instruction without a done-when', () => {
    const [content] = stepCriteriaContents({
      goal: 'Test an acid',
      step: { id: 'acid', instruction: 'Add vinegar to cup A.' },
    });
    expect(content?.parts).toEqual([
      {
        text: [
          'Goal: Test an acid',
          'Step: Add vinegar to cup A.',
          'Done when: not given. Use the step itself.',
          'No views attached.',
          'Write the criteria.',
        ].join('\n'),
      },
    ]);
  });
});

describe('stepCriteriaJsonSchema', () => {
  it('asks for 1 to 4 strings', () => {
    expect(stepCriteriaJsonSchema()).toEqual({
      type: 'object',
      properties: {
        criteria: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_CRITERIA,
          items: { type: 'string', description: 'One visible end state, at most 15 words' },
        },
      },
      required: ['criteria'],
    });
  });
});

describe('parseStepCriteria', () => {
  it('trims, drops blanks, repeats and non-strings, and keeps at most four', () => {
    const answer = {
      criteria: [
        " Cup B's liquid is blue-green. ",
        '',
        "cup b's liquid is blue-green.",
        7,
        'Cup C is still purple.',
        'Cup A is still pink.',
        'The base bottle is capped.',
        'One too many.',
      ],
    };
    expect(parseStepCriteria(`\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``)).toEqual([
      "Cup B's liquid is blue-green.",
      'Cup C is still purple.',
      'Cup A is still pink.',
      'The base bottle is capped.',
    ]);
  });

  it('throws a readable error without criteria', () => {
    expect(() => parseStepCriteria('{"criteria":[" "]}')).toThrow(
      'The step criteria answer has no criteria',
    );
    expect(() => parseStepCriteria('{"steps":[]}')).toThrow(
      'The step criteria answer has no criteria',
    );
    expect(() => parseStepCriteria('Cup B is blue-green.')).toThrow(/not valid JSON/);
  });
});
