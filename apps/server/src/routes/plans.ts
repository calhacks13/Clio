import {
  PlanRequestSchema,
  type PlanResponse,
  StepCheckRequestSchema,
  type StepCheckResponse,
  StepCriteriaRequestSchema,
  type StepCriteriaResponse,
} from '@clio/protocol';
import { Hono } from 'hono';
import type { ServerDeps } from '../deps';
import { geminiNotConfigured, notFound } from '../errors';
import { generatePlan } from '../services/plan-service';
import { askStepCheck, askStepCriteria } from '../services/step-check-service';
import { limitBody, parseBody, safeId } from './request';

// AI-generated lesson plans: written by the planner at runtime, stored in <data>/plans/. The
// planner's model also checks single steps from camera views for the headset's step watcher, and
// splits a step's done-when state into criteria when the step gains focus.

export function planRoutes({
  planner,
  checker,
  procedures,
  now,
  logger,
  limits,
}: ServerDeps): Hono {
  const app = new Hono();

  app.post('/api/plans', limitBody(limits.imageBytes), async (c) => {
    if (!planner) throw geminiNotConfigured('Plan generation');
    const body = await parseBody(c, PlanRequestSchema, 'plan request');
    if (body.revise) safeId(body.revise.planId, 'plan id');
    const started = now().getTime();
    const plan = await generatePlan({ planner, procedures, now }, body);
    const ms = Math.max(0, now().getTime() - started);
    const steps = plan.procedure.steps.length;
    const stage = body.stage === 'full' ? '' : ` (stage ${body.stage})`;
    logger.info(`plan ${plan.planId}${stage}: ${steps} steps from "${body.goal}" in ${ms} ms`);
    return c.json(plan satisfies PlanResponse);
  });

  app.post('/api/plans/check', limitBody(limits.imageBytes), async (c) => {
    if (!checker) throw geminiNotConfigured('Step checks');
    const body = await parseBody(c, StepCheckRequestSchema, 'step check request');
    const { answer, latencyMs } = await askStepCheck(checker, body, now);
    return c.json({ ...answer, model: checker.model, latencyMs } satisfies StepCheckResponse);
  });

  app.post('/api/plans/criteria', limitBody(limits.imageBytes), async (c) => {
    if (!checker) throw geminiNotConfigured('Step criteria');
    const body = await parseBody(c, StepCriteriaRequestSchema, 'step criteria request');
    const { criteria, latencyMs } = await askStepCriteria(checker, body, now);
    return c.json({ criteria, model: checker.model, latencyMs } satisfies StepCriteriaResponse);
  });

  app.get('/api/plans/:id', async (c) => {
    const id = safeId(c.req.param('id'), 'plan id');
    const plan = await procedures.getPlan(id);
    if (!plan) throw notFound(`No plan "${id}"`);
    return c.json(plan);
  });

  return app;
}
