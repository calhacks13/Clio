import { ApiPaths, type SceneModel } from "@clio/protocol";
import type { Fetch } from "@clio-viewer/api";
import type { DerivedState } from "./derived";

// The files the 3D scene draws that are not JSON documents: the Quest room scan the compile keeps
// (derived/room.glb, which environment.json's `room` describes) and each object's generated model
// (scene/model-<id>.glb, which the detail's SceneDoc describes), read through the /api/clio proxy.
//
// They are read lazily: only while the layer that draws them is shown (the Room and Models
// toggles), and once per version of the file (the compile's compiledAt, the scene's builtAt), since
// a compile or a scene build rewrites them in place. The failure semantics are ClioDerivedSource's:
// a 404, or a body that does not parse, means the file is absent and it is not read again until its
// version changes; any other failure backs off from 2 s to 30 s and tries again. A file that is
// absent never means the episode is gone: ClioSource alone decides that.

/** Failed reads retry after 2 s, doubling up to 30 s, as ClioDerivedSource's do. */
export const FILE_BACKOFF_MIN_MS = 2000;
export const FILE_BACKOFF_MAX_MS = 30_000;

/** One file the scene can draw. */
export interface FileRef {
  /** The proxy URL. */
  url: string;
  /** The file's name, as the document names it. */
  name: string;
  /** What rewrites it: the compile's compiledAt or the scene's builtAt. */
  version: string;
  /** Changes whenever the file must be read again: its URL and its version. */
  key: string;
}

/** The proxy path of an ApiPaths path: "/api/x" under "/api/clio" is "/api/clio/x". */
const under = (apiBase: string, path: string) =>
  `${apiBase}${path.slice("/api".length)}`;

function fileRef(url: string, name: string, version: string): FileRef {
  return { url, name, version, key: `${version} ${url}` };
}

/**
 * The room scan to read: the compile's room.glb when the Room toggle is on and environment.json
 * describes one. Null otherwise, so nothing is read.
 */
export function roomFile(
  state: Pick<DerivedState, "episodeId" | "environment" | "compiledAt">,
  shown: boolean,
  apiBase = "/api/clio",
): FileRef | null {
  const { episodeId, environment, compiledAt } = state;
  const room = environment?.room;
  if (!shown || !episodeId || !compiledAt || !room) return null;
  return fileRef(
    under(apiBase, ApiPaths.episodeDerived(episodeId, room.file)),
    room.file,
    compiledAt,
  );
}

/** An object's generated model and its file. */
export interface ModelFile {
  model: SceneModel;
  file: FileRef;
}

const NO_MODELS: ReadonlyMap<string, ModelFile> = new Map();

/**
 * The models to read, by object id: every object the scene made a model for, while the Models
 * toggle is on. An object whose model could not be made (a null `model`) has none.
 */
export function modelFiles(
  state: Pick<DerivedState, "episodeId" | "scene">,
  shown: boolean,
  apiBase = "/api/clio",
): ReadonlyMap<string, ModelFile> {
  const { episodeId, scene } = state;
  if (!shown || !episodeId || !scene) return NO_MODELS;
  const files = new Map<string, ModelFile>();
  for (const model of scene.objects) {
    if (model.model === null) continue;
    files.set(model.id, {
      model,
      file: fileRef(
        under(apiBase, ApiPaths.episodeScene(episodeId, model.model)),
        model.model,
        scene.builtAt,
      ),
    });
  }
  return files;
}

/** The proxy URL of a scene file (a crop the inspector shows), or null without an episode. */
export function sceneFileUrl(
  episodeId: string | null,
  name: string,
  apiBase = "/api/clio",
): string | null {
  return episodeId
    ? under(apiBase, ApiPaths.episodeScene(episodeId, name))
    : null;
}

/**
 * How one file read came back. idle: not started (or stopped); loading: being read, or waiting to
 * retry after a failure; missing (404) and invalid (did not parse) both read as "absent".
 */
export type FileStatus = "idle" | "loading" | "ok" | "missing" | "invalid";

export interface FileState<T> {
  status: FileStatus;
  /** The parsed file, while the status is ok. */
  value: T | null;
  /** The last read failed (server unreachable or erroring) and will be retried. */
  error: { message: string; status: number | null; retryAtMs: number } | null;
}

