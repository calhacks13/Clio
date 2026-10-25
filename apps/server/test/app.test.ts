import { join } from 'node:path';
import { ApiErrorSchema, ApiPaths, HealthResponseSchema } from '@clio/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { ClipStore } from '../src/storage/clip-store';
import { DerivedStore } from '../src/storage/derived-store';
import { EpisodeStore } from '../src/storage/episode-store';
import { ProcedureStore } from '../src/storage/procedure-store';
import { SceneStore } from '../src/storage/scene-store';
import { episodeCreate } from './fixtures';
import { captureLogger, harness, tempDir } from './harness';

const fakeMinter = { mint: async () => ({ token: 't', expiresAt: '2026-10-24T03:45:00.000Z' }) };

describe('GET /api/health', () => {
  it('reports the version, the live model and the relay path', async () => {
    const h = await harness();
    const res = await h.request('GET', ApiPaths.health);
    expect(res.status).toBe(200);
    expect(HealthResponseSchema.parse(await res.json())).toEqual({
      ok: true,
      version: '9.9.9-test',
      coach: { configured: false, liveModel: 'live-test', relayPath: '/gemini' },
    });
  });

  it('says the coach is configured when Gemini services are wired', async () => {
    const h = await harness({ tokenMinter: fakeMinter });
    const res = await h.request('GET', ApiPaths.health);
    expect(HealthResponseSchema.parse(await res.json()).coach.configured).toBe(true);
  });
});

describe('app', () => {
  it('answers unknown routes with a JSON 404', async () => {
    const h = await harness();
    const res = await h.request('GET', '/api/nope');
    expect(res.status).toBe(404);
    expect(ApiErrorSchema.parse(await res.json()).error).toEqual({
      code: 'not_found',
      message: 'No route for GET /api/nope',
    });
  });

  it('turns unexpected errors into a logged JSON 500 without leaking details', async () => {
    const h = await harness();
    vi.spyOn(h.episodes, 'list').mockRejectedValue(new Error('EACCES: permission denied'));
    const res = await h.request('GET', ApiPaths.episodes);
    expect(res.status).toBe(500);
    expect(ApiErrorSchema.parse(await res.json()).error).toEqual({
      code: 'internal',
      message: 'Internal server error',
    });
    expect(h.logger.lines.some((l) => l.startsWith('error GET /api/episodes failed'))).toBe(true);
  });

  it('logs one line per request', async () => {
    const h = await harness();
    await h.request('GET', ApiPaths.health);
    expect(h.logger.lines.filter((l) => l.startsWith('info GET /api/health 200'))).toHaveLength(1);
  });
});

describe('CORS on /api', () => {
  const corsHeaders = (res: Response) =>
    [...res.headers.keys()].filter((name) => name.startsWith('access-control-'));
  const preflight = (origin: string, method = 'POST') => ({
    origin,
    'access-control-request-method': method,
    'access-control-request-headers': 'content-type',
  });

  it('lets the visualizer viewer read /api, including the x-next-from offset', async () => {
    const h = await harness();
    const created = await h.request('POST', ApiPaths.episodes, episodeCreate());
    expect(created.status).toBe(201);
    const { episodeId } = (await created.json()) as { episodeId: string };
    for (const origin of ['http://127.0.0.1:3001', 'http://localhost:3001']) {
      const res = await h.request('GET', `${ApiPaths.episodeFrames(episodeId)}?from=0`, undefined, {
        origin,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-next-from')).toBe('0');
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
      expect(res.headers.get('access-control-expose-headers')?.split(',')).toContain('x-next-from');
      expect(res.headers.get('vary')).toContain('Origin');
    }
  });

  it('answers a preflight from the visualizer viewer', async () => {
    const h = await harness();
    const res = await h.request(
      'OPTIONS',
      ApiPaths.episodes,
      undefined,
      preflight('http://127.0.0.1:3001'),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:3001');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type');
  });

  it('gives any other origin no CORS headers, on the coach token route too', async () => {
    const h = await harness({ tokenMinter: fakeMinter });
    const origin = 'https://example.com';
    const site = { origin, 'sec-fetch-site': 'cross-site' };
    const list = await h.request('GET', ApiPaths.episodes, undefined, site);
    const token = await h.request('POST', ApiPaths.coachToken, {}, site);
    const tokenPreflight = await h.request('OPTIONS', ApiPaths.coachToken, undefined, {
      ...preflight(origin),
      'sec-fetch-site': 'cross-site',
    });
    const listPreflight = await h.request('OPTIONS', ApiPaths.episodes, undefined, {
      ...preflight(origin, 'GET'),
      'sec-fetch-site': 'cross-site',
    });
    for (const res of [list, token, tokenPreflight, listPreflight]) {
      expect(res.status).toBe(403);
      expect(corsHeaders(res)).toEqual([]);
    }
    expect(ApiErrorSchema.parse(await token.json()).error.code).toBe('forbidden_origin');
  });

  it('refuses writes from other websites that a browser sends without a preflight', async () => {
    const mint = vi.fn(fakeMinter.mint);
    const h = await harness({ tokenMinter: { mint } });
    // A form post or a `no-cors` fetch: text/plain body, no preflight. Other local ports count too.
    for (const site of [
      { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      { origin: 'http://127.0.0.1:4000', 'sec-fetch-site': 'same-site' },
    ]) {
      const headers = { ...site, 'content-type': 'text/plain' };
      const body = JSON.stringify(episodeCreate());
      expect((await h.request('POST', ApiPaths.episodes, body, headers)).status).toBe(403);
      expect((await h.request('POST', ApiPaths.coachToken, '{}', headers)).status).toBe(403);
    }
    expect(await h.episodes.list()).toEqual([]);
    expect(mint).not.toHaveBeenCalled();
  });

  it('serves the headset through the Vite proxy as before', async () => {
    const h = await harness({ tokenMinter: fakeMinter });
    // Same-origin GETs carry no Origin; same-origin POSTs carry the Vite origin. Neither needs CORS.
    const health = await h.request('GET', ApiPaths.health);
    const token = await h.request(
      'POST',
      ApiPaths.coachToken,
      {},
      { origin: 'https://localhost:5173', 'sec-fetch-site': 'same-origin' },
    );
    expect(health.status).toBe(200);
    expect(token.status).toBe(200);
    expect(await token.json()).toMatchObject({ token: 't' });
    expect([...corsHeaders(health), ...corsHeaders(token)]).toEqual([]);
  });

  it('uses the origins it is given instead of the default', async () => {
    const dir = await tempDir();
    const app = createApp({
      version: '9.9.9-test',
      liveModel: 'live-test',
      episodes: new EpisodeStore(join(dir, 'episodes')),
      derived: new DerivedStore(join(dir, 'derived')),
      scenes: new SceneStore(join(dir, 'scenes')),
      procedures: new ProcedureStore({
        curatedDir: join(dir, 'procedures'),
        plansDir: join(dir, 'plans'),
      }),
      clips: new ClipStore(join(dir, 'clips')),
      logger: captureLogger(),
      corsOrigins: ['https://viewer.test'],
    });
    const from = (origin: string) => app.request(ApiPaths.health, { headers: { origin } });
    expect((await from('https://viewer.test')).headers.get('access-control-allow-origin')).toBe(
      'https://viewer.test',
    );
    expect(corsHeaders(await from('http://127.0.0.1:3001'))).toEqual([]);
  });
});
