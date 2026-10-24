import { describe, expect, test } from "bun:test";
import {
  clioResponseHeaders,
  clioUpstreamHeaders,
  clioUpstreamOrigin,
  type ClioProxyRequest,
  DEFAULT_CLIO_SERVER_URL,
  isLoopbackHost,
  planClioProxy,
} from "../proxy-rules";

const ID = "ep-20261024-065830-ht6h";

function request(overrides: Partial<ClioProxyRequest> = {}): ClioProxyRequest {
  return {
    method: "GET",
    path: ["episodes"],
    searchParams: new URLSearchParams(),
    host: "127.0.0.1:3001",
    serverUrl: undefined,
    ...overrides,
  };
}

function url(overrides: Partial<ClioProxyRequest> = {}): string {
  const plan = planClioProxy(request(overrides));
  if (!plan.ok) throw new Error(`rejected with ${plan.status}`);
  return plan.url.href;
}

function status(overrides: Partial<ClioProxyRequest> = {}): number {
  const plan = planClioProxy(request(overrides));
  return plan.ok ? 200 : plan.status;
}

describe("planClioProxy: allowed reads", () => {
  test("the episode list", () => {
    expect(url()).toBe("http://127.0.0.1:8787/api/episodes");
  });

  test("one episode's detail", () => {
    expect(url({ path: ["episodes", ID] })).toBe(
      `http://127.0.0.1:8787/api/episodes/${ID}`,
    );
  });

  test("each channel, with and without a from offset", () => {
    for (const channel of ["frames", "events", "objects"]) {
      expect(url({ path: ["episodes", ID, channel] })).toBe(
        `http://127.0.0.1:8787/api/episodes/${ID}/${channel}`,
      );
      expect(
        url({
          path: ["episodes", ID, channel],
          searchParams: new URLSearchParams({ from: "123456" }),
        }),
      ).toBe(`http://127.0.0.1:8787/api/episodes/${ID}/${channel}?from=123456`);
    }
  });

  test("HEAD is allowed", () => {
    expect(status({ method: "HEAD" })).toBe(200);
  });

  test("other query parameters are dropped", () => {
    expect(
      url({
        path: ["episodes", ID, "frames"],
        searchParams: new URLSearchParams("from=0&x=1&path=/gemini"),
      }),
    ).toBe(`http://127.0.0.1:8787/api/episodes/${ID}/frames?from=0`);
  });

  test("from is forwarded only to the channel files", () => {
    const searchParams = new URLSearchParams({ from: "10" });
    expect(url({ searchParams })).toBe("http://127.0.0.1:8787/api/episodes");
    expect(url({ path: ["episodes", ID], searchParams })).toBe(
      `http://127.0.0.1:8787/api/episodes/${ID}`,
    );
  });

  test("one episode's compiled files", () => {
    for (const name of [
      "manifest.json",
      "tracks.json",
      "environment.json",
      "retarget-clio-arm-6dof.json",
      "retarget-arm_v2.1.json",
      "0.json",
      `${"a".repeat(91)}.json`,
    ]) {
      expect(url({ path: ["episodes", ID, "derived", name] })).toBe(
        `http://127.0.0.1:8787/api/episodes/${ID}/derived/${name}`,
      );
    }
  });

  test("from is not forwarded to compiled files", () => {
    expect(
      url({
        path: ["episodes", ID, "derived", "manifest.json"],
        searchParams: new URLSearchParams({ from: "10" }),
      }),
    ).toBe(`http://127.0.0.1:8787/api/episodes/${ID}/derived/manifest.json`);
  });

  test("CLIO_SERVER_URL picks another loopback server", () => {
    expect(url({ serverUrl: "http://localhost:8788" })).toBe(
      "http://localhost:8788/api/episodes",
    );
    expect(url({ serverUrl: "http://[::1]:8788/" })).toBe(
      "http://[::1]:8788/api/episodes",
    );
  });
});

