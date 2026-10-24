import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type BenchRun,
  BenchRunSchema,
  type BenchScenario,
  type BenchScenarioCreateSchema,
  type BenchScenarioDetail,
  BenchScenarioSchema,
  type BenchScenarioSummary,
  type BenchScenarioUpdateSchema,
  type ImagePayload,
} from '@clio/protocol';
import type { z } from 'zod';
import { isSafeId } from '../ids';
import { describeError, type Logger } from '../log';
import { goalIdCandidates, slugFromGoal } from '../services/plan-ids';
import { isMissing, readJson, writeJsonAtomic } from './files';
import { KeyedMutex } from './keyed-mutex';

// The planner bench's scenarios, one folder each:
//   <dir>/scenarios/<id>/scenario.json   the request, the expectations, the view files
//   <dir>/scenarios/<id>/view-<n>.jpg    the camera views, as captured
//   <dir>/scenarios/<id>/runs/<run>.json one per planner answer, with its grades
// Views never change after a scenario is created, so a run can always be replayed. Deleting a
// scenario moves its folder to <dir>/deleted/ rather than removing it.

export type BenchScenarioCreateBody = z.output<typeof BenchScenarioCreateSchema>;
export type BenchScenarioUpdateBody = z.output<typeof BenchScenarioUpdateSchema>;

const EXTENSIONS: Record<ImagePayload['mimeType'], string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Ids tried for one scenario; bounded so a full directory cannot spin forever. */
const MAX_ID_ATTEMPTS = 1000;

export interface BenchStoreOptions {
  now?: () => Date;
  logger?: Logger;
}

export class BenchStore {
  readonly #scenariosDir: string;
  readonly #deletedDir: string;
  readonly #now: () => Date;
  readonly #logger: Logger | undefined;
  readonly #mutex = new KeyedMutex();

  constructor(dir: string, options: BenchStoreOptions = {}) {
    this.#scenariosDir = join(dir, 'scenarios');
    this.#deletedDir = join(dir, 'deleted');
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger;
  }

