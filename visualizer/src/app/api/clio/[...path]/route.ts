import { NextRequest } from "next/server";
import { DatasetExportRequestSchema } from "@clio/protocol";
import {
  clioResponseHeaders,
  clioUpstreamHeaders,
  planClioProxy,
} from "@/lib/clio/proxy-rules";

// Loopback-only proxy: episode reads and an explicit dataset export POST.
// Paths and upstream/Host restrictions live in src/lib/clio/proxy-rules.ts.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// How long to wait for the upstream's response headers. The body is not under
// this timeout: a long replay read streams for as long as the client reads.
const UPSTREAM_HEADERS_TIMEOUT_MS = 10_000;

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(
  req: NextRequest,
  ctx: RouteContext,
  method: "GET" | "HEAD" | "POST",
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

  let body: string | undefined;
  const headers = clioUpstreamHeaders();
  if (method === "POST") {
    // This is the only permitted write: an explicit, same-origin local export.
    const origin = req.headers.get("origin");
    if (
      (origin &&
        origin !== `${req.nextUrl.protocol}//${req.headers.get("host")}`) ||
      req.headers.get("sec-fetch-site") === "cross-site"
    ) {
      return new Response("Forbidden origin", { status: 403 });
    }
    if (!req.headers.get("content-type")?.startsWith("application/json")) {
      return new Response("Expected JSON", { status: 415 });
    }
    const reader = req.body?.getReader();
    let text = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 16_384) {
          await reader.cancel();
          return new Response("Export request too large", { status: 413 });
        }
        text += decoder.decode(value, { stream: true });
      }
    }
    try {
      body = JSON.stringify(
        DatasetExportRequestSchema.parse(JSON.parse(text + decoder.decode())),
      );
    } catch {
      return new Response("Invalid dataset export request", { status: 400 });
    }
    headers.set("content-type", "application/json");
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
      headers,
      body,
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

export function POST(req: NextRequest, ctx: RouteContext) {
  return proxy(req, ctx, "POST");
}
