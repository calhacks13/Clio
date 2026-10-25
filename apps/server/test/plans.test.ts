import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ApiErrorSchema,
  ApiPaths,
  PlanResponseSchema,
  ProcedureListResponseSchema,
  ProcedureSchema,
  type StepCheckRequest,
  StepCheckResponseSchema,
  type StepCriteriaRequest,
  StepCriteriaResponseSchema,
} from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import type { Planner, PlannerRequest } from '../src/services/planner';
import type { StepChecker } from '../src/services/step-check';
import { type Harness, harness, steppingClock } from './harness';
import {
  modelFirstStage,
  modelPlan,
  modelRestObjects,
  modelRestStage,
  modelReview,
  modelRevision,
  modelWrittenStep,
} from './plan-fixtures';
import { procedureInput, writeJson } from './procedure-fixtures';

function scriptedPlanner(
  ...answers: Array<string | Error>
): Planner & { requests: PlannerRequest[] } {
  const requests: PlannerRequest[] = [];
  return {
    model: 'planner-test',
    requests,
    async draft(request) {
      requests.push(request);
      const answer = answers[Math.min(requests.length - 1, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer ?? '';
    },
  };
}

function scriptedChecker(
  answer: string | Error,
  criteria: string | Error = '{"criteria":["The blue cap is open."]}',
): StepChecker & { checks: StepCheckRequest[]; criteriaRequests: StepCriteriaRequest[] } {
  const checks: StepCheckRequest[] = [];
  const criteriaRequests: StepCriteriaRequest[] = [];
  return {
    model: 'checker-test',
    checks,
    criteriaRequests,
    async check(request) {
      checks.push(request);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async criteria(request) {
      criteriaRequests.push(request);
      if (criteria instanceof Error) throw criteria;
      return criteria;
    },
  };
}

const PLAN = JSON.stringify(modelPlan());
const IMAGE = { mimeType: 'image/jpeg' as const, data: '/9j/4AAQSkZJRgABAQ' };
const ORIGIN = {
  kind: 'generated',
  goal: 'Refill the washer fluid',
  model: 'planner-test',
  createdAt: '2026-10-24T03:15:02.123Z',
};

async function planHarness(planner: Planner): Promise<Harness> {
  return harness({ planner, now: steppingClock('2026-10-24T03:15:02.123Z') });
}

async function postPlan(h: Harness, body: unknown) {
  const res = await h.request('POST', ApiPaths.plans, body);
  return { res, body: (await res.json()) as unknown };
}

describe('POST /api/plans', () => {
  it('answers 503 when no Gemini key is configured', async () => {
    const h = await harness();
    const res = await h.request('POST', ApiPaths.plans, { goal: 'Refill the washer fluid' });
    expect(res.status).toBe(503);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('gemini_not_configured');
  });

  it('plans from the goal, context and images, then stores the plan under a slug id', async () => {
    const planner = scriptedPlanner(PLAN);
    const h = await planHarness(planner);
    const { res, body } = await postPlan(h, {
      goal: 'Refill the washer fluid',
      context: 'It is a 2015 Civic.',
      images: [IMAGE],
    });
    expect(res.status).toBe(200);
    const plan = PlanResponseSchema.parse(body);
    expect(plan.planId).toBe('refill-the-washer-fluid');
    expect(plan.procedure.id).toBe('refill-the-washer-fluid');
    expect(plan.procedure.origin).toEqual(ORIGIN);
    expect(plan.procedure.steps.map((s) => s.id)).toEqual(['open-cap', 'pour-fluid', 'close-cap']);
    expect(plan.procedure.steps[0]?.doneWhen).toBe(
      'The blue cap is flipped open and the reservoir neck is visible.',
    );
    expect(plan.warnings).toEqual(['Make sure the engine is off and cool.']);
    expect(planner.requests).toEqual([
      {
        goal: 'Refill the washer fluid',
        context: 'It is a 2015 Civic.',
        images: [IMAGE],
        timeoutMs: 40_000,
      },
    ]);

    const stored = ProcedureSchema.parse(
      JSON.parse(await h.readData('plans', 'refill-the-washer-fluid.json')),
    );
    expect(stored).toEqual(plan.procedure);
    const fetched = await h.request('GET', ApiPaths.plan('refill-the-washer-fluid'));
    expect(ProcedureSchema.parse(await fetched.json())).toEqual(plan.procedure);
    const list = ProcedureListResponseSchema.parse(
      await (await h.request('GET', ApiPaths.procedures)).json(),
    );
    expect(list.procedures).toEqual([
      {
        id: 'refill-the-washer-fluid',
        version: 1,
        title: 'Refill washer fluid',
        summary: 'Open the washer reservoir, pour in fluid, and close it.',
        stepCount: 3,
        source: 'generated',
      },
    ]);
  });

  it('never reuses an id: the same goal again gets -2, and curated ids are skipped', async () => {
    const h = await planHarness(scriptedPlanner(PLAN));
    await writeJson(h.proceduresDir, 'fold-towel.json', procedureInput('fold-towel'));
    const first = PlanResponseSchema.parse(
      (await postPlan(h, { goal: 'Refill the washer fluid' })).body,
    );
    const second = PlanResponseSchema.parse(
      (await postPlan(h, { goal: 'Refill the washer fluid' })).body,
    );
    const towel = PlanResponseSchema.parse((await postPlan(h, { goal: 'Fold towel' })).body);
    expect([first.planId, second.planId, towel.planId]).toEqual([
      'refill-the-washer-fluid',
      'refill-the-washer-fluid-2',
      'fold-towel-2',
    ]);
    expect(second.procedure.id).toBe('refill-the-washer-fluid-2');
  });

  it('retries once with the validation errors, then succeeds', async () => {
    const broken = modelPlan();
    broken.steps[0] = { ...broken.steps[0], targets: ['ghost'] } as (typeof broken.steps)[0];
    const brokenText = JSON.stringify(broken);
    const planner = scriptedPlanner(brokenText, PLAN);
    const h = await planHarness(planner);
    const { res } = await postPlan(h, { goal: 'Refill the washer fluid' });
    expect(res.status).toBe(200);
    expect(planner.requests).toHaveLength(2);
    expect(planner.requests[1]?.retry?.previousText).toBe(brokenText);
    expect(planner.requests[1]?.retry?.errors).toContain('Unknown object "ghost"');
  });

  it('retries when the answer is not JSON', async () => {
    const planner = scriptedPlanner('Sure! Here is a plan.', PLAN);
    const h = await planHarness(planner);
    expect((await postPlan(h, { goal: 'Refill the washer fluid' })).res.status).toBe(200);
    expect(planner.requests[1]?.retry?.errors).toMatch(/^The response was not valid JSON/);
  });

  it('answers 502 with the errors when the retry is invalid too, and saves nothing', async () => {
    const h = await planHarness(scriptedPlanner('{"title":"x"}'));
    const { res, body } = await postPlan(h, { goal: 'Refill the washer fluid' });
    expect(res.status).toBe(502);
    const error = ApiErrorSchema.parse(body).error;
    expect(error.code).toBe('plan_invalid');
    expect((error.details as { errors: string }).errors).toMatch(/steps/);
    await expect(readdir(join(h.dataDir, 'plans'))).rejects.toThrow(/ENOENT/);
  });

  it('answers 502 when the planner call fails', async () => {
    const h = await planHarness(scriptedPlanner(new Error('quota exceeded')));
    const { res, body } = await postPlan(h, { goal: 'Refill the washer fluid' });
    expect(res.status).toBe(502);
    expect(ApiErrorSchema.parse(body).error).toEqual({
      code: 'upstream_failed',
      message: 'Planner request failed: quota exceeded',
    });
  });

  it('logs each plan with its step count, goal and latency', async () => {
    const h = await harness({
      planner: scriptedPlanner(PLAN),
      now: steppingClock('2026-10-24T03:15:02.000Z', 1_000),
    });
    await postPlan(h, { goal: 'Refill the washer fluid' });
    expect(h.logger.lines).toContain(
      'info plan refill-the-washer-fluid: 3 steps from "Refill the washer fluid" in 3000 ms',
    );
  });

  // Each clock reading is `stepMs` later: the request starts, then each planner call starts.
  const slowHarness = (planner: Planner, stepMs: number) =>
    harness({ planner, now: steppingClock('2026-10-24T03:15:02.000Z', stepMs) });

  it('gives the draft and its retry one 40 s budget between them', async () => {
    const planner = scriptedPlanner('Sure! Here is a plan.', PLAN);
    const h = await slowHarness(planner, 10_000);
    expect((await postPlan(h, { goal: 'Refill the washer fluid' })).res.status).toBe(200);
    expect(planner.requests.map((r) => r.timeoutMs)).toEqual([30_000, 20_000]);
  });

  it('answers 504 instead of retrying when less than 10 s of the budget is left', async () => {
    const planner = scriptedPlanner('Sure! Here is a plan.', PLAN);
    const h = await slowHarness(planner, 20_000);
    const { res, body } = await postPlan(h, { goal: 'Refill the washer fluid' });
    expect(res.status).toBe(504);
    const error = ApiErrorSchema.parse(body).error;
    expect(error.code).toBe('plan_timeout');
    expect(error.message).toBe(
      'The planner ran out of time: its plan was invalid and too little time was left to retry',
    );
    expect((error.details as { errors: string }).errors).toMatch(
      /^The response was not valid JSON/,
    );
    expect(planner.requests).toHaveLength(1);
    await expect(readdir(join(h.dataDir, 'plans'))).rejects.toThrow(/ENOENT/);
  });

  it('validates the request', async () => {
    const h = await planHarness(scriptedPlanner(PLAN));
    expect((await postPlan(h, { goal: 'no' })).res.status).toBe(400);
    const tooMany = { goal: 'Refill the washer fluid', images: [IMAGE, IMAGE, IMAGE, IMAGE] };
    expect((await postPlan(h, tooMany)).res.status).toBe(400);
  });
});

describe('POST /api/plans with revise', () => {
  async function withBasePlan(...answers: string[]) {
    const planner = scriptedPlanner(PLAN, ...answers);
    const h = await planHarness(planner);
    await postPlan(h, { goal: 'Refill the washer fluid' });
    return { h, planner };
  }

  const revise = (planId: string, fromStepIndex = 1) => ({
    goal: 'Refill the washer fluid',
    revise: { planId, fromStepIndex, reason: 'They found a funnel' },
  });

  it('keeps the done steps, asks only for the rest, and saves <root>-r1', async () => {
    const { h, planner } = await withBasePlan(JSON.stringify(modelRevision()));
    const base = ProcedureSchema.parse(
      await (await h.request('GET', ApiPaths.plan('refill-the-washer-fluid'))).json(),
    );
    const { res, body } = await postPlan(h, revise('refill-the-washer-fluid'));
    expect(res.status).toBe(200);
    const plan = PlanResponseSchema.parse(body);
    expect(plan.planId).toBe('refill-the-washer-fluid-r1');
    expect(plan.procedure.origin).toEqual({ ...ORIGIN, revisionOf: 'refill-the-washer-fluid' });
    expect(plan.procedure.steps[0]).toEqual(base.steps[0]);
    expect(plan.procedure.steps.map((s) => s.id)).toEqual([
      'open-cap',
      'open-cap-2',
      'pour-slowly',
    ]);
    expect(plan.procedure.objects.map((o) => o.id)).toEqual([
      'washer_cap',
      'coolant_cap',
      'fluid_jug',
      'funnel',
    ]);
    expect(plan.warnings).toEqual(['Wipe up any spilled fluid.']);
    expect(planner.requests[1]).toEqual({
      goal: 'Refill the washer fluid',
      images: [],
      timeoutMs: 40_000,
      revision: { reason: 'They found a funnel', base, fromStepIndex: 1, skippedStepIds: [] },
    });
    expect(JSON.parse(await h.readData('plans', 'refill-the-washer-fluid-r1.json')).id).toBe(
      'refill-the-washer-fluid-r1',
    );
  });

  it('numbers later revisions from the same root', async () => {
    const answer = JSON.stringify(modelRevision());
    const { h } = await withBasePlan(answer, answer);
    await postPlan(h, revise('refill-the-washer-fluid'));
    const { body } = await postPlan(h, revise('refill-the-washer-fluid-r1'));
    const plan = PlanResponseSchema.parse(body);
    expect(plan.planId).toBe('refill-the-washer-fluid-r2');
    expect(plan.procedure.origin).toMatchObject({ revisionOf: 'refill-the-washer-fluid-r1' });
  });

  it('records the plan it revised as the parent, though the base keeps the first id', async () => {
    const answer = JSON.stringify(modelRevision());
    const { h } = await withBasePlan(answer, answer);
    const first = PlanResponseSchema.parse(
      (await postPlan(h, revise('refill-the-washer-fluid'))).body,
    );
    // The headset sends the running plan, which keeps the id the lesson started with.
    const base = { ...first.procedure, id: 'refill-the-washer-fluid' };
    const request = revise(first.planId);
    const { body } = await postPlan(h, { ...request, revise: { ...request.revise, base } });
    const plan = PlanResponseSchema.parse(body);
    expect(plan.planId).toBe('refill-the-washer-fluid-r2');
    expect(plan.procedure.origin).toMatchObject({ revisionOf: 'refill-the-washer-fluid-r1' });
  });

  it('tells the planner which kept steps were skipped rather than done', async () => {
    const { h, planner } = await withBasePlan(JSON.stringify(modelRevision()));
    const request = revise('refill-the-washer-fluid');
    const { res } = await postPlan(h, {
      ...request,
      revise: { ...request.revise, skippedStepIds: ['open-cap'] },
    });
    expect(res.status).toBe(200);
    expect(planner.requests[1]?.revision?.skippedStepIds).toEqual(['open-cap']);
  });

  /** A revision for procedureInput(), whose only object is cup_a. */
  const WAVE = JSON.stringify({
    objects: [],
    steps: [
      {
        id: 'wave',
        instruction: 'Wave at cup A.',
        doneWhen: 'A hand waves above cup A.',
        targets: ['cup_a'],
        action: { verb: 'point_at', object: 'cup_a' },
        show: [],
        success: { type: 'confirm', prompt: 'A hand waves above cup A' },
        mistakes: [],
      },
    ],
    warnings: [],
  });

  it('revises curated procedures too', async () => {
    const planner = scriptedPlanner(WAVE);
    const h = await planHarness(planner);
    await writeJson(h.proceduresDir, 'demo.json', procedureInput('demo'));
    const { res, body } = await postPlan(h, revise('demo', 1));
    expect(res.status).toBe(200);
    const plan = PlanResponseSchema.parse(body);
    expect(plan.planId).toBe('demo-r1');
    expect(plan.procedure.steps.map((s) => s.id)).toEqual(['touch-cup', 'wave']);
  });

  it('clamps fromStepIndex past the end and says so', async () => {
    const { h, planner } = await withBasePlan(JSON.stringify(modelRevision()));
    const { body } = await postPlan(h, revise('refill-the-washer-fluid', 9));
    const plan = PlanResponseSchema.parse(body);
    expect(planner.requests[1]?.revision?.fromStepIndex).toBe(3);
    expect(plan.procedure.steps).toHaveLength(5);
    expect(plan.warnings[0]).toBe('fromStepIndex 9 is past the end of the plan; kept all 3 steps');
  });

  it('revises the plan as it stands now when the request carries it as base', async () => {
    const { h, planner } = await withBasePlan(JSON.stringify(modelRevision()));
    const stored = ProcedureSchema.parse(
      await (await h.request('GET', ApiPaths.plan('refill-the-washer-fluid'))).json(),
    );
    // The coach reworded the first step and dropped the last one during the lesson.
    const [first, second] = stored.steps;
    const edited = { ...stored, steps: [{ ...first, instruction: 'Pop the blue cap.' }, second] };
    const { res, body } = await postPlan(h, {
      ...revise('refill-the-washer-fluid'),
      revise: { ...revise('refill-the-washer-fluid').revise, base: edited },
    });
    expect(res.status).toBe(200);
    const base = ProcedureSchema.parse(edited);
    expect(planner.requests[1]?.revision).toEqual({
      reason: 'They found a funnel',
      base,
      fromStepIndex: 1,
      skippedStepIds: [],
    });
    const plan = PlanResponseSchema.parse(body);
    expect(plan.planId).toBe('refill-the-washer-fluid-r1');
    expect(plan.procedure.steps[0]).toEqual(base.steps[0]);
    expect(plan.procedure.steps.map((s) => s.id)).toEqual([
      'open-cap',
      'open-cap-2',
      'pour-slowly',
    ]);
  });

  it('keeps the same fromStepIndex clamp with a base, and needs no stored plan', async () => {
    const planner = scriptedPlanner(WAVE);
    const h = await planHarness(planner);
    const base = procedureInput('coach-lesson');
    const { res, body } = await postPlan(h, {
      goal: 'Refill the washer fluid',
      revise: { planId: 'coach-lesson', fromStepIndex: 7, reason: 'They found a funnel', base },
    });
    expect(res.status).toBe(200);
    expect(planner.requests[0]?.revision?.fromStepIndex).toBe(2);
    const plan = PlanResponseSchema.parse(body);
    expect(plan.planId).toBe('coach-lesson-r1');
    expect(plan.procedure.origin).toMatchObject({ revisionOf: 'coach-lesson' });
    expect(plan.procedure.steps.map((s) => s.id)).toEqual(['touch-cup', 'done', 'wave']);
    expect(plan.warnings[0]).toBe('fromStepIndex 7 is past the end of the plan; kept all 2 steps');
  });

  it('names the revision after the plan it revises, not the id inside the base', async () => {
    const h = await planHarness(scriptedPlanner(WAVE));
    const { body } = await postPlan(h, {
      goal: 'Refill the washer fluid',
      revise: {
        planId: 'demo-lesson',
        fromStepIndex: 1,
        reason: 'They found a funnel',
        base: procedureInput('demo'),
      },
    });
    const plan = PlanResponseSchema.parse(body);
    expect(plan.planId).toBe('demo-lesson-r1');
    expect(plan.procedure.origin).toMatchObject({ revisionOf: 'demo-lesson' });
  });

  it('answers 404 for an unknown plan and 400 for an unsafe id', async () => {
    const h = await planHarness(scriptedPlanner(PLAN));
    expect((await postPlan(h, revise('nope'))).res.status).toBe(404);
    expect((await postPlan(h, revise('../../etc'))).res.status).toBe(400);
  });
});

describe('POST /api/plans in two stages', () => {
  const FIRST = JSON.stringify(modelFirstStage());
  const first = { goal: 'Refill the washer fluid', images: [IMAGE, IMAGE], stage: 'first' };

  it('starts with the first step from its card, the rest in outline, and where it saw the objects', async () => {
    const planner = scriptedPlanner(FIRST);
    const h = await planHarness(planner);
    const { res, body } = await postPlan(h, first);
    expect(res.status).toBe(200);
    const plan = PlanResponseSchema.parse(body);
    expect(plan.planId).toBe('refill-the-washer-fluid');
    expect(plan.outlineFrom).toBe(1);
    expect(plan.procedure.steps.map((s) => [s.id, s.success.type, s.show.length])).toEqual([
      ['open-cap', 'confirm', 1],
      ['pour-fluid', 'confirm', 0],
      ['close-cap', 'confirm', 0],
    ]);
    expect(plan.procedure.steps[0]?.mistakes.map((m) => [m.kind, m.when])).toEqual([
      [
        'wrong_cap',
        {
          type: 'hand_near',
          object: 'coolant_cap',
          hand: 'either',
          point: 'pinch',
          radius: 0.06,
          dwellMs: 700,
        },
      ],
    ]);
    expect(plan.procedure.objects.map((o) => [o.id, o.kind, o.tracking?.query])).toEqual(
      modelFirstStage().objects.map((card) => [card.id, 'item', card.look]),
    );
    expect(plan.sightings).toEqual([
      { objectId: 'washer_cap', view: 0, point: [0.25, 0.4], box: [0.23, 0.38, 0.27, 0.42] },
      { objectId: 'coolant_cap', view: 1, point: [0.8, 0.6], box: [0.7, 0.5, 0.9, 0.7] },
    ]);
    expect(planner.requests).toEqual([
      {
        goal: 'Refill the washer fluid',
        images: [IMAGE, IMAGE],
        stage: 'first',
        timeoutMs: 40_000,
      },
    ]);
    expect(h.logger.lines).toContainEqual(
      expect.stringMatching(/^info plan refill-the-washer-fluid \(stage first\): 3 steps/),
    );
    const stored = ProcedureSchema.parse(
      JSON.parse(await h.readData('plans', 'refill-the-washer-fluid.json')),
    );
    expect(stored).toEqual(plan.procedure);
  });

  it('writes the outline in full as a revision, with a minute to think and retry', async () => {
    const planner = scriptedPlanner(FIRST, JSON.stringify(modelRestStage()));
    const h = await harness({
      planner,
      planRest: 'single',
      now: steppingClock('2026-10-24T03:15:02.123Z'),
    });
    const started = PlanResponseSchema.parse((await postPlan(h, first)).body);
    const { res, body } = await postPlan(h, {
      goal: 'Refill the washer fluid',
      images: [IMAGE],
      stage: 'rest',
      revise: {
        planId: started.planId,
        fromStepIndex: 1,
        reason: 'Write the outline in full',
        base: started.procedure,
      },
    });
    expect(res.status).toBe(200);
    const plan = PlanResponseSchema.parse(body);
    expect(plan.planId).toBe('refill-the-washer-fluid-r1');
    expect(plan.procedure.steps[0]).toEqual(started.procedure.steps[0]);
    expect(plan.procedure.steps.map((s) => s.id)).toEqual([
      'open-cap',
      'open-cap-2',
      'pour-slowly',
    ]);
    // The washer cap's card is written in full; the coolant cap's stays a card.
    expect(plan.procedure.objects.map((o) => [o.id, o.label, o.placement])).toEqual([
      ['washer_cap', 'washer cap', { method: 'detect', hint: 'front left of the engine bay' }],
      ['coolant_cap', 'coolant cap', { method: 'detect' }],
      ['fluid_jug', 'fluid jug', { method: 'detect' }],
      ['funnel', 'funnel', { method: 'detect' }],
    ]);
    expect(plan.procedure.objects[0]?.tracking?.query).toBe('blue cap with a windshield symbol');
    expect(plan).not.toHaveProperty('outlineFrom');
    expect(plan).not.toHaveProperty('sightings');
    expect(planner.requests[1]).toEqual({
      goal: 'Refill the washer fluid',
      images: [IMAGE],
      stage: 'rest',
      timeoutMs: 60_000,
      revision: {
        reason: 'Write the outline in full',
        base: started.procedure,
        fromStepIndex: 1,
        skippedStepIds: [],
      },
    });
  });

  it('says where a whole plan saw its objects too', async () => {
    const answer = { ...modelPlan(), sightings: modelFirstStage().sightings };
    const h = await planHarness(scriptedPlanner(JSON.stringify(answer)));
    const plan = PlanResponseSchema.parse(
      (await postPlan(h, { goal: 'Refill the washer fluid', images: [IMAGE] })).body,
    );
    expect(plan.sightings?.map((s) => s.objectId)).toEqual(['washer_cap']);
    expect(plan).not.toHaveProperty('outlineFrom');
  });

  it('answers 400 for a rest without a plan, or a first stage that revises', async () => {
    const h = await planHarness(scriptedPlanner(FIRST));
    const rest = await postPlan(h, { goal: 'Refill the washer fluid', stage: 'rest' });
    expect(rest.res.status).toBe(400);
    expect(ApiErrorSchema.parse(rest.body).error.code).toBe('invalid_stage');
    const revising = await postPlan(h, {
      goal: 'Refill the washer fluid',
      stage: 'first',
      revise: { planId: 'refill-the-washer-fluid', fromStepIndex: 1, reason: 'r' },
    });
    expect(revising.res.status).toBe(400);
    expect(ApiErrorSchema.parse(revising.body).error.code).toBe('invalid_stage');
  });
});

describe('POST /api/plans stage rest in parallel', () => {
  const FIRST = JSON.stringify(modelFirstStage());
  type Answer = string | Error;
  /** Answers each call by what it asks for: stage first, a part of stage rest, or the rest whole. */
  function partPlanner(answers: {
    review?: Answer[];
    objects?: Answer;
    step?: (index: number, attempt: number) => Answer;
    rest?: Answer;
  }): Planner & { requests: PlannerRequest[] } {
    const requests: PlannerRequest[] = [];
    const tries = new Map<string, number>();
    return {
      model: 'planner-test',
      requests,
      async draft(request) {
        requests.push(request);
        const { part } = request;
        const key = part?.kind === 'step' ? `step-${part.index}` : (part?.kind ?? request.stage);
        const attempt = tries.get(String(key)) ?? 0;
        tries.set(String(key), attempt + 1);
        const answer = !part
          ? request.stage === 'first'
            ? FIRST
            : (answers.rest ?? new Error('no rest'))
          : part.kind === 'review'
            ? (answers.review?.[Math.min(attempt, (answers.review?.length ?? 1) - 1)] ??
              JSON.stringify(modelReview()))
            : part.kind === 'objects'
              ? (answers.objects ?? JSON.stringify(modelRestObjects()))
              : (answers.step?.(part.index, attempt) ??
                JSON.stringify(modelWrittenStep(part.index)));
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
  }

  async function staged(planner: Planner) {
    const h = await planHarness(planner);
    const started = PlanResponseSchema.parse(
      (await postPlan(h, { goal: 'Refill the washer fluid', images: [IMAGE], stage: 'first' }))
        .body,
    );
    const rest = await postPlan(h, {
      goal: 'Refill the washer fluid',
      images: [IMAGE],
      stage: 'rest',
      revise: {
        planId: started.planId,
        fromStepIndex: 1,
        reason: 'Write the outline in full',
        base: started.procedure,
      },
    });
    return { h, started, ...rest };
  }

  it('checks the outline, then writes each line and the card objects at once', async () => {
    const planner = partPlanner({});
    const { res, body, started } = await staged(planner);
    expect(res.status).toBe(200);
    const plan = PlanResponseSchema.parse(body);
    expect(plan.planId).toBe('refill-the-washer-fluid-r1');
    expect(plan.procedure.steps[0]).toEqual(started.procedure.steps[0]);
    expect(plan.procedure.steps.map((s) => [s.id, s.success.type])).toEqual([
      ['open-cap', 'confirm'],
      ['pour-fluid', 'confirm'],
      ['close-cap', 'hand_near'],
    ]);
    expect(plan.procedure.steps[1]?.show.map((item) => item.object)).toEqual([
      'fluid_jug',
      'washer_cap',
    ]);
    expect(plan.procedure.objects.map((o) => [o.id, o.placement])).toEqual([
      ['washer_cap', { method: 'detect', hint: 'front left of the engine bay' }],
      ['coolant_cap', { method: 'detect' }],
      ['fluid_jug', { method: 'detect' }],
    ]);
    expect(plan.warnings).toEqual(modelRestObjects().warnings);
    const parts = planner.requests.slice(1).map((r) => r.part);
    expect(parts.map((p) => p?.kind).sort()).toEqual(['objects', 'review', 'step', 'step']);
    // The review and the objects go first, together; the writers see the checked outline and
    // every object, and each new object is declared by the first line that uses it.
    expect(parts.slice(0, 2).map((p) => p?.kind)).toEqual(['objects', 'review']);
    const writers = parts.filter((p) => p?.kind === 'step');
    expect(writers.map((p) => [p.index, p.declare, p.objects.map((o) => o.id)])).toEqual([
      [0, ['fluid_jug'], ['washer_cap', 'coolant_cap', 'fluid_jug']],
      [1, [], ['washer_cap', 'coolant_cap', 'fluid_jug']],
    ]);
    expect(planner.requests[1]).toMatchObject({ stage: 'rest', revision: { fromStepIndex: 1 } });
  });

  it('asks a writer again with its errors, and keeps its line as an outline step if it fails twice', async () => {
    const broken = JSON.stringify({ step: { ...modelPlan().steps[2], targets: ['ghost'] } });
    const planner = partPlanner({
      step: (index) => (index === 1 ? broken : JSON.stringify(modelWrittenStep(index))),
    });
    const { body } = await staged(planner);
    const plan = PlanResponseSchema.parse(body);
    expect(plan.procedure.steps[2]).toMatchObject({
      id: 'close-cap',
      doneWhen: 'The blue cap is shut flat on the reservoir.',
      success: { type: 'confirm', prompt: 'The blue cap is shut flat on the reservoir.' },
      show: [],
    });
    const retries = planner.requests.filter((r) => r.part?.kind === 'step' && r.retry);
    expect(retries).toHaveLength(1);
    expect(retries[0]?.retry?.errors).toMatch(/Unknown object "ghost"/);
  });

  it('keeps the card objects as they are when the objects call fails', async () => {
    const planner = partPlanner({ objects: new Error('503 overloaded') });
    const { body, started } = await staged(planner);
    const plan = PlanResponseSchema.parse(body);
    expect(plan.procedure.objects.slice(0, 2)).toEqual(started.procedure.objects);
    expect(plan.warnings).toEqual([]);
  });

  it('writes the rest in one call when the outline cannot be checked', async () => {
    const planner = partPlanner({
      review: ['{"todo": []}', '{"still": "no outline"}'],
      rest: JSON.stringify(modelRestStage()),
    });
    const { res, body } = await staged(planner);
    expect(res.status).toBe(200);
    const plan = PlanResponseSchema.parse(body);
    expect(plan.procedure.steps.map((s) => s.id)).toEqual([
      'open-cap',
      'open-cap-2',
      'pour-slowly',
    ]);
    const reviews = planner.requests.filter((r) => r.part?.kind === 'review');
    expect(reviews.map((r) => r.retry?.errors)).toEqual([
      undefined,
      'The answer has no `outline` array',
    ]);
    expect(planner.requests.at(-1)).toMatchObject({ stage: 'rest' });
    expect(planner.requests.at(-1)).not.toHaveProperty('part');
  });
});

describe('GET /api/plans/:id', () => {
  it('serves only generated plans', async () => {
    const h = await harness();
    await writeJson(h.proceduresDir, 'demo.json', procedureInput('demo'));
    expect((await h.request('GET', ApiPaths.plan('demo'))).status).toBe(404);
    expect((await h.request('GET', '/api/plans/..%2Fx')).status).toBe(400);
  });
});

describe('POST /api/plans/check', () => {
  const check = (overrides: Partial<StepCheckRequest> = {}) => ({
    goal: 'Refill the washer fluid',
    step: {
      id: 'open-cap',
      instruction: 'Flip open the blue washer fluid cap.',
      doneWhen: 'The blue cap is flipped open.',
    },
    images: [IMAGE],
    ...overrides,
  });

  async function postCheck(h: Harness, body: unknown) {
    const res = await h.request('POST', ApiPaths.planCheck, body);
    return { res, body: (await res.json()) as unknown };
  }

  it('answers 503 without a step checker', async () => {
    const h = await harness({ planner: scriptedPlanner(PLAN) });
    const { res, body } = await postCheck(h, check());
    expect(res.status).toBe(503);
    expect(ApiErrorSchema.parse(body).error).toEqual({
      code: 'gemini_not_configured',
      message: 'Step checks is off: GEMINI_API_KEY is not set on the server',
    });
  });

  it("returns the model's verdict and observation, the model and the measured latency", async () => {
    const checker = scriptedChecker('{"verdict":"done","observation":"The blue cap is open."}');
    const h = await harness({ checker, now: steppingClock('2026-10-24T03:15:02.000Z', 250) });
    const { res, body } = await postCheck(h, check());
    expect(res.status).toBe(200);
    expect(StepCheckResponseSchema.parse(body)).toEqual({
      verdict: 'done',
      observation: 'The blue cap is open.',
      model: 'checker-test',
      latencyMs: 250,
    });
    expect(body).toEqual(StepCheckResponseSchema.parse(body));
    expect(checker.checks).toEqual([check()]);
  });

  it('passes the start of the step, the looks and the mix-ups on, and answers what went wrong', async () => {
    const checker = scriptedChecker(
      JSON.stringify({
        evidence: { label: 'red cap', point: [300, 700] },
        observation: 'They opened the red coolant cap.',
        wrong: 'opened the red coolant cap, not the blue one',
        progress: 10,
        verdict: 'not_done',
      }),
    );
    const h = await harness({ checker, now: steppingClock('2026-10-24T03:15:02.000Z', 250) });
    const request = check({
      before: [IMAGE],
      objects: [{ id: 'cap', label: 'blue cap', look: 'blue flip cap with a windshield symbol' }],
      confusions: ['Opening the red coolant cap instead'],
    });
    const { res, body } = await postCheck(h, request);
    expect(res.status).toBe(200);
    expect(StepCheckResponseSchema.parse(body)).toEqual({
      verdict: 'not_done',
      observation: 'They opened the red coolant cap.',
      progress: 10,
      wrong: 'opened the red coolant cap, not the blue one',
      evidence: { label: 'red cap', point: [0.7, 0.3] },
      model: 'checker-test',
      latencyMs: 250,
    });
    expect(checker.checks).toEqual([request]);
  });

  it('judges each criterion and holds back a done while one is not met', async () => {
    const checker = scriptedChecker(
      JSON.stringify({
        criteria: [
          { met: 'yes', seen: 'blue cap flipped up' },
          { met: 'no', seen: 'red cap open too' },
        ],
        observation: 'The blue cap is open.',
        verdict: 'done',
      }),
    );
    const h = await harness({ checker });
    const criteria = ['The blue cap is flipped open.', 'The red coolant cap is still closed.'];
    const { res, body } = await postCheck(h, check({ criteria }));
    expect(res.status).toBe(200);
    expect(StepCheckResponseSchema.parse(body)).toMatchObject({
      verdict: 'not_done',
      criteria: [
        { text: 'The blue cap is flipped open.', met: 'yes', seen: 'blue cap flipped up' },
        { text: 'The red coolant cap is still closed.', met: 'no', seen: 'red cap open too' },
      ],
    });
    expect(checker.checks[0]?.criteria).toEqual(criteria);
  });

  it('answers 502 when the model call fails', async () => {
    const h = await harness({ checker: scriptedChecker(new Error('deadline exceeded')) });
    const { res, body } = await postCheck(h, check());
    expect(res.status).toBe(502);
    expect(ApiErrorSchema.parse(body).error).toEqual({
      code: 'upstream_failed',
      message: 'Step check failed: deadline exceeded',
    });
  });

  it('answers 502 when the model answers something unusable', async () => {
    const h = await harness({ checker: scriptedChecker('{"verdict":"probably"}') });
    const { res, body } = await postCheck(h, check());
    expect(res.status).toBe(502);
    expect(ApiErrorSchema.parse(body).error).toEqual({
      code: 'upstream_failed',
      message:
        'Step check gave an unusable answer: The step check verdict "probably" is not one of ' +
        'done, not_done, unsure',
    });
  });

  it('validates the request', async () => {
    const checker = scriptedChecker('{"verdict":"done","observation":"Open."}');
    const h = await harness({ checker });
    expect((await postCheck(h, check({ images: [] }))).res.status).toBe(400);
    expect((await postCheck(h, check({ images: [IMAGE, IMAGE, IMAGE, IMAGE] }))).res.status).toBe(
      400,
    );
    const noInstruction = check({ step: { id: 'open-cap', instruction: '' } });
    expect((await postCheck(h, noInstruction)).res.status).toBe(400);
    const res = await h.request('POST', ApiPaths.planCheck, 'not json');
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('invalid_json');
    expect(checker.checks).toEqual([]);
  });
});

describe('POST /api/plans/criteria', () => {
  const step = {
    id: 'open-cap',
    instruction: 'Flip open the blue washer fluid cap.',
    doneWhen: 'The blue cap is flipped open.',
  };

  it("returns the step's criteria, the model and the measured latency", async () => {
    const checker = scriptedChecker(
      '{}',
      '{"criteria":["The blue cap is flipped open.","  ","The red cap is still closed."]}',
    );
    const h = await harness({ checker, now: steppingClock('2026-10-24T03:15:02.000Z', 250) });
    const request = {
      goal: 'Refill the washer fluid',
      step,
      images: [IMAGE],
      confusions: ['Opening the red coolant cap instead'],
    };
    const res = await h.request('POST', ApiPaths.planCriteria, request);
    expect(res.status).toBe(200);
    expect(StepCriteriaResponseSchema.parse(await res.json())).toEqual({
      criteria: ['The blue cap is flipped open.', 'The red cap is still closed.'],
      model: 'checker-test',
      latencyMs: 250,
    });
    expect(checker.criteriaRequests).toEqual([request]);
  });

  it('answers 503 without a checker and 502 for no criteria', async () => {
    const off = await harness();
    const body = { goal: 'Refill the washer fluid', step };
    expect((await off.request('POST', ApiPaths.planCriteria, body)).status).toBe(503);
    const h = await harness({ checker: scriptedChecker('{}', '{"criteria":[]}') });
    const res = await h.request('POST', ApiPaths.planCriteria, body);
    expect(res.status).toBe(502);
    expect(ApiErrorSchema.parse(await res.json()).error.message).toBe(
      'Step criteria gave an unusable answer: The step criteria answer has no criteria',
    );
  });
});
