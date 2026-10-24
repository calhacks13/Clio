import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ApiErrorSchema,
  ApiPaths,
  PlanResponseSchema,
  ProcedureListResponseSchema,
  ProcedureSchema,
} from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import type { Planner, PlannerRequest } from '../src/services/planner';
import { type Harness, harness, steppingClock } from './harness';
import { modelPlan, modelRevision } from './plan-fixtures';
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
    expect(plan.warnings).toEqual(['Make sure the engine is off and cool.']);
    expect(planner.requests).toEqual([
      { goal: 'Refill the washer fluid', context: 'It is a 2015 Civic.', images: [IMAGE] },
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
      revision: { reason: 'They found a funnel', base, fromStepIndex: 1 },
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

  it('revises curated procedures too', async () => {
    const planner = scriptedPlanner(
      JSON.stringify({
        objects: [],
        steps: [
          {
            id: 'wave',
            instruction: 'Wave at cup A.',
            targets: ['cup_a'],
            action: { verb: 'point_at', object: 'cup_a' },
            success: { type: 'confirm', prompt: 'Waved' },
            mistakes: [],
          },
        ],
        warnings: [],
      }),
    );
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

  it('answers 404 for an unknown plan and 400 for an unsafe id', async () => {
    const h = await planHarness(scriptedPlanner(PLAN));
    expect((await postPlan(h, revise('nope'))).res.status).toBe(404);
    expect((await postPlan(h, revise('../../etc'))).res.status).toBe(400);
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
