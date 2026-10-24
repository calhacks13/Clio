import type { ImagePayload, StepCheckRequest, StepCheckResponse } from '@clio/protocol';
import type { Clock } from '../../core/clock';
import type { AppBus } from '../events';

// The coach's second pair of eyes. Gemini Live only takes a turn when the learner speaks, so a
// step finished in silence would go unnoticed. While a step waits and nobody is talking, the
// watcher shows a fresh camera frame and the step's done-when to a vision model every few seconds.
// When it looks done, the coach is told and decides; the watcher never completes a step. It sees
// only the camera, never the tracker. Every answer is recorded as a `step.watch` annotation.

/** Port: judges one step from camera views (the server's /api/plans/check). */
export interface StepChecker {
  check(request: StepCheckRequest): Promise<StepCheckResponse>;
}

/** Port: fresh camera views, newest last. */
export interface WatchFrameSource {
  snapshots(max: number): Promise<ImagePayload[]>;
}

export interface WatchTarget {
  /** Which lesson, so an answer never lands in the next one (steps can share ids). */
  lesson: number;
  goal: string;
  step: StepCheckRequest['step'];
}

export interface StepWatcherOptions {
  /** Time between looks at the same step, and before the first look after it starts (ms). */
  intervalMs?: number;
  /** Look only after this long with no speech from either side (ms). */
  quietMs?: number;
  /** Don't suggest the same step again for this long (ms). */
  repeatMs?: number;
  /** After this many failures in a row, pause for `pauseMs`. */
  maxFailures?: number;
  pauseMs?: number;
}

export interface StepWatcherDeps {
  bus: AppBus;
  clock: Clock;
  checker: StepChecker;
  frames: WatchFrameSource;
  /** The step to look at now, or null to stay idle. */
  target: () => WatchTarget | null;
  /** Whether a coach that can see is in charge (otherwise the watcher stays idle). */
  enabled: () => boolean;
  options?: StepWatcherOptions;
}

const DEFAULTS: Required<StepWatcherOptions> = {
  intervalMs: 6000,
  quietMs: 2500,
  repeatMs: 20_000,
  maxFailures: 2,
  pauseMs: 60_000,
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class StepWatcher {
  private readonly o: Required<StepWatcherOptions>;
  private watching: string | null = null;
  private lastLookT = 0;
  private lastTalkT = Number.NEGATIVE_INFINITY;
  private suggested: { key: string; t: number } | null = null;
  private inFlight = false;
  private failures = 0;
  private pausedUntil = Number.NEGATIVE_INFINITY;
  private readonly off: () => void;

  constructor(private readonly deps: StepWatcherDeps) {
    this.o = { ...DEFAULTS, ...deps.options };
    this.off = deps.bus.on('coach.caption', ({ t }) => {
      this.lastTalkT = t;
    });
  }

  /** Call every frame. Returns the look it started, if any, so the caller can track it. */
  tick(t: number): Promise<void> | null {
    const target = this.deps.enabled() ? this.deps.target() : null;
    if (!target) {
      this.watching = null;
      return null;
    }
    const key = `${target.lesson}:${target.step.id}`;
    if (key !== this.watching) {
      this.watching = key;
      this.lastLookT = t;
      return null;
    }
    if (this.inFlight || t < this.pausedUntil) return null;
    if (t - this.lastLookT < this.o.intervalMs || t - this.lastTalkT < this.o.quietMs) return null;
    const recent = this.suggested;
    if (recent?.key === key && t - recent.t < this.o.repeatMs) return null;
    this.lastLookT = t;
    this.inFlight = true;
    return this.look(target).finally(() => {
      this.inFlight = false;
    });
  }

  stop(): void {
    this.off();
  }

  private async look(target: WatchTarget): Promise<void> {
    const { bus, clock, checker, frames } = this.deps;
    let images: ImagePayload[];
    try {
      images = await frames.snapshots(1);
    } catch {
      images = [];
    }
    if (images.length === 0) return;
    let answer: StepCheckResponse;
    try {
      answer = await checker.check({ goal: target.goal, step: target.step, images });
    } catch (err) {
      if (this.deps.target()?.lesson !== target.lesson) return;
      if (++this.failures >= this.o.maxFailures) {
        this.failures = 0;
        this.pausedUntil = clock.now() + this.o.pauseMs;
      }
      bus.emit('annotation', {
        t: clock.now(),
        label: 'step.watch',
        data: { stepId: target.step.id, error: errorText(err) },
      });
      return;
    }
    this.failures = 0;
    const now = this.deps.target();
    // That lesson is over: its recording has stopped and the answer belongs to no step now.
    if (now?.lesson !== target.lesson) return;
    const t = clock.now();
    bus.emit('annotation', {
      t,
      label: 'step.watch',
      data: {
        stepId: target.step.id,
        verdict: answer.verdict,
        observation: answer.observation,
        model: answer.model,
        latencyMs: answer.latencyMs,
      },
    });
    // The step may have finished or changed while the model looked.
    if (answer.verdict !== 'done' || now.step.id !== target.step.id) return;
    this.suggested = { key: `${target.lesson}:${target.step.id}`, t };
    bus.emit('step.looks_done', {
      t,
      stepId: target.step.id,
      observation: answer.observation,
      image: images.at(-1)?.data ?? null,
    });
  }
}
