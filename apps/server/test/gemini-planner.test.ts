import { ACTION_VERBS, safeParseProcedure } from '@clio/protocol';
import type { GenerateContentParameters } from '@google/genai';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { thinkingConfig } from '../src/services/gemini';
import {
  createGeminiPlanner,
  PLAN_THINKING,
  PLAN_TIMEOUT_MS,
  STEP_CHECK_TIMEOUT_MS,
} from '../src/services/gemini-planner';
import { buildPlanCandidate } from '../src/services/plan-build';
import { PLANNER_SYSTEM_INSTRUCTION, plannerContents } from '../src/services/plan-prompt';
import { buildPlanJsonSchema } from '../src/services/plan-schema';
import {
  STEP_CHECK_INSTRUCTION,
  stepCheckContents,
  stepCheckJsonSchema,
} from '../src/services/step-check';
import { modelPlan } from './plan-fixtures';

const IMAGE = { mimeType: 'image/jpeg' as const, data: '/9j/4AAQSkZJRgABAQ' };
const CHECK = {
  goal: 'Refill the washer fluid',
  step: {
    id: 'open-cap',
    instruction: 'Flip open the blue washer fluid cap.',
    doneWhen: 'The blue cap is flipped open.',
  },
  images: [IMAGE],
};

function fakeAi(text: string | undefined) {
  const calls: GenerateContentParameters[] = [];
  return {
    calls,
    models: {
      generateContent: async (params: GenerateContentParameters) => {
        calls.push(params);
        const signal = params.config?.abortSignal;
        if (signal?.aborted) throw signal.reason;
        return { text };
      },
    },
  };
}

