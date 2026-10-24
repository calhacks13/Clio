import { type Procedure, ProcedureSchema } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { plannerModelNames } from '../src/services/bench';
import {
  describePlan,
  JUDGE_INSTRUCTION,
  judgeContents,
  judgeJsonSchema,
  parseJudgement,
} from '../src/services/bench-judge';
import { modelPlan } from './plan-fixtures';

// The planner bench's judge: what it is shown, and how its answer is read.

const IMAGE = { mimeType: 'image/jpeg' as const, data: '/9j/4AAQSkZJRgABAQ==' };

const PROCEDURE: Procedure = ProcedureSchema.parse({
  ...modelPlan(),
  schema: 'clio.procedure/1',
  id: 'refill',
  version: 1,
  origin: {
    kind: 'generated',
    goal: 'Refill the washer fluid',
    model: 'planner-test',
    createdAt: '2026-10-24T03:15:02.000Z',
  },
});

describe('describePlan', () => {
  it('lists the warnings, objects and every step field that decides correctness', () => {
    const text = describePlan(PROCEDURE, ['Make sure the engine is off and cool.']);
    expect(text.split('\n').slice(0, 7)).toEqual([
      'Title: Refill washer fluid',
      'Summary: Open the washer reservoir, pour in fluid, and close it.',
      'Warnings: Make sure the engine is off and cool.',
      'Objects:',
      '- washer_cap (washer cap, item): blue cap with a windshield symbol',
      '- coolant_cap (coolant cap, item): yellow cap with a warning symbol',
      '- fluid_jug (fluid jug, container): blue plastic jug of washer fluid',
    ]);
    expect(text).toContain(
      [
        '1. open-cap: Flip open the blue washer fluid cap.',
        '   Done when: The blue cap is flipped open and the reservoir neck is visible.',
        '   Action: twist(washer_cap) ccw 0.5',
        '   Outlines: blue washer fluid cap',
        '   Mistakes: wrong_cap: That is the coolant cap. Use the blue one.',
      ].join('\n'),
    );
    expect(text).toContain('   Action: pour(fluid_jug → washer_cap)');
    expect(text).toContain('   Coach notes: Watch the level through the reservoir wall.');
  });

  it('marks the steps a re-plan kept as already done', () => {
    const text = describePlan(PROCEDURE, [], 1);
    expect(text).toContain('1. open-cap [already done]: Flip open');
    expect(text).toContain('2. pour-fluid: Pour the fluid');
    expect(text).toContain('Warnings: (none)');
  });
});

describe('judgeContents', () => {
  it('sends the views first, then the goal, the plan and the numbered expectations', () => {
    const [content] = judgeContents({
      scenario: {
        goal: 'Refill the washer fluid',
        context: 'The jug is behind the battery.',
        expect: ['Uses the blue cap', 'Never touches the coolant cap'],
      },
      procedure: PROCEDURE,
      warnings: [],
      images: [IMAGE],
    });
    expect(content?.parts?.[0]).toEqual({ inlineData: IMAGE });
    const text = content?.parts?.[1]?.text ?? '';
    expect(text.startsWith('Goal: Refill the washer fluid\n')).toBe(true);
    expect(text).toContain(
      'What the learner said about their setup: The jug is behind the battery.',
    );
    expect(text).toContain('Attached: the 1 camera view the planner saw.');
    expect(text).toContain('THE PLAN\nTitle: Refill washer fluid');
    expect(text).toContain(
      'EXPECTATIONS\n1. Uses the blue cap\n2. Never touches the coolant cap\n\nGrade the plan',
    );
  });

  it('explains a re-plan', () => {
    const [content] = judgeContents({
      scenario: {
        goal: 'Refill the washer fluid',
        expect: ['Adds a funnel'],
        revise: { base: PROCEDURE, fromStepIndex: 2, reason: 'Fluid spilled' },
      },
      procedure: PROCEDURE,
      warnings: [],
      images: [],
    });
    const text = content?.parts?.[0]?.text ?? '';
    expect(text).toContain('No camera views');
    expect(text).toContain(
      'The first 2 steps were already done; the planner rewrote the rest because: Fluid spilled',
    );
  });

  it('asks for a reason before each yes or no', () => {
    expect(JUDGE_INSTRUCTION).toContain('Judge what the plan says, not what the planner');
    const items = (judgeJsonSchema().properties as Record<string, { items: unknown }>).criteria
      ?.items as { properties: Record<string, unknown> };
    expect(Object.keys(items.properties)).toEqual(['n', 'reason', 'met']);
  });
});

describe('parseJudgement', () => {
  const EXPECT = ['Uses the blue cap', 'Warns about heat', 'Has a done-when per step'];

  it('matches answers to expectations by number, in any order', () => {
    const answer = parseJudgement(
      JSON.stringify({
        criteria: [
          { n: 3, reason: 'All steps have one.', met: true },
          { n: 1, reason: ' open-cap uses washer_cap. ', met: true },
          { n: 2, reason: 'No warning about heat.', met: false },
        ],
        issues: ['  ', 'pour-fluid has no funnel'],
      }),
      EXPECT,
    );
    expect(answer).toEqual({
      criteria: [
        { expectation: 'Uses the blue cap', met: true, reason: 'open-cap uses washer_cap.' },
        { expectation: 'Warns about heat', met: false, reason: 'No warning about heat.' },
        { expectation: 'Has a done-when per step', met: true, reason: 'All steps have one.' },
      ],
      issues: ['pour-fluid has no funnel'],
      passed: false,
    });
  });

  it('falls back to order when the numbers are missing, and passes when all are met', () => {
    const answer = parseJudgement(
      '```json\n{"criteria":[{"met":true,"reason":"a"},{"met":true,"reason":"b"}]}\n```',
      EXPECT.slice(0, 2),
    );
    expect(answer.passed).toBe(true);
    expect(answer.issues).toEqual([]);
    expect(answer.criteria.map((c) => c.reason)).toEqual(['a', 'b']);
  });

  it('counts a skipped or malformed answer as not met', () => {
    const answer = parseJudgement(
      JSON.stringify({ criteria: [{ n: 1, met: 'yes', reason: 'x' }], issues: [] }),
      EXPECT.slice(0, 2),
    );
    expect(answer.criteria.map((c) => c.met)).toEqual([false, false]);
    expect(answer.passed).toBe(false);
  });

  it('throws a readable error for an unusable answer', () => {
    expect(() => parseJudgement('nope', EXPECT)).toThrow(/not valid JSON/);
    expect(() => parseJudgement('{"issues":[]}', EXPECT)).toThrow(
      'The judge answer has no criteria',
    );
  });
});

describe('plannerModelNames', () => {
  it('keeps Gemini text models, newest first, and always the configured ones', () => {
    expect(
      plannerModelNames(
        [
          'models/gemini-3.5-flash-lite',
          'models/gemini-3.8-flash',
          'models/gemini-3.8-flash-tts',
          'models/gemini-3.1-flash-image',
          'models/gemini-robotics-er-2-preview',
          'models/gemma-4-31b-it',
          'models/lyria-3.5',
          'models/gemini-2.5-computer-use-preview-10-2025',
          'models/gemini-3.10-flash',
        ],
        ['gemini-pro-latest'],
      ),
    ).toEqual([
      'gemini-robotics-er-2-preview',
      'gemini-pro-latest',
      'gemini-3.10-flash',
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite',
    ]);
  });
});
