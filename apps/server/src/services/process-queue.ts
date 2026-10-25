import { type ChildProcess, spawn } from 'node:child_process';
import { isSafeId } from '../ids';
import { describeError, type Logger } from '../log';

// Runs a pipeline command for one episode at a time, in the background. The compiler
// (`clio compile`) and the scene builder (`clio scene`) each own a queue, so a slow scene build
// never holds up the next compile. The server never waits for either.

/** idle: nothing waiting or running for that episode. */
export type EpisodeJobState = 'idle' | 'queued' | 'running';

export interface EpisodeJobRequest {
  /** Run even when the output on disk is up to date. Otherwise the run passes `--if-stale`. */
  force?: boolean;
  /**
   * Catching up rather than asked for, like the sweep's runs: it waits behind every request, and
   * is dropped while that episode is running, since that run already reads the current files.
   */
  background?: boolean;
}

export interface EpisodeJobQueueOptions {
  /** Starts every log line about a run, e.g. "Compile" or "Scene build". */
  label: string;
  /** The pipeline CLI, e.g. ['uv', 'run', '--frozen', '--project', '<repo>/pipeline', 'clio']. */
  command: readonly string[];
  /** One run's arguments after `command`. `force` leaves out `--if-stale`. */
  args(id: string, force: boolean): string[];
  /** The episodes a sweep checks, oldest first, and what its log line calls them. */
  sweep: { list(): Promise<string[]>; what: string };
  /**
   * Whether a run that exited 0 only found its output up to date, given its stdout and when it
   * started (epoch ms). Such runs are not logged: they are the usual outcome of a sweep.
   */
  upToDate(run: { id: string; stdout: string; startedAt: number }): boolean | Promise<boolean>;
  timeoutMs: number;
  /** How long a timed-out run gets to exit after SIGTERM before it is killed. */
  killGraceMs?: number;
  /** After each run that exited 0. `background`: it was the sweep's, or asked for as background. */
  onSuccess?(id: string, job: { background: boolean }): void;
  logger?: Logger;
}

const DEFAULT_KILL_GRACE_MS = 5000;
/** Output kept per run: enough for the end of a Python traceback. */
const TAIL_BYTES = 4096;

interface Job {
  id: string;
  /** Runs without `--if-stale`. */
  force: boolean;
  /** Queued by the sweep or as background: runs after every requested one. */
  swept: boolean;
}
type RunResult = { ok: true; stdout: string } | { ok: false; error: string };

/**
 * The command as a child process (no shell), one episode per run. One run at a time: requested
 * runs in the order asked for, then the sweep's. Asking for an episode that is already waiting
 * does nothing; asking for the one that is running queues one rerun behind it, because the files
 * it read may have changed since it started.
 */
export class EpisodeJobQueue {
  readonly #label: string;
  readonly #program: string;
  readonly #commandArgs: readonly string[];
  readonly #args: EpisodeJobQueueOptions['args'];
  readonly #sweepList: () => Promise<string[]>;
  readonly #sweepWhat: string;
  readonly #upToDate: EpisodeJobQueueOptions['upToDate'];
  readonly #onSuccess: EpisodeJobQueueOptions['onSuccess'];
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

  constructor(options: EpisodeJobQueueOptions) {
    const [program, ...args] = options.command;
    if (!program) throw new Error(`The ${options.label.toLowerCase()} command is empty`);
    this.#label = options.label;
    this.#program = program;
    this.#commandArgs = args;
    this.#args = options.args;
    this.#sweepList = options.sweep.list;
    this.#sweepWhat = options.sweep.what;
    this.#upToDate = options.upToDate;
    this.#onSuccess = options.onSuccess;
    this.#timeoutMs = options.timeoutMs;
    this.#killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.#logger = options.logger;
  }

  /**
   * Asks for a run for one episode and returns at once. Asking again while it waits does nothing,
   * except that a forced request makes the waiting run forced, and a request moves a background
   * one up.
   */
  enqueue(id: string, request: EpisodeJobRequest = {}): void {
    if (!isSafeId(id)) throw new Error(`Unsafe episode id: ${id}`);
    this.#add({ id, force: request.force ?? false, swept: request.background ?? false });
  }

  state(id: string): EpisodeJobState {
    if (this.#running?.id === id) return 'running';
    return this.#queued.has(id) ? 'queued' : 'idle';
  }

  /** Why the last run for this episode failed; null before any run and after a success. */
  lastError(id: string): string | null {
    return this.#errors.get(id) ?? null;
  }

  /**
   * Queues an `--if-stale` run for every episode the sweep lists, each as its own run behind the
   * requested ones. Resolves once they are queued, not when they have run; never rejects.
   */
  sweep(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#sweeping ??= this.#sweepList()
      .then(
        (ids) => {
          if (this.#closed || ids.length === 0) return;
          for (const id of ids) this.#add({ id, force: false, swept: true });
          this.#logger?.info(`${this.#label} sweep: checking ${ids.length} ${this.#sweepWhat}`);
        },
        (error) => {
          this.#logger?.warn(
            `${this.#label} sweep could not list the episodes: ${describeError(error)}`,
          );
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

  /** Server shutdown: drops what is waiting and stops the running command. */
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
    // The sweep only catches up on what changed while the server was down. A running command
    // already reads the current files, and whatever changes them asks for a run of its own.
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
      .catch((error) => this.#logger?.error(`${this.#label} queue failed`, error))
      .finally(() => {
        this.#running = null;
        this.#child = null;
        this.#next();
      });
  }

  async #run(job: Job): Promise<void> {
    const started = performance.now();
    const startedAt = Date.now();
    const result = await this.#spawn([...this.#commandArgs, ...this.#args(job.id, job.force)]);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    if (result.ok) {
      this.#errors.delete(job.id);
      const upToDate = await this.#upToDate({ id: job.id, stdout: result.stdout, startedAt });
      if (!upToDate) this.#logger?.info(`${this.#label} of ${job.id} finished in ${seconds}s`);
      this.#onSuccess?.(job.id, { background: job.swept });
    } else {
      this.#errors.set(job.id, result.error);
      this.#logger?.warn(
        `${this.#label} of ${job.id} failed after ${seconds}s: ${lastLine(result.error)}`,
      );
    }
  }

  #spawn(args: string[]): Promise<RunResult> {
    const failedToStart = (error: unknown): RunResult => ({
      ok: false,
      error: `Could not start ${this.#program}: ${describeError(error)}`,
    });
    let child: ChildProcess;
    try {
      // Its own process group, so a timeout or shutdown also stops what it started (uv runs Python
      // as a child of its own). It inherits the server's environment, keys and tool paths included.
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
          settle({ ok: true, stdout: stdout.text() });
        } else {
          const exit = code === null ? `signal ${signal}` : `code ${code}`;
          settle({ ok: false, error: stderr.text() || stdout.text() || `Exited with ${exit}` });
        }
      });
    });
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

export function lastLine(text: string): string {
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