  /** Newest first. Folders without a valid scenario.json are logged and skipped. */
  async list(): Promise<BenchScenarioSummary[]> {
    let ids: string[];
    try {
      ids = (await readdir(this.#scenariosDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && isSafeId(e.name))
        .map((e) => e.name);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const summaries: BenchScenarioSummary[] = [];
    for (const id of ids) {
      const scenario = await this.#read(id);
      if (scenario) summaries.push(summarize(scenario, await this.#runs(id)));
    }
    return summaries.sort((a, b) => compare(b.createdAt, a.createdAt) || compare(a.id, b.id));
  }

  async get(id: string): Promise<BenchScenarioDetail | null> {
    const scenario = await this.#read(id);
    return scenario && { scenario, runs: await this.#runs(id) };
  }

  async getScenario(id: string): Promise<BenchScenario | null> {
    return this.#read(id);
  }

  async getRun(id: string, runId: string): Promise<BenchRun | null> {
    if (!isSafeId(id) || !isSafeId(runId)) return null;
    return this.#readRun(join(this.#runsDir(id), `${runId}.json`));
  }

  /** Writes the views first and scenario.json last, so a half-written folder is never listed. */
  async create(input: BenchScenarioCreateBody): Promise<BenchScenarioDetail> {
    await mkdir(this.#scenariosDir, { recursive: true });
    const id = await this.#claimId(input.title);
    const views = await Promise.all(
      input.images.map(async (image, i) => {
        const file = `view-${i + 1}.${EXTENSIONS[image.mimeType]}`;
        await writeFile(join(this.#scenariosDir, id, file), Buffer.from(image.data, 'base64'));
        return { file, mimeType: image.mimeType };
      }),
    );
    const at = this.#now().toISOString();
    const scenario: BenchScenario = {
      id,
      title: input.title,
      goal: input.goal,
      ...(input.context ? { context: input.context } : {}),
      ...(input.revise ? { revise: input.revise } : {}),
      expect: input.expect,
      tags: input.tags,
      views,
      createdAt: at,
      updatedAt: at,
    };
    const runs = uniqueById(input.runs);
    if (runs.length) {
      await mkdir(this.#runsDir(id), { recursive: true });
      for (const run of runs) await this.#writeRun(id, run);
    }
    await writeJsonAtomic(this.#scenarioPath(id), scenario);
    return { scenario, runs: sortRuns(runs) };
  }

  async update(id: string, patch: BenchScenarioUpdateBody): Promise<BenchScenario | null> {
    return this.#mutex.run(id, async () => {
      const scenario = await this.#read(id);
      if (!scenario) return null;
      const { context, ...rest } = patch;
      const next: BenchScenario = { ...scenario, ...dropUndefined(rest) };
      if (context === null || context?.trim() === '') delete next.context;
      else if (context !== undefined) next.context = context;
      next.updatedAt = this.#now().toISOString();
      await writeJsonAtomic(this.#scenarioPath(id), next);
      return next;
    });
  }

  /** Moves the folder to deleted/. Returns false when there is no such scenario. */
  async remove(id: string): Promise<boolean> {
    return this.#mutex.run(id, async () => {
      if (!(await this.#read(id))) return false;
      await mkdir(this.#deletedDir, { recursive: true });
      const stamp = this.#now().toISOString().replace(/[:.]/g, '-');
      await rename(join(this.#scenariosDir, id), join(this.#deletedDir, `${id}-${stamp}`));
      return true;
    });
  }

  /** View `n` (1-based) as stored. */
  async readView(
    id: string,
    n: number,
  ): Promise<{ bytes: Buffer; mimeType: ImagePayload['mimeType'] } | null> {
    const scenario = await this.#read(id);
    const view = scenario?.views[n - 1];
    if (!view || !isSafeId(view.file)) return null;
    try {
      return {
        bytes: await readFile(join(this.#scenariosDir, id, view.file)),
        mimeType: view.mimeType,
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /** Every view as an image payload, for the planner and the judge. */
  async readViews(scenario: BenchScenario): Promise<ImagePayload[]> {
    const images: ImagePayload[] = [];
    for (let n = 1; n <= scenario.views.length; n++) {
      const view = await this.readView(scenario.id, n);
      if (!view) throw new Error(`Scenario "${scenario.id}" is missing view ${n}`);
      images.push({ mimeType: view.mimeType, data: view.bytes.toString('base64') });
    }
    return images;
  }

  /** Returns false when there is no such scenario. */
  async addRun(id: string, run: BenchRun): Promise<boolean> {
    return this.#mutex.run(id, async () => {
      if (!(await this.#read(id))) return false;
      await mkdir(this.#runsDir(id), { recursive: true });
      await this.#writeRun(id, run);
      return true;
    });
  }

  /** Applies `change` to a stored run and saves it. Null when the scenario or run is missing. */
  async updateRun(
    id: string,
    runId: string,
    change: (run: BenchRun) => BenchRun,
  ): Promise<BenchRun | null> {
    return this.#mutex.run(id, async () => {
      const run = await this.getRun(id, runId);
      if (!run) return null;
      const next = BenchRunSchema.parse(change(run));
      await this.#writeRun(id, next);
      return next;
    });
  }

  async #claimId(title: string): Promise<string> {
    let attempts = 0;
    for (const id of goalIdCandidates(slugFromGoal(title))) {
      if (++attempts > MAX_ID_ATTEMPTS) break;
      try {
        await mkdir(join(this.#scenariosDir, id));
        return id;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new Error(`No free scenario id for "${title}"`);
  }

  async #read(id: string): Promise<BenchScenario | null> {
    if (!isSafeId(id)) return null;
    let raw: unknown;
    try {
      raw = await readJson(this.#scenarioPath(id));
    } catch (error) {
      this.#logger?.warn(`Skipping bench scenario ${id}: ${describeError(error)}`);
      return null;
    }
    if (raw === undefined) return null;
    const parsed = BenchScenarioSchema.safeParse(raw);
    if (!parsed.success) {
      this.#logger?.warn(`Skipping invalid bench scenario ${id}: ${parsed.error.message}`);
      return null;
    }
    return parsed.data;
  }

  async #runs(id: string): Promise<BenchRun[]> {
    let files: string[];
    try {
      files = (await readdir(this.#runsDir(id))).filter(
        (f) => f.endsWith('.json') && !f.startsWith('.'),
      );
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const runs: BenchRun[] = [];
    for (const file of files) {
      const run = await this.#readRun(join(this.#runsDir(id), file));
      if (run) runs.push(run);
    }
    return sortRuns(runs);
  }

  async #readRun(path: string): Promise<BenchRun | null> {
    let raw: unknown;
    try {
      raw = await readJson(path);
    } catch (error) {
      this.#logger?.warn(`Skipping bench run ${path}: ${describeError(error)}`);
      return null;
    }
    if (raw === undefined) return null;
    const parsed = BenchRunSchema.safeParse(raw);
    if (!parsed.success) {
      this.#logger?.warn(`Skipping invalid bench run ${path}: ${parsed.error.message}`);
      return null;
    }
    return parsed.data;
  }

  async #writeRun(id: string, run: BenchRun): Promise<void> {
    if (!isSafeId(run.id)) throw new Error(`Invalid run id "${run.id}"`);
    await writeJsonAtomic(join(this.#runsDir(id), `${run.id}.json`), run);
  }

  #scenarioPath(id: string): string {
    return join(this.#scenariosDir, id, 'scenario.json');
  }

  #runsDir(id: string): string {
    return join(this.#scenariosDir, id, 'runs');
  }
}

function summarize(scenario: BenchScenario, runs: BenchRun[]): BenchScenarioSummary {
  const last = runs[0];
  return {
    id: scenario.id,
    title: scenario.title,
    goal: scenario.goal,
    tags: scenario.tags,
    revising: scenario.revise !== undefined,
    expectCount: scenario.expect.length,
    views: scenario.views.length,
    createdAt: scenario.createdAt,
    runCount: runs.length,
    lastRun: last
      ? {
          model: last.model,
          createdAt: last.createdAt,
          ok: last.result.ok,
          ...(last.verdict ? { grade: last.verdict.grade } : {}),
          judged: last.judgement !== undefined,
          ...(last.judgement ? { passed: last.judgement.passed } : {}),
        }
      : null,
  };
}

/** Newest first; ids break ties, so runs made in the same second keep a stable order. */
function sortRuns(runs: BenchRun[]): BenchRun[] {
  return [...runs].sort((a, b) => compare(b.createdAt, a.createdAt) || compare(b.id, a.id));
}

function uniqueById(runs: BenchRun[]): BenchRun[] {
  const seen = new Set<string>();
  return runs.filter((run) => !seen.has(run.id) && seen.add(run.id));
}

function dropUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
