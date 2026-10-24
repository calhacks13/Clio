import { describe, expect, test } from "bun:test";
import type {
  EpisodeBatchIntegrity,
  EpisodeFinish,
  EpisodeMeta,
} from "@clio/protocol";
import type { Fetch } from "@clio-viewer/api";
import {
  buildCaptureFromClio,
  ClioCaptureBuilder,
  HEADSET,
} from "@clio-viewer/capture/from-clio";
import type { Capture } from "@clio-viewer/capture/model";
import {
  syntheticEpisode,
  syntheticFrames,
  toNdjson,
} from "../__fixtures__/synthetic-episode";
import {
  advanceClock,
  clockModeFor,
  createClock,
  liveEdgeUs,
} from "../live-clock";
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  ClioSource,
  type ClioSourceOptions,
  FRAMES_CAP_BYTES,
  HANDS_KEPT_US,
  JOIN_TAIL_BYTES,
  LIVE_GROWTH_MS,
  POLL_EVERY_MS,
  STATUS_EVERY_MS,
} from "../source";
import { type Channel, CHANNELS } from "../types";

// The episode source against a fake Clio server behind a mocked fetch. The
// fake answers `?from=` the way apps/server does: the lines in [from, end),
// where end is the end of the file's last whole line, and `x-next-from: end`.
// Laptop time (`now`) and the wall clock (`wallNow`) are fake too, so every
// test controls when status reads run and whether an episode is still live.

const START_EPOCH_MS = Date.UTC(2026, 9, 24, 12);
const us = (ms: number) => Math.round(ms * 1000);

/** One NDJSON file. Bytes before `base` are gone (trimmed) or never existed. */
class FakeFile {
  base = 0;
  bytes = Buffer.alloc(0);

  get size(): number {
    return this.base + this.bytes.length;
  }

  append(text: string): void {
    this.bytes = Buffer.concat([this.bytes, Buffer.from(text)]);
  }

  /** The file was replaced by a different one (a server restart). */
  replace(text: string): void {
    this.base = 0;
    this.bytes = Buffer.from(text);
  }

  /** Forgets bytes before `offset`, so long streams need not be held. */
  trimTo(offset: number): void {
    const n = offset - this.base;
    if (n <= 0) return;
    this.bytes = this.bytes.subarray(n);
    this.base = offset;
  }

  /** apps/server lastLineEnd: the end of the last whole line in [floor, size). */
  lastLineEnd(floor: number): number {
    if (this.size <= floor) return floor;
    const newline = this.bytes.lastIndexOf(10);
    const end = newline < 0 ? this.base : this.base + newline + 1;
    return end > floor ? end : floor;
  }

  slice(from: number, end: number): Uint8Array {
    if (from < this.base) throw new Error(`read below byte ${this.base}`);
    return this.bytes.subarray(from - this.base, end - this.base);
  }
}

interface FakeEpisode {
  meta: EpisodeMeta;
  finish: EpisodeFinish | null;
  batches?: EpisodeBatchIntegrity;
  files: Record<Channel, FakeFile>;
}

type Scope = "list" | "detail" | Channel;
type Failure = {
  scope: Scope;
  status: number | "network";
  /** Requests of the scope let through before this one fails. */
  after?: number;
};

const BODY_CHUNK = 64 * 1024;

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + BODY_CHUNK));
      at += BODY_CHUNK;
    },
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

class FakeServer {
  readonly episodes = new Map<string, FakeEpisode>();
  /** Every request, as "list", "detail:<id>" or "<channel>:<from>". */
  readonly requests: string[] = [];
  /** Requests still running, in the order they started. */
  readonly open = new Set<string>();
  /** The next request of a scope fails, once per entry. */
  failures: Failure[] = [];
  /**
   * Answer channel reads up to the file's size, partial last line included,
   * with x-next-from still at the last whole line.
   */
  bodyToSize = false;
  /** Per channel read: the requests already running when it started. */
  readonly overlaps: { request: string; running: string[] }[] = [];

  add(meta: EpisodeMeta, finish: EpisodeFinish | null = null): FakeEpisode {
    const episode: FakeEpisode = {
      meta,
      finish,
      files: {
        frames: new FakeFile(),
        events: new FakeFile(),
        objects: new FakeFile(),
      },
    };
    this.episodes.set(meta.episodeId, episode);
    return episode;
  }

  channelRequests(channel: Channel): string[] {
    return this.requests.filter((r) => r.startsWith(`${channel}:`));
  }

