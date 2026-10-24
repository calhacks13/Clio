import {
  BenchCheckRequestSchema,
  type BenchCheckRun,
  BenchCheckTestCreateSchema,
  type BenchCheckTestDetail,
  type BenchCheckTestListResponse,
  BenchCheckTestRunRequestSchema,
  BenchCheckTestUpdateSchema,
  BenchJudgeRequestSchema,
  type BenchModelsResponse,
  BenchPaths,
  BenchPlanRequestSchema,
  type BenchRevise,
  type BenchRun,
  BenchRunScenarioRequestSchema,
  BenchRunUpdateSchema,
  BenchScenarioCreateSchema,
  type BenchScenarioListResponse,
  BenchScenarioUpdateSchema,
  type PlanStage,
  type StepCheckResponse,
} from '@clio/protocol';
import { Hono } from 'hono';
import type { BenchDeps, ServerDeps } from '../deps';
import { ApiError, geminiNotConfigured, invalidId, notFound } from '../errors';
import { isSafeId } from '../ids';
import { describeError } from '../log';
import { type BenchModels, benchPlan, judgeRun, scenarioPlanRequest } from '../services/bench';
import { askStepCheck, expectLabel, runCheckTest } from '../services/bench-checks';
import type { PlanRequestBody } from '../services/plan-service';
import { limitBody, parseBody, safeId } from './request';

// The planner bench (docs/planner-bench.md): the laptop page and `pnpm bench` put the planner in
// front of real scenes and grade what it writes, and replay the step watcher's saved looks
// (watcher tests). Plans here never reach the headset's lesson list, and nothing here is
// recorded in episodes.

