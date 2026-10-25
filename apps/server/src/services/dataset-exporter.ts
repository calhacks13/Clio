import { randomUUID } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatasetExportRequest, DatasetExportStatus } from '@clio/protocol';
import { ApiError } from '../errors';
import type { Logger } from '../log';
import { EpisodeJobQueue, lastLine } from './process-queue';

export interface DatasetExporter {
  create(request: DatasetExportRequest): DatasetExportStatus;
  status(id: string): DatasetExportStatus | null;
  archive(id: string): string | null;
}

interface Job {
  request: DatasetExportRequest;
  ready: boolean;
  finishedAt: number | null;
}

const RETAIN_MS = 60 * 60_000;
const EXPORT_ID = /^export-[0-9a-f-]{36}$/;

/** One local Python export at a time; finished archives expire after an hour. */
export class ProcessDatasetExporter implements DatasetExporter {
  readonly #jobs = new Map<string, Job>();
  readonly #queue: EpisodeJobQueue;
  readonly #directory: string;
  readonly #cleanup: NodeJS.Timeout;
  #pruning = false;
  #closed = false;

  constructor(options: {
    command: readonly string[];
    episodesDir: string;
    exportDir: string;
    logger?: Logger;
    timeoutMs?: number;
  }) {
    this.#directory = options.exportDir;
    this.#queue = new EpisodeJobQueue({
      label: 'Dataset export',
      command: options.command,
      args: (id) => {
        const request = this.#jobs.get(id)?.request;
        if (!request) throw new Error(`Unknown dataset export ${id}`);
        return [
          'export-lerobot',
          ...request.episodeIds.map((ep) => join(options.episodesDir, ep)),
          '--out',
          join(this.#directory, id, 'dataset'),
          '--repo-id',
          `local/${request.name}`,
          '--fps',
          String(request.fps),
          '--archive',
          join(this.#directory, id, 'dataset.zip'),
        ];
      },
      sweep: { list: async () => [], what: 'datasets' },
      upToDate: () => false,
      onSuccess: (id) => {
        const job = this.#jobs.get(id);
        if (!job) throw new Error(`Unknown dataset export ${id}`);
        job.ready = true;
        job.finishedAt = Date.now();
        // Only the ZIP is needed once packaging completes.
        void rm(join(this.#directory, id, 'dataset'), { recursive: true, force: true }).catch(
          (error) => options.logger?.warn(`Export cleanup failed: ${error}`),
        );
      },
      timeoutMs: options.timeoutMs ?? 30 * 60_000,
      logger: options.logger,
    });
    this.#cleanup = setInterval(() => void this.prune(), 60_000);
    this.#cleanup.unref();
    void this.prune();
  }

  create(request: DatasetExportRequest): DatasetExportStatus {
    if (this.#closed) throw new ApiError(503, 'export_unavailable', 'The server is shutting down');
    if (
      this.#jobs.size >= 20 ||
      [...this.#jobs.keys()].filter((id) => this.#queue.state(id) !== 'idle').length >= 4
    ) {
      throw new ApiError(429, 'export_busy', 'Too many dataset exports. Try again later.');
    }
    const id = `export-${randomUUID()}`;
    this.#jobs.set(id, { request, ready: false, finishedAt: null });
    this.#queue.enqueue(id);
    const status = this.status(id);
    if (!status) throw new Error(`Could not start dataset export ${id}`);
    return status;
  }

  status(id: string): DatasetExportStatus | null {
    const job = this.#jobs.get(id);
    if (!job) return null;
    const error = this.#queue.lastError(id);
    const state = error ? 'failed' : job.ready ? 'ready' : this.#queue.state(id);
    if (error) job.finishedAt ??= Date.now();
    if (job.finishedAt !== null && Date.now() - job.finishedAt >= RETAIN_MS) return null;
    return {
      id,
      name: job.request.name,
      episodeCount: job.request.episodeIds.length,
      fps: job.request.fps,
      state: state === 'idle' ? 'failed' : state,
      error: error ? exportError(error) : null,
    };
  }

  archive(id: string): string | null {
    return this.status(id)?.state === 'ready' ? join(this.#directory, id, 'dataset.zip') : null;
  }

  idle(): Promise<void> {
    return this.#queue.idle();
  }

  close(): void {
    this.#closed = true;
    clearInterval(this.#cleanup);
    this.#queue.close();
  }

  /** Also removes expired directories left by a previous server process. */
  async prune(): Promise<void> {
    if (this.#pruning) return;
    this.#pruning = true;
    try {
      for (const id of this.#jobs.keys()) {
        if (!this.status(id)) {
          await rm(join(this.#directory, id), { recursive: true, force: true });
          this.#jobs.delete(id);
        }
      }
      const entries = await readdir(this.#directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !EXPORT_ID.test(entry.name)) continue;
        const job = this.#jobs.get(entry.name);
        if (job && job.finishedAt === null) continue;
        const dir = join(this.#directory, entry.name);
        const finishedAt = job?.finishedAt ?? (await stat(dir)).mtimeMs;
        if (Date.now() - finishedAt < RETAIN_MS) continue;
        await rm(dir, { recursive: true, force: true });
        this.#jobs.delete(entry.name);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A cleanup failure must never interrupt recording or exporting.
        return;
      }
    } finally {
      this.#pruning = false;
    }
  }
}

/** Keep the first validation issue, rather than the trailing "... and N more" summary. */
export function exportError(output: string): string {
  const lines = output
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const validation = lines.findIndex((line) => line.includes('is not a valid Clio episode:'));
  if (validation >= 0 && lines[validation + 1]) {
    return `Recording validation failed: ${lines[validation + 1]}`;
  }
  return lastLine(output);
}
