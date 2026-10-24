import { GEMINI_RELAY_PATH, type HealthResponse } from '@clio/protocol';
import { Hono } from 'hono';
import type { ServerDeps } from '../deps';

export function healthRoutes({ version, liveModel, tokenMinter }: ServerDeps): Hono {
  const app = new Hono();
  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      version,
      coach: { configured: tokenMinter !== null, liveModel, relayPath: GEMINI_RELAY_PATH },
    } satisfies HealthResponse),
  );
  return app;
}
