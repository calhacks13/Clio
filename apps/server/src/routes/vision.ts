import {
  FocusRequestSchema,
  type FocusResponse,
  LocateRequestSchema,
  type LocateResponse,
  PrimaryRequestSchema,
  type PrimaryResponse,
} from '@clio/protocol';
import { Hono } from 'hono';
import type { ServerDeps } from '../deps';
import {
  geminiNotConfigured,
  upstreamFailed,
  upstreamTimedOut,
  visionNotConfigured,
} from '../errors';
import { describeError } from '../log';
import type { FocusAnswer } from '../services/focus';
import { GeminiTimeoutError } from '../services/gemini';
import { alignDetections, type LocateAnswer } from '../services/vision';
import { limitBody, parseBody } from './request';

export function visionRoutes({ locator, focus, primary, now, logger, limits }: ServerDeps): Hono {
  const app = new Hono();

  app.post('/api/vision/locate', limitBody(limits.imageBytes), async (c) => {
    if (!locator) throw visionNotConfigured();
    const body = await parseBody(c, LocateRequestSchema, 'locate request');
    const started = now().getTime();
    let answer: LocateAnswer;
    try {
      answer = await locator.locate(body);
    } catch (error) {
      throw upstreamFailed(`Vision request failed: ${describeError(error)}`);
    }
    const latencyMs = Math.max(0, now().getTime() - started);
    return c.json({
      detections: alignDetections(
        body.objects.map((o) => o.id),
        answer.detections,
      ),
      model: answer.model,
      latencyMs,
      ...(answer.refreshMs !== undefined && { refreshMs: answer.refreshMs }),
    } satisfies LocateResponse);
  });

  // The action focus: Robotics-ER 2 boxes the step's objects in one sharp frame, sharpens what
  // jev is told about each, and names the one thing to touch next. Always Gemini, whatever
  // CLIO_VISION_URL says: the tracker is what it corrects.
  app.post('/api/vision/focus', limitBody(limits.imageBytes), async (c) => {
    if (!focus) throw geminiNotConfigured('The action focus');
    const body = await parseBody(c, FocusRequestSchema, 'focus request');
    const started = now().getTime();
    let answer: FocusAnswer;
    try {
      answer = await focus.focus(body);
    } catch (error) {
      if (error instanceof GeminiTimeoutError) {
        throw upstreamTimedOut(`Action focus timed out: ${error.message}`);
      }
      throw upstreamFailed(`Action focus failed: ${describeError(error)}`);
    }
    return c.json({
      ...answer,
      model: focus.model,
      latencyMs: Math.max(0, now().getTime() - started),
    } satisfies FocusResponse);
  });

  // The primary-object demo: name the main object in view, then outline it.
  app.post('/api/vision/primary', limitBody(limits.imageBytes), async (c) => {
    if (!primary) throw geminiNotConfigured('Primary object detection');
    const body = await parseBody(c, PrimaryRequestSchema, 'primary request');
    let answer: PrimaryResponse;
    try {
      answer = await primary.find(body, c.req.raw.signal);
    } catch (error) {
      if (c.req.raw.signal.aborted) logger.info('primary: dropped, the client stopped waiting');
      throw upstreamFailed(`Primary object request failed: ${describeError(error)}`);
    }
    const { name, detection, model, timings: t } = answer;
    const what = name === null ? 'nothing named' : `"${name}" ${detection ? 'found' : 'not found'}`;
    logger.info(
      `primary: ${what} (${model.picker} ${t.pickMs} ms, ${model.finder} ${t.findMs} ms)`,
    );
    return c.json(answer satisfies PrimaryResponse);
  });

  return app;
}
