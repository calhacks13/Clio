import type { Procedure, StepCheckVerdict } from '@clio/protocol';

// Pure: the planner bench's live watch. While you do a plan's steps in front of the camera, the
// page asks the step watcher's question about the focused step every few seconds, as the headset
// does, and this keeps the lesson's progress: which steps are done, which one has focus, and
// every answer. Unlike the headset, it can move on by itself when a step looks done, so a whole
// lesson can be followed hands-free.

export type WatchStatus = 'todo' | 'done' | 'skipped';
export type DoneBy = 'watcher' | 'you' | 'before';

export interface WatchLook {
  at: number;
  step: number;
  verdict?: StepCheckVerdict;
  observation?: string;
  error?: string;
  latencyMs?: number;
  model?: string;
  /** The frame it judged, as a data URL. */
  image?: string;
}

export interface StepProgress {
  status: WatchStatus;
  by?: DoneBy;
  /** When the step got focus the last time, and when it was finished (ms, `at` clock). */
  startedAt?: number;
  endedAt?: number;
}

export interface LookOutcome {
  /** The focused step looked done this many times in a row. */
  streak: number;
  /** It moved on to the next step. */
  advanced: boolean;
  /** It looks done enough, but moving on is up to you. */
  suggest: boolean;
}

/** Answers kept for the log; older ones are dropped. */
const MAX_LOOKS = 80;

export class WatchSession {
  readonly progress: StepProgress[];
  readonly looks: WatchLook[] = [];
  focus: number | null = null;
  streak = 0;
  readonly startedAt: number;
  finishedAt: number | null = null;

  /** `doneBefore` steps were done before this plan was revised, so they start done. */
  constructor(
    readonly steps: Procedure['steps'],
    now: number,
    doneBefore = 0,
  ) {
    this.startedAt = now;
    this.progress = steps.map((_, i) =>
      i < doneBefore ? { status: 'done', by: 'before' } : { status: 'todo' },
    );
    this.refocus(now);
  }

  get complete(): boolean {
    return this.focus === null;
  }

  get doneCount(): number {
    return this.progress.filter((p) => p.status === 'done').length;
  }

  /**
   * Records one answer. Only an answer about the focused step counts towards moving on; one
   * about a step that lost focus while the model looked is logged and ignored.
   */
  record(look: WatchLook, options: { autoAdvance: boolean; needed: number }): LookOutcome {
    this.looks.unshift(look);
    this.looks.length = Math.min(this.looks.length, MAX_LOOKS);
    if (look.step !== this.focus || look.error) {
      return { streak: this.streak, advanced: false, suggest: false };
    }
    this.streak = look.verdict === 'done' ? this.streak + 1 : 0;
    const enough = this.streak >= Math.max(1, options.needed);
    if (enough && options.autoAdvance) {
      this.finish(look.step, 'watcher', look.at);
      return { streak: this.streak, advanced: true, suggest: false };
    }
    return { streak: this.streak, advanced: false, suggest: enough };
  }

  /** You say the focused step (or another one) is done. */
  markDone(step: number, now: number): void {
    this.finish(step, 'you', now);
  }

  skip(step: number, now: number): void {
    const p = this.progress[step];
    if (p?.status !== 'todo') return;
    p.status = 'skipped';
    p.endedAt = now;
    this.refocus(now);
  }

  /** Works on `step` now, reopening it if it was done or skipped. */
  focusOn(step: number, now: number): void {
    const p = this.progress[step];
    if (!p) return;
    p.status = 'todo';
    delete p.by;
    delete p.endedAt;
    this.setFocus(step, now);
  }

  /** Reopens the step before the focused one (or the last one, once the lesson is complete). */
  back(now: number): void {
    const from = this.focus ?? this.progress.length;
    for (let i = from - 1; i >= 0; i--) {
      if (this.progress[i]?.by !== 'before') {
        this.focusOn(i, now);
        return;
      }
    }
  }

  /** Seconds on the focused step, or the whole lesson's when it is complete. */
  elapsed(now: number): { step: number; total: number } {
    const end = this.finishedAt ?? now;
    const p = this.focus === null ? undefined : this.progress[this.focus];
    return {
      step: p?.startedAt === undefined ? 0 : now - p.startedAt,
      total: end - this.startedAt,
    };
  }

  private finish(step: number, by: DoneBy, now: number): void {
    const p = this.progress[step];
    if (!p || p.status === 'done') return;
    p.status = 'done';
    p.by = by;
    p.endedAt = now;
    this.refocus(now);
  }

  /** Focus goes to the first step still to do, as on the headset. */
  private refocus(now: number): void {
    const next = this.progress.findIndex((p) => p.status === 'todo');
    if (next === -1) {
      this.focus = null;
      this.streak = 0;
      this.finishedAt ??= now;
      return;
    }
    if (next !== this.focus) this.setFocus(next, now);
  }

  private setFocus(step: number, now: number): void {
    this.focus = step;
    this.streak = 0;
    this.finishedAt = null;
    const p = this.progress[step];
    if (p) p.startedAt = now;
  }
}
