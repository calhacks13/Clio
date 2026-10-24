import type {
  NormalizedPoint,
  Procedure,
  StepCheckObject,
  StepCheckRequest,
  StepCheckVerdict,
} from '@clio/protocol';

// Pure: the planner bench's live watch. While you do a plan's steps in front of the camera, the
// page asks the step watcher's question about the focused step over and over, and this keeps the
// lesson's progress: which steps are done, which one has focus, how far along it looks, and every
// answer. Unlike the headset, it can move on by itself when a step looks done, so a whole lesson
// can be followed hands-free.

export type WatchStatus = 'todo' | 'done' | 'skipped';
export type DoneBy = 'watcher' | 'you' | 'before';

/** What a look asked about: the step as it stood, and what its objects look like. */
export interface LookAsked {
  step: StepCheckRequest['step'];
  objects: StepCheckObject[];
  confusions: string[];
}

export interface WatchLook {
  /** Numbered by the session, from 1. */
  n?: number;
  at: number;
  step: number;
  verdict?: StepCheckVerdict;
  observation?: string;
  /** How far along the step looked, in percent. */
  progress?: number;
  /** What the learner did instead, e.g. "picked up the milk, not the yogurt drink". */
  wrong?: string;
  /** The object that decided it, in the frame it judged. */
  evidence?: { label: string; point: NormalizedPoint };
  error?: string;
  latencyMs?: number;
  model?: string;
  asked?: LookAsked;
  /** The frame it judged, as a data URL. */
  image?: string;
  /** The frame from when the step gained focus, sent as `before`, as a data URL. */
  before?: string;
}

export interface StepProgress {
  status: WatchStatus;
  by?: DoneBy;
  /** When the step got focus the last time, and when it was finished (ms, `at` clock). */
  startedAt?: number;
  endedAt?: number;
  /** How far along it looked in the last answer about it, in percent. */
  percent?: number;
}

/** The shortest pause between one answer and the next look. */
export const MIN_LOOK_GAP_MS = 500;
/** After a failed look, wait at least this long, so a broken server isn't asked twice a second. */
export const FAILED_LOOK_GAP_MS = 3000;

/**
 * How long to wait before the next look. `intervalMs` 0 means as fast as the model answers: the
 * next look starts a moment after the previous answer. Otherwise looks start `intervalMs` apart.
 */
export function nextLookDelay(intervalMs: number, tookMs: number, failed = false): number {
  const delay = Math.max(MIN_LOOK_GAP_MS, intervalMs - tookMs);
  return failed ? Math.max(FAILED_LOOK_GAP_MS, delay) : delay;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * What the step watcher is told about a step besides its words: what its objects look like (the
 * outlines' descriptions, then the declared objects it targets) so a look-alike is not taken for
 * one, and its mistakes, which often look like success.
 */
export function stepCheckHints(
  procedure: Procedure,
  index: number,
): { objects: StepCheckObject[]; confusions: string[] } {
  const step = procedure.steps[index];
  if (!step) return { objects: [], confusions: [] };
  const declared = new Map(procedure.objects.map((o) => [o.id, o]));
  const objects: StepCheckObject[] = [];
  const seen = new Set<string>();
  for (const item of step.show) {
    if (seen.has(item.object)) continue;
    seen.add(item.object);
    const label = declared.get(item.object)?.label ?? item.phrase;
    objects.push({ id: item.object, label, look: clip(item.description, 300) });
  }
  for (const id of step.targets) {
    const o = declared.get(id);
    if (!o || o.hidden || seen.has(id)) continue;
    seen.add(id);
    const look = o.tracking?.query ?? o.description ?? o.label;
    objects.push({ id, label: o.label, look: clip(look, 300) });
  }
  const confusions = [...new Set(step.mistakes.map((m) => clip(m.message.trim(), 200)))].filter(
    Boolean,
  );
  return { objects: objects.slice(0, 6), confusions: confusions.slice(0, 4) };
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
  /** Bumped whenever a step gains focus, so the page knows to keep a new "before" frame. */
  focusTurn = 0;
  /** Answers that said the learner did something else instead. */
  wrongCount = 0;
  readonly startedAt: number;
  finishedAt: number | null = null;
  #looked = 0;

  /** `doneBefore` steps were done before this plan was revised, so they start done. */
  constructor(
    public steps: Procedure['steps'],
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
   * about a step that lost focus while the model looked is logged and ignored. A "done" that also
   * says what went wrong is not done.
   */
  record(look: WatchLook, options: { autoAdvance: boolean; needed: number }): LookOutcome {
    look.n = ++this.#looked;
    this.looks.unshift(look);
    this.looks.length = Math.min(this.looks.length, MAX_LOOKS);
    if (look.wrong) this.wrongCount++;
    if (look.step !== this.focus || look.error) {
      return { streak: this.streak, advanced: false, suggest: false };
    }
    const p = this.progress[look.step];
    if (p && look.progress !== undefined) p.percent = look.progress;
    this.streak = look.verdict === 'done' && !look.wrong ? this.streak + 1 : 0;
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
    delete p.percent;
    this.setFocus(step, now);
  }

  /**
   * Swaps in a refined plan (a stage "rest" answer: the same first steps, the outline from `from`
   * rewritten in full) without losing progress. Steps before `from` and any finished run of steps
   * after it stay as they were; the rest become the refined ones. A refined step with the id of a
   * step finished out of order keeps that progress, and the focused step keeps its clock.
   */
  refine(steps: Procedure['steps'], from: number, now: number): void {
    const old = this.steps;
    const oldProgress = [...this.progress];
    let keep = Math.min(from, old.length, steps.length);
    while (keep < old.length && keep < steps.length && oldProgress[keep]?.status !== 'todo') keep++;
    const next = [...old.slice(0, keep), ...steps.slice(keep)];
    const finished = new Map<string, StepProgress>();
    for (let i = keep; i < old.length; i++) {
      const p = oldProgress[i];
      const id = old[i]?.id;
      if (p && id && p.status !== 'todo') finished.set(id, p);
    }
    const progress = next.map((step, i): StepProgress => {
      const p = i < keep ? oldProgress[i] : finished.get(step.id);
      if (p) return p;
      const startedAt = i === this.focus ? oldProgress[i]?.startedAt : undefined;
      return startedAt === undefined ? { status: 'todo' } : { status: 'todo', startedAt };
    });
    this.steps = next;
    this.progress.splice(0, this.progress.length, ...progress);
    const focus = this.focus;
    if (focus !== null && focus >= keep) this.streak = 0;
    if (focus !== null && this.progress[focus]?.status === 'todo') return;
    this.refocus(now);
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
    p.percent = 100;
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
    this.focusTurn++;
    this.streak = 0;
    this.finishedAt = null;
    const p = this.progress[step];
    if (p) p.startedAt = now;
  }
}
