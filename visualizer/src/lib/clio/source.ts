import {
  EPISODE_FEATURE,
  type EpisodeBatchIntegrity,
  type EpisodeDetailResponse,
  type EpisodeFinish,
  type EpisodeMeta,
} from "@clio/protocol";
import {
  episodeTails,
  type Fetch,
  getEpisode,
  listEpisodes,
  NdjsonTail,
} from "@clio-viewer/api";
import { ClioCaptureBuilder, HEADSET } from "@clio-viewer/capture/from-clio";
import {
  type Channel,
  CHANNELS,
  type EpisodeSourceState,
  type FollowMode,
  type SourceError,
} from "./types";

// Where the Clio episode viewer gets its episode (docs/plans/visualizer.md
// 2.2, 2.5): polls the Clio server through the /api/clio proxy and feeds a
// ClioCaptureBuilder. /clio/live follows the newest episode and switches when
// a newer one appears; a pinned source stays on one episode.
//
// Each turn reads frames first, then events, objects and, when the episode
// lists the object.observations feature, observations, and applies them in
// that order. Offsets come from the server's x-next-from (NdjsonTail), except
// when the source stops a read early itself (the frames window and size cap),
// where the end of the last whole line read is the next offset.
//
// Time rule: every sample time is the recording's own `t` (the builder turns
// ms into µs). Laptop time (`now`, performance.now()) only marks when a read
// arrived, for the live clock and the status, and never reaches a sample.

/** How often a followed episode is read. */
export const POLL_EVERY_MS = 500;
/** How often the list (live) and the episode's detail are read. */
export const STATUS_EVERY_MS = 2000;
/** Failed reads retry after 0.5 s, doubling up to 5 s. */
export const BACKOFF_MIN_MS = 500;
export const BACKOFF_MAX_MS = 5000;
/** An unfinished episode counts as live while it grew this recently. */
export const LIVE_GROWTH_MS = 15_000;
/** Joining a live episode with a longer frames file starts this far from its end. */
export const JOIN_TAIL_BYTES = 2 * 1024 * 1024;
/** While live, hand samples are kept this far behind the newest frame. */
export const HANDS_KEPT_US = 5 * 60 * 1_000_000;
/** A replayed episode loads at most this many bytes of frames. */
export const FRAMES_CAP_BYTES = 128 * 1024 * 1024;
/** One read takes at most this many bytes of frames, so a long load arrives in steps. */
export const FRAMES_WINDOW_BYTES = 8 * 1024 * 1024;

/** A request for "after the end": answers nothing but the file's end, as x-next-from. */
const END_PROBE = Number.MAX_SAFE_INTEGER;

export interface ClioSourceOptions {
  follow: FollowMode;
  /** The pinned episode; ignored when following live. */
  episodeId?: string | null;
  fetch?: Fetch;
  /** Stands in for /api; the visualizer's proxy is /api/clio. */
  apiBase?: string;
  /** Laptop time in ms, performance.now() by default: arrival times only. */
  now?: () => number;
  /** Wall clock in ms, Date.now() by default: whether an episode opened is still recording. */
  wallNow?: () => number;
  /** FRAMES_CAP_BYTES unless set (tests). */
  framesCapBytes?: number;
  /** FRAMES_WINDOW_BYTES unless set (tests). */
  framesWindowBytes?: number;
}

/**
 * live: joined while recording; hands are kept HANDS_KEPT_US behind the
 * newest frame. replay: loaded from the start, up to FRAMES_CAP_BYTES.
 */
type Load = "live" | "replay";

/** The fetch one read goes through: remembers the HTTP status, and can stop the body early. */
class Reader {
  status: number | null = null;
  /** The last body was stopped at `limit`. */
  cut = false;
  limit = Number.POSITIVE_INFINITY;

  constructor(private readonly base: Fetch) {}

