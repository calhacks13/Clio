import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isSafeId } from '../ids';
import type { Logger } from '../log';
import { isFile, isMissing } from '../storage/files';
import {
  EpisodeJobQueue,
  type EpisodeJobRequest,
  type EpisodeJobState,
  lastLine,
} from './process-queue';

// Compiles episodes in the background with the pipeline's `clio compile`, which reads
// data/episodes/<id>/ and writes data/derived/<id>/ (docs/data-pipeline.md). The server asks for a
// compile when an episode finishes and never waits for it: the finish reply goes out first.

/** idle: nothing waiting or running for that episode. */
export type CompileJobState = EpisodeJobState;

/** `force`: compile even when the compile on disk is up to date (no `--if-stale`). */
export type CompileRequest = EpisodeJobRequest;

/** Port: background compiles. null when compiling is off (CLIO_COMPILE=off, or uv is missing). */
export interface EpisodeCompiler {
  /**
   * Asks for a compile of one episode and returns at once. Asking again while it waits does nothing,
   * except that a forced request makes the waiting compile forced.
   */
  enqueue(id: string, request?: CompileRequest): void;
  state(id: string): CompileJobState;
  /** Why the last compile of this episode failed; null before any run and after a success. */
  lastError(id: string): string | null;
  /**
   * Queues an `--if-stale` compile of every finished episode, each as its own run behind the
   * requested ones. Resolves once they are queued, not when they have run; never rejects.
   */
  sweep(): Promise<void>;
}

export interface ProcessCompilerOptions {
  /** The pipeline CLI, e.g. ['uv', 'run', '--frozen', '--project', '<repo>/pipeline', 'clio']. */
  command: readonly string[];
  /** Absolute: data/episodes. */
  episodesDir: string;
  /** Absolute: data/derived. The compiler writes each episode to <derivedDir>/<id>/. */
  derivedDir: string;
  fps?: number;
  /** Robot profile files, each passed as `--retarget <file>`. */
  retargetProfiles?: readonly string[];
  timeoutMs?: number;
  /** How long a timed-out compile gets to exit after SIGTERM before it is killed. */
  killGraceMs?: number;
  /**
   * After each run that leaves an ok compile on disk: it compiled, or found the compile up to
   * date. `background`: the run was the sweep's. The scene builder hooks in here.
   */
  onCompiled?(id: string, run: { background: boolean }): void;
  logger?: Logger;
}

export const DEFAULT_COMPILE_FPS = 30;
/** Generous: a long episode solves IK for every grid frame, and the first `uv run` also syncs. */
export const DEFAULT_COMPILE_TIMEOUT_MS = 10 * 60_000;

/** `clio compile` as a child process, one episode per run, on its own queue (EpisodeJobQueue). */
export class ProcessEpisodeCompiler extends EpisodeJobQueue implements EpisodeCompiler {
  constructor(options: ProcessCompilerOptions) {
    const fps = String(options.fps ?? DEFAULT_COMPILE_FPS);
    const profiles = (options.retargetProfiles ?? []).flatMap((profile) => ['--retarget', profile]);
    super({
      label: 'Compile',
      command: options.command,
      args: (id, force) => [
        'compile',
        join(options.episodesDir, id),
        '--out',
        options.derivedDir,
        '--fps',
        fps,
        ...profiles,
        ...(force ? [] : ['--if-stale']),
        '--json',
      ],
      sweep: { list: () => finishedEpisodes(options.episodesDir), what: 'finished episodes' },
      upToDate: ({ stdout }) => reportsUpToDate(stdout),
      timeoutMs: options.timeoutMs ?? DEFAULT_COMPILE_TIMEOUT_MS,
      killGraceMs: options.killGraceMs,
      onSuccess: options.onCompiled,
      logger: options.logger,
    });
  }
}

/**
 * The ids of the finished episodes in `dir` (a dir with meta.json and finish.json), sorted, so
 * oldest first. None when `dir` does not exist yet, as on a fresh install.
 */
async function finishedEpisodes(dir: string): Promise<string[]> {
  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory() && isSafeId(e.name)).map((e) => e.name);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const finished = await Promise.all(
    names.map(
      async (id) =>
        (await isFile(join(dir, id, 'meta.json'))) && isFile(join(dir, id, 'finish.json')),
    ),
  );
  return names.filter((_, i) => finished[i]).sort();
}

/** Whether `clio compile --json` reported the compile as already up to date (`--if-stale`). */
function reportsUpToDate(stdout: string): boolean {
  try {
    return (JSON.parse(lastLine(stdout)) as { skipped?: unknown } | null)?.skipped === true;
  } catch {
    return false;
  }
}
