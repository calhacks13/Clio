import { describe, expect, it } from 'vitest';
import {
  parseStepCheck,
  STEP_CHECK_INSTRUCTION,
  stepCheckContents,
  stepCheckJsonSchema,
} from '../src/services/step-check';

// The step watcher's question to the planner's model: is this step's done-when state visible,
// with the right object, and if not, did the learner do something else?

const IMAGE = { mimeType: 'image/jpeg' as const, data: '/9j/4AAQSkZJRgABAQ' };
const NEWER = { mimeType: 'image/webp' as const, data: 'UklGRiQAAABXRUJQ' };
const START = { mimeType: 'image/jpeg' as const, data: '/9j/START' };
const STEP = {
  id: 'acid-to-a',
  instruction: 'Add vinegar to cup A.',
  doneWhen: 'Cup A has turned pink.',
};

describe('STEP_CHECK_INSTRUCTION', () => {
  it.each([
    'You judge one step of a hands-on task from headset camera views',
    'Tell it apart from look-alikes by how it looks',
    'a white bottle of vinegar is not a white bottle of water',
    'they did something else: the step is not done',
    'With views from the start of the step, compare them with now',
    'Count a hand only where you see it',
    '[y, x] normalized to 0-1000, on the object itself, not on the hand',
    'in at most 15 words',
    'e.g. "opened the red cap, not the blue one"',
    'from 0 (not started) to 100 (done)',
    'done: only when the done-when state is clearly visible in the newest view',
    'not_done: when it is visibly not yet true, or the learner did something else',
    'unsure: when you cannot tell',
    'out of view, cut off by the edge or hidden',
    'hands are in the way',
    'What you cannot see is unsure, not not_done.',
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

  it('shows the start of the step, then now, each under a heading', () => {
    const [content] = stepCheckContents({
      goal: 'Test an acid',
      step: STEP,
      images: [IMAGE],
      before: [START],
    });
    expect(content?.parts).toEqual([
      { text: 'Start of the step:' },
      { inlineData: { mimeType: 'image/jpeg', data: '/9j/START' } },
      { text: 'Now:' },
      { inlineData: { mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRgABAQ' } },
      {
        text: [
          'Goal: Test an acid',
          'Step: Add vinegar to cup A.',
          'Done when: Cup A has turned pink.',
          'Attached: 1 view from the start of the step, then 1 camera view from now, newest last.',
          'Is the step done?',
        ].join('\n'),
      },
    ]);
  });

  it("says what the step's objects look like and which mistakes look like success", () => {
    const [content] = stepCheckContents({
      goal: 'Get a yogurt drink from the fridge',
      step: { id: 'take', instruction: 'Take the yogurt drink off the shelf.' },
      images: [IMAGE],
      objects: [
        { id: 'yogurt', label: 'yogurt drink', look: ' small white bottle with a pink cap ' },
        { id: 'fridge', label: 'fridge', look: 'fridge' },
        { id: 'shelf', label: 'middle shelf', look: '' },
      ],
      confusions: ['That is the milk. Take the small bottle with the pink cap.'],
    });
    expect(content?.parts?.at(-1)?.text).toBe(
      [
        'Goal: Get a yogurt drink from the fridge',
        'Step: Take the yogurt drink off the shelf.',
        'Done when: not given. Judge whether the step itself has visibly been carried out.',
        "The step's objects look like this:",
        '- yogurt drink: small white bottle with a pink cap',
        '- fridge',
        '- middle shelf',
        'Mistakes that look like success (not done):',
        '- That is the milk. Take the small bottle with the pink cap.',
        "Attached: 1 camera view from the learner's headset, newest last.",
        'Is the step done?',
      ].join('\n'),
    );
  });
});

describe('stepCheckJsonSchema', () => {
  it('asks for the evidence and what it sees before the verdict, in the subset Gemini supports', () => {
    const schema = stepCheckJsonSchema();
    expect(Object.keys(schema.properties as object)).toEqual([
      'evidence',
      'observation',
      'wrong',
      'progress',
      'verdict',
    ]);
    expect(schema).toEqual({
      type: 'object',
      properties: {
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
          description: 'What you see that decides it, in at most 15 words (160 characters)',
        },
        wrong: {
          type: 'string',
          description: 'What the learner did instead, in at most 12 words; empty if nothing',
        },
        progress: { type: 'integer', description: 'How far along the step is, 0 to 100' },
        verdict: { type: 'string', enum: ['done', 'not_done', 'unsure'] },
      },
      required: ['evidence', 'observation', 'wrong', 'progress', 'verdict'],
    });
    expect(JSON.stringify(schema)).not.toMatch(/maxLength|pattern|default|additionalProperties/);
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

  it('reads progress, what went wrong, and the evidence as [x, y] in 0..1', () => {
    const answer = {
      evidence: { label: 'milk carton', point: [450, 610] },
      observation: 'They hold the milk carton.',
      wrong: ' picked up the milk, not the yogurt drink ',
      progress: 20,
      verdict: 'not_done',
    };
    expect(parseStepCheck(JSON.stringify(answer))).toEqual({
      verdict: 'not_done',
      observation: 'They hold the milk carton.',
      progress: 20,
      wrong: 'picked up the milk, not the yogurt drink',
      evidence: { label: 'milk carton', point: [0.61, 0.45] },
    });
  });

  it('treats an empty or "none" wrong as nothing wrong', () => {
    for (const wrong of ['', '  ', 'none', 'None.', 'N/A', 'nothing']) {
      const answer = { verdict: 'done', observation: 'Cup A is pink.', wrong, progress: 100 };
      expect(parseStepCheck(JSON.stringify(answer))).toEqual({
        verdict: 'done',
        observation: 'Cup A is pink.',
        progress: 100,
      });
    }
  });

  it('never calls a step done when the learner did something else', () => {
    const answer = { verdict: 'done', observation: 'B is pink.', wrong: 'used cup B, not cup A' };
    expect(parseStepCheck(JSON.stringify(answer))).toMatchObject({
      verdict: 'not_done',
      wrong: 'used cup B, not cup A',
    });
    const unsure = { verdict: 'unsure', observation: 'Blurred.', wrong: 'maybe cup B' };
    expect(parseStepCheck(JSON.stringify(unsure)).verdict).toBe('unsure');
  });

  it('keeps progress whole and within 0 to 100, and drops one that is not a number', () => {
    const progress = (value: unknown) =>
      parseStepCheck(JSON.stringify({ verdict: 'not_done', observation: 'o', progress: value }))
        .progress;
    expect([progress(42.6), progress(-5), progress(140), progress('50'), progress(null)]).toEqual([
      43,
      0,
      100,
      undefined,
      undefined,
    ]);
  });

  it('reads evidence that is null or unusable as null', () => {
    const evidence = (value: unknown) =>
      parseStepCheck(JSON.stringify({ verdict: 'unsure', observation: 'o', evidence: value }))
        .evidence;
    expect(evidence(null)).toBeNull();
    expect(evidence({ label: 'cup', point: [500] })).toBeNull();
    expect(evidence({ label: ' ', point: [500, 500] })).toBeNull();
    expect(evidence({ point: [500, 500] })).toBeNull();
    expect(evidence({ label: 'cup', point: [1200, -10] })).toEqual({ label: 'cup', point: [0, 1] });
  });

  it('cuts an observation longer than 160 characters, and a wrong longer than 120', () => {
    const long = 'the cup is still purple '.repeat(10);
    const { observation, wrong } = parseStepCheck(
      JSON.stringify({ verdict: 'not_done', observation: long, wrong: long }),
    );
    expect(observation).toHaveLength(160);
    expect(long.startsWith(observation)).toBe(true);
    expect(wrong).toHaveLength(120);
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
