import { once } from 'node:events';
import { request as httpRequest, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiErrorSchema, ApiPaths, HealthResponseSchema } from '@clio/protocol';
import { createAdaptorServer } from '@hono/node-server';
import { describe, expect, it, onTestFinished } from 'vitest';
import { harness } from './harness';
import { APP_JS, ASSET, fakeBuild, INDEX_HTML, NAVIGATE, SECRET } from './static-fixtures';

// The server serves the built headset app at `/`, so one origin carries the app, the API and the
// relay (docs/deploy.md).

const IMMUTABLE = 'public, max-age=31536000, immutable';

async function served() {
  return harness({ staticDir: await fakeBuild() });
}

describe('the built headset app', () => {
  it('serves index.html at / and has the browser revalidate it on every load', async () => {
    const h = await served();
    for (const path of ['/', '/index.html']) {
      const res = await h.request('GET', path, undefined, NAVIGATE);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(await res.text()).toBe(INDEX_HTML);
    }
  });

  it.each([
    [ASSET.js, 'text/javascript; charset=utf-8'],
    [ASSET.css, 'text/css; charset=utf-8'],
    [ASSET.font, 'font/woff'],
    [ASSET.worklet, 'text/javascript; charset=utf-8'],
  ])('serves %s as %s', async (path, type) => {
    const h = await served();
    const res = await h.request('GET', path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(type);
  });

  it("caches Vite's hashed /assets for a year, and revalidates everything else", async () => {
    const h = await served();
    const js = await h.request('GET', ASSET.js);
    expect(js.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(await js.text()).toBe(APP_JS);
    const worklet = await h.request('GET', ASSET.worklet);
    expect(worklet.headers.get('cache-control')).toBe('no-cache');
  });

  it('answers HEAD with the length and no body', async () => {
    const h = await served();
    const res = await h.request('HEAD', ASSET.js);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(APP_JS.length));
    expect(await res.text()).toBe('');
  });

  it('falls back to index.html when a browser opens an unknown page', async () => {
    const h = await served();
    const res = await h.request('GET', '/lesson/shirt-fold', undefined, NAVIGATE);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it.each([
    ['/api/nope', NAVIGATE],
    ['/api', NAVIGATE],
    ['/gemini', NAVIGATE],
    ['/gemini/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent', {}],
    ['/assets/index-Old00000.js', NAVIGATE],
    ['/assets/', NAVIGATE],
    ['/favicon.ico', NAVIGATE],
    ['/lesson', { accept: '*/*' }],
  ])('never falls back for %s (accept: %o): JSON 404', async (path, headers) => {
    const h = await served();
    const res = await h.request('GET', path, undefined, headers);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBeNull();
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('not_found');
  });

  it('leaves the API as it was', async () => {
    const h = await served();
    const res = await h.request('GET', ApiPaths.health, undefined, NAVIGATE);
    expect(res.status).toBe(200);
    expect(HealthResponseSchema.parse(await res.json()).ok).toBe(true);
  });

  it('only answers GET and HEAD', async () => {
    const h = await served();
    const res = await h.request('POST', '/', 'x', NAVIGATE);
    expect(res.status).toBe(404);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('not_found');
  });

  it('never serves a file outside the build, whatever the request path', async () => {
    // A real server: request targets reach the app as sent, without URL normalization.
    const h = await served();
    const server = createAdaptorServer({ fetch: h.app.fetch });
    if (!(server instanceof Server)) throw new Error('Expected an HTTP/1.1 server');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;

    for (const path of [
      '/../secret.txt',
      '/assets/../../secret.txt',
      '/%2e%2e/secret.txt',
      '/..%2fsecret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/assets%2f..%2f..%2fsecret.txt',
      '//secret.txt',
      '/assets/\\..\\..\\secret.txt',
    ]) {
      const { status, body } = await rawGet(port, path);
      expect(body, path).not.toContain(SECRET);
      expect([400, 404], path).toContain(status);
    }
  });

  it('serves nothing without a build, as before', async () => {
    const h = await harness();
    const res = await h.request('GET', '/', undefined, NAVIGATE);
    expect(res.status).toBe(404);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('not_found');
  });
});

function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: NAVIGATE }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
