import { type ChildProcess, spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isSafeId } from '../ids';
import { describeError, type Logger } from '../log';
import { isMissing } from '../storage/files';

// Compiles episodes in the background with the pipeline's `clio compile`, which reads
// data/episodes/<id>/ and writes data/derived/<id>/ (docs/data-pipeline.md). The server asks for a
// compile when an episode finishes and never waits for it: the finish reply goes out first.

/** idle: nothing waiting or running for that episode. */
export type CompileJobState = 'idle' | 'queued' | 'running';

export interface CompileRequest {
  /** Compile even when the compile on disk is up to date. Otherwise the run passes `--if-stale`. */
  force?: boolean;
}

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
  logger?: Logger;
}

export const DEFAULT_COMPILE_FPS = 30;
/** Generous: a long episode solves IK for every grid frame, and the first `uv run` also syncs. */
export const DEFAULT_COMPILE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_KILL_GRACE_MS = 5000;
/** Output kept per run: enough for the end of a Python traceback. */
const TAIL_BYTES = 4096;

interface Job {
  id: string;
  /** Runs without `--if-stale`. */
  force: boolean;
  /** Queued by the sweep: runs after every requested compile. */
  swept: boolean;
}
type RunResult = { ok: true; upToDate: boolean } | { ok: false; error: string };

/**
 * `clio compile` as a child process (no shell), one episode per run. One run at a time: requested
 * compiles in the order asked for, then the sweep's. Asking for an episode that is already waiting
 * does nothing; asking for the one that is running queues one rerun behind it, because the raw
 * files it read may have changed since it started.
 */
export class ProcessEpisodeCompiler implements EpisodeCompiler {
  readonly #program: string;
  readonly #args: readonly string[];
  readonly #episodesDir: string;
  readonly #derivedDir: string;
  readonly #fps: number;
  readonly #profiles: readonly string[];
  readonly #timeoutMs: number;
  readonly #killGraceMs: number;
  readonly #logger: Logger | undefined;

  readonly #queue: Job[] = [];
  /** The waiting job of each episode in #queue. */
  readonly #queued = new Map<string, Job>();
  readonly #errors = new Map<string, string>();
  #sweeping: Promise<void> | null = null;
  #running: Job | null = null;
  #child: ChildProcess | null = null;
  #idleWaiters: (() => void)[] = [];
  #closed = false;

  constructor(options: ProcessCompilerOptions) {
    const [program, ...args] = options.command;
    if (!program) throw new Error('The compile command is empty');
    this.#program = program;
    this.#args = args;
    this.#episodesDir = options.episodesDir;
    this.#derivedDir = options.derivedDir;
    this.#fps = options.fps ?? DEFAULT_COMPILE_FPS;
    this.#profiles = options.retargetProfiles ?? [];
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_COMPILE_TIMEOUT_MS;
    this.#killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.#logger = options.logger;
  }

  enqueue(id: string, request: CompileRequest = {}): void {
    if (!isSafeId(id)) throw new Error(`Unsafe episode id: ${id}`);
    this.#add({ id, force: request.force ?? false, swept: false });
  }

