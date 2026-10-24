import type { IncomingMessage } from 'node:http';
import { ApiErrorSchema, ApiPaths } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ACCESS_COOKIE, hasAccess, keysMatch, upgradeHasAccess } from '../src/access';
import { harness } from './harness';
import { ASSET, fakeBuild, INDEX_HTML, NAVIGATE } from './static-fixtures';

// CLIO_ACCESS_KEY: a shared secret for public URLs (docs/deploy.md). ?key=<key> on any page trades
// it for a cookie; /api (except health) and the relay then need the cookie or a bearer token.

const KEY = 'k3y-for-tests';

async function gated(accessKey = KEY) {
  return harness({ accessKey, staticDir: await fakeBuild() });
}

const withCookie = (value = KEY) => ({ cookie: `theme=dark; ${ACCESS_COOKIE}=${value}` });
const withBearer = (value = KEY) => ({ authorization: `Bearer ${value}` });

describe('keysMatch', () => {
  it('compares whole keys', () => {
    expect(keysMatch(KEY, KEY)).toBe(true);
    expect(keysMatch('k3y-for-test', KEY)).toBe(false);
    expect(keysMatch(`${KEY}x`, KEY)).toBe(false);
    expect(keysMatch('', KEY)).toBe(false);
  });
});

describe('hasAccess', () => {
  it('accepts the access cookie or a bearer token, and nothing else', () => {
    expect(hasAccess(withCookie(), KEY)).toBe(true);
    expect(hasAccess(withBearer(), KEY)).toBe(true);
    expect(hasAccess({ authorization: `bearer ${KEY}` }, KEY)).toBe(true);
    expect(hasAccess(withCookie('nope'), KEY)).toBe(false);
    expect(hasAccess(withBearer('nope'), KEY)).toBe(false);
    expect(hasAccess({ authorization: `Basic ${KEY}` }, KEY)).toBe(false);
    expect(hasAccess({ cookie: `other=${KEY}` }, KEY)).toBe(false);
    expect(hasAccess({}, KEY)).toBe(false);
  });

  it('reads the headers of a WebSocket upgrade request', () => {
    const allowed = upgradeHasAccess(KEY);
    expect(allowed({ headers: withCookie() } as IncomingMessage)).toBe(true);
    expect(allowed({ headers: {} } as IncomingMessage)).toBe(false);
  });
});

describe('without CLIO_ACCESS_KEY', () => {
  it('leaves the API open and ignores ?key= links', async () => {
    const h = await harness({ staticDir: await fakeBuild() });
    expect((await h.request('GET', ApiPaths.procedures)).status).toBe(200);
    const page = await h.request('GET', `/?key=${KEY}`, undefined, NAVIGATE);
    expect(page.status).toBe(200);
    expect(page.headers.get('set-cookie')).toBeNull();
    expect(await page.text()).toBe(INDEX_HTML);
  });
});

