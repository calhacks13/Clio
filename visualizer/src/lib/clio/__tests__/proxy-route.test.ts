import { afterEach, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { GET, HEAD } from "@/app/api/clio/[...path]/route";

// The proxy route itself, with the upstream behind a mocked fetch: binary
// files (the room scan, the object models, their crops) come back byte for
// byte with their content-type, and the server's own status passes through.
// The rules are tested in proxy-rules.test.ts.

const ID = "ep-20261024-120000-synt";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Every byte value, so nothing is decoded as text on the way. */
const BINARY = Uint8Array.from({ length: 256 }, (_, i) => i);

function serve(response: () => Response) {
  const upstream = mock<
    (input: unknown, init?: RequestInit) => Promise<Response>
  >(async () => response());
  globalThis.fetch = upstream as unknown as typeof fetch;
  return upstream;
}

function call(method: "GET" | "HEAD", path: string[]) {
  const req = new NextRequest(
    `http://127.0.0.1:3001/api/clio/${path.join("/")}`,
    {
      method,
      headers: { host: "127.0.0.1:3001", cookie: "hf_access_token=secret" },
    },
  );
  const ctx = { params: Promise.resolve({ path }) };
  return method === "GET" ? GET(req, ctx) : HEAD(req, ctx);
}

describe("binary files through the proxy", () => {
  test("a scene model and the room scan stream through unchanged", async () => {
    for (const [path, type] of [
      [["episodes", ID, "scene", "model-syringe.glb"], "model/gltf-binary"],
      [["episodes", ID, "scene", "crop-syringe-1.jpg"], "image/jpeg"],
      [["episodes", ID, "derived", "room.glb"], "model/gltf-binary"],
    ] as const) {
      const upstream = serve(
        () => new Response(BINARY, { headers: { "content-type": type } }),
      );
      const res = await call("GET", [...path]);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(type);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(BINARY);
      const [url, init] = upstream.mock.calls[0];
      expect(String(url)).toBe(`http://127.0.0.1:8787/api/${path.join("/")}`);
      expect(new Headers(init?.headers).get("cookie")).toBeNull();
    }
  });

  test("a missing scene file is the server's 404", async () => {
    serve(() => Response.json({ error: "not_found" }, { status: 404 }));
    const res = await call("GET", ["episodes", ID, "scene", "model-cup_a.glb"]);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  test("HEAD answers with no body", async () => {
    serve(
      () =>
        new Response(null, {
          headers: { "content-type": "model/gltf-binary" },
        }),
    );
    const res = await call("HEAD", [
      "episodes",
      ID,
      "scene",
      "model-syringe.glb",
    ]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("model/gltf-binary");
    expect(res.body).toBeNull();
  });

  test("a name outside the rules never reaches the server", async () => {
    const upstream = serve(() => new Response(BINARY));
    const res = await call("GET", ["episodes", ID, "scene", "splat.ply"]);
    expect(res.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});
