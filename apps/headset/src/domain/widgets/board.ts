import {
  type CoachToolArgs,
  type Handedness,
  WIDGET_KINDS,
  WIDGET_TEXT_MAX,
  type WidgetKind,
  type WidgetToolName,
} from '@clio/protocol';
import type { Clock } from '../../core/clock';
import type { LessonView, WidgetsView } from '../coach/ports';
import type { ToolCallInfo, ToolOutcome, WidgetToolHandlers } from '../coach/toolbox';
import type { AppBus } from '../events';
import { formatClock, formatCount } from './format';
import { recordedWidget } from './record';
import { cleanText, hasText, matchItem, matchSpoken, normalise, sameLabel } from './rules';
import { summarise, widgetLine } from './summary';
import {
  type ChecklistItem,
  type ChecklistWidget,
  type ChoicesWidget,
  NO_WIDGETS,
  type ProgressWidget,
  type RecordedWidget,
  type TimerWidget,
  WIDGET_ANNOTATION,
  WIDGET_LIMITS,
  type Widget,
  type WidgetActor,
  type WidgetAnnotation,
  type WidgetCloseReason,
  type WidgetIntent,
  type WidgetOp,
  type WidgetScope,
  type WidgetSnapshot,
} from './types';

// The coach's widgets (docs/widgets.md): what is on the learner's screen beside the step card,
// for how long, and what the coach hears back. The voice shows them through one upserting tool
// per kind; the board owns the rest: one of each kind (two timers), three in all, when each
// closes, and the learner's answers by touch or voice. Every change replaces the widget's record
// and the snapshot presenters read, is recorded as a widget.updated annotation and only then
// tells the coach, through a bus event the narrator words.
//
// The coach learns what the widgets say (the on_screen line), never whether or where one is
// drawn: the dock always shows everything.

export interface WidgetBoardDeps {
  bus: AppBus;
  clock: Clock;
  /** Plan ids, focus and labels: never positions. */
  view: LessonView;
}

/** Who changed the board, and the coach call behind it. */
interface Cause {
  by: WidgetActor;
  callId?: string;
}

/** What an annotation records besides the widget. */
interface Change extends Cause {
  op: WidgetOp;
  reason?: WidgetCloseReason;
  item?: number;
  hand?: Handedness;
  via?: 'touch' | 'voice';
}

type Fail = { ok: false; error: string };
type Room = { ok: true; replaced?: string } | Fail;

/** The fields every widget kind has. */
type Common = Pick<
  Widget,
  | 'id'
  | 'seq'
  | 'rev'
  | 'createdT'
  | 'updatedT'
  | 'status'
  | 'doneT'
  | 'closeAt'
  | 'leaving'
  | 'stepId'
  | 'scope'
>;

const APP: Cause = { by: 'app' };
const fail = (error: string): Fail => ({ ok: false, error });
const ok = (result: object): ToolOutcome => ({ ok: true, result });
const needsText = (field: string) => fail(`${field} needs letters or numbers.`);
const isKind = (name: string): name is WidgetKind =>
  (WIDGET_KINDS as readonly string[]).includes(name);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** A text argument once cleaned: where the contract would point at it, and its limit. */
type Sized = readonly [path: string, text: string, max: number];

/** Each of a list's texts, pointed at as the contract does: items[1]. */
const each = (path: string, texts: readonly string[], max: number): Sized[] =>
  texts.map((text, i) => [`${path}[${i}]`, text, max]);

/**
 * The contract's own error for text past its limit, for text that cleaning made longer ("a→b" is
 * "a to b", "ﬁ" two letters): the coach writes it shorter, as it would its own long text.
 */
function tooLong(tool: WidgetToolName, fields: readonly Sized[]): Fail | null {
  const issues = fields
    .filter(([, text, max]) => text.length > max)
    .map(
      ([path, , max]) => `✖ Too big: expected string to have <=${max} characters\n  → at ${path}`,
    );
  return issues.length > 0 ? fail(`Invalid arguments for ${tool}: ${issues.join('\n')}`) : null;
}