export interface LazyFileOptions<T> {
  url: string;
  /** Turns the body into what a layer draws; a throw means the file is invalid. */
  parse: (bytes: ArrayBuffer) => Promise<T>;
  /** Releases a parsed value (its geometries and materials) when it is let go. */
  dispose?: (value: T) => void;
  fetch?: Fetch;
  /** Laptop time in ms, performance.now() by default: only for retry times. */
  now?: () => number;
}

class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`${url}: HTTP ${status}`);
  }
}

const browserFetch: Fetch = (input, init) => fetch(input, init);

const IDLE: FileState<never> = { status: "idle", value: null, error: null };

/** The state of a file with no reader (nothing to read, or its layer is hidden). */
export const idleFile = <T>(): FileState<T> => IDLE;

/**
 * One file read once, with retries. `subscribe` and `getSnapshot` fit `useSyncExternalStore`;
 * `start` reads it (again after `stop`); `stop` abandons the read in flight and disposes the parsed
 * value, so a hidden layer holds nothing; `step` is one attempt (tests drive it directly) and
 * resolves with the ms to wait before the next, or null once the file is read or absent.
 */
export class LazyFile<T> {
  readonly #url: string;
  readonly #parse: (bytes: ArrayBuffer) => Promise<T>;
  readonly #dispose: ((value: T) => void) | undefined;
  readonly #fetch: Fetch;
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();

  #state: FileState<T> = IDLE;
  #failures = 0;
  #running = false;
  #generation = 0;
  #abort = new AbortController();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #wake: (() => void) | null = null;

  constructor(options: LazyFileOptions<T>) {
    this.#url = options.url;
    this.#parse = options.parse;
    this.#dispose = options.dispose;
    this.#fetch = options.fetch ?? browserFetch;
    this.#now = options.now ?? (() => performance.now());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): FileState<T> => this.#state;

  start(): void {
    if (this.#running) return;
    this.#running = true;
    if (this.#abort.signal.aborted) this.#abort = new AbortController();
    void this.#loop(++this.#generation);
  }

  /** Stops reading, abandons the read in flight and lets the parsed value go. */
  stop(): void {
    this.#running = false;
    this.#generation++;
    this.#abort.abort();
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#wake?.();
    const { value } = this.#state;
    this.#failures = 0;
    this.#set(IDLE);
    if (value !== null) this.#dispose?.(value);
  }

  async #loop(generation: number): Promise<void> {
    const current = () => this.#running && generation === this.#generation;
    while (current()) {
      const wait = await this.step();
      if (wait === null || !current()) break;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        this.#timer = setTimeout(resolve, wait);
      });
      this.#wake = null;
      this.#timer = null;
    }
  }

  /** One read. Null once the file is read or absent; else the ms until the next try. */
  async step(): Promise<number | null> {
    const { status } = this.#state;
    if (status === "ok" || status === "missing" || status === "invalid") {
      return null;
    }
    const signal = this.#abort.signal;
    if (status === "idle")
      this.#set({ status: "loading", value: null, error: null });
    let bytes: ArrayBuffer;
    try {
      const res = await this.#fetch(this.#url, { cache: "no-store", signal });
      if (res.status === 404) {
        if (!signal.aborted)
          this.#set({ status: "missing", value: null, error: null });
        return null;
      }
      if (!res.ok) throw new HttpError(this.#url, res.status);
      // The whole body first, so a dropped connection retries instead of reading as invalid.
      bytes = await res.arrayBuffer();
    } catch (err) {
      if (signal.aborted) return null;
      this.#failures++;
      const wait = Math.min(
        FILE_BACKOFF_MAX_MS,
        FILE_BACKOFF_MIN_MS * 2 ** (this.#failures - 1),
      );
      this.#set({
        status: "loading",
        value: null,
        error: {
          message: err instanceof Error ? err.message : String(err),
          status: err instanceof HttpError ? err.status : null,
          retryAtMs: this.#now() + wait,
        },
      });
      return wait;
    }
    if (signal.aborted) return null;
    let value: T;
    try {
      value = await this.#parse(bytes);
    } catch {
      if (!signal.aborted)
        this.#set({ status: "invalid", value: null, error: null });
      return null;
    }
    // Stopped while parsing: nobody will draw it.
    if (signal.aborted) {
      this.#dispose?.(value);
      return null;
    }
    this.#failures = 0;
    this.#set({ status: "ok", value, error: null });
    return null;
  }

  #set(next: FileState<T>): void {
    const prev = this.#state;
    if (
      prev.status === next.status &&
      prev.value === next.value &&
      prev.error === next.error
    ) {
      return;
    }
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}