export function benchRoutes({ bench, now, logger, limits }: ServerDeps): Hono {
  const app = new Hono();
  const on = (): BenchDeps => {
    if (!bench) throw new ApiError(503, 'bench_off', 'The planner bench is not set up');
    return bench;
  };
  const gemini = (): BenchModels => {
    const models = on().models;
    if (!models) throw geminiNotConfigured('The planner bench');
    return models;
  };
  const scenarioOf = async (id: string) => {
    const scenario = await on().store.getScenario(safeId(id, 'scenario id'));
    if (!scenario) throw notFound(`No bench scenario "${id}"`);
    return scenario;
  };

  app.get(BenchPaths.models, async (c) => {
    const models = gemini();
    let names: string[];
    try {
      names = await models.list();
    } catch (error) {
      logger.warn(`Cannot list Gemini models: ${describeError(error)}`);
      names = [...new Set([models.plannerModel, models.judgeModel])];
    }
    return c.json({
      plannerModel: models.plannerModel,
      judgeModel: models.judgeModel,
      models: names,
    } satisfies BenchModelsResponse);
  });

  app.post(BenchPaths.plan, limitBody(limits.imageBytes), async (c) => {
    const models = gemini();
    const { model, budgetMs, ...body } = await parseBody(
      c,
      BenchPlanRequestSchema,
      'bench plan request',
    );
    if (body.revise) safeId(body.revise.planId, 'plan id');
    const planner = models.planner(model ?? models.plannerModel);
    const run = withStage(
      await benchPlan({ planner, plans: on().plans, now, budgetMs }, body),
      body,
    );
    logRun(run);
    return c.json(run satisfies BenchRun);
  });

  app.post(BenchPaths.check, limitBody(limits.imageBytes), async (c) => {
    const models = gemini();
    const { model, ...body } = await parseBody(c, BenchCheckRequestSchema, 'bench check request');
    const planner = models.planner(model ?? models.plannerModel);
    const { answer, latencyMs } = await askStepCheck(planner, body, now);
    return c.json({ ...answer, model: planner.model, latencyMs } satisfies StepCheckResponse);
  });

  app.get(BenchPaths.scenarios, async (c) =>
    c.json({ scenarios: await on().store.list() } satisfies BenchScenarioListResponse),
  );

  app.post(BenchPaths.scenarios, limitBody(limits.imageBytes), async (c) => {
    const body = await parseBody(c, BenchScenarioCreateSchema, 'bench scenario');
    for (const run of body.runs) if (!isSafeId(run.id)) throw invalidId('run id');
    const detail = await on().store.create(body);
    logger.info(`bench scenario ${detail.scenario.id}: "${detail.scenario.title}"`);
    return c.json(detail, 201);
  });

  app.get('/api/bench/scenarios/:id', async (c) => {
    const id = safeId(c.req.param('id'), 'scenario id');
    const detail = await on().store.get(id);
    if (!detail) throw notFound(`No bench scenario "${id}"`);
    return c.json(detail);
  });

  app.patch('/api/bench/scenarios/:id', async (c) => {
    const id = safeId(c.req.param('id'), 'scenario id');
    const patch = await parseBody(c, BenchScenarioUpdateSchema, 'bench scenario update');
    const scenario = await on().store.update(id, patch);
    if (!scenario) throw notFound(`No bench scenario "${id}"`);
    return c.json(scenario);
  });

  app.delete('/api/bench/scenarios/:id', async (c) => {
    const id = safeId(c.req.param('id'), 'scenario id');
    if (!(await on().store.remove(id))) throw notFound(`No bench scenario "${id}"`);
    return c.json({ ok: true });
  });

  app.get('/api/bench/scenarios/:id/views/:n', async (c) => {
    const id = safeId(c.req.param('id'), 'scenario id');
    const n = Number(c.req.param('n'));
    const view = Number.isInteger(n) && n >= 1 ? await on().store.readView(id, n) : null;
    if (!view) throw notFound(`No view ${c.req.param('n')} in bench scenario "${id}"`);
    return c.body(new Uint8Array(view.bytes), 200, {
      'content-type': view.mimeType,
      'cache-control': 'private, max-age=60',
    });
  });

  app.post('/api/bench/scenarios/:id/runs', async (c) => {
    const models = gemini();
    const scenario = await scenarioOf(c.req.param('id'));
    const { model, budgetMs, stage, revise } = await parseBody(
      c,
      BenchRunScenarioRequestSchema,
      'bench run request',
      { emptyAsObject: true },
    );
    const images = await on().store.readViews(scenario);
    const planner = models.planner(model ?? models.plannerModel);
    const body = staged(scenarioPlanRequest(scenario, images), stage, revise);
    const run = withStage(
      await benchPlan({ planner, plans: on().plans, now, budgetMs }, body),
      body,
    );
    await on().store.addRun(scenario.id, run);
    logRun(run, scenario.id);
    return c.json(run satisfies BenchRun, 201);
  });

  app.patch('/api/bench/scenarios/:id/runs/:runId', async (c) => {
    const id = safeId(c.req.param('id'), 'scenario id');
    const runId = safeId(c.req.param('runId'), 'run id');
    const { verdict } = await parseBody(c, BenchRunUpdateSchema, 'bench run update');
    const run = await on().store.updateRun(id, runId, (r) => {
      const { verdict: _old, ...rest } = r;
      return verdict ? { ...rest, verdict: { ...verdict, at: now().toISOString() } } : rest;
    });
    if (!run) throw notFound(`No run "${runId}" in bench scenario "${id}"`);
    return c.json(run satisfies BenchRun);
  });

  app.post('/api/bench/scenarios/:id/runs/:runId/judge', async (c) => {
    const models = gemini();
    const scenario = await scenarioOf(c.req.param('id'));
    const runId = safeId(c.req.param('runId'), 'run id');
    const { model } = await parseBody(c, BenchJudgeRequestSchema, 'bench judge request', {
      emptyAsObject: true,
    });
    const run = await on().store.getRun(scenario.id, runId);
    if (!run) throw notFound(`No run "${runId}" in bench scenario "${scenario.id}"`);
    const images = await on().store.readViews(scenario);
    const judgement = await judgeRun(
      models.judge(model ?? models.judgeModel),
      scenario,
      run,
      images,
      now,
    );
    const judged = await on().store.updateRun(scenario.id, runId, (r) => ({ ...r, judgement }));
    if (!judged) throw notFound(`No run "${runId}" in bench scenario "${scenario.id}"`);
    const met = judgement.criteria.filter((x) => x.met).length;
    logger.info(
      `bench judge ${scenario.id}/${runId}: ${met}/${judgement.criteria.length} met by ${judgement.model}`,
    );
    return c.json(judged satisfies BenchRun);
  });

  // Watcher tests: a saved look of the step watcher, asked again with any model.

  const checkTestOf = async (id: string) => {
    const test = await on().checks.getTest(safeId(id, 'watcher test id'));
    if (!test) throw notFound(`No watcher test "${id}"`);
    return test;
  };

  app.get(BenchPaths.checkTests, async (c) =>
    c.json({ tests: await on().checks.list() } satisfies BenchCheckTestListResponse),
  );

  app.post(BenchPaths.checkTests, limitBody(limits.imageBytes), async (c) => {
    const body = await parseBody(c, BenchCheckTestCreateSchema, 'watcher test');
    const detail = await on().checks.create(body);
    logger.info(
      `bench watcher test ${detail.test.id}: "${detail.test.title}", expects ${expectLabel(detail.test.expect)}`,
    );
    return c.json(detail satisfies BenchCheckTestDetail, 201);
  });

  app.get('/api/bench/checks/:id', async (c) => {
    const id = safeId(c.req.param('id'), 'watcher test id');
    const detail = await on().checks.get(id);
    if (!detail) throw notFound(`No watcher test "${id}"`);
    return c.json(detail satisfies BenchCheckTestDetail);
  });

  app.patch('/api/bench/checks/:id', async (c) => {
    const id = safeId(c.req.param('id'), 'watcher test id');
    const patch = await parseBody(c, BenchCheckTestUpdateSchema, 'watcher test update');
    const test = await on().checks.update(id, patch);
    if (!test) throw notFound(`No watcher test "${id}"`);
    return c.json(test);
  });

  app.delete('/api/bench/checks/:id', async (c) => {
    const id = safeId(c.req.param('id'), 'watcher test id');
    if (!(await on().checks.remove(id))) throw notFound(`No watcher test "${id}"`);
    return c.json({ ok: true });
  });

  app.get('/api/bench/checks/:id/frames/:file', async (c) => {
    const id = safeId(c.req.param('id'), 'watcher test id');
    const file = safeId(c.req.param('file'), 'frame name');
    const frame = await on().checks.readFrame(id, file);
    if (!frame) throw notFound(`No frame "${file}" in watcher test "${id}"`);
    return c.body(new Uint8Array(frame.bytes), 200, {
      'content-type': frame.mimeType,
      'cache-control': 'private, max-age=60',
    });
  });

  app.post('/api/bench/checks/:id/runs', async (c) => {
    const models = gemini();
    const test = await checkTestOf(c.req.param('id'));
    const { model } = await parseBody(c, BenchCheckTestRunRequestSchema, 'watcher test run', {
      emptyAsObject: true,
    });
    const planner = models.planner(model ?? models.plannerModel);
    if (!planner.checkStep) throw geminiNotConfigured('Step checks');
    const run = await runCheckTest({ planner, now }, test, await on().checks.readFrames(test));
    await on().checks.addRun(test.id, run);
    const said = run.result.ok ? run.result.answer.verdict : `failed (${run.result.code})`;
    logger.info(
      `bench watcher test ${test.id}: ${run.model} said ${said}, ${run.passed ? 'pass' : 'FAIL'} in ${run.latencyMs} ms`,
    );
    return c.json(run satisfies BenchCheckRun, 201);
  });

  function logRun(run: BenchRun, scenarioId?: string): void {
    const where = scenarioId ? ` for ${scenarioId}` : '';
    const what = run.result.ok
      ? `${run.result.procedure.steps.length} steps`
      : `failed (${run.result.code})`;
    logger.info(`bench run ${run.id}${where}: ${run.model} ${what} in ${run.latencyMs} ms`);
  }

  return app;
}

/** A scenario's request at another stage: "rest" rewrites the outline of a stage-first plan. */
function staged(
  request: PlanRequestBody,
  stage: PlanStage | undefined,
  revise: BenchRevise | undefined,
): PlanRequestBody {
  if (!stage || stage === 'full') return request;
  if (stage === 'first' || !revise) return { ...request, stage };
  const skippedStepIds = revise.skippedStepIds ?? request.revise?.skippedStepIds;
  return {
    ...request,
    stage,
    revise: {
      planId: revise.base.id,
      fromStepIndex: revise.fromStepIndex,
      reason: revise.reason,
      ...(skippedStepIds ? { skippedStepIds } : {}),
      base: revise.base,
    },
  };
}

/** Records the stage a run was asked at, when the planner path did not. */
function withStage(run: BenchRun, body: Pick<PlanRequestBody, 'stage'>): BenchRun {
  if (body.stage === 'full' || run.request.stage) return run;
  return { ...run, request: { ...run.request, stage: body.stage } };
}
