import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type Procedure, type ProcedureSummary, safeParseProcedure } from '@clio/protocol';
import { isSafeId } from '../ids';
import { describeError, type Logger } from '../log';
import { createFileExclusive, isMissing, readJson } from './files';

// Two read-only-ish sources of procedures:
// - curated: `procedures/*.json` in the repo, hand-written;
// - generated: `<data>/plans/<id>.json`, written by the planner (never overwritten).
// Invalid or unreadable files are logged once per file version and skipped, so one bad file (or
// folder) never takes the list down. Curated wins when both sources define the same id.

export type ProcedureSource = 'curated' | 'generated';

export interface ProcedureStoreOptions {
  curatedDir: string;
  plansDir: string;
  logger?: Logger;
}

interface Loaded {
  procedure: Procedure;
  /** Newest-first sort key for generated plans: origin.createdAt, else the file's mtime. */
  createdAt: string;
}

interface CacheEntry {
  size: number;
  mtimeMs: number;
  loaded: Loaded | null;
}

/** Ids tried for one plan; bounded so a full directory cannot spin forever. */
const MAX_ID_ATTEMPTS = 1000;

export class ProcedureStore {
  readonly #curatedDir: string;
  readonly #plansDir: string;
  readonly #logger: Logger | undefined;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(options: ProcedureStoreOptions) {
    this.#curatedDir = options.curatedDir;
    this.#plansDir = options.plansDir;
    this.#logger = options.logger;
  }

  async list(): Promise<ProcedureSummary[]> {
    const curated = (await this.#loadAll(this.#curatedDir)).sort((a, b) =>
      compare(a.procedure.id, b.procedure.id),
    );
    const curatedIds = new Set(curated.map((l) => l.procedure.id));
    const generated = (await this.#loadAll(this.#plansDir))
      .filter((l) => !curatedIds.has(l.procedure.id))
      .sort((a, b) => compare(b.createdAt, a.createdAt) || compare(a.procedure.id, b.procedure.id));
    return [
      ...curated.map((l) => summarize(l.procedure, 'curated')),
      ...generated.map((l) => summarize(l.procedure, 'generated')),
    ];
  }

  /** A curated procedure or a generated plan; curated wins an id clash. */
  async get(id: string): Promise<Procedure | null> {
    return (await this.#find(this.#curatedDir, id)) ?? (await this.#find(this.#plansDir, id));
  }

  /** Only generated plans (`GET /api/plans/:id`). */
  getPlan(id: string): Promise<Procedure | null> {
    return this.#find(this.#plansDir, id);
  }

  /**
   * Writes the plan under the first candidate id that is free (never overwriting a file, never
   * shadowed by a curated id) and returns it with that id.
   */
  async savePlan(procedure: Procedure, candidates: Iterable<string>): Promise<Procedure> {
    await mkdir(this.#plansDir, { recursive: true });
    const curatedIds = new Set((await this.#loadAll(this.#curatedDir)).map((l) => l.procedure.id));
    let attempts = 0;
    for (const id of candidates) {
      if (++attempts > MAX_ID_ATTEMPTS) break;
      if (!isSafeId(id) || curatedIds.has(id)) continue;
      const saved: Procedure = { ...procedure, id };
      const text = `${JSON.stringify(saved, null, 2)}\n`;
      if (await createFileExclusive(join(this.#plansDir, `${id}.json`), text)) return saved;
    }
    throw new Error(`No free plan id for "${procedure.id}"`);
  }

  async #find(dir: string, id: string): Promise<Procedure | null> {
    if (!isSafeId(id)) return null;
    // Files are normally named after their id; fall back to a scan for hand-renamed files.
    const direct = await this.#load(join(dir, `${id}.json`));
    if (direct?.procedure.id === id) return direct.procedure;
    const match = (await this.#loadAll(dir)).find((l) => l.procedure.id === id);
    return match?.procedure ?? null;
  }

  async #loadAll(dir: string): Promise<Loaded[]> {
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
    } catch (error) {
      if (!isMissing(error)) this.#logger?.warn(`Cannot read ${dir}: ${describeError(error)}`);
      return [];
    }
    const loaded: Loaded[] = [];
    for (const file of files.sort()) {
      const l = await this.#load(join(dir, file));
      if (l) loaded.push(l);
    }
    return loaded;
  }

  async #load(path: string): Promise<Loaded | null> {
    let info: { size: number; mtimeMs: number; mtime: Date };
    try {
      info = await stat(path);
    } catch (error) {
      if (!isMissing(error)) this.#logger?.warn(`Cannot read ${path}: ${describeError(error)}`);
      return null;
    }
    const cached = this.#cache.get(path);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs)
      return cached.loaded;
    const loaded = await this.#parse(path, info.mtime);
    this.#cache.set(path, { size: info.size, mtimeMs: info.mtimeMs, loaded });
    return loaded;
  }

  async #parse(path: string, mtime: Date): Promise<Loaded | null> {
    let raw: unknown;
    try {
      raw = await readJson(path);
    } catch (error) {
      this.#logger?.warn(`Skipping procedure ${path}: ${describeError(error)}`);
      return null;
    }
    const result = safeParseProcedure(raw);
    if (!result.ok) {
      this.#logger?.warn(`Skipping invalid procedure ${path}:\n${result.error}`);
      return null;
    }
    const origin = result.procedure.origin;
    const createdAt = origin.kind === 'generated' ? origin.createdAt : mtime.toISOString();
    return { procedure: result.procedure, createdAt };
  }
}

function summarize(p: Procedure, source: ProcedureSource): ProcedureSummary {
  return {
    id: p.id,
    version: p.version,
    title: p.title,
    summary: p.summary,
    stepCount: p.steps.length,
    source,
  };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
