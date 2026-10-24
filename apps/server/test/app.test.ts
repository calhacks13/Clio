import { ApiErrorSchema, ApiPaths, HealthResponseSchema } from '@clio/protocol';
import { describe, expect, it, vi } from 'vitest';
import { harness } from './harness';

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

  it('allows cross-origin calls to /api in development', async () => {
    const h = await harness();
    const res = await h.request('OPTIONS', ApiPaths.episodes, undefined, {
      origin: 'https://192.168.1.20:5173',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('PUT');
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type');
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
