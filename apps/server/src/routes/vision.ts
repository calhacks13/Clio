import { type Detection, LocateRequestSchema, type LocateResponse } from '@clio/protocol';
import { Hono } from 'hono';
import type { ServerDeps } from '../deps';
import { geminiNotConfigured, upstreamFailed } from '../errors';
import { describeError } from '../log';
import { alignDetections } from '../services/vision';
import { limitBody, parseBody } from './request';

export function visionRoutes({ locator, now, limits }: ServerDeps): Hono {
  const app = new Hono();

  app.post('/api/vision/locate', limitBody(limits.imageBytes), async (c) => {
    if (!locator) throw geminiNotConfigured('Object detection');
    const body = await parseBody(c, LocateRequestSchema, 'locate request');
    const started = now().getTime();
    let detections: Detection[];
    try {
      detections = await locator.locate(body);
    } catch (error) {
      throw upstreamFailed(`Vision request failed: ${describeError(error)}`);
    }
    const latencyMs = Math.max(0, now().getTime() - started);
    return c.json({
      detections: alignDetections(
        body.objects.map((o) => o.id),
        detections,
      ),
      model: locator.model,
      latencyMs,
    } satisfies LocateResponse);
  });

  return app;
}
