import { serveStatic } from '@hono/node-server/serve-static';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { isServerPath } from './request';

// The built headset app (`pnpm build`), so one origin serves the app, the API and the relay, and
// any HTTPS front (a tunnel, a cloud host) gives the headset a single URL (docs/deploy.md).
// Vite's hashed /assets/* never change, so browsers keep them for a year. Everything else
// (index.html, the audio worklet) is revalidated on every load, so a rebuild shows up at once.

const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

export function staticAppRoutes(dir: string): Hono {
  const app = new Hono();
  const files = serveStatic({ root: dir });
  const shell = serveStatic({ root: dir, path: 'index.html' });

  app.get('*', async (c, next) => {
    const path = c.req.path;
    if (isServerPath(path)) return next();
    const hashed = path.startsWith('/assets/');
    const file = await serve(files, c, hashed ? IMMUTABLE : REVALIDATE);
    if (file) return file;
    // A missing file stays a 404 (a stale hash must not get HTML back as JavaScript); a browser
    // opening an unknown page gets the app.
    if (hashed || !isPageNavigation(c)) return next();
    return (await serve(shell, c, REVALIDATE)) ?? next();
  });
  return app;
}

/** The file's response with `cacheControl`, or undefined (and no header left behind) on a miss. */
async function serve(
  handler: MiddlewareHandler,
  c: Context,
  cacheControl: string,
): Promise<Response | undefined> {
  c.header('Cache-Control', cacheControl);
  let missed = false;
  const res = await handler(c, async () => {
    missed = true;
  });
  if (!missed && res instanceof Response) return res;
  c.header('Cache-Control', undefined);
  return undefined;
}

/** A browser opening a page: it accepts HTML, and the path has no file extension. */
function isPageNavigation(c: Context): boolean {
  const last = c.req.path.slice(c.req.path.lastIndexOf('/') + 1);
  return !last.includes('.') && (c.req.header('accept') ?? '').includes('text/html');
}
