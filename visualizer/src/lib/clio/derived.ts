import {
  ApiPaths,
  type CompileManifest,
  type CompileState,
  type DerivedArtifact,
  type DerivedKind,
  type EnvironmentDoc,
  EnvironmentDocSchema,
  EpisodeDerivedStatusSchema,
  type RetargetDoc,
  RetargetDocSchema,
} from "@clio/protocol";
import type { Fetch } from "@clio-viewer/api";
import type { EpisodeStatus } from "./types";

// The compiled side of a Clio episode (docs/data-pipeline.md): what
// `clio compile` wrote to data/derived/<id>/ after the episode finished, read
// through the /api/clio proxy. Separate from ClioSource on purpose: it has its
// own poll loop, requests and abort signal, so a slow or failing compiled read
// never delays or changes the live following of raw frames, events and
// objects.
//
// Each turn reads the episode's detail for its compile state. Once that is ok
// or stale, the manifest's artifacts that a layer draws (DRAWN_KINDS) are read
// and parsed with the @clio/protocol schemas, and read again only when
// manifest.compiledAt changes. A 404 or a file that does not parse means that
// artifact is not compiled, never that the episode is gone: ClioSource alone
// decides that.

/** How often the compile state is read while a compile is queued or running. */
export const DERIVED_COMPILING_EVERY_MS = 2000;
/** While nothing is compiled yet (the episode may still be recording). */
export const DERIVED_WAITING_EVERY_MS = 5000;
/** Once compiled, stale or failed, or when the server cannot compile. */
export const DERIVED_SETTLED_EVERY_MS = 15_000;
/** Failed reads retry after 2 s, doubling up to 30 s. */
export const DERIVED_BACKOFF_MIN_MS = 2000;
export const DERIVED_BACKOFF_MAX_MS = 30_000;

/** How one artifact read came back. missing (404) and invalid both read as "not compiled". */
export type ArtifactStatus = "ok" | "missing" | "invalid";

/**
 * The artifact kinds the scene draws, the only ones read. tracks.json is left
 * on the server until a layer draws it: the scene shows objects, hands and the
 * head from the raw episode.
 */
export const DRAWN_KINDS: ReadonlySet<DerivedKind> = new Set([
  "environment",
  "retarget",
]);

export interface DerivedState {
  episodeId: string | null;
  /**
   * The server's compile state. Null before the first read, and when the
   * server cannot compile (its detail has no `derived`).
   */
  compile: CompileState | null;
  /** The last successful compile, as the detail reports it. */
  manifest: CompileManifest | null;
  /** Why the last compile run failed. */
  compileError: string | null;
  /** The compiledAt the documents below were read for; null before any. */
  compiledAt: string | null;
  environment: EnvironmentDoc | null;
  /** One per robot profile, in manifest order. */
  retarget: readonly RetargetDoc[];
  /** Each artifact read for `compiledAt` (the DRAWN_KINDS), by file name. */
  artifacts: Readonly<Record<string, ArtifactStatus>>;
  /** The last read failed (server unreachable or erroring) and will be retried. */
  error: { message: string; status: number | null; retryAtMs: number } | null;
}

export interface ClioDerivedSourceOptions {
  episodeId: string;
  fetch?: Fetch;
  /** Stands in for /api; the visualizer's proxy is /api/clio. */
  apiBase?: string;
  /** Laptop time in ms, performance.now() by default: only for retry times. */
  now?: () => number;
}

const NO_RETARGET: readonly RetargetDoc[] = [];
const NO_ARTIFACTS: Readonly<Record<string, ArtifactStatus>> = {};

/** The state before anything is known, also what a page shows with no episode. */
export function emptyDerivedState(episodeId: string | null): DerivedState {
  return {
    episodeId,
    compile: null,
    manifest: null,
    compileError: null,
    compiledAt: null,
    environment: null,
    retarget: NO_RETARGET,
    artifacts: NO_ARTIFACTS,
    error: null,
  };
}

/** The proxy path of an ApiPaths path: "/api/x" under "/api/clio" is "/api/clio/x". */
const under = (apiBase: string, path: string) =>
  `${apiBase}${path.slice("/api".length)}`;

class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`${url}: HTTP ${status}`);
  }
}

type Parsed =
  | { kind: "environment"; doc: EnvironmentDoc }
  | { kind: "retarget"; doc: RetargetDoc };

type ArtifactResult =
  | { name: string; status: "ok"; parsed: Parsed }
  | { name: string; status: "missing" | "invalid" };

