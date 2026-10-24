import type { PrimaryResponse } from '@clio/protocol';
import type { ClearMessage, TargetMessage } from '../adapters/net/tracker-client';
import type { PrimaryAnswer } from './answer';

// The demo's naming loop: look at the scene and ask the server for the main object (a Gemini pick
// and a paid jev box) about once a second, each look starting PERIOD_MS after the last one
// started, or as soon as it ends if it took longer. Never two requests at once. The tracker
// follows the object between looks (trackerUpdate). An answer that arrives after the loop has
// moved on (it was stopped, or it gave up waiting) is dropped, so it can't replace a newer one.

export interface PrimaryLoopOptions {
  /** Time from the start of one look to the start of the next (ms). */
  periodMs?: number;
  /** Wait after a failed look (network or server error) before the next (ms). */
  retryMs?: number;
  /**
   * Give up on a request after this long (ms). Well past the server's own finder timeout, so it
   * only catches a hung connection: the server may still be working (and paying) for it.
   */
  timeoutMs?: number;
}

export interface PrimaryLoopDeps<A extends { response: PrimaryResponse }> {
  /**
   * One look: capture a frame and ask about it, naming the last object named. Null when there
   * was nothing to ask about yet (no camera frame or head pose).
   */
  ask(previous: string | null, signal: AbortSignal): Promise<A | null>;
  /** The answer to the latest request, and how long the look took (ms). */
  answer(answer: A, cycleMs: number): void;
  /** A look that failed. The loop carries on after retryMs. */
  failed?(err: unknown): void;
  /** performance.now() timeline. */
  now(): number;
  options?: PrimaryLoopOptions;
}

export const DEFAULT_PERIOD_MS = 1000;
const DEFAULT_RETRY_MS = 3000;
const DEFAULT_TIMEOUT_MS = 30_000;

interface InFlight {
  seq: number;
  startT: number;
  controller: AbortController;
}

export class PrimaryLoop<A extends { response: PrimaryResponse }> {
  private running = false;
  /** Bumped by every request and every abandon, so only the latest request's answer is used. */
  private seq = 0;
  private inFlight: InFlight | null = null;
  private nextT = Number.NEGATIVE_INFINITY;
  private previous: string | null = null;

  constructor(private readonly deps: PrimaryLoopDeps<A>) {}

  get busy(): boolean {
    return this.inFlight !== null;
  }

  start(): void {
    this.running = true;
    this.nextT = this.deps.now();
  }

  /** Stop looking; the answer to a request still in flight is dropped. */
  stop(): void {
    this.running = false;
    this.abandon();
    this.previous = null;
  }

  /** Per frame: start the next look when it is due. */
  tick(): void {
    if (!this.running) return;
    const now = this.deps.now();
    if (this.inFlight) {
      if (now - this.inFlight.startT < this.timeoutMs) return;
      this.abandon();
      this.deps.failed?.(new Error(`No answer within ${this.timeoutMs / 1000} s`));
      this.nextT = now + this.retryMs;
    }
    if (now < this.nextT) return;
    void this.look(now);
  }

  private async look(startT: number): Promise<void> {
    const seq = ++this.seq;
    const controller = new AbortController();
    this.inFlight = { seq, startT, controller };
    let answer: A | null = null;
    let failure: { err: unknown } | null = null;
    try {
      answer = await this.deps.ask(this.previous, controller.signal);
    } catch (err) {
      failure = { err };
    }
    if (seq !== this.seq) return;
    this.inFlight = null;
    const now = this.deps.now();
    if (failure) {
      this.nextT = now + this.retryMs;
      this.deps.failed?.(failure.err);
      return;
    }
    this.nextT = startT + this.periodMs;
    if (!answer) return;
    this.previous = answer.response.name;
    this.deps.answer(answer, now - startT);
  }

  private abandon(): void {
    this.inFlight?.controller.abort();
    this.inFlight = null;
    this.seq++;
  }

  private get periodMs(): number {
    return this.deps.options?.periodMs ?? DEFAULT_PERIOD_MS;
  }

  private get retryMs(): number {
    return this.deps.options?.retryMs ?? DEFAULT_RETRY_MS;
  }

  private get timeoutMs(): number {
    return this.deps.options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }
}

/**
 * What to tell the tracker about an answer measured on streamed frame `seq` (null: the frame was
 * not streamed), while it tracks the object named `tracking`: track what the answer found; drop
 * the target when nothing stands out or another object is named but not found; else nothing (jev
 * missing the tracked object once is no reason to lose it).
 */
export function trackerUpdate(
  answer: PrimaryAnswer,
  seq: number | null,
  tracking: string | null,
): TargetMessage | ClearMessage | null {
  if (answer.found) {
    return seq === null
      ? null
      : { type: 'target', seq, box: answer.detection.box, name: answer.name };
  }
  return tracking !== null && answer.name !== tracking ? { type: 'clear' } : null;
}