  readonly fetch: Fetch = async (input) => {
    const url = new URL(input, "http://127.0.0.1:3001");
    const parts = url.pathname.split("/").slice(3); // after /api/clio
    const id = parts[1];
    const channel = parts[2] as Channel | undefined;
    const from = Number(url.searchParams.get("from") ?? 0);
    const scope: Scope = !id ? "list" : channel ? channel : "detail";
    const request =
      scope === "list"
        ? "list"
        : scope === "detail"
          ? `detail:${id}`
          : `${channel}:${from}`;
    this.requests.push(request);
    if (channel) this.overlaps.push({ request, running: [...this.open] });
    this.open.add(request);
    try {
      // Let other requests start, as a real server would.
      await Promise.resolve();
      const failure = this.failures.findIndex((f) => f.scope === scope);
      const due = failure >= 0 && !this.failures[failure].after;
      if (failure >= 0 && !due)
        this.failures[failure].after = (this.failures[failure].after ?? 0) - 1;
      if (due) {
        const { status } = this.failures.splice(failure, 1)[0];
        if (status === "network") throw new TypeError("fetch failed");
        return json({ error: "failed", message: `HTTP ${status}` }, status);
      }
      if (scope === "list") return json({ episodes: this.#summaries() });
      const episode = id ? this.episodes.get(id) : undefined;
      if (!episode) {
        return json({ error: "not_found", message: `No episode ${id}` }, 404);
      }
      if (scope === "detail") {
        return json({
          meta: episode.meta,
          summary: this.#summary(episode),
          finish: episode.finish,
          ...(episode.batches ? { batches: episode.batches } : {}),
        });
      }
      const file = episode.files[scope];
      const floor = from < file.size ? from : 0;
      const end = file.lastLineEnd(floor);
      const stop = this.bodyToSize ? Math.max(end, file.size) : end;
      const body = from >= stop ? new Uint8Array(0) : file.slice(from, stop);
      return new Response(streamOf(body), {
        status: 200,
        headers: {
          "content-type": "application/x-ndjson",
          "x-next-from": String(end),
        },
      });
    } finally {
      this.open.delete(request);
    }
  };

  #summary(episode: FakeEpisode) {
    const { meta, finish } = episode;
    return {
      episodeId: meta.episodeId,
      createdAt: meta.createdAt,
      mode: meta.mode,
      procedureId: meta.procedure?.id ?? null,
      finished: finish !== null,
      outcome: finish?.outcome ?? null,
      durationMs: finish?.durationMs ?? null,
      frameCount: 0,
      eventCount: 0,
    };
  }

  /** Newest first, like EpisodeStore.list. */
  #summaries() {
    return [...this.episodes.values()]
      .map((e) => this.#summary(e))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

/** Laptop and wall clocks the test moves by hand. */
class Clocks {
  nowMs = 1_000_000;
  wallMs = START_EPOCH_MS;

  advance(ms: number): void {
    this.nowMs += ms;
    this.wallMs += ms;
  }
}

function sourceOn(
  server: FakeServer,
  clocks: Clocks,
  options: Partial<ClioSourceOptions> = {},
): ClioSource {
  return new ClioSource({
    follow: "pinned",
    fetch: server.fetch,
    now: () => clocks.nowMs,
    wallNow: () => clocks.wallMs,
    ...options,
  });
}

/** Steps until the source says it is done, or `max` turns. */
async function drain(source: ClioSource, max = 50): Promise<number> {
  let wait = 0;
  for (let i = 0; i < max && wait !== Number.POSITIVE_INFINITY; i++) {
    wait = await source.step();
  }
  return wait;
}

/** A synthetic episode with its NDJSON already split into records. */
function episodeData(
  id = "ep-20261024-120000-aaaa",
  startEpochMs = START_EPOCH_MS,
) {
  return syntheticEpisode({ episodeId: id, startEpochMs });
}

/** Adds the whole episode to the server (finished or not). */
function serve(
  server: FakeServer,
  data: ReturnType<typeof syntheticEpisode>,
  finished = true,
): FakeEpisode {
  const episode = server.add(data.meta, finished ? data.finish : null);
  episode.files.frames.append(toNdjson(data.frames));
  episode.files.events.append(toNdjson(data.events));
  episode.files.objects.append(toNdjson(data.objects));
  return episode;
}

/** Every sample time in a capture, per series. */
function sampleTimes(capture: Capture): Record<string, number[]> {
  const times: Record<string, number[]> = {
    left: capture.hands.left.samples.map((s) => s.t_us),
    right: capture.hands.right.samples.map((s) => s.t_us),
    events: capture.events.samples.map((s) => s.t_us),
  };
  for (const [id, series] of capture.poses) {
    times[`pose:${id}`] = series.samples.map((s) => s.t_us);
  }
  return times;
}

const headsetCount = (source: ClioSource) =>
  source.getSnapshot().capture?.poses.get(HEADSET)?.samples.length ?? 0;

describe("reading", () => {
  test("a finished episode loads in full and the source stops", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    clocks.wallMs = START_EPOCH_MS + 3_600_000;
    const data = episodeData();
    const episode = serve(server, data);
    const source = sourceOn(server, clocks, { episodeId: data.meta.episodeId });

    expect(await drain(source)).toBe(Number.POSITIVE_INFINITY);
    const state = source.getSnapshot();
    expect(state.status).toBe("finished");
    expect(state.episodeId).toBe(data.meta.episodeId);
    expect(headsetCount(source)).toBe(data.frames.length);
    expect(state.capture?.events.samples.length).toBeGreaterThan(0);
    expect(state.offsets).toEqual({
      frames: episode.files.frames.size,
      events: episode.files.events.size,
      objects: episode.files.objects.size,
    });
    expect(state.loaded).toEqual({
      fromUs: 0,
      toUs: us(data.frames.at(-1)?.t ?? 0),
    });
    expect(state.truncated).toBe(false);
    expect(state.counts).toEqual({ duplicates: 0, rejected: 0, corrupt: 0 });
    expect(state.error).toBeNull();
  });

  test("offsets come only from x-next-from", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    const data = episodeData();
    const episode = server.add(data.meta);
    const half = Math.floor(data.frames.length / 2);
    episode.files.frames.append(toNdjson(data.frames.slice(0, half)));
    const wholeEnd = episode.files.frames.size;
    // Half a line more: the body carries it, x-next-from does not.
    const next = toNdjson(data.frames.slice(half, half + 1));
    episode.files.frames.append(next.slice(0, 100));
    server.bodyToSize = true;
    const source = sourceOn(server, clocks, { episodeId: data.meta.episodeId });

    await source.step();
    expect(source.getSnapshot().offsets.frames).toBe(wholeEnd);
    expect(headsetCount(source)).toBe(half);

    episode.files.frames.append(next.slice(100));
    clocks.advance(POLL_EVERY_MS);
    await source.step();
    expect(server.channelRequests("frames").at(-1)).toBe(`frames:${wholeEnd}`);
    expect(source.getSnapshot().offsets.frames).toBe(episode.files.frames.size);
    expect(headsetCount(source)).toBe(half + 1);
    expect(source.getSnapshot().counts.corrupt).toBe(0);
  });

  test("frames are read before events and objects, and applied first", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    const data = episodeData();
    serve(server, data, false);
    const calls: string[] = [];
    const proto = ClioCaptureBuilder.prototype;
    const original = {
      addFrames: proto.addFrames,
      addEvents: proto.addEvents,
      addObjects: proto.addObjects,
    };
    for (const name of ["addFrames", "addEvents", "addObjects"] as const) {
      proto[name] = function (this: ClioCaptureBuilder, records) {
        calls.push(name);
        return original[name].call(this, records);
      };
    }
    try {
      const source = sourceOn(server, clocks, {
        episodeId: data.meta.episodeId,
      });
      await source.step();
    } finally {
      Object.assign(proto, original);
    }
    expect(calls).toEqual(["addFrames", "addEvents", "addObjects"]);
    expect(server.requests).toEqual([
      `detail:${data.meta.episodeId}`,
      "frames:9007199254740991",
      "frames:0",
      "events:0",
      "objects:0",
    ]);
    // Events and objects start only once the frames read is done.
    for (const { request, running } of server.overlaps) {
      if (!request.startsWith("frames")) {
        expect(running.some((r) => r.startsWith("frames"))).toBe(false);
      }
    }
    const later = server.overlaps.find((o) => o.request === "objects:0");
    expect(later?.running).toEqual(["events:0"]);
  });

  test("a failed channel keeps its offset; the others keep their records", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    const data = episodeData();
    const episode = serve(server, data, false);
    server.failures.push({ scope: "events", status: 500 });
    const source = sourceOn(server, clocks, { episodeId: data.meta.episodeId });

    const wait = await source.step();
    let state = source.getSnapshot();
    expect(wait).toBe(BACKOFF_MIN_MS);
    expect(state.offsets.events).toBe(0);
    expect(state.offsets.frames).toBe(episode.files.frames.size);
    expect(state.offsets.objects).toBe(episode.files.objects.size);
    expect(headsetCount(source)).toBe(data.frames.length);
    expect(state.capture?.events.samples.length).toBe(0);
    expect(state.error).toMatchObject({
      scope: "events",
      status: 500,
      retryAtMs: clocks.nowMs + BACKOFF_MIN_MS,
    });

    clocks.advance(wait);
    expect(await source.step()).toBe(POLL_EVERY_MS);
    state = source.getSnapshot();
    expect(server.channelRequests("events")).toEqual(["events:0", "events:0"]);
    expect(state.offsets.events).toBe(episode.files.events.size);
    expect(state.capture?.events.samples.length).toBeGreaterThan(0);
    expect(state.error).toBeNull();
  });