/** What clear_widget matches a widget's words against. */
function nameOf(w: Widget): string {
  switch (w.kind) {
    case 'checklist':
      return w.title;
    case 'choices':
      return w.question;
    case 'caution':
      return w.text;
    default:
      return w.label;
  }
}

/** The coach may clear these to make room; a running timer, open question or caution stays. */
function evictable(w: Widget): boolean {
  switch (w.kind) {
    case 'timer':
      return w.status === 'done';
    case 'choices':
      return w.chosen !== null;
    case 'caution':
      return false;
    default:
      return true;
  }
}

/** The close a widget has of its own: a finished one's linger from when it finished, else none. */
function ownClose(w: Widget): number | null {
  if (w.status !== 'done' || w.doneT === null) return null;
  switch (w.kind) {
    case 'timer':
      return w.doneT + WIDGET_LIMITS.timerLingerMs;
    case 'choices':
      return w.doneT + WIDGET_LIMITS.chosenLingerMs;
    default:
      return w.doneT + WIDGET_LIMITS.completeLingerMs;
  }
}

/** A widget that may have reached its end: done ones close after their linger. */
function ending(
  prev: Widget | undefined,
  done: boolean,
  t: number,
  linger: number,
): Pick<Widget, 'status' | 'doneT' | 'closeAt'> {
  if (!done) return { status: 'active', doneT: null, closeAt: null };
  const doneT = prev?.status === 'done' && prev.doneT !== null ? prev.doneT : t;
  return { status: 'done', doneT, closeAt: doneT + linger };
}

export class WidgetBoard implements WidgetsView {
  /** Insertion order is the snapshot's order: oldest first. */
  private readonly widgets = new Map<string, Widget>();
  /** Timers still running from a lesson that ended: shown, but no lesson is waiting on them. */
  private readonly leftOver = new Set<string>();
  private seq = 0;
  private snap: WidgetSnapshot = NO_WIDGETS;
  private offs: (() => void)[] = [];
  /** When the learner's current utterance began (its first partial transcript), or null. */
  private utteranceT: number | null = null;

  constructor(private readonly deps: WidgetBoardDeps) {}

  /**
   * step.entered, plan.changed, plan.requested, procedure.completed/aborted, lesson.phase (idle),
   * transcript (and the learner's partial captions, for when an answer began).
   */
  attach(): () => void {
    this.detach();
    const b = this.deps.bus;
    this.offs = [
      b.on('step.entered', ({ t, stepId }) => this.stepEntered(stepId, t)),
      b.on('plan.changed', ({ t }) => this.planChanged(t)),
      b.on('plan.requested', ({ t, revision }) => {
        if (!revision) this.lessonOver(t);
      }),
      b.on('procedure.completed', ({ t }) => this.lessonOver(t)),
      b.on('procedure.aborted', ({ t }) => this.lessonOver(t)),
      // end_lesson while the lesson is still being planned or written aborts nothing: the lesson
      // goes back to idle.
      b.on('lesson.phase', ({ t, phase }) => {
        if (phase === 'idle') this.lessonOver(t);
      }),
      // A blank partial never becomes a final transcript, so it starts no utterance.
      b.on('coach.caption', ({ t, role, text, final }) => {
        if (role === 'user' && !final && text.trim()) this.utteranceT ??= t;
      }),
      b.on('transcript', ({ t, role, text, final }) => {
        if (role !== 'user' || !final) return;
        const began = this.utteranceT ?? t;
        this.utteranceT = null;
        this.heard(text, began, t);
      }),
    ];
    return () => this.detach();
  }