describe('with CLIO_ACCESS_KEY', () => {
  it('answers /api with a JSON 401 that says how to get in', async () => {
    const h = await gated();
    const res = await h.request('GET', ApiPaths.procedures);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
    const { error } = ApiErrorSchema.parse(await res.json());
    expect(error.code).toBe('unauthorized');
    expect(error.message).toContain('?key=');
  });

  it('turns requests away before reading their bodies', async () => {
    const h = await gated();
    const res = await h.request('POST', ApiPaths.episodes, { not: 'an episode' });
    expect(res.status).toBe(401);
  });

  it('keeps GET /api/health open for platform health checks', async () => {
    const h = await gated();
    expect((await h.request('GET', ApiPaths.health)).status).toBe(200);
    expect((await h.request('HEAD', ApiPaths.health)).status).toBe(200);
  });

  it('lets the access cookie or a bearer token through', async () => {
    const h = await gated();
    expect((await h.request('GET', ApiPaths.procedures, undefined, withCookie())).status).toBe(200);
    expect((await h.request('GET', ApiPaths.procedures, undefined, withBearer())).status).toBe(200);
    expect((await h.request('GET', ApiPaths.procedures, undefined, withCookie('x'))).status).toBe(
      401,
    );
    expect((await h.request('GET', ApiPaths.procedures, undefined, withBearer('x'))).status).toBe(
      401,
    );
  });

  it('does not take ?key= as a credential on the API', async () => {
    const h = await gated();
    expect((await h.request('GET', `${ApiPaths.procedures}?key=${KEY}`)).status).toBe(401);
  });

  it('gates unknown API routes too, which stay JSON 404s for those with the key', async () => {
    const h = await gated();
    expect((await h.request('GET', '/api/nope')).status).toBe(401);
    expect((await h.request('GET', '/api/nope', undefined, withBearer())).status).toBe(404);
  });

  it('still answers CORS preflights, which never carry credentials', async () => {
    const h = await gated();
    const res = await h.request('OPTIONS', ApiPaths.episodes, undefined, {
      origin: 'http://localhost:3000',
      'access-control-request-method': 'POST',
    });
    expect(res.status).toBe(204);
  });

  it('trades a ?key= link for a 30-day HttpOnly cookie and redirects to the URL without it', async () => {
    const h = await gated();
    const res = await h.request('GET', `/?emulate=1&key=${KEY}&debug=1`, undefined, NAVIGATE);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?emulate=1&debug=1');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(new RegExp(`^${ACCESS_COOKIE}=${KEY};`));
    expect(cookie).toContain('Max-Age=2592000');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
  });

  it('marks the cookie Secure behind an HTTPS front (x-forwarded-proto)', async () => {
    const h = await gated();
    const res = await h.request('GET', `/?key=${KEY}`, undefined, {
      ...NAVIGATE,
      'x-forwarded-proto': 'https',
    });
    expect(res.headers.get('set-cookie')).toContain('Secure');
  });

  it('opens the API with the cookie the link set', async () => {
    const h = await gated();
    const link = await h.request('GET', `/?key=${KEY}`, undefined, NAVIGATE);
    const cookie = (link.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const res = await h.request('GET', ApiPaths.procedures, undefined, { cookie });
    expect(res.status).toBe(200);
  });

  it('keeps the path and drops every key parameter', async () => {
    const h = await gated();
    const location = async (path: string) =>
      (await h.request('GET', path, undefined, NAVIGATE)).headers.get('location');
    expect(await location(`/lesson/fold?key=${KEY}`)).toBe('/lesson/fold');
    expect(await location(`/?key=wrong&key=${KEY}`)).toBe('/');
    expect(await location(`/?goal=wash%20a%20cup&key=${KEY}`)).toBe('/?goal=wash%20a%20cup');
  });

  it('never redirects to another site', async () => {
    const h = await gated();
    const res = await h.request('GET', `http://localhost//evil.example/?key=${KEY}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/evil.example/');
  });

  it('reads keys with + / and = as typed or percent-encoded', async () => {
    // Render's generateValue makes base64 keys, and a browser sends a typed `+` as is.
    const key = 'ab+cd/ef==';
    const h = await gated(key);
    for (const typed of ['ab+cd/ef==', 'ab%2Bcd%2Fef%3D%3D']) {
      const res = await h.request('GET', `/?key=${typed}`, undefined, NAVIGATE);
      expect(res.status, typed).toBe(302);
      expect(res.headers.get('set-cookie')).toContain(
        `${ACCESS_COOKIE}=${encodeURIComponent(key)}`,
      );
    }
    const cookie = `${ACCESS_COOKIE}=${encodeURIComponent(key)}`;
    expect((await h.request('GET', ApiPaths.procedures, undefined, { cookie })).status).toBe(200);
  });

  it('sets nothing for a wrong key, and the page itself stays public', async () => {
    const h = await gated();
    const res = await h.request('GET', '/?key=wrong', undefined, NAVIGATE);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it('keeps static files public', async () => {
    const h = await gated();
    expect((await h.request('GET', ASSET.js)).status).toBe(200);
    expect((await h.request('GET', '/', undefined, NAVIGATE)).status).toBe(200);
  });
});