  test("failures back off from 0.5 s, doubling to 5 s, then reset", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    serve(server, episodeData(), false);
    for (let i = 0; i < 7; i++) {
      server.failures.push({ scope: "list", status: "network" });
    }
    const source = sourceOn(server, clocks, { follow: "live" });

    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      const wait = await source.step();
      waits.push(wait);
      expect(source.getSnapshot().error).toMatchObject({
        scope: "list",
        status: null,
      });
      clocks.advance(wait);
    }
    expect(waits).toEqual([500, 1000, 2000, 4000, 5000, 5000, 5000]);
    expect(BACKOFF_MIN_MS).toBe(500);
    expect(BACKOFF_MAX_MS).toBe(5000);

    clocks.advance(STATUS_EVERY_MS);
    expect(await source.step()).toBe(POLL_EVERY_MS);
    expect(source.getSnapshot().error).toBeNull();
    expect(source.getSnapshot().episodeId).not.toBeNull();
  });

  test("the revision bumps only on new records", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    const data = episodeData();
    const episode = server.add(data.meta);
    episode.files.frames.append(toNdjson(data.frames.slice(0, 100)));
    const source = sourceOn(server, clocks, { episodeId: data.meta.episodeId });

    await source.step();
    const first = source.getSnapshot();
    expect(first.revision).toBe(1);

    clocks.advance(POLL_EVERY_MS);
    await source.step();
    // Nothing new: the same snapshot, so React does not render again.
    expect(source.getSnapshot()).toBe(first);

    episode.files.frames.append(toNdjson(data.frames.slice(100, 200)));
    clocks.advance(POLL_EVERY_MS);
    await source.step();
    expect(source.getSnapshot().revision).toBe(2);

    episode.files.events.append(toNdjson(data.events.slice(0, 1)));
    clocks.advance(POLL_EVERY_MS);
    await source.step();
    expect(source.getSnapshot().revision).toBe(3);
  });

  test("repeated bytes after a restart add no samples", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    const data = episodeData();
    const episode = serve(server, data, false);
    const source = sourceOn(server, clocks, { episodeId: data.meta.episodeId });
    await source.step();
    const before = source.getSnapshot();
    const times = sampleTimes(before.capture as Capture);

    // The headset restarted its upload and sent the same batches again.
    const batch = {
      frames: toNdjson(data.frames.slice(-90)),
      events: toNdjson(data.events.slice(-3)),
      objects: toNdjson(data.objects.slice(-40)),
    };
    for (const c of CHANNELS) episode.files[c].append(batch[c]);
    clocks.advance(POLL_EVERY_MS);
    await source.step();

    const after = source.getSnapshot();
    expect(after.offsets.frames).toBe(episode.files.frames.size);
    expect(sampleTimes(after.capture as Capture)).toEqual(times);
    expect(after.revision).toBe(before.revision);
    expect(after.counts.duplicates).toBeGreaterThanOrEqual(90 + 3);
    expect(after.counts.rejected).toBe(0);
  });
});

