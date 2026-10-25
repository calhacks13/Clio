import {
  type EpisodeBatchInput,
  type EpisodeCreate,
  type EpisodeFinish,
  KEYFRAME_MEDIA,
} from '@clio/protocol';
import { type EpisodeSink, SinkError } from './sink';

// Delivery guarantees for one episode: create → batches and media files in the order they were
// handed over → finish, strictly one at a time, retrying transient failures with exponential
// backoff (the venue Wi-Fi will drop). A batch or file the server rejects as invalid is dropped
// and reported, so one bad upload can't stall the stream. Media go in the same queue, so a compile
// that starts on finish sees every file that made it.

export interface UploaderOptions {
  sleep?: (ms: number) => Promise<void>;
  onDrop?: (why: string) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Batches held while the server is unreachable; the oldest are dropped beyond this. */
  maxQueued?: number;
  /**
   * Media bytes held while the server is unreachable (default 24 MiB). Beyond this the oldest
   * queued keyframes are dropped; a room scan never is.
   */
  maxMediaBytes?: number;
}

type Op =
  | { kind: 'batch'; batch: EpisodeBatchInput }
  | { kind: 'media'; name: string; body: Blob }
  | { kind: 'finish'; finish: EpisodeFinish };

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A few room scans and every keyframe of an episode fit, with room to spare. */
export const MAX_MEDIA_BYTES = 24 * 1024 * 1024;

/** Keyframes are many and each can be spared; a room scan snapshot is the room. */
const spareable = (op: Op) => op.kind === 'media' && KEYFRAME_MEDIA.test(op.name);

export class EpisodeUploader {
  private readonly queue: Op[] = [];
  private id: string | null = null;
  private running: Promise<void> | null = null;
  private failed = false;
  private finishing = false;
  private inFlight: Op | null = null;
  private mediaBytes = 0;
  private readonly maxQueued: number;
  private readonly maxMediaBytes: number;
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
    this.maxMediaBytes = options.maxMediaBytes ?? MAX_MEDIA_BYTES;
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

  /** Bytes of the media files not yet delivered, the one being sent included. */
  get queuedMediaBytes(): number {
    return this.mediaBytes;
  }

  push(batch: EpisodeBatchInput): void {
    this.queue.push({ kind: 'batch', batch });
    this.trim();
    this.kick();
  }

  /** Enqueue a file for media/<name>, after everything handed over before it. */
  media(name: string, body: Blob): void {
    if (this.failed || this.finishing) {
      this.onDrop(`media ${name}: ${this.failed ? 'no episode' : 'episode already finished'}`);
      return;
    }
    this.queue.push({ kind: 'media', name, body });
    this.mediaBytes += body.size;
    this.trimMedia();
    this.kick();
  }

  /** Enqueue the finish and resolve once everything has been delivered (or dropped). */
  finish(finish: EpisodeFinish): Promise<void> {
    this.finishing = true;
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
          this.mediaBytes = 0;
          return;
        }
      }
      const op = this.queue[0];
      if (!op) break;
      this.inFlight = op;
      const id = this.id;
      try {
        await this.retrying(() => this.deliver(id, op));
      } catch (err) {
        this.onDrop(`${opName(op)}: ${errorMessage(err)}`);
      }
      this.inFlight = null;
      this.queue.shift();
      if (op.kind === 'media') this.mediaBytes -= op.body.size;
    }
  }

  private deliver(id: string, op: Op): Promise<void> {
    if (op.kind === 'batch') return this.sink.append(id, op.batch);
    if (op.kind === 'media') return this.sink.putMedia(id, op.name, op.body);
    return this.sink.finish(id, op.finish);
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

  /** The same for media bytes: the oldest queued keyframes go first, never one in flight. */
  private trimMedia(): void {
    while (this.mediaBytes > this.maxMediaBytes) {
      const i = this.queue.findIndex((op) => spareable(op) && op !== this.inFlight);
      const [op] = i >= 0 ? this.queue.splice(i, 1) : [];
      if (op?.kind !== 'media') break;
      this.mediaBytes -= op.body.size;
      this.onDrop(`media ${op.name}: upload queue full`);
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

function opName(op: Op): string {
  if (op.kind === 'batch') return `batch ${op.batch.seq}`;
  if (op.kind === 'media') return `media ${op.name}`;
  return 'finish';
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
