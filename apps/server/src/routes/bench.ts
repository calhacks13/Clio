import {
  BenchCheckRequestSchema,
  BenchJudgeRequestSchema,
  type BenchModelsResponse,
  BenchPaths,
  BenchPlanRequestSchema,
  type BenchRun,
  BenchRunScenarioRequestSchema,
  BenchRunUpdateSchema,
  BenchScenarioCreateSchema,
  type BenchScenarioListResponse,
  BenchScenarioUpdateSchema,
  type StepCheckResponse,
} from '@clio/protocol';
import { Hono } from 'hono';
import type { BenchDeps, ServerDeps } from '../deps';
import { ApiError, geminiNotConfigured, invalidId, notFound, upstreamFailed } from '../errors';
import { isSafeId } from '../ids';
import { describeError } from '../log';
import { type BenchModels, benchPlan, judgeRun, scenarioPlanRequest } from '../services/bench';
import { parseStepCheck } from '../services/step-check';
import { limitBody, parseBody, safeId } from './request';

// The planner bench (docs/planner-bench.md): the laptop page and `pnpm bench` put the planner in
// front of real scenes and grade what it writes. Plans here never reach the headset's lesson
// list, and nothing here is recorded in episodes.

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
    const run = await benchPlan({ planner, plans: on().plans, now, budgetMs }, body);
    logRun(run);
    return c.json(run satisfies BenchRun);
  });

  app.post(BenchPaths.check, limitBody(limits.imageBytes), async (c) => {
    const models = gemini();
    const { model, ...body } = await parseBody(c, BenchCheckRequestSchema, 'bench check request');
    const planner = models.planner(model ?? models.plannerModel);
    if (!planner.checkStep) throw geminiNotConfigured('Step checks');
    const started = now().getTime();
    let text: string;
    try {
      text = await planner.checkStep(body);
    } catch (error) {
      throw upstreamFailed(`Step check failed: ${describeError(error)}`);
    }
    const latencyMs = Math.max(0, now().getTime() - started);
    try {
      const answer = parseStepCheck(text);
      return c.json({ ...answer, model: planner.model, latencyMs } satisfies StepCheckResponse);
    } catch (error) {
      throw upstreamFailed(`Step check gave an unusable answer: ${describeError(error)}`);
    }
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
    const { model, budgetMs } = await parseBody(
      c,
      BenchRunScenarioRequestSchema,
      'bench run request',
      { emptyAsObject: true },
    );
    const images = await on().store.readViews(scenario);
    const planner = models.planner(model ?? models.plannerModel);
    const run = await benchPlan(
      { planner, plans: on().plans, now, budgetMs },
      scenarioPlanRequest(scenario, images),
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

  function logRun(run: BenchRun, scenarioId?: string): void {
    const where = scenarioId ? ` for ${scenarioId}` : '';
    const what = run.result.ok
      ? `${run.result.procedure.steps.length} steps`
      : `failed (${run.result.code})`;
    logger.info(`bench run ${run.id}${where}: ${run.model} ${what} in ${run.latencyMs} ms`);
  }

  return app;
}
