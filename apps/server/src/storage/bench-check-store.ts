import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type BenchCheckModelTally,
  type BenchCheckRun,
  BenchCheckRunSchema,
  type BenchCheckTest,
  type BenchCheckTestCreateSchema,
  type BenchCheckTestDetail,
  BenchCheckTestSchema,
  type BenchCheckTestSummary,
  type BenchCheckTestUpdateSchema,
  type ImagePayload,
} from '@clio/protocol';
import type { z } from 'zod';
import { isSafeId } from '../ids';
import { describeError, type Logger } from '../log';
import type { CheckTestFrames } from '../services/bench-checks';
import { goalIdCandidates, slugFromGoal } from '../services/plan-ids';
import { IMAGE_EXTENSIONS } from './bench-store';
import { isMissing, readJson, writeJsonAtomic } from './files';
import { KeyedMutex } from './keyed-mutex';

// The planner bench's watcher tests, one folder each, like its scenarios (bench-store.ts):
//   <dir>/checks/<id>/check.json      the step, its hints, the expected answer, the frame files
//   <dir>/checks/<id>/before-<n>.jpg  the views from when the step started
//   <dir>/checks/<id>/now-<n>.jpg     the views the watcher judged
//   <dir>/checks/<id>/runs/<run>.json one per answer, graded against the expectation
// Frames never change after a test is saved. Deleting one moves it to <dir>/deleted/check-<id>-….

export type BenchCheckTestCreateBody = z.output<typeof BenchCheckTestCreateSchema>;
export type BenchCheckTestUpdateBody = z.output<typeof BenchCheckTestUpdateSchema>;

/** Ids tried for one test; bounded so a full directory cannot spin forever. */
const MAX_ID_ATTEMPTS = 1000;

export interface BenchCheckStoreOptions {
  now?: () => Date;
  logger?: Logger;
}

export class BenchCheckStore {
  readonly #checksDir: string;
  readonly #deletedDir: string;
  readonly #now: () => Date;
  readonly #logger: Logger | undefined;
  readonly #mutex = new KeyedMutex();

  /** `dir` is the bench's folder (data/bench); tests live in its checks/ folder. */
  constructor(dir: string, options: BenchCheckStoreOptions = {}) {
    this.#checksDir = join(dir, 'checks');
    this.#deletedDir = join(dir, 'deleted');
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger;
  }

