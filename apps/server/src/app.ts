import { Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { type AppDeps, resolveDeps } from './deps';
import { ApiError, errorBody } from './errors';
import type { Logger } from './log';
import { benchRoutes } from './routes/bench';
import { clipRoutes } from './routes/clips';
import { coachRoutes } from './routes/coach';
import { episodeRoutes } from './routes/episodes';
import { healthRoutes } from './routes/health';
import { planRoutes } from './routes/plans';
import { procedureRoutes } from './routes/procedures';
import { sceneRoutes } from './routes/scene';
import { visionRoutes } from './routes/vision';

/** The HTTP API. The Gemini Live relay is not here: it hooks the server's `upgrade` event. */
export function createApp(deps: AppDeps): Hono {
  const d = resolveDeps(deps);
  const app = new Hono();

  app.use('*', logRequests(d.logger));
  // The headset reaches us through the Vite proxy (same origin); CORS is for tools in dev.
  app.use('/api/*', cors());

  app.route('/', healthRoutes(d));
  app.route('/', coachRoutes(d));
  app.route('/', procedureRoutes(d));
  app.route('/', planRoutes(d));
  app.route('/', visionRoutes(d));
  app.route('/', sceneRoutes(d));
  app.route('/', episodeRoutes(d));
  app.route('/', clipRoutes(d));
  app.route('/', benchRoutes(d));

  app.notFound((c) =>
    c.json(errorBody('not_found', `No route for ${c.req.method} ${c.req.path}`), 404),
  );
  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json(error.toBody(), error.status);
    if (error instanceof HTTPException) {
      const code = error.status === 413 ? 'payload_too_large' : 'http_error';
      return c.json(errorBody(code, error.message || 'Request failed'), error.status);
    }
    d.logger.error(`${c.req.method} ${c.req.path} failed`, error);
    return c.json(errorBody('internal', 'Internal server error'), 500);
  });
  return app;
}

function logRequests(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    await next();
    const ms = Math.round(performance.now() - started);
    logger.info(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
  };
}