/** A document of the episode's kind, or null when the body is not one. */
function parseArtifact(
  artifact: DerivedArtifact,
  body: unknown,
  episodeId: string,
): Parsed | null {
  let parsed: Parsed | null = null;
  if (artifact.kind === "environment") {
    const r = EnvironmentDocSchema.safeParse(body);
    if (r.success) parsed = { kind: "environment", doc: r.data };
  } else if (artifact.kind === "retarget") {
    const r = RetargetDocSchema.safeParse(body);
    if (r.success) parsed = { kind: "retarget", doc: r.data };
  }
  // A valid document for another episode is not this episode's.
  return parsed && parsed.doc.episodeId === episodeId ? parsed : null;
}

const browserFetch: Fetch = (input, init) => fetch(input, init);

/**
 * The compiled documents of one episode. `subscribe` and `getSnapshot` fit
 * `useSyncExternalStore`; `start` and `stop` run the poll loop; `step` is one
 * turn of it (tests drive it directly).
 */
export class ClioDerivedSource {
  readonly #episodeId: string;
  readonly #fetch: Fetch;
  readonly #apiBase: string;
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();

  #state: DerivedState;
  #failures = 0;
  #running = false;
  #generation = 0;
  #stepping: Promise<number> | null = null;
  #abort = new AbortController();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #wake: (() => void) | null = null;