describe("following", () => {
  test("finish triggers one final read, then reading stops", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    const data = episodeData();
    const episode = server.add(data.meta);
    const half = Math.floor(data.frames.length / 2);
    episode.files.frames.append(toNdjson(data.frames.slice(0, half)));
    clocks.wallMs = START_EPOCH_MS + data.frames[half - 1].t + 500;
    const source = sourceOn(server, clocks, { episodeId: data.meta.episodeId });
    await source.step();
    expect(source.getSnapshot().status).toBe("live");

    // The last batch and finish.json land together.
    episode.files.frames.append(toNdjson(data.frames.slice(half)));
    episode.finish = data.finish;
    clocks.advance(STATUS_EVERY_MS);
    const framesBefore = server.channelRequests("frames").length;
    expect(await source.step()).toBe(POLL_EVERY_MS);
    expect(server.channelRequests("frames").length).toBe(framesBefore + 1);
    expect(headsetCount(source)).toBe(data.frames.length);
    expect(source.getSnapshot().status).toBe("finished");
    expect(source.getSnapshot().finish).toEqual(data.finish);

    const requests = server.requests.length;
    clocks.advance(STATUS_EVERY_MS);
    expect(await source.step()).toBe(Number.POSITIVE_INFINITY);
    expect(server.requests.length).toBe(requests);
  });

  test("growth within 15 s means live, otherwise stopped", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    const data = episodeData();
    const episode = server.add(data.meta);
    episode.files.frames.append(toNdjson(data.frames.slice(0, 100)));
    clocks.wallMs = START_EPOCH_MS + data.frames[99].t + 300;
    const source = sourceOn(server, clocks, { episodeId: data.meta.episodeId });
    await source.step();
    expect(source.getSnapshot().status).toBe("live");

    clocks.advance(LIVE_GROWTH_MS - 1000);
    await source.step();
    expect(source.getSnapshot().status).toBe("live");

    clocks.advance(1000);
    await source.step();
    expect(source.getSnapshot().status).toBe("stopped");

    episode.files.frames.append(toNdjson(data.frames.slice(100, 110)));
    clocks.advance(POLL_EVERY_MS);
    await source.step();
    expect(source.getSnapshot().status).toBe("live");
  });

  test("an unfinished episode that stopped long ago is stopped and loads in full", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    clocks.wallMs = START_EPOCH_MS + 3_600_000;
    const data = episodeData();
    serve(server, data, false);
    const source = sourceOn(server, clocks, { episodeId: data.meta.episodeId });
    await drain(source, 3);
    const state = source.getSnapshot();
    expect(state.status).toBe("stopped");
    expect(headsetCount(source)).toBe(data.frames.length);
    expect(state.handsKeptFromUs).toBeNull();
  });

  test("/clio/live switches to a newer episode; a pinned source never does", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    const older = episodeData("ep-20261024-120000-aaaa", START_EPOCH_MS);
    serve(server, older, false);
    clocks.wallMs = START_EPOCH_MS + 12_500;
    const live = sourceOn(server, clocks, { follow: "live" });
    const pinned = sourceOn(server, clocks, {
      episodeId: older.meta.episodeId,
    });
    await live.step();
    await pinned.step();
    expect(live.getSnapshot().episodeId).toBe(older.meta.episodeId);
    expect(live.getSnapshot().follow).toBe("live");

    const newer = episodeData(
      "ep-20261024-120100-bbbb",
      START_EPOCH_MS + 60_000,
    );
    serve(server, newer, false);
    clocks.advance(STATUS_EVERY_MS);
    await live.step();
    await pinned.step();
    expect(live.getSnapshot().episodeId).toBe(newer.meta.episodeId);
    expect(live.getSnapshot().capture).not.toBe(null);
    expect(headsetCount(live)).toBe(newer.frames.length);
    expect(pinned.getSnapshot().episodeId).toBe(older.meta.episodeId);

    // Pinning a live source stops it from switching again.
    expect(live.pin()).toBe(newer.meta.episodeId);
    expect(live.getSnapshot().follow).toBe("pinned");
    serve(
      server,
      episodeData("ep-20261024-120200-cccc", START_EPOCH_MS + 120_000),
      false,
    );
    clocks.advance(STATUS_EVERY_MS);
    await live.step();
    expect(live.getSnapshot().episodeId).toBe(newer.meta.episodeId);
  });

  test("a shrunk file resets the capture and rebuilds it", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    const data = episodeData();
    const episode = server.add(data.meta);
    episode.files.frames.append(toNdjson(data.frames.slice(0, 400)));
    clocks.wallMs = START_EPOCH_MS + data.frames[399].t + 300;
    const source = sourceOn(server, clocks, { episodeId: data.meta.episodeId });
    await source.step();
    const before = source.getSnapshot();
    expect(headsetCount(source)).toBe(400);

    // A different, shorter file under the same name.
    episode.files.frames.replace(toNdjson(data.frames.slice(0, 50)));
    clocks.advance(POLL_EVERY_MS);
    expect(await source.step()).toBe(0);
    await source.step();
    const after = source.getSnapshot();
    expect(after.capture).not.toBe(before.capture);
    expect(headsetCount(source)).toBe(50);
    expect(after.offsets.frames).toBe(episode.files.frames.size);
    expect(after.counts.duplicates).toBe(0);
  });

  test("a failed read right after a shrink still rebuilds", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    const data = episodeData();
    const episode = server.add(data.meta);
    episode.files.frames.append(toNdjson(data.frames.slice(0, 400)));
    clocks.wallMs = START_EPOCH_MS + data.frames[399].t + 300;
    const source = sourceOn(server, clocks, { episodeId: data.meta.episodeId });
    await source.step();
    const before = source.getSnapshot();

    episode.files.frames.replace(toNdjson(data.frames.slice(0, 50)));
    server.failures.push({ scope: "detail", status: 500 });
    clocks.advance(POLL_EVERY_MS);
    expect(await source.step()).toBe(BACKOFF_MIN_MS);
    expect(source.getSnapshot().error?.scope).toBe("detail");

    clocks.advance(BACKOFF_MIN_MS);
    expect(await source.step()).toBe(0);
    await source.step();
    const after = source.getSnapshot();
    expect(after.error).toBeNull();
    expect(after.capture).not.toBe(before.capture);
    expect(headsetCount(source)).toBe(50);
    expect(after.offsets.frames).toBe(episode.files.frames.size);
    expect(after.counts.duplicates).toBe(0);
  });

  test("a pinned episode that is gone stops with a 404", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    const source = sourceOn(server, clocks, {
      episodeId: "ep-20261024-120000-gone",
    });
    expect(await source.step()).toBe(Number.POSITIVE_INFINITY);
    expect(source.getSnapshot().error).toEqual({
      scope: "detail",
      message: expect.any(String),
      status: 404,
      retryAtMs: null,
    });
    const requests = server.requests.length;
    expect(await source.step()).toBe(Number.POSITIVE_INFINITY);
    expect(server.requests.length).toBe(requests);
  });

  test("a pinned episode deleted while reading stops with a 404", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    const data = episodeData();
    serve(server, data, false);
    clocks.wallMs = START_EPOCH_MS + 12_500;
    const source = sourceOn(server, clocks, { episodeId: data.meta.episodeId });
    await source.step();
    server.episodes.delete(data.meta.episodeId);
    clocks.advance(POLL_EVERY_MS);
    expect(await source.step()).toBe(Number.POSITIVE_INFINITY);
    const state = source.getSnapshot();
    expect(state.error).toMatchObject({ status: 404, retryAtMs: null });
    expect(state.episodeId).toBeNull();
  });

  test("following live, a 404 goes back to the list", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    const older = episodeData("ep-20261024-120000-aaaa", START_EPOCH_MS);
    const newer = episodeData(
      "ep-20261024-120100-bbbb",
      START_EPOCH_MS + 60_000,
    );
    serve(server, older, false);
    serve(server, newer, false);
    clocks.wallMs = START_EPOCH_MS + 72_500;
    const source = sourceOn(server, clocks, { follow: "live" });
    await source.step();
    expect(source.getSnapshot().episodeId).toBe(newer.meta.episodeId);

    server.episodes.delete(newer.meta.episodeId);
    clocks.advance(POLL_EVERY_MS);
    const wait = await source.step();
    expect(wait).toBe(BACKOFF_MIN_MS);
    expect(source.getSnapshot()).toMatchObject({
      episodeId: null,
      error: { status: 404 },
    });

    clocks.advance(wait);
    const from = server.requests.length;
    await source.step();
    expect(server.requests.slice(from, from + 2)).toEqual([
      "list",
      `detail:${older.meta.episodeId}`,
    ]);
    expect(source.getSnapshot().episodeId).toBe(older.meta.episodeId);
    expect(source.getSnapshot().error).toBeNull();
  });

  test("start and stop run and end the poll loop", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    clocks.wallMs = START_EPOCH_MS + 3_600_000;
    const data = episodeData();
    serve(server, data);
    const source = sourceOn(server, clocks, { episodeId: data.meta.episodeId });
    const seen: number[] = [];
    const unsubscribe = source.subscribe(() => {
      seen.push(source.getSnapshot().revision);
    });
    source.start();
    source.stop();
    source.start();
    for (let i = 0; i < 50 && headsetCount(source) === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    source.stop();
    unsubscribe();
    expect(headsetCount(source)).toBe(data.frames.length);
    expect(seen.length).toBeGreaterThan(0);
    // One loop, not two: the episode was read once.
    expect(server.channelRequests("frames")).toEqual(["frames:0"]);
  });
});

