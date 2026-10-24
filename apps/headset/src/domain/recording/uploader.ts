import type { EpisodeBatchInput, EpisodeCreate, EpisodeFinish } from '@clio/protocol';
import { type EpisodeSink, SinkError } from './sink';

// Delivery guarantees for one episode: create → batches in seq order → finish, strictly one at a
// time, retrying transient failures with exponential backoff (the venue Wi-Fi will drop). A batch
// the server rejects as invalid is dropped and reported, so one bad batch can't stall the stream.

export interface UploaderOptions {
  sleep?: (ms: number) => Promise<void>;
  onDrop?: (why: string) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Batches held while the server is unreachable; the oldest are dropped beyond this. */
  maxQueued?: number;
}

type Op = { kind: 'batch'; batch: EpisodeBatchInput } | { kind: 'finish'; finish: EpisodeFinish };

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class EpisodeUploader {
  private readonly queue: Op[] = [];
  private id: string | null = null;
  private running: Promise<void> | null = null;
  private failed = false;
  private inFlight: Op | null = null;
  private readonly maxQueued: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onDrop: (why: string) => void;
  private readonly baseDelay: number;
  private readonly maxDelay: number;

  constructor(
    private readonly sink: EpisodeSink,
    private readonly meta: EpisodeCreate,
    options: UploaderOptions = {},
  ) {
    this.sleep = options.sleep ?? realSleep;
    this.onDrop = options.onDrop ?? ((why) => console.warn(`[uploader] dropped ${why}`));
    this.baseDelay = options.baseDelayMs ?? 500;
    this.maxDelay = options.maxDelayMs ?? 8000;
    this.maxQueued = options.maxQueued ?? 300;
    // Create the episode right away, so the server knows a session started before the first batch.
    void this.kick();
  }

  get episodeId(): string | null {
    return this.id;
  }

  /** Operations not yet delivered. */
  get queued(): number {
    return this.queue.length;
  }

  push(batch: EpisodeBatchInput): void {
    this.queue.push({ kind: 'batch', batch });
    this.trim();
    this.kick();
  }

  /** Enqueue the finish and resolve once everything has been delivered (or dropped). */
  finish(finish: EpisodeFinish): Promise<void> {
    this.queue.push({ kind: 'finish', finish });
    return this.kick();
  }

  private kick(): Promise<void> {
    if (!this.running) {
      this.running = this.drain().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async drain(): Promise<void> {
    while (!this.failed && (!this.id || this.queue.length > 0)) {
      if (!this.id) {
        try {
          this.id = await this.retrying(() => this.sink.create(this.meta));
        } catch (err) {
          this.failed = true;
          this.onDrop(`episode create: ${errorMessage(err)}`);
          this.queue.length = 0;
          return;
        }
      }
      const op = this.queue[0];
      if (!op) break;
      this.inFlight = op;
      const id = this.id;
      try {
        if (op.kind === 'batch') await this.retrying(() => this.sink.append(id, op.batch));
        else await this.retrying(() => this.sink.finish(id, op.finish));
      } catch (err) {
        this.onDrop(
          `${op.kind === 'batch' ? `batch ${op.batch.seq}` : 'finish'}: ${errorMessage(err)}`,
        );
      }
      this.inFlight = null;
      this.queue.shift();
    }
  }

  /** Keep memory bounded during long outages: drop the oldest queued batches, never in-flight. */
  private trim(): void {
    let batches = this.queue.filter((op) => op.kind === 'batch').length;
    while (batches > this.maxQueued) {
      const i = this.queue.findIndex((op) => op.kind === 'batch' && op !== this.inFlight);
      const [op] = i >= 0 ? this.queue.splice(i, 1) : [];
      if (op?.kind !== 'batch') break;
      this.onDrop(`batch ${op.batch.seq}: upload queue full`);
      batches--;
    }
  }

  /** Retries retriable failures forever with backoff; rethrows non-retriable ones. */
  private async retrying<T>(fn: () => Promise<T>): Promise<T> {
    let delay = this.baseDelay;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof SinkError && !err.retriable) throw err;
        await this.sleep(delay);
        delay = Math.min(delay * 2, this.maxDelay);
      }
    }
  }
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
