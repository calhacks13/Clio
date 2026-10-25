import {
  type Handedness,
  parseToolArgs,
  WIDGET_KINDS,
  type WidgetKind,
  type WidgetToolName,
} from '@clio/protocol';
import { createLogger } from '../core/log';
import type { ToolCallInfo, ToolOutcome } from '../domain/coach/toolbox';
import type { WidgetBoard } from '../domain/widgets/board';
import type { Widget } from '../domain/widgets/types';

// window.__widgets, for tuning the widgets on the device without a conversation (?debug=1 or
// ?widgetDemo=, docs/widgets.md). Calls go straight to the board's tools, past CoachToolbox, so
// nothing is recorded as a coach.tool_call the coach never made: the board records them as
// widget.updated by 'debug'. A touch here is a learner's touch, and the coach hears it as one.

const log = createLogger('widgets');

/** The arguments each kind is shown with when none are given. */
export const SAMPLE_ARGS: Record<WidgetKind, Record<string, unknown>> = {
  timer: { seconds: 120, label: 'Glue sets' },
  progress: { label: 'Screws out', value: 2, total: 4 },
  checklist: { title: 'Gather', items: ['Funnel', 'Rag', 'Washer fluid'], done: ['Funnel'] },
  choices: { question: 'Which screwdriver do you have?', options: ['Phillips', 'Flat'] },
  value: { label: 'Torque', value: '25 N m' },
  caution: { text: 'The pan stays hot for 10 minutes' },
};

export interface WidgetDebug {
  /** Shows a kind as its show_<kind> tool would, validated the same way; SAMPLE_ARGS by default. */
  show(kind: WidgetKind, args?: Record<string, unknown>): ToolOutcome;
  /** clear_widget: an id, a kind, a label or 'all' (the default). */
  clear(widgetId?: string): ToolOutcome;
  /** A learner touching a checklist item or a choice option. */
  touch(widgetId: string, index: number, hand?: Handedness): void;
  /** What is on screen now, oldest first. */
  list(): readonly Widget[];
  /** Shows each kind with SAMPLE_ARGS, every kind by default; the board's caps still apply. */
  demo(kinds?: readonly WidgetKind[]): void;
}

/** No coach call is behind a debug change; the board records it without one. */
const CALL: ToolCallInfo = { callId: 'debug' };

/** Sets window.__widgets (in a browser) and returns the same calls. */
export function installWidgetDebug(board: WidgetBoard): WidgetDebug {
  const tools = board.handlers('debug');
  const run = (name: WidgetToolName, args: unknown): ToolOutcome => {
    const parsed = parseToolArgs(name, args);
    if (!parsed.ok) return parsed;
    // The board answers every tool at once (widget-board.test.ts holds it to that).
    const handler = tools[name] as (args: unknown, call: ToolCallInfo) => ToolOutcome;
    return handler(parsed.args, CALL);
  };
  const debug: WidgetDebug = {
    show: (kind, args = SAMPLE_ARGS[kind]) => run(`show_${kind}`, args),
    clear: (widgetId = 'all') => run('clear_widget', { widget_id: widgetId }),
    touch(widgetId, index, hand = 'right') {
      const widget = board.snapshot().widgets.find((w) => w.id === widgetId);
      if (widget?.kind === 'choices') board.touch({ type: 'choose', widgetId, index, hand });
      else if (widget?.kind === 'checklist') board.touch({ type: 'tick', widgetId, index, hand });
    },
    list: () => board.snapshot().widgets,
    demo(kinds = WIDGET_KINDS) {
      for (const kind of kinds) {
        const outcome = debug.show(kind);
        if (!outcome.ok) log.warn(`widget demo: ${kind} not shown (${outcome.error})`);
      }
    },
  };
  if (typeof window !== 'undefined') {
    (window as unknown as { __widgets: WidgetDebug }).__widgets = debug;
  }
  return debug;
}