  readonly fetch: Fetch = async (input, init) => {
    this.status = null;
    this.cut = false;
    const res = await this.base(input, init);
    this.status = res.status;
    if (!res.ok || !res.body || !Number.isFinite(this.limit)) return res;
    return limitBody(res, this.limit, () => {
      this.cut = true;
    });
  };
}

/**
 * The response with its body stopped after `limit` bytes. NdjsonTail then
 * keeps only whole lines and, without x-next-from, takes the end of the last
 * one as its next offset.
 */
function limitBody(res: Response, limit: number, onCut: () => void): Response {
  const headers = new Headers(res.headers);
  const upstream = (res.body as ReadableStream<Uint8Array>).getReader();
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await upstream.read();
      if (chunk.done) {
        controller.close();
        return;
      }
      if (sent + chunk.value.byteLength <= limit) {
        sent += chunk.value.byteLength;
        controller.enqueue(chunk.value);
        return;
      }
      if (limit > sent)
        controller.enqueue(chunk.value.subarray(0, limit - sent));
      sent = limit;
      // The server's end is past what was kept.
      headers.delete("x-next-from");
      onCut();
      await upstream.cancel();
      controller.close();
    },
    cancel: (reason) => upstream.cancel(reason),
  });
  return {
    ok: res.ok,
    status: res.status,
    headers,
    body,
  } as unknown as Response;
}

interface Session {
  id: string;
  meta: EpisodeMeta;
  /** summary.createdAt, wall-clock ms: when the server created the episode. */
  createdAtMs: number;
  builder: ClioCaptureBuilder;
  finish: EpisodeFinish | null;
  batches: EpisodeBatchIntegrity | null;
  tails: Record<Channel, NdjsonTail>;
  readers: Record<Channel, Reader>;
  /** meta.features lists object.observations: observations.ndjson is read. */
  observes: boolean;
  load: Load;
  /** The byte the frames were read from (the tail join point, or 0). */
  framesFrom: number;
  /** The frames size cap stopped the load. */
  truncated: boolean;
  /** The first complete read is done: later bytes are growth. */
  primed: boolean;
  /** Whether a live load still has to check that the episode is recording. */
  checkFresh: boolean;
  /**
   * The episode has to be read again from byte 0: "rebuild" after a file
   * shrank, "replay" after a join turned out stale. Kept until the reopen
   * succeeds, so a failed read retries it instead of reading on.
   */
  reopen: "rebuild" | "replay" | null;
  /** Read in full after the finish was known: nothing more will arrive. */
  done: boolean;
  /** Laptop time of the last growth. */
  grewAtMs: number;
  newest: EpisodeSourceState["newest"];
  handsKeptFromUs: number | null;
}

class NotFound extends Error {}

const EMPTY_OFFSETS: Record<Channel, number> = {
  frames: 0,
  events: 0,
  objects: 0,
  observations: 0,
};

const browserFetch: Fetch = (input, init) => fetch(input, init);

/**
 * The episode source of /clio/live and /clio/<id>. `subscribe` and
 * `getSnapshot` fit `useSyncExternalStore`; `start` and `stop` run the poll
 * loop; `step` is one turn of it (tests drive it directly).
 */
export class ClioSource {
  #follow: FollowMode;
  readonly #pinnedId: string | null;
  readonly #fetch: Fetch;
  readonly #apiBase: string;
  readonly #now: () => number;
  readonly #wallNow: () => number;
  readonly #framesCap: number;
  readonly #framesWindow: number;
  readonly #listeners = new Set<() => void>();

  #session: Session | null = null;
  #snapshot: EpisodeSourceState;
  #revision = 0;
  #error: SourceError | null = null;
  #failures = 0;
  #nextStatusAtMs = Number.NEGATIVE_INFINITY;
  /** Pinned to an episode the server does not have: nothing more to read. */
  #gone = false;

  #running = false;
  /** Bumps on every start, so a loop left over from before a stop ends. */
  #generation = 0;
  #stepping: Promise<number> | null = null;
  #abort = new AbortController();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #wake: (() => void) | null = null;

