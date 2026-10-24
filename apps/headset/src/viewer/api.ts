import {
  ApiPaths,
  type EpisodeDetailResponse,
  EpisodeDetailResponseSchema,
  EpisodeListResponseSchema,
  type EpisodeSummary,
} from '@clio/protocol';
import type { z } from 'zod';
import { NdjsonDecoder } from './episode-data';

// The viewer's reads from the Clio server, same origin (the Vite dev server proxies /api). Another
// page can read through its own proxy by passing an `apiBase` that stands in for /api.

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

// Not `fetch` itself: called as a method it would run with the wrong `this` and throw.
const browserFetch: Fetch = (input, init) => fetch(input, init);

const API = '/api';

/** An ApiPaths path under another base, e.g. "/api/clio" for "/api/clio/episodes". */
const under = (apiBase: string, path: string) =>
  apiBase === API ? path : `${apiBase}${path.slice(API.length)}`;

async function getJson<S extends z.ZodType>(
  url: string,
  schema: S,
  fetchFn: Fetch,
  signal?: AbortSignal,
): Promise<z.output<S>> {
  const res = await fetchFn(url, { cache: 'no-store', signal });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return schema.parse(await res.json());
}

export async function listEpisodes(
  fetchFn = browserFetch,
  apiBase = API,
  signal?: AbortSignal,
): Promise<EpisodeSummary[]> {
  const url = under(apiBase, ApiPaths.episodes);
  return (await getJson(url, EpisodeListResponseSchema, fetchFn, signal)).episodes;
}

export function getEpisode(
  id: string,
  signal?: AbortSignal,
  fetchFn = browserFetch,
  apiBase = API,
): Promise<EpisodeDetailResponse> {
  const url = under(apiBase, ApiPaths.episode(id));
  return getJson(url, EpisodeDetailResponseSchema, fetchFn, signal);
}

export interface NdjsonTailOptions {
  /** The byte offset to start from (default 0). */
  from?: number;
  /**
   * `from` may fall inside a line (joining a long live file near its end): drop everything up to
   * the first line break, once.
   */
  skipFirstLine?: boolean;
}

/**
 * Follows one of an episode's NDJSON files: every read returns only the records appended since the
 * previous one (the server's `?from=` byte offset), so a live episode is never downloaded twice.
 */
export class NdjsonTail {
  #from: number;
  #skipFirstLine: boolean;
  #corrupt = 0;

  constructor(
    readonly url: string,
    private readonly fetchFn: Fetch = browserFetch,
    options: NdjsonTailOptions = {},
  ) {
    this.#from = options.from ?? 0;
    this.#skipFirstLine = options.skipFirstLine ?? false;
  }

  /** Bytes consumed so far. */
  get offset(): number {
    return this.#from;
  }

  /** Whole lines that were not valid JSON, skipped (counted once a read succeeds). */
  get corrupt(): number {
    return this.#corrupt;
  }

  /**
   * All or nothing: the offset moves only once the whole body has arrived, and each read decodes
   * on its own, so a read that fails partway leaves no half line behind and the retry asks for the
   * same bytes again.
   */
  async read(signal?: AbortSignal): Promise<unknown[]> {
    const res = await this.fetchFn(`${this.url}?from=${this.#from}`, { cache: 'no-store', signal });
    if (!res.ok) throw new Error(`${this.url}: HTTP ${res.status}`);
    const decoder = new NdjsonDecoder();
    const records: unknown[] = [];
    let bytes = 0;
    /** Bytes up to the end of the last whole line; a trailing partial line is read again. */
    let whole = 0;
    let skip = this.#skipFirstLine;
    const reader = res.body?.getReader();
    for (;;) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) break;
      // 0x0a never occurs inside a multi-byte UTF-8 character, so this is a line boundary.
      const newline = chunk.value.lastIndexOf(0x0a);
      if (newline >= 0) whole = bytes + newline + 1;
      bytes += chunk.value.byteLength;
      let value = chunk.value;
      if (skip) {
        const first = value.indexOf(0x0a);
        if (first < 0) continue;
        value = value.subarray(first + 1);
        skip = false;
      }
      // A long recording is many thousands of lines: push one by one, never spread.
      for (const record of decoder.push(value)) records.push(record);
    }
    const next = Number(res.headers.get('x-next-from') ?? Number.NaN);
    const known = Number.isSafeInteger(next);
    this.#from = known ? next : this.#from + whole;
    // The server's offset is always a line boundary; a counted one is once a line break arrived.
    this.#skipFirstLine = skip && !known;
    this.#corrupt += decoder.corrupt;
    return records;
  }
}

/** The three NDJSON channels of one episode. */
export function episodeTails(id: string, fetchFn = browserFetch, apiBase = API) {
  return {
    frames: new NdjsonTail(under(apiBase, ApiPaths.episodeFrames(id)), fetchFn),
    events: new NdjsonTail(under(apiBase, ApiPaths.episodeEvents(id)), fetchFn),
    objects: new NdjsonTail(under(apiBase, ApiPaths.episodeObjects(id)), fetchFn),
  };
}
