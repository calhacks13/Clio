import { formatClock, formatCount, timerRemaining } from './format';
import { WIDGET_LIMITS, type Widget } from './types';

// The on_screen line: what the learner's widgets show, in words, for the coach. Every widget
// tool's result carries it, and so do the reconnect recap and cancel notices, so the coach never
// has to remember a widget or guess the time left on a timer. A widget is named by its id, the
// name clear_widget takes.

/** One widget, e.g. `timer "Glue sets" 1:52 left` or `value "Torque" 25 N m`. */
export function widgetLine(w: Widget, t: number): string {
  switch (w.kind) {
    case 'timer':
      return w.status === 'done'
        ? `${w.id} "${w.label}" done`
        : `${w.id} "${w.label}" ${formatClock(timerRemaining(w, t))} left`;
    case 'progress': {
      const count = formatCount(w.value, w.total, w.unit);
      return `${w.id} "${w.label}" ${count}${w.status === 'done' ? ' done' : ''}`;
    }
    case 'checklist': {
      const left = w.items.filter((item) => !item.done).map((item) => item.text);
      const count = `${w.items.length - left.length} of ${w.items.length} done`;
      return `${w.id} "${w.title}" ${count}${left.length > 0 ? `, left: ${left.join(', ')}` : ''}`;
    }
    case 'choices': {
      const chosen = w.chosen === null ? undefined : w.options[w.chosen];
      return `${w.id} "${w.question}" ${chosen === undefined ? 'waiting' : `answered "${chosen}"`}`;
    }
    case 'value':
      return `${w.id} "${w.label}" ${w.value}`;
    case 'caution':
      return `${w.id} "${w.text}"`;
  }
}

/** Every widget on screen, oldest first, in at most 600 characters; null when none is. */
export function summarise(widgets: readonly Widget[], t: number): string | null {
  if (widgets.length === 0) return null;
  const line = widgets.map((w) => widgetLine(w, t)).join('; ');
  const max = WIDGET_LIMITS.summaryMax;
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}