  constructor(options: ClioDerivedSourceOptions) {
    this.#episodeId = options.episodeId;
    this.#fetch = options.fetch ?? browserFetch;
    this.#apiBase = options.apiBase ?? "/api/clio";
    this.#now = options.now ?? (() => performance.now());
    this.#state = emptyDerivedState(options.episodeId);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): DerivedState => this.#state;

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

  /** One turn of the loop. Resolves with the ms to wait before the next. */
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
      if (!current()) break;
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
      await this.#read(signal);
      if (signal.aborted) return 0;
      this.#failures = 0;
      if (this.#state.error) this.#set({ error: null });
      return this.#untilNext();
    } catch (err) {
      if (signal.aborted) return 0;
      this.#failures++;
      const wait = Math.min(
        DERIVED_BACKOFF_MAX_MS,
        DERIVED_BACKOFF_MIN_MS * 2 ** (this.#failures - 1),
      );
      this.#set({
        error: {
          message: err instanceof Error ? err.message : String(err),
          status: err instanceof HttpError ? err.status : null,
          retryAtMs: this.#now() + wait,
        },
      });
      return wait;
    }
  }

  /** Reads the compile state, then the artifacts when a new compile is there to read. */
  async #read(signal: AbortSignal): Promise<void> {
    const id = this.#episodeId;
    const url = under(this.#apiBase, ApiPaths.episode(id));
    const res = await this.#fetch(url, { cache: "no-store", signal });
    if (!res.ok) throw new HttpError(url, res.status);
    const body = (await res.json()) as { derived?: unknown } | null;
    // Only `derived` is read: the raw fields are ClioSource's.
    const derived = EpisodeDerivedStatusSchema.optional().parse(
      body?.derived ?? undefined,
    );
    if (signal.aborted) return;
    if (!derived) {
      this.#set(emptyDerivedState(id));
      return;
    }
    const { state, manifest, error } = derived;
    if (!manifest) {
      // Nothing compiled (or the compiled files were removed): no documents.
      this.#set({
        ...emptyDerivedState(id),
        compile: state,
        compileError: error,
      });
      return;
    }
    // A compile queued or running keeps the documents of the last one.
    this.#set({ compile: state, manifest, compileError: error });
    const readable = state === "ok" || state === "stale";
    if (!readable || manifest.compiledAt === this.#state.compiledAt) return;
    // One failed read abandons the others: the whole compile is read again.
    const reads = new AbortController();
    const both = AbortSignal.any([signal, reads.signal]);
    const results = await Promise.all(
      manifest.artifacts
        .filter((artifact) => DRAWN_KINDS.has(artifact.kind))
        .map((artifact) => this.#artifact(artifact, both)),
    ).finally(() => reads.abort());
    if (signal.aborted) return;
    let environment: EnvironmentDoc | null = null;
    const retarget: RetargetDoc[] = [];
    const artifacts: Record<string, ArtifactStatus> = {};
    for (const result of results) {
      artifacts[result.name] = result.status;
      if (result.status !== "ok") continue;
      const { parsed } = result;
      if (parsed.kind === "environment") environment ??= parsed.doc;
      else retarget.push(parsed.doc);
    }
    this.#set({
      compiledAt: manifest.compiledAt,
      environment,
      retarget: retarget.length > 0 ? retarget : NO_RETARGET,
      artifacts,
    });
  }

  /**
   * One artifact. A 404 is "missing" and a body that is not the document is
   * "invalid"; any other failure throws, so the whole compile is read again.
   */
  async #artifact(
    artifact: DerivedArtifact,
    signal: AbortSignal,
  ): Promise<ArtifactResult> {
    const { name } = artifact;
    const url = under(
      this.#apiBase,
      ApiPaths.episodeDerived(this.#episodeId, name),
    );
    const res = await this.#fetch(url, { cache: "no-store", signal });
    if (res.status === 404) return { name, status: "missing" };
    if (!res.ok) throw new HttpError(url, res.status);
    // The body arrives first, so a dropped connection throws instead of reading as invalid.
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { name, status: "invalid" };
    }
    const parsed = parseArtifact(artifact, body, this.#episodeId);
    return parsed
      ? { name, status: "ok", parsed }
      : { name, status: "invalid" };
  }

  #untilNext(): number {
    switch (this.#state.compile) {
      case "queued":
      case "running":
        return DERIVED_COMPILING_EVERY_MS;
      case "none":
        return DERIVED_WAITING_EVERY_MS;
      default:
        return DERIVED_SETTLED_EVERY_MS;
    }
  }

  /** A new snapshot when anything changed, then tells the subscribers. */
  #set(patch: Partial<DerivedState>): void {
    const next = { ...this.#state, ...patch };
    const keys = Object.keys(next) as (keyof DerivedState)[];
    const same = keys.every((k) => {
      const a = this.#state[k];
      const b = next[k];
      if (Object.is(a, b)) return true;
      // The documents are replaced only when read again.
      if (k === "environment" || k === "retarget") {
        return false;
      }
      return JSON.stringify(a) === JSON.stringify(b);
    });
    if (same) return;
    // Keep the manifest's identity while its content is unchanged.
    if (
      next.manifest !== this.#state.manifest &&
      JSON.stringify(next.manifest) === JSON.stringify(this.#state.manifest)
    ) {
      next.manifest = this.#state.manifest;
    }
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}

/** What the transport shows for the compile state; null when there is nothing to show. */
export interface CompileStatusView {
  /** The compile state when it needs attention; null for a healthy compile. */
  label: string | null;
  /** A failed compile or compile stage: shown in the problem color. */
  problem: boolean;
  /** Tooltip detail, when there is any. */
  detail: string | null;
  /** The quality verdict said not usable: its first reason (may be empty). */
  notUsable: { reason: string | null } | null;
}

/** The label of each state that needs attention; a healthy compile (ok) has none. */
const COMPILE_LABEL: Record<CompileState, string | null> = {
  none: "Not compiled",
  queued: "Compiling",
  running: "Compiling",
  ok: null,
  stale: "Compile stale",
  failed: "Compile failed",
};

/**
 * The compile state the transport shows beside an episode whose raw status is
 * `episodeStatus` (DESIGN.md, "Status and live"). Nothing while it is live or
 * not loaded yet, since nothing can be compiled then. A failed run is a
 * problem whatever state the last good compile is in: the server keeps that
 * compile and reports ok or stale with the run's error, and a compile that
 * wrote a manifest records its failed stages there. A compile queued or
 * running supersedes the last failure and shows as Compiling.
 */
export function compileStatus(
  state: Pick<DerivedState, "compile" | "compileError" | "manifest">,
  episodeStatus: EpisodeStatus | null,
): CompileStatusView | null {
  const { compile, compileError, manifest } = state;
  if (compile === null || episodeStatus === null || episodeStatus === "live") {
    return null;
  }
  const quality = manifest?.quality;
  const notUsable =
    quality && !quality.usable ? { reason: quality.reasons[0] ?? null } : null;
  const compiling = compile === "queued" || compile === "running";
  const failures = compiling
    ? []
    : [
        ...(compileError ? [compileError] : []),
        ...(manifest?.stages ?? [])
          .filter((stage) => stage.status === "failed")
          .map((stage) =>
            stage.detail ? `${stage.name}: ${stage.detail}` : stage.name,
          ),
      ];
  if (compile === "failed" || failures.length > 0) {
    return {
      label: COMPILE_LABEL.failed,
      problem: true,
      detail: failures.length > 0 ? failures.join("\n") : null,
      notUsable,
    };
  }
  const label = COMPILE_LABEL[compile];
  if (label === null && notUsable === null) return null;
  return {
    label,
    problem: false,
    detail:
      compile === "stale"
        ? manifest
          ? "Raw files changed after the last compile"
          : "Compiled by an older pipeline"
        : null,
    notUsable,
  };
}
