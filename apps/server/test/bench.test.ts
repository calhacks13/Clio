import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ApiErrorSchema,
  ApiPaths,
  BenchCheckRunSchema,
  BenchCheckTestDetailSchema,
  BenchCheckTestListResponseSchema,
  BenchCheckTestSchema,
  BenchModelsResponseSchema,
  BenchPaths,
  type BenchRun,
  BenchRunSchema,
  BenchScenarioDetailSchema,
  BenchScenarioListResponseSchema,
  BenchScenarioSchema,
  ProcedureListResponseSchema,
  type StepCheckRequest,
  StepCheckResponseSchema,
} from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import type { BenchDeps } from '../src/deps';
import type { BenchModels } from '../src/services/bench';
import type { BenchJudge, JudgeRequest } from '../src/services/bench-judge';
import type { Planner, PlannerRequest } from '../src/services/planner';
import { BenchCheckStore } from '../src/storage/bench-check-store';
import { BenchStore } from '../src/storage/bench-store';
import { ProcedureStore } from '../src/storage/procedure-store';
import { type Harness, harness, steppingClock, tempDir } from './harness';
import { modelPlan } from './plan-fixtures';

// The planner bench's routes on real stores in a temp dir, with scripted planner and judge models.

const PLAN = JSON.stringify(modelPlan());
const JPEG = Buffer.from('fake jpeg bytes, view one').toString('base64');
const JPEG_2 = Buffer.from('fake jpeg bytes, view two').toString('base64');
const IMAGE = { mimeType: 'image/jpeg' as const, data: JPEG };
const IMAGE_2 = { mimeType: 'image/jpeg' as const, data: JPEG_2 };

interface FakeModels extends BenchModels {
  plannerRequests: Array<PlannerRequest & { model: string }>;
  checks: Array<StepCheckRequest & { model: string }>;
  judgements: Array<JudgeRequest & { model: string }>;
}

function fakeModels(
  options: {
    plans?: Array<string | Error>;
    check?: string | Error;
    judge?: string | Error;
    list?: () => Promise<string[]>;
  } = {},
): FakeModels {
  const plans = options.plans ?? [PLAN];
  const plannerRequests: FakeModels['plannerRequests'] = [];
  const checks: FakeModels['checks'] = [];
  const judgements: FakeModels['judgements'] = [];
  return {
    plannerModel: 'planner-test',
    judgeModel: 'judge-test',
    plannerRequests,
    checks,
    judgements,
    planner: (model): Planner => ({
      model,
      async draft(request) {
        plannerRequests.push({ ...request, model });
        const answer = plans[Math.min(plannerRequests.length - 1, plans.length - 1)];
        if (answer instanceof Error) throw answer;
        return answer ?? '';
      },
      async checkStep(request) {
        checks.push({ ...request, model });
        if (options.check instanceof Error) throw options.check;
        return options.check ?? '{"verdict":"done","observation":"the cap is off"}';
      },
    }),
    judge: (model): BenchJudge => ({
      model,
      async judge(request) {
        judgements.push({ ...request, model });
        const answer = options.judge ?? '{"criteria":[],"issues":[]}';
        if (answer instanceof Error) throw answer;
        return answer;
      },
    }),
    list: options.list ?? (async () => ['gemini-3.8-flash', 'planner-test', 'judge-test']),
  };
}

async function benchHarness(
  models: BenchModels | null = fakeModels(),
): Promise<Harness & { benchDir: string }> {
  const root = await tempDir();
  const benchDir = join(root, 'bench');
  const bench: BenchDeps = {
    store: new BenchStore(benchDir, { now: steppingClock('2026-10-24T03:15:02.000Z', 1_000) }),
    checks: new BenchCheckStore(benchDir, {
      now: steppingClock('2026-10-24T03:15:02.000Z', 1_000),
    }),
    plans: new ProcedureStore({
      curatedDir: join(root, 'none'),
      plansDir: join(benchDir, 'plans'),
    }),
    models,
  };
  const h = await harness({ bench, now: steppingClock('2026-10-24T03:15:02.000Z', 1_000) });
  return Object.assign(h, { benchDir });
}

async function json(res: Response | Promise<Response>): Promise<unknown> {
  return (await res).json();
}

