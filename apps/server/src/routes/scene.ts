import { SceneAskRequestSchema, type SceneAskResponse } from '@clio/protocol';
import { Hono } from 'hono';
import type { ServerDeps } from '../deps';
import { geminiNotConfigured, upstreamFailed } from '../errors';
import { describeError } from '../log';
import type { SceneAnswer } from '../services/scene';
import { limitBody, parseBody } from './request';

// The voice coach's closer look: fresh camera views and a question → the smart model's answer in
// words for the voice, plus where the things it points out are, for the AR layer.

export function sceneRoutes({ scene, now, limits }: ServerDeps): Hono {
  const app = new Hono();

  app.post('/api/scene/ask', limitBody(limits.imageBytes), async (c) => {
    if (!scene) throw geminiNotConfigured('Closer looks');
    const body = await parseBody(c, SceneAskRequestSchema, 'closer look request');
    const started = now().getTime();
    let answer: SceneAnswer;
    try {
      answer = await scene.ask(body);
    } catch (error) {
      throw upstreamFailed(`Closer look failed: ${describeError(error)}`);
    }
    return c.json({
      ...answer,
      model: scene.model,
      latencyMs: Math.max(0, now().getTime() - started),
    } satisfies SceneAskResponse);
  });

  return app;
}
