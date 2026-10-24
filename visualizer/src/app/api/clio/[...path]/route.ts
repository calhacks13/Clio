import { NextRequest } from "next/server";
import {
  clioResponseHeaders,
  clioUpstreamHeaders,
  planClioProxy,
} from "@/lib/clio/proxy-rules";

// Read-only, loopback-only proxy to the local Clio server, so the episode
// viewer reads recordings same-origin. The rules (methods, paths, the `from`
// offset, loopback upstream and Host) live in src/lib/clio/proxy-rules.ts.
// Only GET and HEAD are exported, so Next answers every write with a 405.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// How long to wait for the upstream's response headers. The body is not under
// this timeout: a long replay read streams for as long as the client reads.
const UPSTREAM_HEADERS_TIMEOUT_MS = 10_000;

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(
  req: NextRequest,
  ctx: RouteContext,
  method: "GET" | "HEAD",
): Promise<Response> {
  const { path } = await ctx.params;
  const plan = planClioProxy({
    method,
    path,
    searchParams: req.nextUrl.searchParams,
    host: req.headers.get("host"),
    serverUrl: process.env.CLIO_SERVER_URL,
  });
  if (!plan.ok) {
    return new Response(method === "HEAD" ? null : plan.message, {
      status: plan.status,
      headers: { "cache-control": "no-store" },
    });
  }

  // Abort when the client goes away, or when the server doesn't answer in
  // time. The timer is cleared once headers arrive.
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new DOMException("Upstream timeout", "TimeoutError")),
    UPSTREAM_HEADERS_TIMEOUT_MS,
  );
  let upstream: Response;
  try {
    upstream = await fetch(plan.url, {
      method,
      headers: clioUpstreamHeaders(),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([req.signal, timeout.signal]),
    });
  } catch (err) {
    const isTimeout = timeout.signal.aborted;
    if (!req.signal.aborted) {
      console.error("[clio proxy] upstream fetch failed", err);
    }
    const message = isTimeout
      ? "Gateway timeout: the Clio server took too long"
      : "Bad gateway: the Clio server is not reachable";
    return new Response(method === "HEAD" ? null : message, {
      status: isTimeout ? 504 : 502,
      headers: { "cache-control": "no-store" },
    });
  } finally {
    clearTimeout(timer);
  }

  return new Response(method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: clioResponseHeaders(upstream.headers),
  });
}

export function GET(req: NextRequest, ctx: RouteContext) {
  return proxy(req, ctx, "GET");
}

export function HEAD(req: NextRequest, ctx: RouteContext) {
  return proxy(req, ctx, "HEAD");
}