async function createScenario(h: Harness, body: Record<string, unknown> = {}) {
  const res = await h.request('POST', BenchPaths.scenarios, {
    title: 'Washer fluid, cluttered bay',
    goal: 'Refill the washer fluid',
    images: [IMAGE, IMAGE_2],
    ...body,
  });
  expect(res.status).toBe(201);
  return BenchScenarioDetailSchema.parse(await res.json());
}

describe('GET /api/bench/models', () => {
  it('answers 503 without Gemini', async () => {
    const h = await benchHarness(null);
    const res = await h.request('GET', BenchPaths.models);
    expect(res.status).toBe(503);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('gemini_not_configured');
  });

  it('answers 503 when the bench is not wired at all', async () => {
    const h = await harness();
    const res = await h.request('GET', BenchPaths.scenarios);
    expect(res.status).toBe(503);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('bench_off');
  });

  it('lists the models with the planner and judge defaults', async () => {
    const h = await benchHarness();
    expect(
      BenchModelsResponseSchema.parse(await json(h.request('GET', BenchPaths.models))),
    ).toEqual({
      plannerModel: 'planner-test',
      judgeModel: 'judge-test',
      models: ['gemini-3.8-flash', 'planner-test', 'judge-test'],
    });
  });

  it('falls back to the configured models when the listing fails', async () => {
    const models = fakeModels({ list: () => Promise.reject(new Error('quota')) });
    const h = await benchHarness(models);
    const body = BenchModelsResponseSchema.parse(await json(h.request('GET', BenchPaths.models)));
    expect(body.models).toEqual(['planner-test', 'judge-test']);
    expect(h.logger.lines).toContain('warn Cannot list Gemini models: quota');
  });
});