describe("join at the tail", () => {
  test("a 50 MB live frames file is joined 2 MB before its end", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    const data = episodeData();
    const episode = server.add(data.meta);
    episode.files.events.append(toNdjson(data.events));
    episode.files.objects.append(toNdjson(data.objects));
    // The last ~3 MB of a 50 MB file; reading any earlier byte fails.
    const tail = toNdjson([...syntheticFrames({ durationMs: 20_000, hz: 90 })]);
    const frames = episode.files.frames;
    frames.append(tail);
    frames.base = 50 * 1024 * 1024 - frames.bytes.length;
    const end = frames.size;
    clocks.wallMs = START_EPOCH_MS + 20_500;
    const source = sourceOn(server, clocks, { episodeId: data.meta.episodeId });

    expect(await source.step()).toBe(POLL_EVERY_MS);
    const joinAt = end - JOIN_TAIL_BYTES;
    expect(JOIN_TAIL_BYTES).toBe(2_097_152);
    expect(server.channelRequests("frames")).toEqual([
      "frames:9007199254740991",
      `frames:${joinAt}`,
    ]);
    expect(server.channelRequests("events")).toEqual(["events:0"]);
    expect(server.channelRequests("objects")).toEqual(["objects:0"]);

    // The line the join point falls in is dropped; every later one is read.
    // NDJSON of numbers and ASCII names: one character per byte.
    const lines = tail.slice(joinAt - frames.base).split("\n");
    const kept = lines.slice(1).filter((line) => line !== "");
    const state = source.getSnapshot();
    expect(state.counts).toEqual({ duplicates: 0, rejected: 0, corrupt: 0 });
    expect(headsetCount(source)).toBe(kept.length);
    expect(state.loaded?.fromUs).toBe(us(JSON.parse(kept[0]).t));
    expect(state.offsets.frames).toBe(end);
    expect(state.status).toBe("live");
  });

  test("a short live file is read from the start", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    const data = episodeData();
    serve(server, data, false);
    clocks.wallMs = START_EPOCH_MS + 12_500;
    const source = sourceOn(server, clocks, { episodeId: data.meta.episodeId });
    await source.step();
    expect(server.channelRequests("frames")).toEqual([
      "frames:9007199254740991",
      "frames:0",
    ]);
    expect(headsetCount(source)).toBe(data.frames.length);
  });

  test("a stale join whose reopen fails is still replayed from the start", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    const data = episodeData();
    const episode = server.add(data.meta);
    episode.files.events.append(toNdjson(data.events));
    episode.files.objects.append(toNdjson(data.objects));
    const frames = [...syntheticFrames({ durationMs: 20_000, hz: 90 })];
    episode.files.frames.append(toNdjson(frames));
    expect(episode.files.frames.size).toBeGreaterThan(JOIN_TAIL_BYTES);
    // Unfinished, but its last frame is an hour old.
    clocks.wallMs = START_EPOCH_MS + 3_600_000;
    // The detail read that would reopen it as a replay fails once.
    server.failures.push({ scope: "detail", status: 500, after: 1 });
    const source = sourceOn(server, clocks, { episodeId: data.meta.episodeId });

    expect(await source.step()).toBe(BACKOFF_MIN_MS);
    expect(source.getSnapshot().loaded?.fromUs).toBeGreaterThan(0);

    clocks.advance(BACKOFF_MIN_MS);
    expect(await drain(source)).toBe(POLL_EVERY_MS);
    const state = source.getSnapshot();
    expect(state.error).toBeNull();
    expect(state.status).toBe("stopped");
    expect(state.loaded?.fromUs).toBe(us(frames[0].t));
    expect(headsetCount(source)).toBe(frames.length);
    expect(state.handsKeptFromUs).toBeNull();
    expect(server.channelRequests("frames")).toContain("frames:0");
  });
});

