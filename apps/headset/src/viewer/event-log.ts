import type { EpisodeEvent } from '@clio/protocol';
import { formatClock } from './episode-data';

// What the viewer's side panel lists for an event: the lesson, step, mistake, coach and object
// finder events, as one short line each. Everything else (pinches, narrations, status) is left out.

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

export function logEntry(e: EpisodeEvent): LogEntry | null {
  const entry = (kind: LogKind, label: string, text: string): LogEntry => ({
    t: e.t,
    kind,
    label,
    text,
  });
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
      const detail = TOOL_DETAIL_ARGS.map((k) => e.args[k]).find((v) => typeof v === 'string');
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
