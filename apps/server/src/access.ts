import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { ApiPaths } from '@clio/protocol';
import type { Context, MiddlewareHandler } from 'hono';
import { setCookie } from 'hono/cookie';
import { parse as parseCookies } from 'hono/utils/cookie';
import { unauthorized } from './errors';
import { isServerPath } from './routes/request';

// CLIO_ACCESS_KEY: an optional shared secret for public URLs (docs/deploy.md). Opening any page
// with ?key=<key> trades the key for a cookie, and same-origin fetches and WebSockets carry it from
// then on, so the headset needs no code for it. /api (except health) and the /gemini relay need
// the cookie or `Authorization: Bearer <key>`. The app's static files stay public: no secrets.

export const ACCESS_COOKIE = 'clio_access';
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

/** Constant time. Hashing first gives both sides one length, so not even the length leaks. */
export function keysMatch(given: string, key: string): boolean {
  return timingSafeEqual(sha256(given), sha256(key));
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest();

export interface Credentials {
  cookie?: string | undefined;
  authorization?: string | undefined;
}

/** The access cookie, or a bearer token (tools, and the Vite dev proxy). */
export function hasAccess({ cookie, authorization }: Credentials, key: string): boolean {
  const fromCookie = cookie ? parseCookies(cookie, ACCESS_COOKIE)[ACCESS_COOKIE] : undefined;
  const bearer = /^Bearer +(\S+) *$/i.exec(authorization ?? '')?.[1];
  return [fromCookie, bearer].some((given) => given !== undefined && keysMatch(given, key));
}

/** For the relay: a WebSocket upgrade carries the cookie like any other same-origin request. */
export function upgradeHasAccess(key: string): (req: IncomingMessage) => boolean {
  return (req) =>
    hasAccess({ cookie: req.headers.cookie, authorization: req.headers.authorization }, key);
}

/** Guards /api/*. GET /api/health stays open for platform health checks; it holds no secrets. */
export function requireAccess(key: string): MiddlewareHandler {
  return async (c, next) => {
    const health =
      c.req.path === ApiPaths.health && (c.req.method === 'GET' || c.req.method === 'HEAD');
    const credentials = {
      cookie: c.req.header('cookie'),
      authorization: c.req.header('authorization'),
    };
    if (health || hasAccess(credentials, key)) return next();
    return c.json(unauthorized().toBody(), 401, { 'WWW-Authenticate': 'Bearer realm="clio"' });
  };
}

/** A page opened with ?key=<key>: set the cookie, then redirect to the same URL without the key. */
export function acceptKeyLinks(key: string): MiddlewareHandler {
  return async (c, next) => {
    if ((c.req.method !== 'GET' && c.req.method !== 'HEAD') || isServerPath(c.req.path)) {
      return next();
    }
    const url = new URL(c.req.url);
    const parts = queryParts(url.search);
    const keyed = parts.some((p) => p.name === 'key' && p.values.some((v) => keysMatch(v, key)));
    // A wrong key sets nothing: the page loads, and its first API call explains (401).
    if (!keyed) return next();

    setCookie(c, ACCESS_COOKIE, key, {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: isHttps(c, url),
      maxAge: COOKIE_MAX_AGE_S,
    });
    c.header('Cache-Control', 'no-store');
    const rest = parts.filter((p) => p.name !== 'key').map((p) => p.raw);
    // One leading slash: `//host/…` would send the browser to another site.
    const path = url.pathname.replace(/^\/+/, '/');
    return c.redirect(rest.length > 0 ? `${path}?${rest.join('&')}` : path, 302);
  };
}

interface QueryPart {
  /** As sent, so the redirect keeps the other parameters byte for byte. */
  raw: string;
  name: string;
  /** Both readings of `+`: a browser sends a typed `+` as is (Render's base64 keys have them),
   * while form encoding makes it a space. */
  values: string[];
}

function queryParts(search: string): QueryPart[] {
  return search
    .slice(1)
    .split('&')
    .filter((raw) => raw !== '')
    .map((raw) => {
      const eq = raw.indexOf('=');
      const value = eq === -1 ? '' : raw.slice(eq + 1);
      return {
        raw,
        name: decode((eq === -1 ? raw : raw.slice(0, eq)).replaceAll('+', ' ')),
        values: [...new Set([decode(value), decode(value.replaceAll('+', ' '))])],
      };
    });
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** TLS usually ends at the tunnel or host in front, which says so in x-forwarded-proto. */
function isHttps(c: Context, url: URL): boolean {
  const forwarded = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  return (forwarded ?? url.protocol.replace(/:$/, '')) === 'https';
}