describe('POST /api/bench/plan', () => {
  it('plans with the chosen model and keeps the plan out of the headset lesson list', async () => {
    const models = fakeModels();
    const h = await benchHarness(models);
    const res = await h.request('POST', BenchPaths.plan, {
      goal: 'Refill the washer fluid',
      context: 'The jug is behind the battery.',
      images: [IMAGE],
      model: 'gemini-3.8-flash',
    });
    expect(res.status).toBe(200);
    const run = BenchRunSchema.parse(await res.json());
    expect(run).toMatchObject({
      createdAt: '2026-10-24T03:15:02.000Z',
      model: 'gemini-3.8-flash',
      attempts: 1,
      request: {
        goal: 'Refill the washer fluid',
        context: 'The jug is behind the battery.',
        views: 1,
      },
      result: { ok: true, planId: 'refill-the-washer-fluid' },
    });
    expect(run.id).toMatch(/^run-20261024-031502-[a-z0-9]{4}$/);
    expect(run.latencyMs).toBeGreaterThan(0);
    expect(run.result.ok && run.result.procedure.steps).toHaveLength(3);
    expect(run.result.ok && run.result.warnings).toEqual(['Make sure the engine is off and cool.']);
    expect(models.plannerRequests.map((r) => [r.model, r.images])).toEqual([
      ['gemini-3.8-flash', [IMAGE]],
    ]);

    await readFile(join(h.benchDir, 'plans', 'refill-the-washer-fluid.json'), 'utf8');
    const list = ProcedureListResponseSchema.parse(
      await json(h.request('GET', ApiPaths.procedures)),
    );
    expect(list.procedures).toEqual([]);
  });

  it('uses the planner model by default', async () => {
    const models = fakeModels();
    const h = await benchHarness(models);
    await h.request('POST', BenchPaths.plan, { goal: 'Refill the washer fluid' });
    expect(models.plannerRequests[0]?.model).toBe('planner-test');
  });

  it('records a retry and the validation errors that caused it', async () => {
    const h = await benchHarness(fakeModels({ plans: ['Sure! Here is a plan.', PLAN] }));
    const run = BenchRunSchema.parse(
      await json(h.request('POST', BenchPaths.plan, { goal: 'Refill the washer fluid' })),
    );
    expect(run.attempts).toBe(2);
    expect(run.firstAttemptErrors).toMatch(/^The response was not valid JSON/);
    expect(run.result.ok).toBe(true);
  });

  it('answers a failed plan as a failed run, not an error', async () => {
    const h = await benchHarness(fakeModels({ plans: [new Error('quota exceeded')] }));
    const res = await h.request('POST', BenchPaths.plan, { goal: 'Refill the washer fluid' });
    expect(res.status).toBe(200);
    const run = BenchRunSchema.parse(await res.json());
    expect(run.result).toEqual({
      ok: false,
      code: 'upstream_failed',
      message: 'Planner request failed: quota exceeded',
    });
    expect(h.logger.lines.some((l) => /failed \(upstream_failed\)/.test(l))).toBe(true);
  });

  it('re-plans from a base plan', async () => {
    const models = fakeModels({
      plans: [PLAN, JSON.stringify({ objects: [], steps: [modelPlan().steps[2]], warnings: [] })],
    });
    const h = await benchHarness(models);
    const first = BenchRunSchema.parse(
      await json(h.request('POST', BenchPaths.plan, { goal: 'Refill the washer fluid' })),
    );
    if (!first.result.ok) throw new Error('expected a plan');
    const res = await h.request('POST', BenchPaths.plan, {
      goal: 'Refill the washer fluid',
      images: [IMAGE_2],
      revise: {
        planId: first.result.planId,
        fromStepIndex: 1,
        reason: 'The jug is empty',
        base: first.result.procedure,
      },
    });
    const run = BenchRunSchema.parse(await res.json());
    expect(run.request.revise).toEqual({ fromStepIndex: 1, reason: 'The jug is empty' });
    expect(models.plannerRequests[1]?.revision?.reason).toBe('The jug is empty');
    expect(run.result.ok && run.result.procedure.steps.map((s) => s.id)).toEqual([
      'open-cap',
      'close-cap',
    ]);
  });

  it('gives slow models a longer budget when asked, and records it', async () => {
    const models = fakeModels();
    const h = await benchHarness(models);
    const run = BenchRunSchema.parse(
      await json(
        h.request('POST', BenchPaths.plan, { goal: 'Refill the washer fluid', budgetMs: 120_000 }),
      ),
    );
    expect(run.budgetMs).toBe(120_000);
    expect(models.plannerRequests[0]?.timeoutMs).toBeGreaterThan(100_000);
    const normal = BenchRunSchema.parse(
      await json(h.request('POST', BenchPaths.plan, { goal: 'Refill the washer fluid' })),
    );
    expect(normal.budgetMs).toBeUndefined();
    expect(models.plannerRequests[1]?.timeoutMs).toBeLessThanOrEqual(40_000);
    const tooLong = await h.request('POST', BenchPaths.plan, {
      goal: 'Refill the washer fluid',
      budgetMs: 3_600_000,
    });
    expect(tooLong.status).toBe(400);
  });

  it('rejects an unknown model name shape', async () => {
    const h = await benchHarness();
    const res = await h.request('POST', BenchPaths.plan, { goal: 'Refill it', model: '../x' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/bench/check', () => {
  it('checks a step with the chosen model', async () => {
    const models = fakeModels();
    const h = await benchHarness(models);
    const res = await h.request('POST', BenchPaths.check, {
      goal: 'Refill the washer fluid',
      step: { id: 'open-cap', instruction: 'Open the cap.', doneWhen: 'The cap is off.' },
      images: [IMAGE],
      model: 'gemini-3.8-flash',
    });
    expect(res.status).toBe(200);
    expect(StepCheckResponseSchema.parse(await res.json())).toEqual({
      verdict: 'done',
      observation: 'the cap is off',
      model: 'gemini-3.8-flash',
      latencyMs: 1_000,
    });
    expect(models.checks[0]?.step.id).toBe('open-cap');
  });

  it('answers 502 for an unusable answer', async () => {
    const h = await benchHarness(fakeModels({ check: '{"verdict":"maybe"}' }));
    const res = await h.request('POST', BenchPaths.check, {
      goal: 'Refill the washer fluid',
      step: { id: 'open-cap', instruction: 'Open the cap.' },
      images: [IMAGE],
    });
    expect(res.status).toBe(502);
  });
});

describe('bench scenarios', () => {
  it('saves the views and the runs made before saving, and lists the scenario', async () => {
    const h = await benchHarness();
    const run = BenchRunSchema.parse(
      await json(h.request('POST', BenchPaths.plan, { goal: 'Refill the washer fluid' })),
    );
    const detail = await createScenario(h, {
      expect: ['Uses the blue cap, not the yellow one'],
      tags: ['distractor'],
      runs: [{ ...run, verdict: { grade: 'pass', at: '2026-10-24T03:15:09.000Z' } }],
    });
    expect(detail.scenario).toMatchObject({
      id: 'washer-fluid-cluttered-bay',
      title: 'Washer fluid, cluttered bay',
      expect: ['Uses the blue cap, not the yellow one'],
      tags: ['distractor'],
      views: [
        { file: 'view-1.jpg', mimeType: 'image/jpeg' },
        { file: 'view-2.jpg', mimeType: 'image/jpeg' },
      ],
    });
    expect(detail.runs.map((r) => r.id)).toEqual([run.id]);

    const dir = join(h.benchDir, 'scenarios', 'washer-fluid-cluttered-bay');
    expect((await readdir(dir)).sort()).toEqual([
      'runs',
      'scenario.json',
      'view-1.jpg',
      'view-2.jpg',
    ]);
    const view = await h.request('GET', BenchPaths.scenarioView('washer-fluid-cluttered-bay', 2));
    expect(view.status).toBe(200);
    expect(view.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await view.arrayBuffer()).toString('base64')).toBe(JPEG_2);
    expect(
      (await h.request('GET', BenchPaths.scenarioView('washer-fluid-cluttered-bay', 3))).status,
    ).toBe(404);

    const list = BenchScenarioListResponseSchema.parse(
      await json(h.request('GET', BenchPaths.scenarios)),
    );
    expect(list.scenarios).toEqual([
      {
        id: 'washer-fluid-cluttered-bay',
        title: 'Washer fluid, cluttered bay',
        goal: 'Refill the washer fluid',
        tags: ['distractor'],
        revising: false,
        expectCount: 1,
        views: 2,
        createdAt: detail.scenario.createdAt,
        runCount: 1,
        lastRun: {
          model: 'planner-test',
          createdAt: run.createdAt,
          ok: true,
          grade: 'pass',
          judged: false,
        },
      },
    ]);
  });

  it('gives a second scenario with the same title its own id', async () => {
    const h = await benchHarness();
    await createScenario(h);
    expect((await createScenario(h)).scenario.id).toBe('washer-fluid-cluttered-bay-2');
  });

  it('rejects a scenario without views', async () => {
    const h = await benchHarness();
    const res = await h.request('POST', BenchPaths.scenarios, {
      title: 'No views',
      goal: 'Refill the washer fluid',
      images: [],
    });
    expect(res.status).toBe(400);
  });

  it('edits the title, expectations and tags, and clears the context with null', async () => {
    const h = await benchHarness();
    const { scenario } = await createScenario(h, { context: 'Old car.' });
    const res = await h.request('PATCH', BenchPaths.scenario(scenario.id), {
      title: 'Renamed',
      expect: ['Warns that the engine must be cool'],
      tags: ['safety'],
      context: null,
    });
    expect(res.status).toBe(200);
    const updated = BenchScenarioSchema.parse(await res.json());
    expect(updated).toMatchObject({
      id: scenario.id,
      title: 'Renamed',
      expect: ['Warns that the engine must be cool'],
      tags: ['safety'],
    });
    expect(updated.context).toBeUndefined();
    expect(updated.updatedAt > scenario.updatedAt).toBe(true);
  });

  it('runs a saved scenario on its stored views and keeps the run', async () => {
    const models = fakeModels();
    const h = await benchHarness(models);
    const { scenario } = await createScenario(h, { context: 'Behind the battery.' });
    const res = await h.request('POST', BenchPaths.scenarioRuns(scenario.id), {
      model: 'gemini-3.8-flash',
    });
    expect(res.status).toBe(201);
    const run = BenchRunSchema.parse(await res.json());
    expect(models.plannerRequests[0]).toMatchObject({
      model: 'gemini-3.8-flash',
      goal: 'Refill the washer fluid',
      context: 'Behind the battery.',
      images: [IMAGE, IMAGE_2],
    });
    const detail = BenchScenarioDetailSchema.parse(
      await json(h.request('GET', BenchPaths.scenario(scenario.id))),
    );
    expect(detail.runs.map((r) => r.id)).toEqual([run.id]);
  });

  it('runs a re-plan scenario as a revision of its base plan', async () => {
    const models = fakeModels({
      plans: [JSON.stringify({ objects: [], steps: [modelPlan().steps[2]], warnings: [] })],
    });
    const h = await benchHarness(models);
    const base = BenchRunSchema.parse(
      await json(
        (await benchHarness()).request('POST', BenchPaths.plan, {
          goal: 'Refill the washer fluid',
        }),
      ),
    );
    if (!base.result.ok) throw new Error('expected a plan');
    const { scenario } = await createScenario(h, {
      revise: { base: base.result.procedure, fromStepIndex: 1, reason: 'The jug is empty' },
    });
    const run = BenchRunSchema.parse(
      await json(h.request('POST', BenchPaths.scenarioRuns(scenario.id), {})),
    );
    expect(models.plannerRequests[0]?.revision).toMatchObject({
      reason: 'The jug is empty',
      fromStepIndex: 1,
    });
    expect(run.request.revise).toEqual({ fromStepIndex: 1, reason: 'The jug is empty' });
  });

  it('grades a run and clears the grade', async () => {
    const h = await benchHarness();
    const { scenario } = await createScenario(h);
    const run = BenchRunSchema.parse(
      await json(h.request('POST', BenchPaths.scenarioRuns(scenario.id))),
    );
    const graded = BenchRunSchema.parse(
      await json(
        h.request('PATCH', BenchPaths.scenarioRun(scenario.id, run.id), {
          verdict: { grade: 'partial', notes: 'Missed the funnel' },
        }),
      ),
    );
    expect(graded.verdict).toMatchObject({ grade: 'partial', notes: 'Missed the funnel' });
    const cleared = BenchRunSchema.parse(
      await json(
        h.request('PATCH', BenchPaths.scenarioRun(scenario.id, run.id), { verdict: null }),
      ),
    );
    expect(cleared.verdict).toBeUndefined();
    const missing = await h.request('PATCH', BenchPaths.scenarioRun(scenario.id, 'run-nope'), {
      verdict: null,
    });
    expect(missing.status).toBe(404);
  });

  it('judges a run against the expectations with the scenario views', async () => {
    const models = fakeModels({
      judge: JSON.stringify({
        criteria: [{ n: 1, reason: 'open-cap targets washer_cap.', met: true }],
        issues: ['close-cap cannot be confirmed by a camera'],
      }),
    });
    const h = await benchHarness(models);
    const { scenario } = await createScenario(h, {
      expect: ['Uses the blue cap', 'Warns about a hot engine'],
    });
    const run = BenchRunSchema.parse(
      await json(h.request('POST', BenchPaths.scenarioRuns(scenario.id))),
    );
    const res = await h.request('POST', BenchPaths.scenarioRunJudge(scenario.id, run.id), {});
    expect(res.status).toBe(200);
    const judged = BenchRunSchema.parse(await res.json());
    expect(judged.judgement).toMatchObject({
      model: 'judge-test',
      passed: false,
      criteria: [
        { expectation: 'Uses the blue cap', met: true, reason: 'open-cap targets washer_cap.' },
        {
          expectation: 'Warns about a hot engine',
          met: false,
          reason: 'The judge gave no answer for this one.',
        },
      ],
      issues: ['close-cap cannot be confirmed by a camera'],
    });
    expect(models.judgements[0]?.images).toEqual([IMAGE, IMAGE_2]);
    expect(models.judgements[0]?.scenario.expect).toEqual([
      'Uses the blue cap',
      'Warns about a hot engine',
    ]);
    const detail = BenchScenarioDetailSchema.parse(
      await json(h.request('GET', BenchPaths.scenario(scenario.id))),
    );
    expect(detail.runs[0]?.judgement?.passed).toBe(false);
  });

  it('refuses to judge without expectations or without a plan', async () => {
    const h = await benchHarness(fakeModels({ plans: [new Error('down')] }));
    const { scenario } = await createScenario(h);
    const run: BenchRun = BenchRunSchema.parse(
      await json(h.request('POST', BenchPaths.scenarioRuns(scenario.id))),
    );
    const noPlan = await h.request('POST', BenchPaths.scenarioRunJudge(scenario.id, run.id));
    expect(ApiErrorSchema.parse(await noPlan.json()).error.code).toBe('nothing_to_judge');

    const h2 = await benchHarness();
    const { scenario: s2 } = await createScenario(h2);
    const run2 = BenchRunSchema.parse(
      await json(h2.request('POST', BenchPaths.scenarioRuns(s2.id))),
    );
    const noExpect = await h2.request('POST', BenchPaths.scenarioRunJudge(s2.id, run2.id));
    expect(noExpect.status).toBe(409);
    expect(ApiErrorSchema.parse(await noExpect.json()).error.code).toBe('no_expectations');
  });

  it('moves a deleted scenario aside instead of removing it', async () => {
    const h = await benchHarness();
    const { scenario } = await createScenario(h);
    expect((await h.request('DELETE', BenchPaths.scenario(scenario.id))).status).toBe(200);
    expect((await h.request('GET', BenchPaths.scenario(scenario.id))).status).toBe(404);
    expect((await h.request('DELETE', BenchPaths.scenario(scenario.id))).status).toBe(404);
    const deleted = await readdir(join(h.benchDir, 'deleted'));
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatch(/^washer-fluid-cluttered-bay-2026-10-24T/);
  });

  it('rejects ids that are not safe path segments', async () => {
    const h = await benchHarness();
    expect((await h.request('GET', '/api/bench/scenarios/.hidden')).status).toBe(400);
    const run = BenchRunSchema.parse(
      await json(h.request('POST', BenchPaths.plan, { goal: 'Refill the washer fluid' })),
    );
    const res = await h.request('POST', BenchPaths.scenarios, {
      title: 'Bad run id',
      goal: 'Refill the washer fluid',
      images: [IMAGE],
      runs: [{ ...run, id: '../escape' }],
    });
    expect(res.status).toBe(400);
  });
});

describe('staged plans on the bench', () => {
  it('records the stage a plan was asked at', async () => {
    const h = await benchHarness();
    const run = BenchRunSchema.parse(
      await json(
        h.request('POST', BenchPaths.plan, { goal: 'Refill the washer fluid', stage: 'first' }),
      ),
    );
    expect(run.request.stage).toBe('first');
    const full = BenchRunSchema.parse(
      await json(h.request('POST', BenchPaths.plan, { goal: 'Refill the washer fluid' })),
    );
    expect(full.request.stage).toBeUndefined();
  });

  it('runs a scenario in two stages: the first, then the rest of its outline', async () => {
    const models = fakeModels({
      plans: [
        PLAN,
        JSON.stringify({ objects: [], steps: modelPlan().steps.slice(1), warnings: [] }),
      ],
    });
    const h = await benchHarness(models);
    const { scenario } = await createScenario(h);
    const first = BenchRunSchema.parse(
      await json(h.request('POST', BenchPaths.scenarioRuns(scenario.id), { stage: 'first' })),
    );
    expect(first.request.stage).toBe('first');
    if (!first.result.ok) throw new Error('expected a plan');

    const rest = await h.request('POST', BenchPaths.scenarioRuns(scenario.id), {
      stage: 'rest',
      revise: {
        base: first.result.procedure,
        fromStepIndex: 1,
        reason: 'Refine the outline while the learner does step 1',
      },
    });
    expect(rest.status).toBe(201);
    const run = BenchRunSchema.parse(await rest.json());
    expect(run.request).toMatchObject({
      stage: 'rest',
      revise: { fromStepIndex: 1, reason: 'Refine the outline while the learner does step 1' },
      views: 2,
    });
    expect(models.plannerRequests[1]?.revision).toMatchObject({
      fromStepIndex: 1,
      base: { id: first.result.planId },
    });
    expect(models.plannerRequests[1]?.images).toEqual([IMAGE, IMAGE_2]);
    const detail = BenchScenarioDetailSchema.parse(
      await json(h.request('GET', BenchPaths.scenario(scenario.id))),
    );
    expect(detail.runs.map((r) => r.request.stage)).toEqual(['rest', 'first']);
  });

  it('needs the plan to refine for stage rest', async () => {
    const h = await benchHarness();
    const { scenario } = await createScenario(h);
    const res = await h.request('POST', BenchPaths.scenarioRuns(scenario.id), { stage: 'rest' });
    expect(res.status).toBe(400);
    expect(ApiErrorSchema.parse(await res.json()).error.message).toMatch(/stage rest needs revise/);
  });
});

describe('watcher tests', () => {
  const MILK = Buffer.from('fake jpeg: holding the milk').toString('base64');
  const FRIDGE = Buffer.from('fake jpeg: the fridge, closed').toString('base64');
  const NOW = { mimeType: 'image/jpeg' as const, data: MILK };
  const BEFORE = { mimeType: 'image/jpeg' as const, data: FRIDGE };
  const STEP = {
    id: 'take-yogurt',
    instruction: 'Take the yogurt drink from the fridge door.',
    doneWhen: 'The learner holds the small pink yogurt drink bottle.',
  };
  const OBJECTS = [
    { id: 'yogurt', label: 'yogurt drink', look: 'Small pink plastic bottle with a foil top' },
  ];
  const CONFUSIONS = ['Picking up the milk carton, not the yogurt drink'];

  async function createTest(h: Harness, body: Record<string, unknown> = {}) {
    const res = await h.request('POST', BenchPaths.checkTests, {
      title: 'Milk taken for the yogurt drink',
      expect: 'wrong',
      goal: 'Get a yogurt drink from the fridge',
      step: STEP,
      images: [NOW],
      before: [BEFORE],
      objects: OBJECTS,
      confusions: CONFUSIONS,
      seen: {
        verdict: 'done',
        observation: 'holding a white carton',
        model: 'gemini-robotics-er-2-preview',
        latencyMs: 1200,
      },
      ...body,
    });
    expect(res.status).toBe(201);
    return BenchCheckTestDetailSchema.parse(await res.json());
  }

  it('saves the frames, the step and its hints, and lists the test', async () => {
    const h = await benchHarness();
    const { test, runs } = await createTest(h);
    expect(runs).toEqual([]);
    expect(test).toMatchObject({
      id: 'milk-taken-for-the-yogurt-drink',
      expect: 'wrong',
      step: STEP,
      objects: OBJECTS,
      confusions: CONFUSIONS,
      before: [{ file: 'before-1.jpg', mimeType: 'image/jpeg' }],
      now: [{ file: 'now-1.jpg', mimeType: 'image/jpeg' }],
      seen: { verdict: 'done', observation: 'holding a white carton' },
    });
    const dir = join(h.benchDir, 'checks', test.id);
    expect((await readdir(dir)).sort()).toEqual(['before-1.jpg', 'check.json', 'now-1.jpg']);

    const frame = await h.request('GET', BenchPaths.checkTestFrame(test.id, 'now-1.jpg'));
    expect(frame.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await frame.arrayBuffer()).toString('base64')).toBe(MILK);
    const notAFrame = await h.request('GET', BenchPaths.checkTestFrame(test.id, 'check.json'));
    expect(notAFrame.status).toBe(404);
    expect((await h.request('GET', '/api/bench/checks/.hidden')).status).toBe(400);

    const list = BenchCheckTestListResponseSchema.parse(
      await json(h.request('GET', BenchPaths.checkTests)),
    );
    expect(list.tests).toEqual([
      {
        id: test.id,
        title: 'Milk taken for the yogurt drink',
        goal: 'Get a yogurt drink from the fridge',
        instruction: STEP.instruction,
        expect: 'wrong',
        thumb: 'now-1.jpg',
        hasBefore: true,
        createdAt: test.createdAt,
        runCount: 0,
        models: [],
        lastRun: null,
      },
    ]);
  });

  it('asks the saved look again with any model and grades the answer', async () => {
    const models = fakeModels({
      check: '{"verdict":"done","observation":"holding a white carton"}',
    });
    const h = await benchHarness(models);
    const { test } = await createTest(h);
    const res = await h.request('POST', BenchPaths.checkTestRuns(test.id), {
      model: 'gemini-3.8-flash',
    });
    expect(res.status).toBe(201);
    const run = BenchCheckRunSchema.parse(await res.json());
    expect(run).toMatchObject({
      model: 'gemini-3.8-flash',
      expect: 'wrong',
      result: { ok: true, answer: { verdict: 'done', observation: 'holding a white carton' } },
      passed: false,
    });
    expect(models.checks[0]).toEqual({
      goal: 'Get a yogurt drink from the fridge',
      step: STEP,
      images: [NOW],
      before: [BEFORE],
      objects: OBJECTS,
      confusions: CONFUSIONS,
      model: 'gemini-3.8-flash',
    });
    expect(h.logger.lines.some((l) => l.includes('said done, FAIL'))).toBe(true);

    // The same look expected "not done" still fails: the watcher said done.
    await h.request('PATCH', BenchPaths.checkTest(test.id), { expect: 'not_done' });
    const again = BenchCheckRunSchema.parse(
      await json(h.request('POST', BenchPaths.checkTestRuns(test.id))),
    );
    expect(again).toMatchObject({ model: 'planner-test', expect: 'not_done', passed: false });

    const detail = BenchCheckTestDetailSchema.parse(
      await json(h.request('GET', BenchPaths.checkTest(test.id))),
    );
    expect(detail.runs.map((r) => r.id)).toEqual([again.id, run.id]);
    const [summary] = BenchCheckTestListResponseSchema.parse(
      await json(h.request('GET', BenchPaths.checkTests)),
    ).tests;
    expect(summary).toMatchObject({
      expect: 'not_done',
      runCount: 2,
      models: [
        { model: 'gemini-3.8-flash', runs: 1, passed: 0 },
        { model: 'planner-test', runs: 1, passed: 0 },
      ],
      lastRun: { model: 'planner-test', passed: false, verdict: 'done' },
    });
  });

  it('passes a "not done" test on an answer of unsure', async () => {
    const h = await benchHarness(
      fakeModels({ check: '{"verdict":"unsure","observation":"the hand hides the bottle"}' }),
    );
    const { test } = await createTest(h, { expect: 'not_done', before: [] });
    expect(test.before).toEqual([]);
    const run = BenchCheckRunSchema.parse(
      await json(h.request('POST', BenchPaths.checkTestRuns(test.id))),
    );
    expect(run.passed).toBe(true);
  });

  it('records a failed model call as a failed run', async () => {
    const h = await benchHarness(fakeModels({ check: new Error('deadline exceeded') }));
    const { test } = await createTest(h);
    const res = await h.request('POST', BenchPaths.checkTestRuns(test.id), {});
    expect(res.status).toBe(201);
    expect(BenchCheckRunSchema.parse(await res.json())).toMatchObject({
      result: {
        ok: false,
        code: 'upstream_failed',
        message: 'Step check failed: deadline exceeded',
      },
      passed: false,
    });
  });

  it('renames a test, clears its notes and moves a deleted one aside', async () => {
    const h = await benchHarness();
    const { test } = await createTest(h, { notes: 'From the fridge lesson' });
    expect(test.notes).toBe('From the fridge lesson');
    const updated = BenchCheckTestSchema.parse(
      await json(
        h.request('PATCH', BenchPaths.checkTest(test.id), {
          title: 'Milk, not yogurt',
          notes: null,
        }),
      ),
    );
    expect(updated).toMatchObject({ id: test.id, title: 'Milk, not yogurt' });
    expect(updated.notes).toBeUndefined();
    expect((await h.request('DELETE', BenchPaths.checkTest(test.id))).status).toBe(200);
    expect((await h.request('GET', BenchPaths.checkTest(test.id))).status).toBe(404);
    expect((await h.request('DELETE', BenchPaths.checkTest(test.id))).status).toBe(404);
    const deleted = await readdir(join(h.benchDir, 'deleted'));
    expect(deleted[0]).toMatch(/^check-milk-taken-for-the-yogurt-drink-2026-10-24T/);
  });

  it('rejects a test without a frame to judge, and runs need Gemini', async () => {
    const h = await benchHarness(null);
    const bad = await h.request('POST', BenchPaths.checkTests, {
      title: 'No frames',
      expect: 'done',
      goal: 'Get a yogurt drink',
      step: STEP,
      images: [],
    });
    expect(bad.status).toBe(400);
    const { test } = await createTest(h);
    expect((await h.request('POST', BenchPaths.checkTestRuns(test.id))).status).toBe(503);
  });
});
