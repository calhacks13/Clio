import {
  PlanRequestSchema,
  type PlanResponse,
  StepCheckRequestSchema,
  type StepCheckResponse,
} from '@clio/protocol';
import { Hono } from 'hono';
import type { ServerDeps } from '../deps';
import { geminiNotConfigured, notFound, upstreamFailed } from '../errors';
import { describeError } from '../log';
import { generatePlan } from '../services/plan-service';
import { parseStepCheck, type StepCheckAnswer } from '../services/step-check';
import { limitBody, parseBody, safeId } from './request';

// AI-generated lesson plans: written by the planner at runtime, stored in <data>/plans/. The
// planner's model also checks single steps from camera views for the headset's step watcher.

export function planRoutes({ planner, procedures, now, logger, limits }: ServerDeps): Hono {
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
    if (!planner?.checkStep) throw geminiNotConfigured('Step checks');
    const body = await parseBody(c, StepCheckRequestSchema, 'step check request');
    const started = now().getTime();
    let text: string;
    try {
      text = await planner.checkStep(body);
    } catch (error) {
      throw upstreamFailed(`Step check failed: ${describeError(error)}`);
    }
    const latencyMs = Math.max(0, now().getTime() - started);
    let answer: StepCheckAnswer;
    try {
      answer = parseStepCheck(text);
    } catch (error) {
      throw upstreamFailed(`Step check gave an unusable answer: ${describeError(error)}`);
    }
    return c.json({ ...answer, model: planner.model, latencyMs } satisfies StepCheckResponse);
  });

  app.get('/api/plans/:id', async (c) => {
    const id = safeId(c.req.param('id'), 'plan id');
    const plan = await procedures.getPlan(id);
    if (!plan) throw notFound(`No plan "${id}"`);
    return c.json(plan);
  });

  return app;
}
