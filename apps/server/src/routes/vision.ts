import {
  LocateRequestSchema,
  type LocateResponse,
  PrimaryRequestSchema,
  type PrimaryResponse,
} from '@clio/protocol';
import { Hono } from 'hono';
import type { ServerDeps } from '../deps';
import { geminiNotConfigured, upstreamFailed, visionNotConfigured } from '../errors';
import { describeError } from '../log';
import { alignDetections, type LocateAnswer } from '../services/vision';
import { limitBody, parseBody } from './request';

export function visionRoutes({ locator, primary, now, logger, limits }: ServerDeps): Hono {
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
    } satisfies LocateResponse);
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