  detach(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  /** The seven tools. */
  handlers(): WidgetToolHandlers {
    const cause = (call?: ToolCallInfo): Cause =>
      call ? { by: 'coach', callId: call.callId } : { by: 'coach' };
    return {
      show_timer: (args, call) => this.showTimer(args, cause(call)),
      show_progress: (args, call) => this.showProgress(args, cause(call)),
      show_checklist: (args, call) => this.showChecklist(args, cause(call)),
      show_choices: (args, call) => this.showChoices(args, cause(call)),
      show_value: (args, call) => this.showValue(args, cause(call)),
      show_caution: (args, call) => this.showCaution(args, cause(call)),
      clear_widget: ({ widget_id }, call) => this.clear(widget_id, cause(call)),
    };
  }

  /** Decide stage, once per frame at the frame's t: timers end, lingers and TTLs expire. */
  tick(t: number): void {
    if (this.widgets.size === 0) return;
    // Replacing or deleting the entry being visited is safe while iterating a Map.
    for (const w of this.widgets.values()) {
      if (w.kind === 'timer' && w.status === 'active' && w.endT <= t) this.timeUp(w, t);
    }
    for (const w of this.widgets.values()) {
      const reason = this.due(w, t);
      if (reason) this.remove(w, t, reason, APP);
    }
  }

  /** Cached; replaced (never mutated) on every change. */
  snapshot(): WidgetSnapshot {
    return this.snap;
  }

  /**
   * A learner's touch from the dock presenter. Stale ids and indices are ignored, and so is a
   * widget on its way out after a step change.
   */
  touch(intent: WidgetIntent): void {
    const w = this.widgets.get(intent.widgetId);
    if (!w || w.leaving || !Number.isInteger(intent.index)) return;
    const t = this.deps.clock.now();
    if (intent.type === 'choose') {
      if (w.kind === 'choices') this.choose(w, intent.index, t, intent.hand);
    } else if (w.kind === 'checklist') {
      this.tickItem(w, intent.index, t, intent.hand);
    }
  }

  /** The on_screen line, or null when nothing shows. */
  summary(): string | null {
    return summarise(this.snap.widgets, this.deps.clock.now());
  }

  /** A timer this lesson started is running. */
  waiting(): boolean {
    for (const w of this.widgets.values()) {
      if (w.kind === 'timer' && w.status === 'active' && !this.leftOver.has(w.id)) return true;
    }
    return false;
  }

  // The tools. Each answers at once, with the on_screen line as it stands after the call.

  private showTimer(
    { seconds, label: rawLabel, object_id }: CoachToolArgs<'show_timer'>,
    cause: Cause,
  ): ToolOutcome {
    const t = this.deps.clock.now();
    const label = cleanText(rawLabel, 'label');
    if (!hasText(label)) return needsText('label');
    const long = tooLong('show_timer', [['label', label, WIDGET_TEXT_MAX.timerLabel]]);
    if (long) return long;
    const durationMs = seconds * 1000;
    const { objectId, note } = this.objectOf(object_id);
    const noted = note ? { note } : {};
    const timers = this.timers();

    const same = timers.find((w) => sameLabel(w.label, label));
    if (same) {
      const next: TimerWidget = {
        ...same,
        ...ending(same, false, t, 0),
        rev: same.rev + 1,
        updatedT: t,
        label,
        durationMs,
        endT: t + durationMs,
        objectId: objectId ?? same.objectId,
      };
      this.put(next, t, { op: 'update', ...cause });
      return ok({
        widget_id: next.id,
        ends_in: formatClock(durationMs),
        restarted: true,
        ...noted,
        on_screen: this.onScreen(t),
      });
    }

    let replaced: string | undefined;
    if (timers.length >= WIDGET_LIMITS.maxTimers) {
      const done = timers.find((w) => w.status === 'done');
      if (!done) {
        const labels = timers.map((w) => `"${w.label}"`).join(', ');
        return fail(`Two timers are running (${labels}). Clear one with clear_widget first.`);
      }
      replaced = widgetLine(done, t);
      this.remove(done, t, 'evicted', cause);
    }
    const room = this.makeRoom(t, cause);
    if (!room.ok) return room;
    replaced ??= room.replaced;

    const id = this.widgets.has('timer') ? 'timer-2' : 'timer';
    const timer: TimerWidget = {
      ...this.common(undefined, id, t, 'lesson'),
      kind: 'timer',
      label,
      durationMs,
      endT: t + durationMs,
      objectId,
    };
    this.put(timer, t, { op: 'show', ...cause });
    return ok({
      widget_id: id,
      ends_in: formatClock(durationMs),
      ...(replaced ? { replaced } : {}),
      ...noted,
      on_screen: this.onScreen(t),
    });
  }

  private showProgress(args: CoachToolArgs<'show_progress'>, cause: Cause): ToolOutcome {
    const t = this.deps.clock.now();
    const label = cleanText(args.label, 'label');
    if (!hasText(label)) return needsText('label');
    const unit = args.unit === undefined ? '' : cleanText(args.unit, 'label');
    const long = tooLong('show_progress', [
      ['label', label, WIDGET_TEXT_MAX.progressLabel],
      ['unit', unit, WIDGET_TEXT_MAX.unit],
    ]);
    if (long) return long;
    // Both as the count shows them (one decimal), so a value that reaches a total of 1.33 reads and
    // finishes at 1.3 of 1.3; 0.1 is the least total it can show.
    const total = Math.max(0.1, round1(args.total));
    const value = Math.min(total, Math.max(0, round1(args.value)));
    const done = value >= total;
    const prev = this.get('progress');
    const room = prev ? null : this.makeRoom(t, cause);
    if (room && !room.ok) return room;

    const next: ProgressWidget = {
      ...this.common(prev, 'progress', t, 'step'),
      ...ending(this.carried(prev), done, t, WIDGET_LIMITS.completeLingerMs),
      kind: 'progress',
      label,
      value,
      total,
      // A unit can be a symbol alone, e.g. "%".
      unit: unit === '' ? null : unit,
    };
    this.put(next, t, { op: prev ? 'update' : 'show', ...cause });
    const progress = formatCount(next.value, next.total, next.unit);
    return ok({
      widget_id: next.id,
      progress,
      done,
      ...(room?.replaced ? { replaced: room.replaced } : {}),
      ...(args.value > args.total
        ? { note: `value was more than total, so it shows ${progress}.` }
        : {}),
      on_screen: this.onScreen(t),
    });
  }

  private showChecklist(args: CoachToolArgs<'show_checklist'>, cause: Cause): ToolOutcome {
    const t = this.deps.clock.now();
    const title = cleanText(args.title, 'label');
    if (!hasText(title)) return needsText('title');
    const texts = args.items.map((item) => cleanText(item, 'label'));
    if (!texts.every(hasText)) return needsText('items');
    const long = tooLong('show_checklist', [
      ['title', title, WIDGET_TEXT_MAX.checklistTitle],
      ...each('items', texts, WIDGET_TEXT_MAX.checklistItem),
    ]);
    if (long) return long;
    if (new Set(texts.map(normalise)).size !== texts.length) {
      return fail('The items must be different.');
    }

    const prev = this.get('checklist');
    const kept = this.carried(prev);
    const done = texts.map(
      (text) => kept?.items.some((item) => item.done && sameLabel(item.text, text)) ?? false,
    );
    const unmatched: string[] = [];
    for (const entry of args.done ?? []) {
      const index = matchItem(texts, cleanText(entry, 'label'));
      if (index === null) unmatched.push(entry);
      else done[index] = true;
    }
    const items: ChecklistItem[] = texts.map((text, i) => ({ text, done: done[i] ?? false }));
    const count = items.filter((item) => item.done).length;

    const room = prev ? null : this.makeRoom(t, cause);
    if (room && !room.ok) return room;
    const next: ChecklistWidget = {
      ...this.common(prev, 'checklist', t, 'step'),
      ...ending(kept, count === items.length, t, WIDGET_LIMITS.completeLingerMs),
      kind: 'checklist',
      title,
      items,
    };
    this.put(next, t, { op: prev ? 'update' : 'show', ...cause });
    return ok({
      widget_id: next.id,
      done: `${count} of ${items.length}`,
      ...(unmatched.length > 0 ? { unmatched } : {}),
      ...(room?.replaced ? { replaced: room.replaced } : {}),
      on_screen: this.onScreen(t),
    });
  }

  private showChoices(args: CoachToolArgs<'show_choices'>, cause: Cause): ToolOutcome {
    const t = this.deps.clock.now();
    const question = cleanText(args.question);
    if (!hasText(question)) return needsText('question');
    const options = args.options.map((option) => cleanText(option, 'label'));
    if (!options.every(hasText)) return needsText('options');
    const long = tooLong('show_choices', [
      ['question', question, WIDGET_TEXT_MAX.question],
      ...each('options', options, WIDGET_TEXT_MAX.option),
    ]);
    if (long) return long;
    if (new Set(options.map(normalise)).size !== options.length) {
      return fail('The options must be different.');
    }

    const prev = this.get('choices');
    const room = prev ? null : this.makeRoom(t, cause);
    if (room && !room.ok) return room;
    const next: ChoicesWidget = {
      ...this.common(prev, 'choices', t, 'step'),
      ...ending(prev, false, t, 0),
      kind: 'choices',
      question,
      options,
      chosen: null,
      chosenVia: null,
      expiresT: t + WIDGET_LIMITS.choicesTtlMs,
    };
    this.put(next, t, { op: prev ? 'update' : 'show', ...cause });
    return ok({
      widget_id: next.id,
      ...(room?.replaced ? { replaced: room.replaced } : {}),
      on_screen: this.onScreen(t),
    });
  }

  private showValue(args: CoachToolArgs<'show_value'>, cause: Cause): ToolOutcome {
    const t = this.deps.clock.now();
    const label = cleanText(args.label, 'label');
    if (!hasText(label)) return needsText('label');
    const value = cleanText(args.value);
    if (!hasText(value)) return needsText('value');
    const long = tooLong('show_value', [
      ['label', label, WIDGET_TEXT_MAX.valueLabel],
      ['value', value, WIDGET_TEXT_MAX.value],
    ]);
    if (long) return long;

    const prev = this.get('value');
    const room = prev ? null : this.makeRoom(t, cause);
    if (room && !room.ok) return room;
    const scope: WidgetScope = args.whole_lesson ? 'lesson' : 'step';
    this.put(
      {
        ...this.common(prev, 'value', t, scope),
        ...ending(prev, false, t, 0),
        kind: 'value',
        label,
        value,
      },
      t,
      { op: prev ? 'update' : 'show', ...cause },
    );
    return ok({
      widget_id: 'value',
      ...(room?.replaced ? { replaced: room.replaced } : {}),
      on_screen: this.onScreen(t),
    });
  }

  private showCaution(args: CoachToolArgs<'show_caution'>, cause: Cause): ToolOutcome {
    const t = this.deps.clock.now();
    const text = cleanText(args.text);
    if (!hasText(text)) return needsText('text');
    const long = tooLong('show_caution', [['text', text, WIDGET_TEXT_MAX.caution]]);
    if (long) return long;

    const prev = this.get('caution');
    const room = prev ? null : this.makeRoom(t, cause);
    if (room && !room.ok) return room;
    this.put(
      {
        ...this.common(prev, 'caution', t, 'lesson'),
        ...ending(prev, false, t, 0),
        kind: 'caution',
        text,
      },
      t,
      { op: prev ? 'update' : 'show', ...cause },
    );
    return ok({
      widget_id: 'caution',
      ...(room?.replaced ? { replaced: room.replaced } : {}),
      on_screen: this.onScreen(t),
    });
  }

  /** "all", an id, every widget of a kind, or the one whose label (title, question, text) it is. */
  private clear(widgetId: string, cause: Cause): ToolOutcome {
    const t = this.deps.clock.now();
    const wanted = widgetId.trim();
    const key = wanted.toLowerCase();
    const all = [...this.widgets.values()];
    let gone: Widget[];
    if (normalise(wanted) === 'all') {
      gone = all;
    } else {
      // The first rule that matches anything wins.
      const byId = this.widgets.get(key);
      const ofKind = isKind(key) ? all.filter((w) => w.kind === key) : [];
      const named = all.find((w) => sameLabel(nameOf(w), wanted));
      gone = byId ? [byId] : ofKind.length > 0 ? ofKind : named ? [named] : [];
      if (gone.length === 0) {
        return fail(`Nothing called "${widgetId}" is on screen. On screen: ${this.onScreen(t)}.`);
      }
    }
    for (const w of gone) this.remove(w, t, 'coach', cause);
    return ok({ cleared: gone.map((w) => w.id), on_screen: this.onScreen(t) });
  }

  // What the learner does.

  /**
   * A final learner transcript, which may answer the open question. Only words begun after the
   * question went up count: Gemini finalises a transcript when the coach's turn ends, so the
   * learner's own words that led to the question arrive after it, and must not answer it.
   */
  private heard(text: string, began: number, t: number): void {
    const open = this.get('choices');
    if (!open || open.chosen !== null || began < open.updatedT) return;
    const index = matchSpoken(open.options, text);
    if (index !== null) this.choose(open, index, t, null);
  }

  /** An answer by touch (with the hand) or out loud (without); a second answer is ignored. */
  private choose(w: ChoicesWidget, index: number, t: number, hand: Handedness | null): void {
    const option = w.options[index];
    if (option === undefined || w.chosen !== null) return;
    const via = hand ? 'touch' : 'voice';
    const next: ChoicesWidget = {
      ...w,
      rev: w.rev + 1,
      updatedT: t,
      status: 'done',
      doneT: t,
      closeAt: t + WIDGET_LIMITS.chosenLingerMs,
      chosen: index,
      chosenVia: via,
    };
    this.put(next, t, {
      op: 'choose',
      by: 'learner',
      item: index,
      ...(hand ? { hand } : {}),
      via,
    });
    this.deps.bus.emit('widget.chosen', {
      t,
      widgetId: w.id,
      question: w.question,
      option,
      via,
    });
  }

  /** Ticks or unticks an item by touch: all ticked is done, an untick makes it active again. */
  private tickItem(w: ChecklistWidget, index: number, t: number, hand: Handedness): void {
    const item = w.items[index];
    if (!item) return;
    const items = w.items.map((it, i) => (i === index ? { text: it.text, done: !it.done } : it));
    const doneCount = items.filter((it) => it.done).length;
    const next: ChecklistWidget = {
      ...w,
      ...ending(w, doneCount === items.length, t, WIDGET_LIMITS.completeLingerMs),
      rev: w.rev + 1,
      updatedT: t,
      items,
    };
    this.put(next, t, {
      op: item.done ? 'untick' : 'tick',
      by: 'learner',
      item: index,
      hand,
      via: 'touch',
    });
    this.deps.bus.emit('widget.ticked', {
      t,
      widgetId: w.id,
      title: w.title,
      item: item.text,
      done: !item.done,
      doneCount,
      total: items.length,
    });
  }

  // The lesson moving on.

  /**
   * Another step took focus: what belonged to the step it left closes, a finished widget after a
   * short grace so its done state is seen (it is leaving meanwhile); an unbound one now belongs to
   * this step. One leaving this step stays after all, with the close it had before the grace.
   */
  private stepEntered(stepId: string, t: number): void {
    for (const w of this.widgets.values()) {
      if (w.scope !== 'step') continue;
      if (w.stepId === stepId) {
        if (w.leaving) {
          const back = { ...w, rev: w.rev + 1, closeAt: ownClose(w), leaving: false };
          this.put(back, t, { op: 'update', ...APP });
        }
      } else if (w.stepId === null) {
        this.replace({ ...w, stepId });
      } else if (w.status === 'done') {
        // Already leaving, it keeps the earlier close.
        if (w.leaving) continue;
        const closeAt = Math.min(
          w.closeAt ?? Number.POSITIVE_INFINITY,
          t + WIDGET_LIMITS.stepChangeGraceMs,
        );
        this.replace({ ...w, rev: w.rev + 1, closeAt, leaving: true });
      } else {
        this.remove(w, t, 'step', APP);
      }
    }
  }

  /** A step-scoped widget whose step left the plan closes. */
  private planChanged(t: number): void {
    const steps = this.deps.view.plan()?.steps ?? [];
    for (const w of this.widgets.values()) {
      if (w.scope !== 'step' || w.stepId === null) continue;
      if (!steps.some((s) => s.id === w.stepId)) this.remove(w, t, 'step', APP);
    }
  }

  /** The lesson ended or another starts: everything goes but a running timer. */
  private lessonOver(t: number): void {
    for (const w of this.widgets.values()) {
      if (w.kind !== 'timer' || w.status !== 'active') this.remove(w, t, 'lesson', APP);
      // It keeps counting down, but the next lesson's stuck nudge does not wait for it.
      else this.leftOver.add(w.id);
    }
  }

  /** A timer reached zero, at its exact end even when the frame is late. */
  private timeUp(w: TimerWidget, t: number): void {
    const next: TimerWidget = {
      ...w,
      rev: w.rev + 1,
      status: 'done',
      doneT: w.endT,
      closeAt: w.endT + WIDGET_LIMITS.timerLingerMs,
    };
    this.put(next, t, { op: 'done', ...APP });
    this.deps.bus.emit('widget.timer_done', {
      t,
      widgetId: w.id,
      label: w.label,
      duration: formatClock(w.durationMs),
    });
  }

  /** Why a widget closes by itself now, if it does. */
  private due(w: Widget, t: number): WidgetCloseReason | null {
    if (w.kind === 'choices' && w.chosen === null && w.expiresT <= t) return 'expired';
    if (w.closeAt !== null && w.closeAt <= t) return 'done';
    if (w.scope === 'step' && w.stepId === null && t - w.updatedT >= WIDGET_LIMITS.unboundStaleMs) {
      return 'stale';
    }
    return null;
  }

  // State.

  private get<K extends WidgetKind>(kind: K): Extract<Widget, { kind: K }> | undefined {
    const w = this.widgets.get(kind);
    return w?.kind === kind ? (w as Extract<Widget, { kind: K }>) : undefined;
  }

  private timers(): TimerWidget[] {
    const timers: TimerWidget[] = [];
    for (const w of this.widgets.values()) if (w.kind === 'timer') timers.push(w);
    return timers;
  }

  /**
   * The shared fields of a show call's widget: the one it updates keeps its instance and step (an
   * unbound one, or one changing scope, binds to the focus); a new one takes the next seq. A show
   * call on one leaving after a step change is the coach's update for the step now in focus (see
   * rebinds), and the call's own close replaces the grace's. With no step in focus it keeps its
   * step.
   */
  private common(prev: Widget | undefined, id: string, t: number, scope: WidgetScope): Common {
    const focus = this.focus();
    const base = {
      updatedT: t,
      status: 'active',
      doneT: null,
      closeAt: null,
      leaving: false,
      scope,
    } as const;
    if (!prev) return { ...base, id, seq: ++this.seq, rev: 1, createdT: t, stepId: focus };
    const rebind = prev.scope !== scope || this.rebinds(prev);
    const stepId = rebind ? focus : (prev.stepId ?? focus);
    return { ...base, id, seq: prev.seq, rev: prev.rev + 1, createdT: prev.createdT, stepId };
  }

  private focus(): string | null {
    return this.deps.view.plan()?.focusId ?? null;
  }

  /** A show call now gives this widget, leaving after a step change, to the step in focus. */
  private rebinds(w: Widget): boolean {
    const focus = this.focus();
    return w.leaving && focus !== null && focus !== w.stepId;
  }

  /**
   * What a show call carries over from the widget it updates (a checklist's ticks, a finished
   * count's done time and linger): nothing when it gives it to another step, where it is that
   * step's widget from the call on.
   */
  private carried<W extends Widget>(prev: W | undefined): W | undefined {
    return prev && !this.rebinds(prev) ? prev : undefined;
  }

  /** Lesson objects a timer can name: the plan's materials, else the procedure's objects. */
  private objectOf(id: string | undefined): { objectId: string | null; note?: string } {
    if (id === undefined) return { objectId: null };
    const { view } = this.deps;
    const ids =
      view.plan()?.materials.map((m) => m.id) ?? view.procedure()?.objects.map((o) => o.id) ?? [];
    const wanted = id.trim();
    if (ids.includes(wanted)) return { objectId: wanted };
    const known = ids.length > 0 ? ids.join(', ') : 'none';
    return {
      objectId: null,
      note: `No object "${id}" in the plan, so it shows without one. Objects: ${known}.`,
    };
  }

  /** Room for one more widget: the evictable one changed least recently goes, if need be. */
  private makeRoom(t: number, cause: Cause): Room {
    if (this.widgets.size < WIDGET_LIMITS.maxWidgets) return { ok: true };
    let victim: Widget | undefined;
    for (const w of this.widgets.values()) {
      if (evictable(w) && (!victim || w.updatedT < victim.updatedT)) victim = w;
    }
    if (!victim) {
      return fail(
        `Three widgets are on screen and none can go yet (${this.onScreen(t)}). Clear one with clear_widget first.`,
      );
    }
    const replaced = widgetLine(victim, t);
    this.remove(victim, t, 'evicted', cause);
    return { ok: true, replaced };
  }

  private onScreen(t: number): string {
    return summarise(this.snap.widgets, t) ?? 'nothing';
  }

  /** A change: the record, then the snapshot, then the annotation. */
  private put(next: Widget, t: number, change: Change): void {
    this.replace(next);
    this.record(next, t, change, recordedWidget(next, t));
  }

  private remove(w: Widget, t: number, reason: WidgetCloseReason, cause: Cause): void {
    this.widgets.delete(w.id);
    this.leftOver.delete(w.id);
    this.publish();
    this.record(w, t, { op: 'close', reason, ...cause }, null);
  }

  /**
   * A record replaced without recording it: an unbound widget binding to a step, or a finished
   * one leaving with its close moved up to the step-change grace (the record keeps no times).
   */
  private replace(next: Widget): void {
    this.widgets.set(next.id, next);
    this.publish();
  }

  private publish(): void {
    this.snap = Object.freeze({
      rev: this.snap.rev + 1,
      widgets: Object.freeze([...this.widgets.values()]),
    });
  }

  private record(w: Widget, t: number, change: Change, widget: RecordedWidget | null): void {
    const data: WidgetAnnotation = {
      op: change.op,
      id: w.id,
      seq: w.seq,
      kind: w.kind,
      by: change.by,
      stepId: w.stepId,
      ...(change.callId !== undefined ? { callId: change.callId } : {}),
      ...(change.reason ? { reason: change.reason } : {}),
      ...(change.item !== undefined ? { item: change.item } : {}),
      ...(change.hand ? { hand: change.hand } : {}),
      ...(change.via ? { via: change.via } : {}),
      widget,
    };
    this.deps.bus.emit('annotation', { t, label: WIDGET_ANNOTATION, data });
  }
}