describe("retention", () => {
  test("10 minutes live at 90 Hz keeps 5 minutes of hands and every head sample", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    const meta = episodeData().meta;
    const episode = server.add(meta);
    const source = sourceOn(server, clocks, { episodeId: meta.episodeId });

    const frames = syntheticFrames({ durationMs: 600_000, hz: 90 });
    let total = 0;
    let lastT = 0;
    for (;;) {
      const chunk: unknown[] = [];
      while (chunk.length < 900) {
        const next = frames.next();
        if (next.done) break;
        chunk.push(next.value);
        lastT = next.value.t;
      }
      if (chunk.length === 0) break;
      total += chunk.length;
      episode.files.frames.append(toNdjson(chunk));
      clocks.advance(10_000);
      clocks.wallMs = START_EPOCH_MS + lastT + 500;
      await source.step();
      episode.files.frames.trimTo(source.getSnapshot().offsets.frames);
    }

    const state = source.getSnapshot();
    const capture = state.capture as Capture;
    expect(total).toBe(54_001);
    expect(capture.poses.get(HEADSET)?.samples.length).toBe(total);
    const hands =
      capture.hands.left.samples.length + capture.hands.right.samples.length;
    expect(hands).toBeLessThanOrEqual(2 * 90 * 300);
    expect(hands).toBeGreaterThan(2 * 90 * 299);
    expect(state.handsKeptFromUs).toBe(us(lastT) - HANDS_KEPT_US + 1);
    expect(capture.hands.left.samples[0].t_us).toBeGreaterThanOrEqual(
      state.handsKeptFromUs ?? 0,
    );
    expect(state.loaded).toEqual({ fromUs: 0, toUs: us(lastT) });
    expect(state.status).toBe("live");
  });

  test("a finished episode stops loading at the frames cap and says so", async () => {
    expect(FRAMES_CAP_BYTES).toBe(128 * 1024 * 1024);
    const server = new FakeServer();
    const clocks = new Clocks();
    clocks.wallMs = START_EPOCH_MS + 3_600_000;
    const data = episodeData();
    const episode = serve(server, data);
    // A small cap and window stand in for 128 MB and 8 MB.
    const cap = Math.floor(episode.files.frames.size / 3);
    const source = sourceOn(server, clocks, {
      episodeId: data.meta.episodeId,
      framesCapBytes: cap,
      framesWindowBytes: Math.floor(cap / 4),
    });

    expect(await drain(source)).toBe(Number.POSITIVE_INFINITY);
    const state = source.getSnapshot();
    expect(state.truncated).toBe(true);
    expect(state.offsets.frames).toBeLessThanOrEqual(cap);
    expect(state.offsets.frames).toBeGreaterThan(cap - 4000);
    const loaded = headsetCount(source);
    expect(loaded).toBeGreaterThan(0);
    expect(loaded).toBeLessThan(data.frames.length / 2);
    expect(state.loaded?.toUs).toBe(us(data.frames[loaded - 1].t));
    // Events and objects are small and load in full.
    expect(state.offsets.events).toBe(episode.files.events.size);
    expect(state.offsets.objects).toBe(episode.files.objects.size);
    // Several windows, none read twice.
    const reads = server.channelRequests("frames");
    expect(reads.length).toBeGreaterThan(3);
    expect(new Set(reads).size).toBe(reads.length);
  });

  test("under the cap a long load arrives in windows and completes", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    clocks.wallMs = START_EPOCH_MS + 3_600_000;
    const data = episodeData();
    const episode = serve(server, data);
    const source = sourceOn(server, clocks, {
      episodeId: data.meta.episodeId,
      framesWindowBytes: Math.floor(episode.files.frames.size / 5),
    });
    expect(await drain(source)).toBe(Number.POSITIVE_INFINITY);
    expect(source.getSnapshot().truncated).toBe(false);
    expect(headsetCount(source)).toBe(data.frames.length);
    expect(server.channelRequests("frames").length).toBeGreaterThanOrEqual(5);
  });
});

