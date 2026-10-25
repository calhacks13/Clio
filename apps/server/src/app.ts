import { Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { DEFAULT_CORS_ORIGINS } from './config';
import { type AppDeps, resolveDeps } from './deps';
import { ApiError, errorBody } from './errors';
import type { Logger } from './log';
import { benchRoutes } from './routes/bench';
import { clipRoutes } from './routes/clips';
import { coachRoutes } from './routes/coach';
import { datasetRoutes } from './routes/datasets';
import { episodeRoutes } from './routes/episodes';
import { healthRoutes } from './routes/health';
import { planRoutes } from './routes/plans';
import { procedureRoutes } from './routes/procedures';
import { sceneRoutes } from './routes/scene';
import { visionRoutes } from './routes/vision';

export interface AppOptions extends AppDeps {
  /** Browser origins that may call /api cross-origin. Default: the visualizer viewer's. */
  corsOrigins?: readonly string[];
}

/** The HTTP API. The Gemini Live relay is not here: it hooks the server's `upgrade` event. */
export function createApp({ corsOrigins = DEFAULT_CORS_ORIGINS, ...deps }: AppOptions): Hono {
  const d = resolveDeps(deps);
  const app = new Hono();

  app.use('*', logRequests(d.logger));
  // The headset reaches us through the Vite proxy (same origin), which needs no CORS.
  app.use('/api/*', corsFor(corsOrigins));

  app.route('/', healthRoutes(d));
  app.route('/', coachRoutes(d));
  app.route('/', procedureRoutes(d));
  app.route('/', planRoutes(d));
  app.route('/', visionRoutes(d));
  app.route('/', sceneRoutes(d));
  app.route('/', episodeRoutes(d));
  app.route('/', datasetRoutes(d));
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

/**
 * CORS for the listed origins only. Any other website open on this laptop gets no CORS headers, so
 * its scripts can't read recordings or minted coach tokens. Hono's `cors()` alone would still send
 * the expose and preflight headers to every origin. Other websites' requests are refused too: a form
 * post or a `no-cors` fetch with a text/plain body needs no preflight, so it would still reach the
 * routes and could create episodes, mint tokens or spend the Gemini key.
 */
function corsFor(origins: readonly string[]): MiddlewareHandler {
  const allowed = new Set(origins);
  // `x-next-from` is how a viewer following a live episode resumes its frames/events/objects reads.
  const handler = cors({ origin: [...allowed], exposeHeaders: ['x-next-from'] });
  return async (c, next) => {
    const origin = c.req.header('origin');
    if (origin === undefined) return next();
    if (allowed.has(origin)) return handler(c, next);
    // Browsers send Sec-Fetch-Site to loopback. The headset's posts come through the Vite proxy as
    // same-origin; tools such as curl send neither header.
    const site = c.req.header('sec-fetch-site');
    if (site === 'cross-site' || site === 'same-site') {
      return c.json(errorBody('forbidden_origin', `Requests from ${origin} are not allowed`), 403);
    }
    return next();
  };
}

function logRequests(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    await next();
    const ms = Math.round(performance.now() - started);
    logger.info(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
  };
}
