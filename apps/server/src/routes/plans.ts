import { PlanRequestSchema, type PlanResponse } from '@clio/protocol';
import { Hono } from 'hono';
import type { ServerDeps } from '../deps';
import { geminiNotConfigured, notFound } from '../errors';
import { generatePlan } from '../services/plan-service';
import { limitBody, parseBody, safeId } from './request';

// AI-generated lesson plans: written by the planner at runtime, stored in <data>/plans/.

export function planRoutes({ planner, procedures, now, logger, limits }: ServerDeps): Hono {
  const app = new Hono();

  app.post('/api/plans', limitBody(limits.imageBytes), async (c) => {
    if (!planner) throw geminiNotConfigured('Plan generation');
    const body = await parseBody(c, PlanRequestSchema, 'plan request');
    if (body.revise) safeId(body.revise.planId, 'plan id');
    const plan = await generatePlan({ planner, procedures, now }, body);
    logger.info(`plan ${plan.planId}: ${plan.procedure.steps.length} steps from "${body.goal}"`);
    return c.json(plan satisfies PlanResponse);
  });

  app.get('/api/plans/:id', async (c) => {
    const id = safeId(c.req.param('id'), 'plan id');
    const plan = await procedures.getPlan(id);
    if (!plan) throw notFound(`No plan "${id}"`);
    return c.json(plan);
  });

  return app;
}