describe("cost", () => {
  test("one second of frames is ingested in under 20 ms", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    const meta = episodeData().meta;
    const episode = server.add(meta);
    const source = sourceOn(server, clocks, { episodeId: meta.episodeId });
    const frames = [...syntheticFrames({ durationMs: 60_000, hz: 90 })];
    let spentMs = 0;
    for (let second = 0; second < 60; second++) {
      const chunk = frames.slice(second * 90, (second + 1) * 90);
      episode.files.frames.append(toNdjson(chunk));
      clocks.advance(1000);
      clocks.wallMs = START_EPOCH_MS + (chunk.at(-1)?.t ?? 0) + 500;
      const t0 = performance.now();
      await source.step();
      spentMs += performance.now() - t0;
    }
    expect(headsetCount(source)).toBe(60 * 90);
    expect(spentMs / 60).toBeLessThan(20);
  });
});

describe("clock skew", () => {
  test("a skewed laptop clock leaves every sample time unchanged", async () => {
    const data = episodeData();
    const runWith = async (now: () => number, wallNow: () => number) => {
      const server = new FakeServer();
      const episode = server.add(data.meta);
      const source = new ClioSource({
        follow: "pinned",
        episodeId: data.meta.episodeId,
        fetch: server.fetch,
        now,
        wallNow,
      });
      // Delivered in one-second batches, as the headset uploads them.
      for (let at = 0; at < 13_000; at += 1000) {
        const inBatch = <T extends { t: number }>(r: T) =>
          r.t >= at && r.t < at + 1000;
        episode.files.frames.append(toNdjson(data.frames.filter(inBatch)));
        episode.files.events.append(toNdjson(data.events.filter(inBatch)));
        episode.files.objects.append(toNdjson(data.objects.filter(inBatch)));
        await source.step();
      }
      return source.getSnapshot();
    };

    let fake = 0;
    const steady = await runWith(
      () => (fake += 500),
      () => START_EPOCH_MS + fake + 300,
    );
    // Hours off, running backwards and jumping about.
    let skewed = 9e9;
    const jumpy = await runWith(
      () => (skewed += skewed % 3 === 0 ? -7777 : 123_457),
      () => START_EPOCH_MS - 86_400_000 + skewed,
    );

    const steadyTimes = sampleTimes(steady.capture as Capture);
    expect(sampleTimes(jumpy.capture as Capture)).toEqual(steadyTimes);
    expect(steadyTimes[`pose:${HEADSET}`]).toEqual(
      data.frames.map((f) => us(f.t)),
    );
    expect(steadyTimes).toEqual(sampleTimes(buildCaptureFromClio(data)));
    for (const state of [steady, jumpy]) {
      expect(state.newest?.tUs).toBe(us(data.frames.at(-1)?.t ?? 0));
    }

    // The clock paces by laptop time and still reads recording time.
    const newest = jumpy.newest;
    const clockInput = {
      episodeId: jumpy.episodeId,
      nowMs: (newest?.receivedAtMs ?? 0) + 400,
      dtMs: 16,
      newest,
      startUs: jumpy.loaded?.fromUs ?? 0,
      endUs: jumpy.capture?.endUs ?? 0,
    };
    const clock = advanceClock(
      createClock(clockModeFor("live"), clockInput),
      clockInput,
    );
    expect(clock.edgeUs).toBe(liveEdgeUs(newest, clockInput.nowMs));
    expect(clock.tUs).toBeLessThanOrEqual(newest?.tUs ?? 0);
  });
});

