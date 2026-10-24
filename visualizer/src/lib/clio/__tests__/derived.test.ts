import { describe, expect, test } from "bun:test";
import {
  CompileManifestSchema,
  EnvironmentDocSchema,
  type EpisodeDerivedStatus,
  EpisodeDetailResponseSchema,
  type EpisodeMeta,
  RetargetDocSchema,
  TracksDocSchema,
} from "@clio/protocol";
import type { Fetch } from "@clio-viewer/api";
import { HEADSET } from "@clio-viewer/capture/from-clio";
import {
  SYNTHETIC_MAX_FRAME_GAP_MS,
  type SyntheticDerived,
  syntheticDerived,
} from "../__fixtures__/synthetic-derived";
import { syntheticEpisode, toNdjson } from "../__fixtures__/synthetic-episode";
import {
  ClioDerivedSource,
  compileStatus,
  DERIVED_BACKOFF_MIN_MS,
  DERIVED_COMPILING_EVERY_MS,
  DERIVED_SETTLED_EVERY_MS,
  DERIVED_WAITING_EVERY_MS,
  emptyDerivedState,
} from "../derived";
import { ClioSource } from "../source";
import type { Channel } from "../types";

// The compiled-episode loader against a fake Clio server behind a mocked
// fetch. The fake serves an episode's detail (with its `derived` status), its
// compiled files by name and, for the isolation tests, its raw NDJSON files
// with `x-next-from` the way apps/server does. The loader reads only what the
// scene draws (environment and retarget), never tracks.json.

const START_EPOCH_MS = Date.UTC(2026, 9, 24, 12);
const EPISODE = syntheticEpisode({ startEpochMs: START_EPOCH_MS });
const ID = EPISODE.meta.episodeId;
const COMPILED = syntheticDerived(EPISODE);
const ENVIRONMENT = "environment.json";
const RETARGET = "retarget-clio-arm-6dof.json";
const TRACKS = "tracks.json";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A request that answers only by failing once its signal aborts. */
const hanging = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("Aborted", "AbortError")),
    );
  });

class FakeServer {
  /** The detail's `derived`; undefined leaves it out (a server that cannot compile). */
  derived: EpisodeDerivedStatus | undefined;
  /** Compiled files by name: a body, or a bare status. */
  readonly files = new Map<string, string | number>();
  detailStatus = 200;
  /** Paths whose requests never answer. */
  readonly hang = new Set<string>();
  /** Every request path, after /api/clio. */
  readonly requests: string[] = [];
  readonly signals: AbortSignal[] = [];
  /** The raw side, for the isolation tests. */
  meta: EpisodeMeta = EPISODE.meta;
  readonly raw: Record<Channel, string> = {
    frames: "",
    events: "",
    objects: "",
  };