  /** Newest first. Folders without a valid check.json are logged and skipped. */
  async list(): Promise<BenchCheckTestSummary[]> {
    let ids: string[];
    try {
      ids = (await readdir(this.#checksDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && isSafeId(e.name))
        .map((e) => e.name);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const summaries: BenchCheckTestSummary[] = [];
    for (const id of ids) {
      const test = await this.#read(id);
      if (test) summaries.push(summarize(test, await this.#runs(id)));
    }
    return summaries.sort((a, b) => compare(b.createdAt, a.createdAt) || compare(a.id, b.id));
  }

  async get(id: string): Promise<BenchCheckTestDetail | null> {
    const test = await this.#read(id);
    return test && { test, runs: await this.#runs(id) };
  }

  async getTest(id: string): Promise<BenchCheckTest | null> {
    return this.#read(id);
  }

  /** Writes the frames first and check.json last, so a half-written folder is never listed. */
  async create(input: BenchCheckTestCreateBody): Promise<BenchCheckTestDetail> {
    await mkdir(this.#checksDir, { recursive: true });
    const id = await this.#claimId(input.title);
    const write = (prefix: string, images: readonly ImagePayload[]) =>
      Promise.all(
        images.map(async (image, i) => {
          const file = `${prefix}-${i + 1}.${IMAGE_EXTENSIONS[image.mimeType]}`;
          await writeFile(join(this.#checksDir, id, file), Buffer.from(image.data, 'base64'));
          return { file, mimeType: image.mimeType };
        }),
      );
    const [before, now] = await Promise.all([
      write('before', input.before ?? []),
      write('now', input.images),
    ]);
    const at = this.#now().toISOString();
    const test: BenchCheckTest = {
      id,
      title: input.title,
      expect: input.expect,
      goal: input.goal,
      step: input.step,
      objects: input.objects ?? [],
      confusions: input.confusions ?? [],
      before,
      now,
      ...(input.seen ? { seen: input.seen } : {}),
      ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
      createdAt: at,
      updatedAt: at,
    };
    await writeJsonAtomic(this.#testPath(id), test);
    return { test, runs: [] };
  }

  async update(id: string, patch: BenchCheckTestUpdateBody): Promise<BenchCheckTest | null> {
    return this.#mutex.run(id, async () => {
      const test = await this.#read(id);
      if (!test) return null;
      const { notes, ...rest } = patch;
      const next: BenchCheckTest = { ...test, ...dropUndefined(rest) };
      if (notes === null || notes?.trim() === '') delete next.notes;
      else if (notes !== undefined) next.notes = notes.trim();
      next.updatedAt = this.#now().toISOString();
      await writeJsonAtomic(this.#testPath(id), next);
      return next;
    });
  }

  /** Moves the folder to deleted/. Returns false when there is no such test. */
  async remove(id: string): Promise<boolean> {
    return this.#mutex.run(id, async () => {
      if (!(await this.#read(id))) return false;
      await mkdir(this.#deletedDir, { recursive: true });
      const stamp = this.#now().toISOString().replace(/[:.]/g, '-');
      await rename(join(this.#checksDir, id), join(this.#deletedDir, `check-${id}-${stamp}`));
      return true;
    });
  }

  /** One of the test's frames, by its file name as listed in check.json. */
  async readFrame(
    id: string,
    file: string,
  ): Promise<{ bytes: Buffer; mimeType: ImagePayload['mimeType'] } | null> {
    const test = await this.#read(id);
    const frame = test && [...test.before, ...test.now].find((f) => f.file === file);
    if (!frame || !isSafeId(frame.file)) return null;
    try {
      return {
        bytes: await readFile(join(this.#checksDir, id, frame.file)),
        mimeType: frame.mimeType,
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /** Every frame as an image payload, for the step check. */
  async readFrames(test: BenchCheckTest): Promise<CheckTestFrames> {
    const load = async (frames: BenchCheckTest['now']) => {
      const images: ImagePayload[] = [];
      for (const frame of frames) {
        const stored = await this.readFrame(test.id, frame.file);
        if (!stored) throw new Error(`Watcher test "${test.id}" is missing ${frame.file}`);
        images.push({ mimeType: stored.mimeType, data: stored.bytes.toString('base64') });
      }
      return images;
    };
    return { before: await load(test.before), now: await load(test.now) };
  }

  /** Returns false when there is no such test. */
  async addRun(id: string, run: BenchCheckRun): Promise<boolean> {
    return this.#mutex.run(id, async () => {
      if (!(await this.#read(id))) return false;
      if (!isSafeId(run.id)) throw new Error(`Invalid run id "${run.id}"`);
      await mkdir(this.#runsDir(id), { recursive: true });
      await writeJsonAtomic(join(this.#runsDir(id), `${run.id}.json`), run);
      return true;
    });
  }

  async #claimId(title: string): Promise<string> {
    let attempts = 0;
    for (const id of goalIdCandidates(slugFromGoal(title))) {
      if (++attempts > MAX_ID_ATTEMPTS) break;
      try {
        await mkdir(join(this.#checksDir, id));
        return id;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new Error(`No free watcher test id for "${title}"`);
  }

  async #read(id: string): Promise<BenchCheckTest | null> {
    if (!isSafeId(id)) return null;
    let raw: unknown;
    try {
      raw = await readJson(this.#testPath(id));
    } catch (error) {
      this.#logger?.warn(`Skipping watcher test ${id}: ${describeError(error)}`);
      return null;
    }
    if (raw === undefined) return null;
    const parsed = BenchCheckTestSchema.safeParse(raw);
    if (!parsed.success) {
      this.#logger?.warn(`Skipping invalid watcher test ${id}: ${parsed.error.message}`);
      return null;
    }
    return parsed.data;
  }

  async #runs(id: string): Promise<BenchCheckRun[]> {
    let files: string[];
    try {
      files = (await readdir(this.#runsDir(id))).filter(
        (f) => f.endsWith('.json') && !f.startsWith('.'),
      );
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const runs: BenchCheckRun[] = [];
    for (const file of files) {
      const path = join(this.#runsDir(id), file);
      try {
        const parsed = BenchCheckRunSchema.safeParse(await readJson(path));
        if (parsed.success) runs.push(parsed.data);
        else
          this.#logger?.warn(`Skipping invalid watcher test run ${path}: ${parsed.error.message}`);
      } catch (error) {
        this.#logger?.warn(`Skipping watcher test run ${path}: ${describeError(error)}`);
      }
    }
    // Newest first; ids break ties, so runs made in the same second keep a stable order.
    return runs.sort((a, b) => compare(b.createdAt, a.createdAt) || compare(b.id, a.id));
  }

  #testPath(id: string): string {
    return join(this.#checksDir, id, 'check.json');
  }

  #runsDir(id: string): string {
    return join(this.#checksDir, id, 'runs');
  }
}

function summarize(test: BenchCheckTest, runs: BenchCheckRun[]): BenchCheckTestSummary {
  const last = runs[0];
  return {
    id: test.id,
    title: test.title,
    goal: test.goal,
    instruction: test.step.instruction,
    expect: test.expect,
    thumb: test.now.at(-1)?.file ?? '',
    hasBefore: test.before.length > 0,
    createdAt: test.createdAt,
    runCount: runs.length,
    models: tallyByModel(runs),
    lastRun: last
      ? {
          model: last.model,
          createdAt: last.createdAt,
          passed: last.passed,
          ...(last.result.ok ? { verdict: last.result.answer.verdict } : {}),
        }
      : null,
  };
}

/** Runs and passes per model, most runs first. */
export function tallyByModel(runs: readonly BenchCheckRun[]): BenchCheckModelTally[] {
  const tallies = new Map<string, BenchCheckModelTally>();
  for (const run of runs) {
    const t = tallies.get(run.model) ?? { model: run.model, runs: 0, passed: 0 };
    t.runs++;
    if (run.passed) t.passed++;
    tallies.set(run.model, t);
  }
  return [...tallies.values()].sort((a, b) => b.runs - a.runs || compare(a.model, b.model));
}

function dropUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
