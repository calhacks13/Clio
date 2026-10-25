import type { Handedness, WidgetKind } from '@clio/protocol';

// The coach's widgets (docs/widgets.md). WidgetBoard owns them; presenters read a WidgetSnapshot
// through a source function each frame. Records are immutable: a change replaces the record and
// the snapshot, so presenters compare by identity. Times are bus ms (performance.now).

export type { WidgetKind };

/** active: running or open. done: finished and still showing while it lingers. */
export type WidgetStatus = 'active' | 'done';
/** step: closes when focus moves to another step. lesson: when the lesson ends. */
export type WidgetScope = 'step' | 'lesson';

interface WidgetBase<K extends WidgetKind> {
  /** The kind, or "timer-2" for a second timer. */
  readonly id: string;
  /** Board-wide instance number, never reused (the dataset's key). */
  readonly seq: number;
  readonly kind: K;
  /** Bumps on every change a presenter must redraw. */
  readonly rev: number;
  readonly createdT: number;
  /** Last content change by the coach or the learner. */
  readonly updatedT: number;
  readonly status: WidgetStatus;
  readonly doneT: number | null;
  /** When the board closes it (a done widget's linger), or null. */
  readonly closeAt: number | null;
  /**
   * On its way out after its step lost focus (the step-change grace), so it takes no touch: true
   * until it closes, a show call gives it to the step in focus, or its own step takes focus again.
   */
  readonly leaving: boolean;
  /** The step it belongs to; null binds it to the next step that takes focus. */
  readonly stepId: string | null;
  readonly scope: WidgetScope;
}

export interface TimerWidget extends WidgetBase<'timer'> {
  readonly label: string;
  readonly durationMs: number;
  /** When it reaches zero. */
  readonly endT: number;
  /** A lesson object to show a chip beside, or null. */
  readonly objectId: string | null;
}

export interface ProgressWidget extends WidgetBase<'progress'> {
  readonly label: string;
  /** 0..total, one decimal at most. */
  readonly value: number;
  readonly total: number;
  readonly unit: string | null;
}

export interface ChecklistItem {
  readonly text: string;
  readonly done: boolean;
}

export interface ChecklistWidget extends WidgetBase<'checklist'> {
  readonly title: string;
  readonly items: readonly ChecklistItem[];
}

export interface ChoicesWidget extends WidgetBase<'choices'> {
  readonly question: string;
  readonly options: readonly string[];
  readonly chosen: number | null;
  readonly chosenVia: 'touch' | 'voice' | null;
  readonly expiresT: number;
}

export interface ValueWidget extends WidgetBase<'value'> {
  readonly label: string;
  readonly value: string;
}

export interface CautionWidget extends WidgetBase<'caution'> {
  readonly text: string;
}

export type Widget =
  | TimerWidget
  | ProgressWidget
  | ChecklistWidget
  | ChoicesWidget
  | ValueWidget
  | CautionWidget;

/** What presenters read. The same object until something changes. */
export interface WidgetSnapshot {
  readonly rev: number;
  /** Oldest first. */
  readonly widgets: readonly Widget[];
}

export const NO_WIDGETS: WidgetSnapshot = Object.freeze({ rev: 0, widgets: Object.freeze([]) });

/** What the learner did on a widget (the dock presenter's callback; the app calls board.touch). */
export type WidgetIntent =
  | { type: 'choose'; widgetId: string; index: number; hand: Handedness }
  | { type: 'tick'; widgetId: string; index: number; hand: Handedness };

export type WidgetOp = 'show' | 'update' | 'done' | 'choose' | 'tick' | 'untick' | 'close';
export type WidgetActor = 'coach' | 'learner' | 'app' | 'debug';
export type WidgetCloseReason =
  | 'coach'
  | 'step'
  | 'lesson'
  | 'done'
  | 'expired'
  | 'evicted'
  | 'stale';

interface RecordedBase {
  id: string;
  seq: number;
  status: WidgetStatus;
  scope: WidgetScope;
  stepId: string | null;
}

/** A widget as recorded: no absolute times (the recorder rebases only the event's t). */
export type RecordedWidget = RecordedBase &
  (
    | {
        kind: 'timer';
        label: string;
        durationMs: number;
        /** As of the annotation's t. */
        remainingMs: number;
        objectId: string | null;
      }
    | { kind: 'progress'; label: string; value: number; total: number; unit: string | null }
    | { kind: 'checklist'; title: string; items: ChecklistItem[] }
    | {
        kind: 'choices';
        question: string;
        options: string[];
        chosen: number | null;
        chosenVia: 'touch' | 'voice' | null;
      }
    | { kind: 'value'; label: string; value: string }
    | { kind: 'caution'; text: string }
  );

/** The data of a `widget.updated` annotation. */
export interface WidgetAnnotation {
  op: WidgetOp;
  id: string;
  seq: number;
  kind: WidgetKind;
  by: WidgetActor;
  stepId: string | null;
  /** The coach call that caused it, when there is one. */
  callId?: string;
  /** close only. */
  reason?: WidgetCloseReason;
  /** choose, tick and untick only. */
  item?: number;
  hand?: Handedness;
  via?: 'touch' | 'voice';
  /** The widget after the change; null after a close. */
  widget: RecordedWidget | null;
}

/** The annotation label every board change is recorded under. */
export const WIDGET_ANNOTATION = 'widget.updated';

export const WIDGET_LIMITS = {
  maxWidgets: 3,
  maxTimers: 2,
  timerLingerMs: 10_000,
  completeLingerMs: 4_000,
  chosenLingerMs: 1_500,
  stepChangeGraceMs: 1_200,
  choicesTtlMs: 90_000,
  unboundStaleMs: 600_000,
  voiceMatchMaxWords: 8,
  summaryMax: 600,
} as const;

/**
 * Code points every bundled widget face has (Inter 400/500/600, Inter Tight 600), inclusive.
 * Widget text is cleaned to these, so troika never falls back to fetching a font from its CDN.
 */
export const FONT_COVERAGE: readonly (readonly [number, number])[] = [
  [0x20, 0x7e],
  [0xa0, 0xac],
  [0xae, 0xff],
  [0x131, 0x131],
  [0x152, 0x153],
  [0x2013, 0x2014],
  [0x2018, 0x201a],
  [0x201c, 0x201e],
  [0x2026, 0x2026],
  [0x20ac, 0x20ac],
  [0x2122, 0x2122],
  [0x2212, 0x2212],
];