  readonly fetch: Fetch = async (input, init) => {
    const url = new URL(input, "http://127.0.0.1:3001");
    const path = url.pathname.replace(/^\/api\/clio/, "");
    const from = url.searchParams.get("from");
    this.requests.push(from === null ? path : `${path}?from=${from}`);
    if (init?.signal) this.signals.push(init.signal);
    if (this.hang.has(path)) return hanging(init);
    await Promise.resolve();
    const [, , id, part, name] = path.split("/");
    if (id !== ID) return json({ error: "not_found" }, 404);
    if (part === undefined) {
      if (this.detailStatus !== 200) return json({}, this.detailStatus);
      return json({
        meta: this.meta,
        summary: {
          episodeId: ID,
          createdAt: this.meta.createdAt,
          mode: this.meta.mode,
          procedureId: this.meta.procedure?.id ?? null,
          finished: false,
          outcome: null,
          durationMs: null,
          frameCount: 0,
          eventCount: 0,
        },
        finish: null,
        ...(this.derived ? { derived: this.derived } : {}),
      });
    }
    if (part === "derived") {
      const file = name === undefined ? undefined : this.files.get(name);
      if (file === undefined) return json({ error: "not_found" }, 404);
      if (typeof file === "number") return json({ error: "failed" }, file);
      return new Response(file, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const text = this.raw[part as Channel];
    const bytes = Buffer.from(text);
    const start = Number(from ?? 0);
    return new Response(start >= bytes.length ? "" : bytes.subarray(start), {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson",
        "x-next-from": String(bytes.length),
      },
    });
  };

  /** Serves a compile: its manifest in the detail and its files by name. */
  compiled(
    compile: SyntheticDerived,
    state: EpisodeDerivedStatus["state"] = "ok",
  ): void {
    this.derived = { state, manifest: compile.manifest, error: null };
    this.files.clear();
    for (const [name, doc] of Object.entries(compile.files)) {
      this.files.set(name, JSON.stringify(doc));
    }
  }

  derivedRequests(): string[] {
    return this.requests.filter((r) => r.includes("/derived/"));
  }
}

function loaderOn(server: FakeServer): ClioDerivedSource {
  return new ClioDerivedSource({
    episodeId: ID,
    fetch: server.fetch,
    now: () => 1000,
  });
}

describe("the synthetic compile", () => {
  test("is valid clio.derived/1", () => {
    expect(() => CompileManifestSchema.parse(COMPILED.manifest)).not.toThrow();
    expect(() => TracksDocSchema.parse(COMPILED.tracks)).not.toThrow();
    expect(() =>
      EnvironmentDocSchema.parse(COMPILED.environment),
    ).not.toThrow();
    for (const doc of COMPILED.retarget) {
      expect(() => RetargetDocSchema.parse(doc)).not.toThrow();
    }
    expect(COMPILED.manifest.artifacts.map((a) => a.name).sort()).toEqual([
      ENVIRONMENT,
      RETARGET,
      TRACKS,
    ]);
  });

  test("has every plane kind the scene draws and an arm with gaps", () => {
    expect(COMPILED.environment.planes.map((p) => p.kind)).toEqual([
      "floor",
      "table",
      "wall",
      "other",
    ]);
    const [arm] = COMPILED.retarget[0].arms;
    expect(arm.q.some((q) => q === null)).toBe(true);
    expect(arm.q.some((q) => q !== null)).toBe(true);
  });

  test("places the table on the detected table plane, turned with it", () => {
    const { table, planes, floor } = COMPILED.environment;
    const plane = planes.find((p) => p.kind === "table");
    expect(table.source).toBe("planes");
    expect(table.pose.slice(3)).toEqual(plane?.pose.slice(3) ?? []);
    expect(table.pose.slice(3)).not.toEqual([0, 0, 0, 1]);
    // Calibrated by two pinched corners: the height is measured.
    expect(floor?.tableHeightM).toBe(0.75);
    const plan = syntheticDerived(EPISODE, { table: "plan" }).environment;
    expect(plan.table).toEqual({
      pose: [0, 0, 0, 0, 0, 0, 1],
      size: [0.6, 0.4],
      source: "plan",
    });
    expect(() => EnvironmentDocSchema.parse(plan)).not.toThrow();
  });

  test("a guessed workspace takes its table height from the detected table", () => {
    const space = EPISODE.meta.space;
    if (!space) throw new Error("the synthetic episode records its space");
    const guessed = syntheticDerived({
      ...EPISODE,
      meta: {
        ...EPISODE.meta,
        space: { ...space, calibration: "default_in_front" },
      },
    }).environment;
    expect(guessed.floor?.tableHeightM).toBeCloseTo(0.748, 9);
    const none = syntheticDerived({
      ...EPISODE,
      meta: { ...EPISODE.meta, space: { ...space, calibration: "none" } },
    }).environment;
    expect(none.floor).toBeNull();
    expect(() => EnvironmentDocSchema.parse(none)).not.toThrow();
  });

  test("a plane is last seen when a snapshot leaves it out, else at the end", () => {
    const end = EPISODE.finish.durationMs;
    const lastSeen = COMPILED.environment.planes.map((p) => p.lastSeenT);
    expect(lastSeen).toEqual([end, end, end, 9600]);
  });

  test("leaves the head, wrists and arm empty across a frame gap", () => {
    expect(COMPILED.tracks.policy.maxFrameGapMs).toBe(
      SYNTHETIC_MAX_FRAME_GAP_MS,
    );
    // 600 ms with no frames, as a lost batch leaves.
    const holed = {
      ...EPISODE,
      frames: EPISODE.frames.filter((f) => f.t < 5000 || f.t > 5600),
    };
    const compiled = syntheticDerived(holed);
    expect(() => TracksDocSchema.parse(compiled.tracks)).not.toThrow();
    expect(compiled.manifest.quality.maxFrameGapMs).toBeGreaterThan(600);
    const { t, head, hands } = compiled.tracks;
    const [arm] = compiled.retarget[0].arms;
    const inGap = t.flatMap((ti, i) => (ti > 5000 && ti < 5600 ? [i] : []));
    expect(inGap.length).toBeGreaterThan(10);
    for (const i of inGap) {
      expect(head[i]).toBeNull();
      expect(
        hands.every((h) => h.wrist[i] === null && h.pinch[i] === null),
      ).toBe(true);
      expect(arm.q[i]).toBeNull();
    }
    const before = t.findIndex((ti) => ti > 4900);
    expect(head[before]).not.toBeNull();
    expect(hands[0].wrist[before]).not.toBeNull();
  });

  test("a failed retarget stage writes no retarget document", () => {
    const failed = syntheticDerived(EPISODE, {
      retargetFailed: "URDF not found",
    });
    expect(() => CompileManifestSchema.parse(failed.manifest)).not.toThrow();
    expect(failed.retarget).toEqual([]);
    expect(failed.manifest.artifacts.map((a) => a.kind)).toEqual([
      "tracks",
      "environment",
    ]);
    expect(failed.manifest.stages).toContainEqual({
      name: "retarget-clio-arm-6dof",
      status: "failed",
      detail: "URDF not found",
    });
    expect(Object.keys(failed.files).sort()).toEqual(
      ["environment.json", "manifest.json", "tracks.json"].sort(),
    );
  });
});

describe("reading a compiled episode", () => {
  test("an ok compile's artifacts are read and parsed", async () => {
    const server = new FakeServer();
    server.compiled(COMPILED);
    const loader = loaderOn(server);

    expect(await loader.step()).toBe(DERIVED_SETTLED_EVERY_MS);
    const state = loader.getSnapshot();
    expect(state.compile).toBe("ok");
    expect(state.compiledAt).toBe(COMPILED.manifest.compiledAt);
    expect(state.environment).toEqual(COMPILED.environment);
    expect(state.retarget).toEqual(COMPILED.retarget);
    expect(state.artifacts).toEqual({
      [ENVIRONMENT]: "ok",
      [RETARGET]: "ok",
    });
    expect(state.error).toBeNull();
    // The manifest comes with the detail; only the artifacts a layer draws
    // are read. The manifest lists tracks.json, which nothing draws yet.
    expect(COMPILED.manifest.artifacts.map((a) => a.name)).toContain(TRACKS);
    expect(server.requests.sort()).toEqual(
      [
        `/episodes/${ID}`,
        `/episodes/${ID}/derived/${ENVIRONMENT}`,
        `/episodes/${ID}/derived/${RETARGET}`,
      ].sort(),
    );
  });

  test("a 404 artifact reads as not compiled, never as a gone episode", async () => {
    const server = new FakeServer();
    server.compiled(COMPILED);
    server.files.delete(ENVIRONMENT);
    const loader = loaderOn(server);

    expect(await loader.step()).toBe(DERIVED_SETTLED_EVERY_MS);
    const state = loader.getSnapshot();
    expect(state.artifacts[ENVIRONMENT]).toBe("missing");
    expect(state.environment).toBeNull();
    expect(state.retarget.length).toBe(1);
    expect(state.compile).toBe("ok");
    expect(state.episodeId).toBe(ID);
    expect(state.error).toBeNull();
  });

  test("a body that is not JSON, or not the document, reads as invalid", async () => {
    const server = new FakeServer();
    server.compiled(COMPILED);
    server.files.set(ENVIRONMENT, '{"schema": "clio.derived/1",');
    server.files.set(RETARGET, JSON.stringify(COMPILED.tracks));
    const loader = loaderOn(server);

    await loader.step();
    const state = loader.getSnapshot();
    expect(state.artifacts).toEqual({
      [ENVIRONMENT]: "invalid",
      [RETARGET]: "invalid",
    });
    expect(state.environment).toBeNull();
    expect(state.retarget).toEqual([]);
    expect(state.error).toBeNull();
  });

  test("a document of another episode reads as invalid", async () => {
    const server = new FakeServer();
    server.compiled(COMPILED);
    server.files.set(
      ENVIRONMENT,
      JSON.stringify({ ...COMPILED.environment, episodeId: "ep-other" }),
    );
    const loader = loaderOn(server);

    await loader.step();
    expect(loader.getSnapshot().artifacts[ENVIRONMENT]).toBe("invalid");
    expect(loader.getSnapshot().environment).toBeNull();
  });

  test("artifacts are read again only when compiledAt changes", async () => {
    const server = new FakeServer();
    server.compiled(COMPILED);
    const loader = loaderOn(server);
    await loader.step();
    const first = loader.getSnapshot();

    await loader.step();
    await loader.step();
    expect(server.derivedRequests().length).toBe(2);
    expect(loader.getSnapshot()).toBe(first);

    const recompiled = syntheticDerived(EPISODE, {
      compiledAt: "2026-10-24T12:05:00.000Z",
    });
    server.compiled(recompiled);
    await loader.step();
    const second = loader.getSnapshot();
    expect(server.derivedRequests().length).toBe(4);
    expect(second.compiledAt).toBe("2026-10-24T12:05:00.000Z");
    expect(second.environment).not.toBe(first.environment);
    expect(second.environment).toEqual(recompiled.environment);
  });

  test("a stale compile is read; a queued or running one keeps the last documents", async () => {
    const server = new FakeServer();
    server.compiled(COMPILED, "stale");
    const loader = loaderOn(server);
    expect(await loader.step()).toBe(DERIVED_SETTLED_EVERY_MS);
    const stale = loader.getSnapshot();
    expect(stale.compile).toBe("stale");
    expect(stale.environment).not.toBeNull();

    const next = syntheticDerived(EPISODE, {
      compiledAt: "2026-10-24T12:09:00.000Z",
    });
    for (const state of ["queued", "running"] as const) {
      server.compiled(next, state);
      expect(await loader.step()).toBe(DERIVED_COMPILING_EVERY_MS);
      const shown = loader.getSnapshot();
      expect(shown.compile).toBe(state);
      expect(shown.environment).toBe(stale.environment);
      expect(shown.compiledAt).toBe(COMPILED.manifest.compiledAt);
    }
    expect(server.derivedRequests().length).toBe(2);

    server.compiled(next, "ok");
    await loader.step();
    expect(loader.getSnapshot().compiledAt).toBe(next.manifest.compiledAt);
    expect(server.derivedRequests().length).toBe(4);
  });

  test("a failed recompile keeps the last documents and shows its error", async () => {
    // The server keeps the last good compile and reports ok or stale with the
    // failed run's error; it sends failed only when there is no manifest.
    for (const state of ["ok", "stale"] as const) {
      const server = new FakeServer();
      server.compiled(COMPILED);
      const loader = loaderOn(server);
      await loader.step();
      const ok = loader.getSnapshot();

      server.derived = {
        state,
        manifest: COMPILED.manifest,
        error: "retarget: URDF not found",
      };
      expect(await loader.step()).toBe(DERIVED_SETTLED_EVERY_MS);
      const failed = loader.getSnapshot();
      expect(failed.compile).toBe(state);
      expect(failed.compileError).toBe("retarget: URDF not found");
      expect(failed.environment).toBe(ok.environment);
      expect(compileStatus(failed, "finished")).toEqual({
        label: "Compile failed",
        problem: true,
        detail: "retarget: URDF not found",
        notUsable: null,
      });
    }
  });

  test("a compile that failed before writing a manifest has no documents", async () => {
    const server = new FakeServer();
    server.derived = {
      state: "failed",
      manifest: null,
      error: "frames.ndjson:1: invalid JSON",
    };
    const loader = loaderOn(server);

    expect(await loader.step()).toBe(DERIVED_SETTLED_EVERY_MS);
    expect(loader.getSnapshot()).toEqual({
      ...emptyDerivedState(ID),
      compile: "failed",
      compileError: "frames.ndjson:1: invalid JSON",
    });
    expect(server.derivedRequests()).toEqual([]);
  });

  test("a failed stage in the manifest shows as a failed compile", async () => {
    const server = new FakeServer();
    server.compiled(
      syntheticDerived(EPISODE, { retargetFailed: "URDF not found" }),
    );
    const loader = loaderOn(server);

    await loader.step();
    const state = loader.getSnapshot();
    expect(state.compile).toBe("ok");
    expect(state.retarget).toEqual([]);
    expect(state.environment).not.toBeNull();
    expect(compileStatus(state, "finished")).toEqual({
      label: "Compile failed",
      problem: true,
      detail: "retarget-clio-arm-6dof: URDF not found",
      notUsable: null,
    });
  });

  test("nothing compiled yet reads no artifacts", async () => {
    const server = new FakeServer();
    server.derived = { state: "none", manifest: null, error: null };
    const loader = loaderOn(server);

    expect(await loader.step()).toBe(DERIVED_WAITING_EVERY_MS);
    expect(loader.getSnapshot()).toEqual({
      ...emptyDerivedState(ID),
      compile: "none",
    });
    expect(server.derivedRequests()).toEqual([]);
  });

  test("compiled files that went away clear the documents", async () => {
    const server = new FakeServer();
    server.compiled(COMPILED);
    const loader = loaderOn(server);
    await loader.step();

    server.derived = { state: "none", manifest: null, error: null };
    await loader.step();
    const state = loader.getSnapshot();
    expect(state.environment).toBeNull();
    expect(state.retarget).toEqual([]);
    expect(state.compiledAt).toBeNull();
  });

  test("a server that cannot compile shows no compile state", async () => {
    const server = new FakeServer();
    const loader = loaderOn(server);

    expect(await loader.step()).toBe(DERIVED_SETTLED_EVERY_MS);
    expect(loader.getSnapshot()).toEqual(emptyDerivedState(ID));
    expect(server.derivedRequests()).toEqual([]);
  });

  test("a failed detail read backs off and keeps what was read", async () => {
    const server = new FakeServer();
    server.compiled(COMPILED);
    const loader = loaderOn(server);
    await loader.step();
    const ok = loader.getSnapshot();

    server.detailStatus = 404;
    expect(await loader.step()).toBe(DERIVED_BACKOFF_MIN_MS);
    expect(await loader.step()).toBe(DERIVED_BACKOFF_MIN_MS * 2);
    const failing = loader.getSnapshot();
    expect(failing.error?.status).toBe(404);
    expect(failing.error?.retryAtMs).toBe(1000 + DERIVED_BACKOFF_MIN_MS * 2);
    expect(failing.environment).toBe(ok.environment);
    expect(failing.compile).toBe("ok");

    server.detailStatus = 200;
    expect(await loader.step()).toBe(DERIVED_SETTLED_EVERY_MS);
    expect(loader.getSnapshot().error).toBeNull();
  });

  test("a server error on an artifact reads the whole compile again", async () => {
    const server = new FakeServer();
    server.compiled(COMPILED);
    server.files.set(RETARGET, 502);
    const loader = loaderOn(server);

    expect(await loader.step()).toBe(DERIVED_BACKOFF_MIN_MS);
    expect(loader.getSnapshot().error?.status).toBe(502);
    expect(loader.getSnapshot().compiledAt).toBeNull();

    server.files.set(RETARGET, JSON.stringify(COMPILED.retarget[0]));
    expect(await loader.step()).toBe(DERIVED_SETTLED_EVERY_MS);
    const state = loader.getSnapshot();
    expect(state.error).toBeNull();
    expect(state.compiledAt).toBe(COMPILED.manifest.compiledAt);
    expect(state.retarget.length).toBe(1);
  });

  test("a failing artifact abandons the reads still running", async () => {
    const server = new FakeServer();
    server.compiled(COMPILED);
    server.hang.add(`/episodes/${ID}/derived/${RETARGET}`);
    server.files.set(ENVIRONMENT, 500);
    const loader = loaderOn(server);

    expect(await loader.step()).toBe(DERIVED_BACKOFF_MIN_MS);
    const retargetRead = server.requests.indexOf(
      `/episodes/${ID}/derived/${RETARGET}`,
    );
    expect(server.signals[retargetRead].aborted).toBe(true);
    expect(loader.getSnapshot().error?.status).toBe(500);
  });

  test("subscribers hear about changes only", async () => {
    const server = new FakeServer();
    server.compiled(COMPILED);
    const loader = loaderOn(server);
    let calls = 0;
    loader.subscribe(() => calls++);

    await loader.step();
    const after = calls;
    expect(after).toBeGreaterThan(0);
    await loader.step();
    expect(calls).toBe(after);
  });

  test("stop abandons the read in flight", async () => {
    const server = new FakeServer();
    server.hang.add(`/episodes/${ID}`);
    const loader = loaderOn(server);

    loader.start();
    await Promise.resolve();
    expect(server.signals.length).toBe(1);
    loader.stop();
    expect(server.signals[0].aborted).toBe(true);
    expect(loader.getSnapshot().error).toBeNull();
  });
});

describe("compile status", () => {
  const view = (
    state: Partial<Parameters<typeof compileStatus>[0]>,
    episode: Parameters<typeof compileStatus>[1] = "finished",
  ) =>
    compileStatus(
      { compile: null, compileError: null, manifest: null, ...state },
      episode,
    );

  test("names each state that needs attention", () => {
    const label = (compile: EpisodeDerivedStatus["state"]) =>
      view({ compile })?.label;
    expect(label("none")).toBe("Not compiled");
    expect(label("queued")).toBe("Compiling");
    expect(label("running")).toBe("Compiling");
    expect(label("stale")).toBe("Compile stale");
    expect(label("failed")).toBe("Compile failed");
  });

  test("a healthy compile shows nothing", () => {
    expect(view({ compile: "ok", manifest: COMPILED.manifest })).toBeNull();
    expect(view({ compile: "ok" })).toBeNull();
  });

  test("shows nothing when the server cannot compile", () => {
    expect(view({ compile: null })).toBeNull();
  });

  test("decides on the raw episode status: nothing while live or unknown", () => {
    // A live episode whose raw reads fail shows Reconnecting, but its raw
    // status stays live, and it is not compiled yet.
    expect(view({ compile: "none" }, "live")).toBeNull();
    expect(view({ compile: "none" }, null)).toBeNull();
    expect(view({ compile: "none" }, "stopped")?.label).toBe("Not compiled");
    expect(view({ compile: "none" }, "finished")?.label).toBe("Not compiled");
  });

  test("a failed compile is a problem, with its error as detail", () => {
    expect(
      view({ compile: "failed", compileError: "resample: no frames" }),
    ).toEqual({
      label: "Compile failed",
      problem: true,
      detail: "resample: no frames",
      notUsable: null,
    });
  });

  test("a failed recompile is a problem whatever the last compile's state", () => {
    for (const compile of ["ok", "stale"] as const) {
      expect(
        view({
          compile,
          compileError: "Timed out after 600 s",
          manifest: COMPILED.manifest,
        }),
      ).toEqual({
        label: "Compile failed",
        problem: true,
        detail: "Timed out after 600 s",
        notUsable: null,
      });
    }
  });

  test("failed stages are a problem, named with their detail", () => {
    const { manifest } = syntheticDerived(EPISODE, {
      retargetFailed: "URDF not found",
    });
    const stages = [
      ...manifest.stages,
      { name: "environment", status: "failed" as const },
    ];
    expect(view({ compile: "ok", manifest: { ...manifest, stages } })).toEqual({
      label: "Compile failed",
      problem: true,
      detail: "retarget-clio-arm-6dof: URDF not found\nenvironment",
      notUsable: null,
    });
    // The run's error comes first, then the last compile's failed stages.
    expect(
      view({
        compile: "stale",
        compileError: "Timed out after 600 s",
        manifest,
      })?.detail,
    ).toBe("Timed out after 600 s\nretarget-clio-arm-6dof: URDF not found");
  });

  test("a compile under way supersedes the last failure", () => {
    const { manifest } = syntheticDerived(EPISODE, {
      retargetFailed: "URDF not found",
    });
    for (const compile of ["queued", "running"] as const) {
      expect(
        view({ compile, compileError: "Timed out after 600 s", manifest }),
      ).toEqual({
        label: "Compiling",
        problem: false,
        detail: null,
        notUsable: null,
      });
    }
  });

  test("a stale compile says why", () => {
    expect(
      view({ compile: "stale", manifest: COMPILED.manifest })?.detail,
    ).toBe("Raw files changed after the last compile");
    // An older pipeline's manifest the server cannot read.
    expect(view({ compile: "stale" })).toEqual({
      label: "Compile stale",
      problem: false,
      detail: "Compiled by an older pipeline",
      notUsable: null,
    });
  });

  test("an unusable verdict carries its first reason", () => {
    const { manifest } = syntheticDerived(EPISODE, {
      quality: {
        usable: false,
        reasons: ["Right hand tracked in 41% of frames", "2 batches missing"],
      },
    });
    expect(view({ compile: "ok", manifest })).toEqual({
      label: null,
      problem: false,
      detail: null,
      notUsable: { reason: "Right hand tracked in 41% of frames" },
    });
    expect(view({ compile: "stale", manifest })?.notUsable).toEqual({
      reason: "Right hand tracked in 41% of frames",
    });
    expect(view({ compile: "ok", manifest }, "live")).toBeNull();
  });
});

describe("live raw following", () => {
  /** A live episode: about the first half of its frames, events and objects so far. */
  function liveServer(): { server: FakeServer; frames: number } {
    const server = new FakeServer();
    const cut = 4000;
    const frames = EPISODE.frames.filter((f) => f.t <= cut);
    server.raw.frames = toNdjson(frames);
    server.raw.events = toNdjson(EPISODE.events.filter((e) => e.t <= cut));
    server.raw.objects = toNdjson(EPISODE.objects.filter((o) => o.t <= cut));
    return { server, frames: frames.length };
  }

  function liveSource(server: FakeServer): ClioSource {
    const lastT = EPISODE.frames[EPISODE.frames.length - 1].t;
    return new ClioSource({
      follow: "pinned",
      episodeId: ID,
      fetch: server.fetch,
      now: () => 1_000_000,
      wallNow: () => START_EPOCH_MS + lastT,
    });
  }

  async function follow(source: ClioSource, server: FakeServer) {
    await source.step();
    await source.step();
    // The rest of the episode arrives.
    server.raw.frames = toNdjson(EPISODE.frames);
    server.raw.events = toNdjson(EPISODE.events);
    server.raw.objects = toNdjson(EPISODE.objects);
    await source.step();
    const state = source.getSnapshot();
    return {
      status: state.status,
      error: state.error,
      revision: state.revision,
      offsets: state.offsets,
      headset: state.capture?.poses.get(HEADSET)?.samples.map((s) => s.t_us),
      events: state.capture?.events.samples.length,
    };
  }

  test("the detail with a compile still opens the raw episode", () => {
    expect(() =>
      EpisodeDetailResponseSchema.parse({
        meta: EPISODE.meta,
        summary: {
          episodeId: ID,
          createdAt: EPISODE.meta.createdAt,
          mode: EPISODE.meta.mode,
          procedureId: null,
          finished: false,
          outcome: null,
          durationMs: null,
          frameCount: 0,
          eventCount: 0,
        },
        finish: null,
        derived: { state: "ok", manifest: COMPILED.manifest, error: null },
      }),
    ).not.toThrow();
  });

  test("hanging and failing compiled reads leave it exactly as without them", async () => {
    const control = liveServer();
    const expected = await follow(liveSource(control.server), control.server);
    expect(expected.status).toBe("live");
    expect(expected.headset?.length).toBe(EPISODE.frames.length);

    const { server } = liveServer();
    server.compiled(COMPILED, "stale");
    server.hang.add(`/episodes/${ID}/derived/${RETARGET}`);
    server.files.delete(ENVIRONMENT);
    const loader = loaderOn(server);
    const pending = loader.step();
    const source = liveSource(server);

    expect(await follow(source, server)).toEqual(expected);
    // The raw source never asks for compiled files, nor the loader for raw ones.
    const sourceRequests = server.requests.filter(
      (r) => !r.includes("/derived/") && r !== `/episodes/${ID}`,
    );
    expect(sourceRequests.length).toBeGreaterThan(0);
    expect(
      sourceRequests.every((r) => /\/(frames|events|objects)\?/.test(r)),
    ).toBe(true);

    loader.stop();
    expect(await pending).toBe(0);
    expect(source.getSnapshot().error).toBeNull();
    expect(source.getSnapshot().episodeId).toBe(ID);
  });

  test("a compiled 404 never sends a pinned episode back to the list", async () => {
    const { server } = liveServer();
    server.compiled(COMPILED);
    server.files.clear();
    const loader = loaderOn(server);
    const source = liveSource(server);

    await loader.step();
    await source.step();
    await source.step();
    expect(loader.getSnapshot().artifacts).toEqual({
      [ENVIRONMENT]: "missing",
      [RETARGET]: "missing",
    });
    expect(source.getSnapshot().error).toBeNull();
    expect(source.getSnapshot().capture).not.toBeNull();
  });
});