/** Records the timeouts the planner asks for; `expired` hands out signals that already fired. */
function spyOnTimeouts({ expired = false } = {}) {
  const spy = vi.spyOn(AbortSignal, 'timeout');
  if (expired) {
    spy.mockImplementation(() =>
      AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    );
  }
  onTestFinished(() => spy.mockRestore());
  return spy;
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
          abortSignal: expect.any(AbortSignal),
        },
      },
    ]);
  });

  it('gives a draft 45 s and a step check 8 s', async () => {
    const timeouts = spyOnTimeouts();
    const planner = createGeminiPlanner(fakeAi('{}'), 'm');
    await planner.draft({ goal: 'Refill it', images: [] });
    await planner.checkStep?.(CHECK);
    expect([PLAN_TIMEOUT_MS, STEP_CHECK_TIMEOUT_MS]).toEqual([45_000, 8_000]);
    expect(timeouts.mock.calls).toEqual([[45_000], [8_000]]);
  });

  it('gives a draft the time its request has left when the request says', async () => {
    const timeouts = spyOnTimeouts();
    await createGeminiPlanner(fakeAi('{}'), 'm').draft({
      goal: 'Refill it',
      images: [],
      timeoutMs: 21_437,
    });
    expect(timeouts.mock.calls).toEqual([[21_437]]);
  });

  it('says how long it waited when Gemini does not answer in time', async () => {
    spyOnTimeouts({ expired: true });
    const planner = createGeminiPlanner(fakeAi('{}'), 'm');
    await expect(planner.draft({ goal: 'Refill it', images: [] })).rejects.toThrow(
      'Gemini did not answer within 45 s',
    );
    await expect(planner.checkStep?.(CHECK)).rejects.toThrow('Gemini did not answer within 8 s');
    await expect(
      planner.draft({ goal: 'Refill it', images: [], timeoutMs: 21_437 }),
    ).rejects.toThrow('Gemini did not answer within 21 s');
  });

  it('checks a step with the same model, the views and the step-check schema', async () => {
    const answer = '{"verdict":"done","observation":"The blue cap is open."}';
    const ai = fakeAi(answer);
    const planner = createGeminiPlanner(ai, 'planner-x');
    expect(await planner.checkStep?.(CHECK)).toBe(answer);
    expect(ai.calls).toEqual([
      {
        model: 'planner-x',
        contents: stepCheckContents(CHECK),
        config: {
          systemInstruction: STEP_CHECK_INSTRUCTION,
          responseMimeType: 'application/json',
          responseJsonSchema: stepCheckJsonSchema(),
          abortSignal: expect.any(AbortSignal),
        },
      },
    ]);
  });

  it('asks for only the remaining steps when revising, with the revision schema', async () => {
    const ai = fakeAi('{}');
    await createGeminiPlanner(ai, 'planner-x').draft({
      goal: 'Refill the washer fluid',
      images: [],
      revision: { reason: 'They found a funnel', base, fromStepIndex: 1, skippedStepIds: [] },
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

  it('lists the kept steps that were skipped apart from the done ones', () => {
    const revisionPrompt = (fromStepIndex: number) =>
      plannerContents({
        goal: 'Refill the washer fluid',
        images: [],
        revision: { reason: 'r', base, fromStepIndex, skippedStepIds: ['open-cap'] },
      })[0]?.parts?.[0]?.text;
    const skippedHeading =
      'Steps that were skipped and NOT done (they stay in the list; plan for their outcome if ' +
      'the goal still needs it):';
    expect(revisionPrompt(2)).toContain(
      [
        'Steps already done (they stay as they are; do not repeat them):',
        '2. pour-fluid: Pour the fluid into the reservoir.',
        skippedHeading,
        '1. open-cap: Flip open the blue washer fluid cap.',
        'The rest of the old plan, which you are replacing:',
        '3. close-cap: Close the washer fluid cap.',
      ].join('\n'),
    );
    expect(revisionPrompt(1)).toContain(
      [
        'Steps already done (they stay as they are; do not repeat them):',
        '(none)',
        skippedHeading,
        '1. open-cap: Flip open the blue washer fluid cap.',
        'The rest of the old plan, which you are replacing:',
      ].join('\n'),
    );
    expect(revisionPrompt(1)).toContain('New step ids must not be: open-cap.');
  });

  it('replays its previous answer and the errors when retrying', () => {
    const contents = plannerContents({
      goal: 'Refill the washer fluid',
      images: [],
      revision: { reason: 'r', base, fromStepIndex: 1, skippedStepIds: [] },
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

  it('thinks as hard as each stage needs, and lets the bench choose', async () => {
    const er = 'gemini-robotics-er-2-preview';
    const ai = fakeAi('{}');
    const planner = createGeminiPlanner(ai, er);
    const revision = { reason: 'r', base, fromStepIndex: 1, skippedStepIds: [] };
    await planner.draft({ goal: 'Refill it', images: [] });
    await planner.draft({ goal: 'Refill it', images: [], stage: 'first' });
    await planner.draft({ goal: 'Refill it', images: [], stage: 'rest', revision });
    await planner.draft({ goal: 'Refill it', images: [], revision });
    expect(ai.calls.map((c) => c.config?.thinkingConfig)).toEqual(
      [PLAN_THINKING.full, PLAN_THINKING.first, PLAN_THINKING.rest, PLAN_THINKING.full].map(
        (level) => (level ? thinkingConfig(er, level).thinkingConfig : undefined),
      ),
    );
    expect(ai.calls.map((c) => c.config?.responseJsonSchema)).toEqual([
      buildPlanJsonSchema('plan'),
      buildPlanJsonSchema('first'),
      buildPlanJsonSchema('revision'),
      buildPlanJsonSchema('revision'),
    ]);

    const tuned = fakeAi('{}');
    const bench = createGeminiPlanner(tuned, er, { thinking: { first: 'minimal', full: null } });
    await bench.draft({ goal: 'Refill it', images: [], stage: 'first' });
    await bench.draft({ goal: 'Refill it', images: [] });
    expect(tuned.calls.map((c) => c.config?.thinkingConfig)).toEqual([
      thinkingConfig(er, 'minimal').thinkingConfig,
      undefined,
    ]);
  });

  it('asks a first stage for the lesson in outline and its first step in full', () => {
    const contents = plannerContents({
      goal: 'Refill the washer fluid',
      images: [IMAGE, IMAGE],
      stage: 'first',
    });
    expect(contents[0]?.parts?.at(-1)?.text).toBe(
      [
        'Goal: Refill the washer fluid',
        "Attached: 2 current camera views from the learner's headset, numbered 1 to 2 in order.",
        'The lesson starts as soon as you answer. Its later steps are written in full ' +
          'afterwards, while the learner works on the first one. So:',
        '- `outline`: every step of the lesson in order, 3 to 10, one line each (id, ' +
          'instruction, doneWhen, targets). outline[0] is the first step.',
        '- `firstStep`: that first step written in full, with the same id as outline[0].',
        'Get the first step right: it starts from the scene as it is now, it names the right ' +
          'object so that a look-alike cannot pass for it, and its doneWhen is a state the ' +
          'camera will see.',
        'Write the lesson plan as JSON.',
      ].join('\n'),
    );
    const retry = plannerContents({
      goal: 'Refill the washer fluid',
      images: [],
      stage: 'first',
      retry: { previousText: '{}', errors: '✖ Invalid input at steps[2].targets[0]' },
    });
    expect(retry.at(-1)?.parts?.[0]?.text).toBe(
      'Your JSON did not pass validation. Fix these errors and return the complete corrected JSON:\n' +
        '✖ Invalid input at steps[2].targets[0]\n' +
        'Paths refer to the plan built from your answer: steps[0] is firstStep, and every later ' +
        'steps[n] is outline[n].',
    );
  });

  it('asks stage rest to write the outline in full, keeping the step under way', () => {
    const contents = plannerContents({
      goal: 'Refill the washer fluid',
      context: 'It is a 2015 Civic.',
      images: [IMAGE],
      stage: 'rest',
      revision: { reason: 'r', base, fromStepIndex: 1, skippedStepIds: [] },
    });
    expect(contents[0]?.parts?.at(-1)?.text).toBe(
      [
        'Write the rest of a lesson plan in full while the learner works on its first step.',
        'Goal: Refill the washer fluid',
        'What the learner said about their setup: It is a 2015 Civic.',
        'Under way or done (they stay as they are; do not repeat them):',
        '1. open-cap: Flip open the blue washer fluid cap. Done when: The blue cap is flipped ' +
          'open and the reservoir neck is visible. Uses: washer_cap.',
        'The outline of the remaining steps, written quickly so the lesson could start. It is ' +
          'the intended shape of the lesson: write every step in full, keeping its id and its ' +
          'place, and change it only where the camera views show it is wrong, incomplete or ' +
          'unsafe:',
        '2. pour-fluid: Pour the fluid into the reservoir. Done when: The blue fluid reaches ' +
          'the top mark on the reservoir. Uses: fluid_jug, washer_cap.',
        '3. close-cap: Close the washer fluid cap. Done when: The blue cap is shut flat on the ' +
          'reservoir. Uses: washer_cap.',
        'Objects already declared (reuse these ids; declare a new object only if a new step needs it):',
        '- washer_cap (washer cap): blue cap with a windshield symbol',
        '- coolant_cap (coolant cap): yellow cap with a warning symbol',
        '- fluid_jug (fluid jug): blue plastic jug of washer fluid',
        "Attached: 1 current camera view from the learner's headset.",
        'Return only the remaining steps, in full, and any NEW objects. New step ids must not ' +
          'be: open-cap. Write `warnings` as for a new plan, hazards in view first, without ' +
          'mentioning the outline or the step under way.',
      ].join('\n'),
    );
  });

  it('fails when Gemini returns no text', async () => {
    const planner = createGeminiPlanner(fakeAi(undefined), 'm');
    await expect(planner.draft({ goal: 'Refill it', images: [] })).rejects.toThrow(/empty/);
    await expect(planner.checkStep?.(CHECK)).rejects.toThrow(/empty/);
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
    'SHOW',
    'outlines in AR',
    'object finder',
    '`phrase`: 2 to 5 words',
    '`description`: one sentence of 12 to 30 words',
    'Too vague: "The washer fluid cap."',
    'on its own',
    'what tells it apart',
    'as it looks at that point in the task',
    '`doneWhen`: one sentence',
    'an end state a camera can confirm',
    '"the blue cap is off and lying on the fender"',
    'ends in a visible state',
    'make `prompt` match `doneWhen`',
    // Written for Robotics-ER 2: the scene as it is, look-alikes, hazards, and only what is there.
    'as things stand now',
    'do not plan that step again',
    'Declare only objects you can see',
    '`sightings`',
    '`point` [y, x]',
    'must not be pointed at',
    'a milk carton beside a yogurt drink',
    'make the mix-up one of its `mistakes`',
    'Name what tells the right object apart',
    'Describe a state, never an action',
    'not "baking soda is added"',
    'must not pass a look-alike',
    'not inside an opaque bottle, syringe or box',
    'Looking, comparing or checking is not a step of its own',
    'close a door, lid or cap that the task opens or uses',
    'Taking or using a look-alike',
    '`warnings` start with every hazard you can see',
    'sharp tools (knives, blades, scissors, needles)',
    'hot things (kettles, stoves, pans, irons)',
    'what it looks like, where it is, and what to do',
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
