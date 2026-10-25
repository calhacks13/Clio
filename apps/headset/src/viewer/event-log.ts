import { type EpisodeEvent, isWidgetTool } from '@clio/protocol';
import { WIDGET_ANNOTATION, type WidgetAnnotation } from '../domain/widgets/types';
import { formatClock } from './episode-data';

// What the viewer's side panel lists for an event: the lesson, step, mistake, coach and object
// finder events, and on the coach's widgets the learner's answers and ticks and a timer running
// out, as one short line each. Everything else (pinches, narrations, status) is left out.

export type LogKind = 'lesson' | 'step' | 'done' | 'mistake' | 'coach' | 'learner' | 'finder';

export interface LogEntry {
  t: number;
  kind: LogKind;
  label: string;
  text: string;
}

const COMPLETED_BY = {
  check: 'Check passed',
  coach: 'Coach advanced',
  user: 'Learner advanced',
  skip: 'Skipped',
} as const;

/** The argument that says most about a coach tool call, in order of preference. */
const TOOL_DETAIL_ARGS = ['reason', 'message', 'goal', 'object_id', 'step_id'];
/** The same for a widget call (docs/widgets.md): its label, question, title, name or hazard. */
const WIDGET_DETAIL_ARGS = ['label', 'question', 'title', 'widget_id', 'text'];

type Entry = (kind: LogKind, label: string, text: string) => LogEntry;

export function logEntry(e: EpisodeEvent): LogEntry | null {
  const entry: Entry = (kind, label, text) => ({ t: e.t, kind, label, text });
  switch (e.type) {
    case 'procedure.started':
      return entry('lesson', 'Lesson', `Started, ${e.stepCount} steps`);
    case 'procedure.completed':
      return entry('lesson', 'Lesson', `Completed in ${formatClock(e.durationMs)}`);
    case 'procedure.aborted':
      return entry('lesson', 'Lesson', `Stopped: ${e.reason}`);
    case 'step.entered':
      return entry('step', `Step ${e.index + 1}`, e.instruction);
    case 'step.completed':
      return entry(
        'done',
        `Step ${e.index + 1}`,
        `${COMPLETED_BY[e.by]}${e.forced ? ' before its check' : ''}`,
      );
    case 'mistake.detected':
      return entry('mistake', 'Mistake', e.message);
    case 'coach.tool_call': {
      const keys = isWidgetTool(e.name) ? WIDGET_DETAIL_ARGS : TOOL_DETAIL_ARGS;
      const detail = keys.map((k) => e.args[k]).find((v) => typeof v === 'string');
      const name = e.name.replaceAll('_', ' ');
      return entry('coach', 'Coach', detail ? `${name}: ${detail}` : name);
    }
    case 'transcript':
      if (!e.final) return null;
      return e.role === 'coach'
        ? entry('coach', 'Coach', e.text)
        : entry('learner', 'Learner', e.text);
    case 'object.detected':
      return entry('finder', 'Finder', `${e.objectId} ${e.found ? 'found' : 'not found'}`);
    case 'annotation':
      return e.label === WIDGET_ANNOTATION ? widgetEntry(e.data, entry) : null;
    default:
      return null;
  }
}

/**
 * A widget change worth a line (docs/widgets.md): the learner's answer or tick, and a timer
 * running out. Showing, updating and closing are the coach's tool calls or need no line.
 */
function widgetEntry(data: unknown, entry: Entry): LogEntry | null {
  if (typeof data !== 'object' || data === null) return null;
  const { op, item, widget } = data as Partial<WidgetAnnotation>;
  if (!widget || (item !== undefined && typeof item !== 'number')) return null;
  // The data is read back unchecked (an annotation's data is unknown), so a field may be missing.
  switch (op) {
    case 'choose': {
      const option =
        widget.kind === 'choices' && item !== undefined ? widget.options?.[item] : null;
      return option ? entry('learner', 'Learner', `Chose "${option}"`) : null;
    }
    case 'tick':
    case 'untick': {
      const text =
        widget.kind === 'checklist' && item !== undefined ? widget.items?.[item]?.text : null;
      const verb = op === 'tick' ? 'Ticked' : 'Unticked';
      return text ? entry('learner', 'Learner', `${verb} "${text}"`) : null;
    }
    case 'done':
      return widget.kind === 'timer' && widget.label
        ? entry('lesson', 'Timer', `"${widget.label}" is up`)
        : null;
    default:
      return null;
  }
}

/** Log entries for events, in their order, skipping events the panel does not list. */
export function logEntries(events: readonly EpisodeEvent[]): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const e of events) {
    const entry = logEntry(e);
    if (entry) entries.push(entry);
  }
  return entries;
}
