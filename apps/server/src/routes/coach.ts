import { CoachTokenRequestSchema, type CoachTokenResponse } from '@clio/protocol';
import { Hono } from 'hono';
import type { ServerDeps } from '../deps';
import { geminiNotConfigured, upstreamFailed } from '../errors';
import { describeError } from '../log';
import { limitBody, parseBody } from './request';

export function coachRoutes({ tokenMinter, liveModel, limits }: ServerDeps): Hono {
  const app = new Hono();

  app.post('/api/coach/token', limitBody(limits.jsonBytes), async (c) => {
    if (!tokenMinter) throw geminiNotConfigured('The direct coach transport');
    const { model = liveModel } = await parseBody(c, CoachTokenRequestSchema, 'token request', {
      emptyAsObject: true,
    });
    let minted: Awaited<ReturnType<typeof tokenMinter.mint>>;
    try {
      minted = await tokenMinter.mint(model);
    } catch (error) {
      throw upstreamFailed(`Could not mint a Gemini Live token: ${describeError(error)}`);
    }
    return c.json({ ...minted, model } satisfies CoachTokenResponse);
  });

  return app;
}
