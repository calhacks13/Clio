import { ACTION_VERBS, safeParseProcedure } from '@clio/protocol';
import type { GenerateContentParameters } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { createGeminiPlanner } from '../src/services/gemini-planner';
import { buildPlanCandidate } from '../src/services/plan-build';
import { PLANNER_SYSTEM_INSTRUCTION, plannerContents } from '../src/services/plan-prompt';
import { buildPlanJsonSchema } from '../src/services/plan-schema';
import { modelPlan } from './plan-fixtures';

const IMAGE = { mimeType: 'image/jpeg' as const, data: '/9j/4AAQSkZJRgABAQ' };

function fakeAi(text: string | undefined) {
  const calls: GenerateContentParameters[] = [];
  return {
    calls,
    models: {
      generateContent: async (params: GenerateContentParameters) => {
        calls.push(params);
        return { text };
      },
    },
  };
}

const base = (() => {
  const r = safeParseProcedure(
    buildPlanCandidate(modelPlan(), {
      id: 'refill-washer-fluid',
      goal: 'refill washer fluid',
      model: 'm',
      createdAt: '2026-10-24T03:15:02.123Z',
    }).candidate,
  );
  if (!r.ok) throw new Error(r.error);
  return r.procedure;
})();

describe('createGeminiPlanner', () => {
  it('sends the images inline, then the goal, with the plan schema as structured output', async () => {
    const ai = fakeAi('{"title":"x"}');
    const planner = createGeminiPlanner(ai, 'planner-x');
    expect(planner.model).toBe('planner-x');
    const text = await planner.draft({
      goal: 'Refill the washer fluid',
      context: 'It is a 2015 Civic.',
      images: [IMAGE],
    });
    expect(text).toBe('{"title":"x"}');
    expect(ai.calls).toEqual([
      {
        model: 'planner-x',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRgABAQ' } },
              {
                text:
                  'Goal: Refill the washer fluid\n' +
                  'What the learner said about their setup: It is a 2015 Civic.\n' +
                  "Attached: 1 current camera view from the learner's headset.\n" +
                  'Write the lesson plan as JSON.',
              },
            ],
          },
        ],
        config: {
          systemInstruction: PLANNER_SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          responseJsonSchema: buildPlanJsonSchema('plan'),
        },
      },
    ]);
  });

  it('asks for only the remaining steps when revising, with the revision schema', async () => {
    const ai = fakeAi('{}');
    await createGeminiPlanner(ai, 'planner-x').draft({
      goal: 'Refill the washer fluid',
      images: [],
      revision: { reason: 'They found a funnel', base, fromStepIndex: 1 },
    });
    const call = ai.calls[0];
    expect(call?.config?.responseJsonSchema).toEqual(buildPlanJsonSchema('revision'));
    expect(call?.contents).toEqual([
      {
        role: 'user',
        parts: [
          {
            text: [
              'Revise a lesson that is in progress.',
              'Goal: Refill the washer fluid',
              'Why the plan must change: They found a funnel',
              'Steps already done (they stay as they are; do not repeat them):',
              '1. open-cap: Flip open the blue washer fluid cap.',
              'The rest of the old plan, which you are replacing:',
              '2. pour-fluid: Pour the fluid into the reservoir.',
              '3. close-cap: Close the washer fluid cap.',
              'Objects already declared (reuse these ids; declare a new object only if a new step needs it):',
              '- washer_cap (washer cap): blue cap with a windshield symbol',
              '- coolant_cap (coolant cap): yellow cap with a warning symbol',
              '- fluid_jug (fluid jug): blue plastic jug of washer fluid',
              'No camera views are attached; assume the setup is unchanged.',
              'Return only the new remaining steps and any NEW objects. New step ids must not be: open-cap.',
            ].join('\n'),
          },
        ],
      },
    ]);
  });

  it('replays its previous answer and the errors when retrying', () => {
    const contents = plannerContents({
      goal: 'Refill the washer fluid',
      images: [],
      revision: { reason: 'r', base, fromStepIndex: 1 },
      retry: { previousText: '{"steps":[]}', errors: '✖ Unknown object "ghost"' },
    });
    expect(contents.slice(1)).toEqual([
      { role: 'model', parts: [{ text: '{"steps":[]}' }] },
      {
        role: 'user',
        parts: [
          {
            text:
              'Your JSON did not pass validation. Fix these errors and return the complete corrected JSON:\n' +
              '✖ Unknown object "ghost"\n' +
              'Paths refer to the merged plan: your first step is steps[1] and your first new object is objects[3].',
          },
        ],
      },
    ]);
  });

  it('fails when Gemini returns no text', async () => {
    await expect(
      createGeminiPlanner(fakeAi(undefined), 'm').draft({ goal: 'Refill it', images: [] }),
    ).rejects.toThrow(/empty/);
  });
});

describe('PLANNER_SYSTEM_INSTRUCTION', () => {
  it.each([
    'Meta Quest 3',
    'ghost hands',
    'robot',
    '3 to 10 steps',
    'exactly one physical action per step',
    'at most 15 words',
    'Declare every object',
    'lowercase slugs',
    '"detect"',
    'tracking.query',
    'Prefer it for visual state changes',
    'pinch_near / hand_near',
    'only when `object` has tracking.moves = true',
    '0 to 2 plausible errors',
    'y up, z toward the learner',
    'hot surfaces, live electrical parts or sharp blades',
    '`warnings`',
    'safe preparatory plan',
  ])('covers %j', (phrase) => {
    expect(PLANNER_SYSTEM_INSTRUCTION).toContain(phrase);
  });

  it('explains every action verb with its meaning and arguments', () => {
    for (const [verb, spec] of Object.entries(ACTION_VERBS)) {
      expect(PLANNER_SYSTEM_INSTRUCTION).toContain(verb);
      expect(PLANNER_SYSTEM_INSTRUCTION).toContain(spec.means);
    }
    expect(PLANNER_SYSTEM_INSTRUCTION).toContain('- pour(object, target): ');
    expect(PLANNER_SYSTEM_INSTRUCTION).toContain('- lift(object?): ');
    expect(PLANNER_SYSTEM_INSTRUCTION).toContain('- wait(): ');
    expect(PLANNER_SYSTEM_INSTRUCTION).toContain('- other(object?, target?): ');
  });
});
