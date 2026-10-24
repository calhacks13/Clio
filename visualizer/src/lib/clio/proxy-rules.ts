import { DERIVED_FILE_NAME } from "@clio/protocol";

// Rules for the read-only Clio proxy at /api/clio/[...path].
//
// The browser reads the local Clio server (127.0.0.1:8787) through this
// same-origin route, so the server needs no CORS for the viewer. The route is
// deliberately narrow, so it can't become a general proxy into the server:
//
// - GET and HEAD only. Writes (episode create, batches, finish, media) never
//   pass through.
// - Only the episode list, one episode's detail, its frames, events and
//   objects files, and its compiled files (derived/<name>, a DERIVED_FILE_NAME
//   from @clio/protocol). /gemini, /api/coach/token, /api/plans, /api/vision,
//   /api/clips and the compile trigger are never reachable.
// - The upstream must be a loopback http(s) origin, and so must the Host the
//   request arrived on (a DNS-rebound page can't read local recordings).
// - Request headers are built from scratch, so the hf_access_token cookie and
//   every other browser header stay on this side.
//
// Pure, so the rules are tested without Next.

export const DEFAULT_CLIO_SERVER_URL = "http://127.0.0.1:8787";

export const CLIO_PROXY_METHODS: readonly string[] = ["GET", "HEAD"];

export const CLIO_CHANNELS = ["frames", "events", "objects"] as const;

/** The segment before a compiled file's name: episodes/<id>/derived/<name>. */
const DERIVED = "derived";

// Same rule as the server's ids (apps/server/src/ids.ts). It also rules out
// "." and "..", and anything an encoded slash or percent decodes into.
const EPISODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// A byte offset. Sixteen digits covers every safe integer.
const BYTE_OFFSET = /^\d{1,16}$/;

// The only response headers the browser sees, besides cache-control.
const FORWARD_RESPONSE_HEADERS = ["content-type", "x-next-from"];

export type ClioProxyRequest = {
  method: string;
  // The catch-all segments after /api/clio, as Next decodes them.
  path: readonly string[];
  searchParams: URLSearchParams;
  // The Host header the request arrived with.
  host: string | null;
  // process.env.CLIO_SERVER_URL; unset means DEFAULT_CLIO_SERVER_URL.
  serverUrl: string | undefined;
};

export type ClioProxyPlan =
  | { ok: true; url: URL }
  | { ok: false; status: number; message: string };

export function isLoopbackHostname(hostname: string): boolean {
  const name = hostname.toLowerCase();
  if (name === "localhost" || name === "[::1]" || name === "::1") return true;
  const octets = name.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)
  );
}

// A Host header is "hostname[:port]" and nothing else.
export function isLoopbackHost(host: string | null): boolean {
  if (!host || /[^A-Za-z0-9.:[\]-]/.test(host)) return false;
  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return false;
  }
  return isLoopbackHostname(url.hostname);
}

// The upstream origin, or null when CLIO_SERVER_URL is not a bare loopback
// http(s) origin (no credentials, path, query or fragment).
export function clioUpstreamOrigin(serverUrl: string | undefined): URL | null {
  let url: URL;
  try {
    url = new URL(serverUrl?.trim() || DEFAULT_CLIO_SERVER_URL);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/") return null;
  if (!isLoopbackHostname(url.hostname)) return null;
  return url;
}

// The server path for the catch-all segments, or null when it isn't one of
// the readable episode routes.
export function clioUpstreamPath(path: readonly string[]): string | null {
  const [root, id, channel, name, ...rest] = path;
  if (root !== "episodes" || rest.length > 0) return null;
  if (id === undefined) return "/api/episodes";
  if (!EPISODE_ID.test(id)) return null;
  if (channel === undefined) return `/api/episodes/${id}`;
  if (channel === DERIVED) {
    // The name pattern also excludes dot segments, slashes and percent signs.
    if (name === undefined || !DERIVED_FILE_NAME.test(name)) return null;
    return `/api/episodes/${id}/${DERIVED}/${name}`;
  }
  if (name !== undefined) return null;
  if (!(CLIO_CHANNELS as readonly string[]).includes(channel)) return null;
  return `/api/episodes/${id}/${channel}`;
}

export function planClioProxy(req: ClioProxyRequest): ClioProxyPlan {
  if (!CLIO_PROXY_METHODS.includes(req.method.toUpperCase())) {
    return { ok: false, status: 405, message: "Method not allowed" };
  }
  if (!isLoopbackHost(req.host)) {
    return { ok: false, status: 403, message: "Forbidden host" };
  }
  const origin = clioUpstreamOrigin(req.serverUrl);
  if (!origin) {
    return {
      ok: false,
      status: 500,
      message: "CLIO_SERVER_URL must be a loopback http origin",
    };
  }
  const upstreamPath = clioUpstreamPath(req.path);
  if (!upstreamPath) return { ok: false, status: 404, message: "Not found" };

  const from = req.searchParams.getAll("from");
  if (
    from.length > 1 ||
    (from[0] !== undefined && !BYTE_OFFSET.test(from[0]))
  ) {
    return { ok: false, status: 400, message: "Invalid from" };
  }

  const url = new URL(upstreamPath, origin);
  // The path is built from checked parts, so this only guards against a
  // future change to the rules above.
  if (url.origin !== origin.origin || url.pathname !== upstreamPath) {
    return { ok: false, status: 404, message: "Not found" };
  }
  const isChannel = req.path.length === 3;
  if (isChannel && from[0] !== undefined) url.searchParams.set("from", from[0]);
  return { ok: true, url };
}

// Nothing from the browser's request is forwarded: no cookies, no
// authorization, no origin or referer.
export function clioUpstreamHeaders(): Headers {
  return new Headers({ accept: "application/json, application/x-ndjson" });
}

export function clioResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers({ "cache-control": "no-store" });
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}