describe("release", () => {
  /** Collects garbage until `ref` is cleared, or gives up after a few rounds. */
  async function released(ref: WeakRef<object>): Promise<boolean> {
    for (let i = 0; i < 20 && ref.deref() !== undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      Bun.gc(true);
    }
    return ref.deref() === undefined;
  }

  test("/clio/live keeps no reference to the previous episode's capture", async () => {
    const server = new FakeServer();
    const clocks = new Clocks();
    serve(server, episodeData("ep-20261024-120000-aaaa"), false);
    clocks.wallMs = START_EPOCH_MS + 12_500;
    const live = sourceOn(server, clocks, { follow: "live" });
    const unsubscribe = live.subscribe(() => {});
    await live.step();
    // Taken inside a function, so no local variable here holds the capture.
    const old = (() => {
      const capture = live.getSnapshot().capture;
      return capture ? new WeakRef(capture) : null;
    })();
    if (!old) throw new Error("no capture");

    serve(
      server,
      episodeData("ep-20261024-120100-bbbb", START_EPOCH_MS + 60_000),
      false,
    );
    clocks.advance(STATUS_EVERY_MS);
    await live.step();
    await live.step();
    expect(live.getSnapshot().episodeId).toBe("ep-20261024-120100-bbbb");
    expect(await released(old)).toBe(true);
    unsubscribe();
  });
});