  state(id: string): CompileJobState {
    if (this.#running?.id === id) return 'running';
    return this.#queued.has(id) ? 'queued' : 'idle';
  }

  lastError(id: string): string | null {
    return this.#errors.get(id) ?? null;
  }

  sweep(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#sweeping ??= finishedEpisodes(this.#episodesDir)
      .then(
        (ids) => {
          if (this.#closed || ids.length === 0) return;
          for (const id of ids) this.#add({ id, force: false, swept: true });
          this.#logger?.info(`Compile sweep: checking ${ids.length} finished episodes`);
        },
        (error) => {
          this.#logger?.warn(`Compile sweep could not list the episodes: ${describeError(error)}`);
        },
      )
      .finally(() => {
        this.#sweeping = null;
      });
    return this.#sweeping;
  }

  /** Resolves once nothing is waiting or running. */
  idle(): Promise<void> {
    if (!this.#running && this.#queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  /** Server shutdown: drops what is waiting and stops the running compile. */
  close(): void {
    this.#closed = true;
    this.#queue.splice(0);
    this.#queued.clear();
    if (this.#child) signalGroup(this.#child, 'SIGTERM');
  }

  #add(job: Job): void {
    if (this.#closed) return;
    const waiting = this.#queued.get(job.id);
    if (waiting) {
      waiting.force ||= job.force;
      if (waiting.swept && !job.swept) {
        // Asked for now: it leaves the sweep's backlog and waits with the other requests.
        waiting.swept = false;
        this.#queue.splice(this.#queue.indexOf(waiting), 1);
        this.#queue.push(waiting);
      }
      return;
    }
    // The sweep only catches up on what finished while the server was down. A running compile
    // already reads the current files, and whatever changes them asks for a compile of its own.
    if (job.swept && this.#running?.id === job.id) return;
    this.#queued.set(job.id, job);
    this.#queue.push(job);
    this.#next();
  }

  #next(): void {
    if (this.#running) return;
    const requested = this.#queue.findIndex((job) => !job.swept);
    const [job] = this.#queue.splice(Math.max(requested, 0), 1);
    if (!job) {
      for (const resolve of this.#idleWaiters.splice(0)) resolve();
      return;
    }
    this.#running = job;
    this.#queued.delete(job.id);
    void this.#run(job)
      .catch((error) => this.#logger?.error('Compile queue failed', error))
      .finally(() => {
        this.#running = null;
        this.#child = null;
        this.#next();
      });
  }

  async #run(job: Job): Promise<void> {
    const started = performance.now();
    const result = await this.#spawn(this.#compileArgs(job));
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    if (result.ok) {
      this.#errors.delete(job.id);
      // Up to date is the usual outcome of a sweep: one line per episode would be noise.
      if (!result.upToDate) this.#logger?.info(`Compile of ${job.id} finished in ${seconds}s`);
    } else {
      this.#errors.set(job.id, result.error);
      this.#logger?.warn(
        `Compile of ${job.id} failed after ${seconds}s: ${lastLine(result.error)}`,
      );
    }
  }

  #compileArgs(job: Job): string[] {
    const profiles = this.#profiles.flatMap((profile) => ['--retarget', profile]);
    return [
      ...this.#args,
      'compile',
      join(this.#episodesDir, job.id),
      '--out',
      this.#derivedDir,
      '--fps',
      String(this.#fps),
      ...profiles,
      ...(job.force ? [] : ['--if-stale']),
      '--json',
    ];
  }

  #spawn(args: string[]): Promise<RunResult> {
    const failedToStart = (error: unknown): RunResult => ({
      ok: false,
      error: `Could not start ${this.#program}: ${describeError(error)}`,
    });
    let child: ChildProcess;
    try {
      // Its own process group, so a timeout or shutdown also stops what it started (uv runs Python
      // as a child of its own).
      child = spawn(this.#program, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      return Promise.resolve(failedToStart(error));
    }
    this.#child = child;
    const stdout = new Tail();
    const stderr = new Tail();
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    return new Promise((resolve) => {
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        signalGroup(child, 'SIGTERM');
        killTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), this.#killGraceMs);
      }, this.#timeoutMs);
      let settled = false;
      const settle = (result: RunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        resolve(result);
      };
      child.on('error', (error) => {
        // Also emitted when a signal cannot be sent; only a failed start ends the run.
        if (child.pid === undefined) settle(failedToStart(error));
      });
      child.on('close', (code, signal) => {
        if (timedOut) {
          settle({ ok: false, error: `Timed out after ${this.#timeoutMs / 1000} s` });
        } else if (code === 0) {
          settle({ ok: true, upToDate: reportsUpToDate(stdout.text()) });
        } else {
          const exit = code === null ? `signal ${signal}` : `code ${code}`;
          settle({ ok: false, error: stderr.text() || stdout.text() || `Exited with ${exit}` });
        }
      });
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

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Whether `clio compile --json` reported the compile as already up to date (`--if-stale`). */
function reportsUpToDate(stdout: string): boolean {
  try {
    return (JSON.parse(lastLine(stdout)) as { skipped?: unknown } | null)?.skipped === true;
  } catch {
    return false;
  }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is gone, or this platform has no process groups.
    child.kill(signal);
  }
}

function lastLine(text: string): string {
  return text.trim().split('\n').at(-1)?.trim() ?? '';
}

/** The last TAIL_BYTES of a stream; when older output was dropped, its cut first line goes too. */
class Tail {
  #bytes = Buffer.alloc(0);
  #cut = false;

  push(chunk: Buffer): void {
    const joined = Buffer.concat([this.#bytes, chunk]);
    if (joined.length <= TAIL_BYTES) {
      this.#bytes = joined;
      return;
    }
    this.#cut = true;
    this.#bytes = Buffer.from(joined.subarray(joined.length - TAIL_BYTES));
  }

  text(): string {
    const text = this.#bytes.toString('utf8');
    return (this.#cut ? text.slice(text.indexOf('\n') + 1) : text).trim();
  }
}