  constructor(options: ClioSourceOptions) {
    this.#follow = options.follow;
    this.#pinnedId =
      options.follow === "pinned" ? (options.episodeId ?? null) : null;
    this.#fetch = options.fetch ?? browserFetch;
    this.#apiBase = options.apiBase ?? "/api/clio";
    this.#now = options.now ?? (() => performance.now());
    this.#wallNow = options.wallNow ?? (() => Date.now());
    this.#framesCap = options.framesCapBytes ?? FRAMES_CAP_BYTES;
    this.#framesWindow = options.framesWindowBytes ?? FRAMES_WINDOW_BYTES;
    this.#snapshot = this.#state();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): EpisodeSourceState => this.#snapshot;

  /** Starts polling (again after `stop`). */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    if (this.#abort.signal.aborted) this.#abort = new AbortController();
    void this.#loop(++this.#generation);
  }

  /** Stops polling and abandons the read in flight. The state is kept. */
  stop(): void {
    this.#running = false;
    this.#abort.abort();
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#wake?.();
  }

  /** Stays on the episode shown from now on; returns its id for the address. */
  pin(): string | null {
    const id = this.#session?.id ?? null;
    if (id && this.#follow === "live") {
      this.#follow = "pinned";
      this.#publish();
    }
    return id;
  }

  /** One turn of the loop. Resolves with the ms to wait before the next (Infinity: done). */
  step(): Promise<number> {
    this.#stepping ??= this.#turn().finally(() => {
      this.#stepping = null;
    });
    return this.#stepping;
  }

  async #loop(generation: number): Promise<void> {
    const current = () => this.#running && generation === this.#generation;
    while (current()) {
      const wait = await this.step();
      if (!current() || wait === Number.POSITIVE_INFINITY) break;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        this.#timer = setTimeout(resolve, wait);
      });
      this.#wake = null;
      this.#timer = null;
    }
    if (generation === this.#generation) this.#running = false;
  }

  async #turn(): Promise<number> {
    const signal = this.#abort.signal;
    try {
      const wait = await this.#work(signal);
      // Stopped meanwhile: a restarted loop goes straight on.
      return signal.aborted ? 0 : wait;
    } catch (err) {
      if (signal.aborted) return 0;
      return this.#failed(err);
    } finally {
      // Also when stopped: what a finished read applied is shown.
      this.#publish();
    }
  }

  async #work(signal: AbortSignal): Promise<number> {
    if (this.#gone) return Number.POSITIVE_INFINITY;
    if (this.#now() >= this.#nextStatusAtMs) {
      await this.#status(signal);
      this.#nextStatusAtMs = this.#now() + STATUS_EVERY_MS;
    }
    const s = this.#session;
    if (!s) return this.#ok(this.#untilStatus());
    if (s.reopen) return this.#reopen(s, signal);
    if (s.done) {
      return this.#ok(
        this.#follow === "live"
          ? this.#untilStatus()
          : Number.POSITIVE_INFINITY,
      );
    }
    return this.#read(s, signal);
  }

  /** Live: opens the newest episode. Pinned: opens its episode. Then reads the detail. */
  async #status(signal: AbortSignal): Promise<void> {
    let id = this.#session?.id ?? null;
    if (this.#follow === "live") {
      const reader = new Reader(this.#fetch);
      const listed = await this.#scoped("list", reader, () =>
        listEpisodes(reader.fetch, this.#apiBase, signal),
      );
      id = listed[0]?.episodeId ?? id;
    } else if (!id) {
      id = this.#pinnedId;
    }
    if (!id) return;
    if (id !== this.#session?.id) {
      const detail = await this.#detail(id, signal);
      this.#session = await this.#open(detail, signal);
      return;
    }
    const s = this.#session;
    if (!s || s.finish) return;
    const detail = await this.#detail(id, signal);
    if (this.#session !== s) return;
    s.batches = detail.batches ?? null;
    if (detail.finish) {
      // The headset finished: the next read is the last one.
      s.finish = detail.finish;
      s.builder.finish(detail.finish);
    }
  }

  #detail(id: string, signal: AbortSignal): Promise<EpisodeDetailResponse> {
    const reader = new Reader(this.#fetch);
    return this.#scoped("detail", reader, () =>
      getEpisode(id, signal, reader.fetch, this.#apiBase),
    );
  }

  /**
   * A new session for an episode. A finished one is replayed from the start;
   * an unfinished one whose frames file is longer than JOIN_TAIL_BYTES is
   * joined that far from its end.
   */
  async #open(
    detail: EpisodeDetailResponse,
    signal: AbortSignal,
    load: Load = detail.finish ? "replay" : "live",
  ): Promise<Session> {
    const id = detail.meta.episodeId;
    const builder = new ClioCaptureBuilder(detail.meta);
    if (detail.finish) builder.finish(detail.finish);
    const urls = episodeTails(id, this.#fetch, this.#apiBase);
    const readers = {
      frames: new Reader(this.#fetch),
      events: new Reader(this.#fetch),
      objects: new Reader(this.#fetch),
      observations: new Reader(this.#fetch),
    };
    let framesFrom = 0;
    if (load === "live") {
      const probe = new NdjsonTail(urls.frames.url, readers.frames.fetch, {
        from: END_PROBE,
      });
      await this.#scoped("frames", readers.frames, () => probe.read(signal));
      if (probe.offset > JOIN_TAIL_BYTES) {
        framesFrom = probe.offset - JOIN_TAIL_BYTES;
      }
    }
    const tail = (channel: Channel, from = 0) =>
      new NdjsonTail(urls[channel].url, readers[channel].fetch, {
        from,
        skipFirstLine: from > 0,
      });
    const createdAtMs = Date.parse(detail.summary.createdAt);
    return {
      id,
      meta: detail.meta,
      createdAtMs,
      builder,
      finish: detail.finish,
      batches: detail.batches ?? null,
      tails: {
        frames: tail("frames", framesFrom),
        events: tail("events"),
        objects: tail("objects"),
        observations: tail("observations"),
      },
      readers,
      observes:
        detail.meta.features?.includes(EPISODE_FEATURE.objectObservations) ??
        false,
      load,
      framesFrom,
      truncated: false,
      primed: false,
      checkFresh: load === "live",
      reopen: null,
      done: false,
      // Until a frame says otherwise, an episode the server created moments
      // ago is live.
      grewAtMs: this.#now() - (this.#wallNow() - createdAtMs),
      newest: null,
      handsKeptFromUs: null,
    };
  }

  /** Replaces the session with a new one read from byte 0, as `s.reopen` says. */
  async #reopen(s: Session, signal: AbortSignal): Promise<number> {
    const detail = await this.#detail(s.id, signal);
    const load = s.reopen === "replay" ? "replay" : undefined;
    if (this.#session === s) {
      this.#session = await this.#open(detail, signal, load);
    }
    return this.#ok(0);
  }

  /** Reads what each channel gained and applies it as frames, events, objects, observations. */
  async #read(s: Session, signal: AbortSignal): Promise<number> {
    const finalRead = s.finish !== null;
    const before = { ...this.#offsets(s) };

    const frames = s.readers.frames;
    const capLeft = this.#framesCap - (s.tails.frames.offset - s.framesFrom);
    frames.limit =
      s.load === "replay"
        ? Math.min(this.#framesWindow, capLeft)
        : this.#framesWindow;
    if (s.load === "replay" && capLeft <= 0) s.truncated = true;
    let receivedAtMs = this.#now();
    const framesRead = s.truncated
      ? Promise.resolve<unknown[]>([])
      : s.tails.frames.read(signal).finally(() => {
          receivedAtMs = this.#now();
        });
    const [framesResult] = await Promise.allSettled([framesRead]);
    const [eventsResult, objectsResult, observationsResult] =
      await Promise.allSettled([
        s.tails.events.read(signal),
        s.tails.objects.read(signal),
        s.observes
          ? s.tails.observations.read(signal)
          : Promise.resolve<unknown[]>([]),
      ]);
    // Records already read are applied even if the loop was stopped meanwhile:
    // their offsets have moved on, so they would not be read again.
    if (this.#session !== s) return 0;
    const results: Record<Channel, PromiseSettledResult<unknown[]>> = {
      frames: framesResult as PromiseSettledResult<unknown[]>,
      events: eventsResult,
      objects: objectsResult,
      observations: observationsResult,
    };

    const shrank = CHANNELS.some(
      (c) => results[c].status === "fulfilled" && s.tails[c].offset < before[c],
    );
    if (shrank) {
      // The file is not the one read so far: start over.
      s.reopen = "rebuild";
      return this.#reopen(s, signal);
    }

    const got = (c: Channel) => {
      const r = results[c];
      return r.status === "fulfilled" ? r.value : [];
    };
    const { builder } = s;
    const skipped = builder.duplicates + builder.rejected;
    const received = CHANNELS.reduce((n, c) => n + got(c).length, 0);
    builder.addFrames(got("frames"));
    builder.addEvents(got("events"));
    builder.addObjects(got("objects"));
    builder.addObservations(got("observations"));
    if (received > builder.duplicates + builder.rejected - skipped) {
      this.#revision++;
    }

    const headset = builder.capture.poses.get(HEADSET);
    const newestUs = headset?.samples.at(-1)?.t_us;
    if (newestUs !== undefined && newestUs !== s.newest?.tUs) {
      s.newest = { tUs: newestUs, receivedAtMs };
    }
    const cut =
      results.frames.status === "fulfilled" && !s.truncated && frames.cut;
    if (cut && s.load === "replay" && frames.limit === capLeft) {
      s.truncated = true;
    }

    if (s.checkFresh && s.newest) {
      s.checkFresh = false;
      const ageMs = this.#wallNow() - (s.createdAtMs + s.newest.tUs / 1000);
      if (ageMs >= LIVE_GROWTH_MS) {
        // Not recording any more: replay it from the start instead.
        if (s.framesFrom > 0) {
          s.reopen = "replay";
          return this.#reopen(s, signal);
        }
        s.load = "replay";
        s.grewAtMs = Number.NEGATIVE_INFINITY;
      } else {
        s.grewAtMs = this.#now() - Math.max(0, ageMs);
      }
    }
    if (s.load === "live" && s.newest) this.#keepHands(s, s.newest.tUs);

    const grew = CHANNELS.some((c) => this.#offsets(s)[c] > before[c]);
    if (s.primed && grew) s.grewAtMs = this.#now();

    const failed = CHANNELS.find((c) => results[c].status === "rejected");
    if (failed) {
      const reason = (results[failed] as PromiseRejectedResult).reason;
      return this.#failed(reason, failed, s.readers[failed].status);
    }
    const more = cut && !s.truncated;
    if (!more) s.primed = true;
    if (finalRead && !more) s.done = true;
    return this.#ok(more ? 0 : POLL_EVERY_MS);
  }

  /**
   * Keeps hand samples newer than HANDS_KEPT_US behind the newest frame, so at
   * 90 Hz a hand holds at most 90 × 300 samples.
   */
  #keepHands(s: Session, newestUs: number): void {
    const keepFromUs = newestUs - HANDS_KEPT_US + 1;
    if (keepFromUs <= (s.handsKeptFromUs ?? 0)) return;
    const { hands } = s.builder.capture;
    const dropped =
      hands.left.dropBefore(keepFromUs) + hands.right.dropBefore(keepFromUs);
    if (dropped > 0) s.handsKeptFromUs = keepFromUs;
  }

  /** Runs one request, turning a failure into an error with its scope and status. */
  async #scoped<T>(
    scope: SourceError["scope"],
    reader: Reader,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (err) {
      throw Object.assign(
        reader.status === 404 ? new NotFound(messageOf(err)) : toError(err),
        { scope, status: reader.status },
      );
    }
  }

  #ok(wait: number): number {
    this.#failures = 0;
    this.#error = null;
    return wait;
  }

  /** Records a failed read and returns the backoff before the next try. */
  #failed(
    err: unknown,
    scope?: SourceError["scope"],
    status?: number | null,
  ): number {
    const tagged = err as {
      scope?: SourceError["scope"];
      status?: number | null;
    };
    const where = scope ?? tagged.scope ?? "detail";
    const code = status ?? tagged.status ?? null;
    this.#failures++;
    const wait = Math.min(
      BACKOFF_MAX_MS,
      BACKOFF_MIN_MS * 2 ** (this.#failures - 1),
    );
    const notFound = code === 404 || err instanceof NotFound;
    if (notFound && this.#follow === "pinned") {
      // The episode is gone: the page goes back to the list.
      this.#session = null;
      this.#gone = true;
      this.#error = {
        scope: where,
        message: messageOf(err),
        status: 404,
        retryAtMs: null,
      };
      return Number.POSITIVE_INFINITY;
    }
    if (notFound) {
      // Following live: back to the list, which names the newest episode.
      this.#session = null;
      this.#nextStatusAtMs = this.#now() + wait;
    }
    this.#error = {
      scope: where,
      message: messageOf(err),
      status: code,
      retryAtMs: this.#now() + wait,
    };
    return wait;
  }

  #untilStatus(): number {
    return Math.max(0, this.#nextStatusAtMs - this.#now());
  }

  #offsets(s: Session): Record<Channel, number> {
    return {
      frames: s.tails.frames.offset,
      events: s.tails.events.offset,
      objects: s.tails.objects.offset,
      observations: s.tails.observations.offset,
    };
  }

  #state(): EpisodeSourceState {
    const s = this.#session;
    const headset = s?.builder.capture.poses.get(HEADSET)?.samples;
    const first = headset?.[0]?.t_us;
    const last = headset?.at(-1)?.t_us;
    return {
      follow: this.#follow,
      episodeId: s?.id ?? null,
      meta: s?.meta ?? null,
      finish: s?.finish ?? null,
      capture: s?.builder.capture ?? null,
      revision: this.#revision,
      status: !s
        ? null
        : s.finish
          ? "finished"
          : this.#now() - s.grewAtMs < LIVE_GROWTH_MS
            ? "live"
            : "stopped",
      offsets: s ? this.#offsets(s) : EMPTY_OFFSETS,
      loaded:
        first !== undefined && last !== undefined
          ? { fromUs: first, toUs: last }
          : null,
      truncated: s?.truncated ?? false,
      handsKeptFromUs: s?.handsKeptFromUs ?? null,
      newest: s?.newest ?? null,
      batches: s?.batches
        ? { ...s.batches, sent: s.finish?.batches ?? null }
        : null,
      counts: {
        duplicates: s?.builder.duplicates ?? 0,
        rejected: s?.builder.rejected ?? 0,
        corrupt: s ? CHANNELS.reduce((n, c) => n + s.tails[c].corrupt, 0) : 0,
      },
      error: this.#error,
    };
  }

  /** A new snapshot when anything shown changed, then tells the subscribers. */
  #publish(): void {
    const next = this.#state();
    if (sameState(this.#snapshot, next)) return;
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }
}

function sameState(a: EpisodeSourceState, b: EpisodeSourceState): boolean {
  const keys = Object.keys(a) as (keyof EpisodeSourceState)[];
  return keys.every((k) => {
    const x = a[k];
    const y = b[k];
    if (Object.is(x, y)) return true;
    // Small records rebuilt on every snapshot: compare their values.
    if (k === "capture" || k === "meta" || k === "finish") return false;
    return JSON.stringify(x) === JSON.stringify(y);
  });
}

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const toError = (err: unknown) =>
  err instanceof Error ? err : new Error(String(err));