describe("planClioProxy: rejected", () => {
  test("writes", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(status({ method, path: ["episodes", ID, "frames"] })).toBe(405);
    }
  });

  test("routes outside the episode reads", () => {
    for (const path of [
      ["gemini"],
      ["gemini", "live"],
      ["coach", "token"],
      ["plans"],
      ["vision", "locate"],
      ["clips", "a.mp4"],
      ["health"],
      ["procedures"],
      ["episodes", ID, "batches"],
      ["episodes", ID, "finish"],
      ["episodes", ID, "media", "clip.mp4"],
      ["episodes", ID, "frames", "extra"],
      ["api", "episodes"],
      [],
    ]) {
      expect(status({ path })).toBe(404);
    }
  });

  test("compiled file names outside the derived name rule", () => {
    for (const name of [
      "..",
      ".",
      "%2e%2e",
      "..%2fmanifest.json",
      "../manifest.json",
      "../../meta.json",
      "%2e%2e%2fmanifest.json",
      "..\\manifest.json",
      "a/../manifest.json",
      ".manifest.json",
      "-manifest.json",
      "Manifest.json",
      "TRACKS.JSON",
      "tracks.JSON",
      "frames.ndjson",
      "objects.ndjson",
      "manifest",
      "manifest.json.bak",
      "manifest.json?x=1",
      "manifest.json#x",
      "mani fest.json",
      "manifest%20.json",
      ".json",
      `${"a".repeat(97)}.json`,
    ]) {
      expect(status({ path: ["episodes", ID, "derived", name] })).toBe(404);
    }
  });

  test("compiled files at any other depth", () => {
    for (const path of [
      ["episodes", ID, "derived"],
      ["episodes", ID, "derived", "manifest.json", "extra"],
      ["episodes", ID, "derived", "retarget", "arm.json"],
      ["episodes", "derived", "manifest.json"],
      ["episodes", ID, "frames", "manifest.json"],
      ["episodes", ID, "compile"],
      ["derived", "manifest.json"],
    ]) {
      expect(status({ path })).toBe(404);
    }
  });

  test("compiled files under a bad episode id", () => {
    for (const id of ["..", "%2e%2e", ".hidden", "ep id", ""]) {
      expect(
        status({ path: ["episodes", id, "derived", "manifest.json"] }),
      ).toBe(404);
    }
  });

  test("writes to compiled files", () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect(
        status({ method, path: ["episodes", ID, "derived", "manifest.json"] }),
      ).toBe(405);
    }
  });

  test("raw and encoded dot segments", () => {
    for (const segment of [
      "..",
      ".",
      "%2e%2e",
      "%2E%2E",
      "..%2fgemini",
      "../gemini",
      "a/../../gemini",
      "..\\gemini",
    ]) {
      expect(status({ path: ["episodes", segment] })).toBe(404);
      expect(status({ path: ["episodes", segment, "frames"] })).toBe(404);
    }
    expect(status({ path: ["..", "coach", "token"] })).toBe(404);
    expect(status({ path: ["episodes", "..", "..", "plans"] })).toBe(404);
  });

  test("bad episode ids", () => {
    for (const id of [
      "",
      "-ep",
      ".hidden",
      "_ep",
      "ep id",
      "ep?x=1",
      "ep#x",
      "ep%20x",
      "épisode",
      "a".repeat(129),
    ]) {
      expect(status({ path: ["episodes", id] })).toBe(404);
    }
    expect(status({ path: ["episodes", "a".repeat(128)] })).toBe(200);
  });

  test("a from offset that is not digits", () => {
    for (const from of [
      "-1",
      "1.5",
      "1e3",
      "0x10",
      " 1",
      "",
      "abc",
      "1".repeat(17),
    ]) {
      expect(
        status({
          path: ["episodes", ID, "frames"],
          searchParams: new URLSearchParams({ from }),
        }),
      ).toBe(400);
    }
    expect(
      status({
        path: ["episodes", ID, "frames"],
        searchParams: new URLSearchParams("from=1&from=2"),
      }),
    ).toBe(400);
  });

  test("a Host that is not loopback", () => {
    for (const host of [
      null,
      "",
      "evil.example",
      "evil.example:3001",
      "localhost.evil.example:3001",
      "127.0.0.1.evil.example",
      "192.168.1.20:3001",
      "0.0.0.0:3001",
      "user@127.0.0.1:3001",
      "127.0.0.1:3001/x",
    ]) {
      expect(status({ host })).toBe(403);
    }
  });

  test("a CLIO_SERVER_URL that is not a bare loopback origin", () => {
    for (const serverUrl of [
      "http://example.com:8787",
      "http://192.168.1.20:8787",
      "http://0.0.0.0:8787",
      "http://127.0.0.1.evil.example:8787",
      "http://user:pw@127.0.0.1:8787",
      "http://127.0.0.1:8787/api",
      "http://127.0.0.1:8787/?x=1",
      "file:///etc/passwd",
      "ws://127.0.0.1:8787",
      "not a url",
    ]) {
      expect(status({ serverUrl })).toBe(500);
    }
  });

  test("the method is checked before anything else is answered", () => {
    expect(status({ method: "POST", host: "evil.example" })).toBe(405);
  });
});

describe("loopback checks", () => {
  test("loopback Host headers", () => {
    for (const host of [
      "127.0.0.1:3001",
      "localhost:3001",
      "LOCALHOST:3001",
      "[::1]:3001",
      "127.0.0.1",
      "127.1.2.3:3001",
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  test("the default upstream", () => {
    expect(clioUpstreamOrigin(undefined)?.href).toBe(
      `${DEFAULT_CLIO_SERVER_URL}/`,
    );
    expect(clioUpstreamOrigin("")?.href).toBe(`${DEFAULT_CLIO_SERVER_URL}/`);
  });
});

describe("headers", () => {
  test("upstream headers are built from scratch", () => {
    const headers = clioUpstreamHeaders();
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("origin")).toBeNull();
    expect([...headers.keys()]).toEqual(["accept"]);
  });

  test("only content-type and x-next-from come back, never cached", () => {
    const headers = clioResponseHeaders(
      new Headers({
        "content-type": "application/x-ndjson",
        "x-next-from": "4096",
        "set-cookie": "hf_access_token=secret",
        "access-control-allow-origin": "*",
        "cache-control": "max-age=60",
        "content-length": "4096",
      }),
    );
    expect(Object.fromEntries(headers)).toEqual({
      "cache-control": "no-store",
      "content-type": "application/x-ndjson",
      "x-next-from": "4096",
    });
  });
});
