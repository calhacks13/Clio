import { timerRemaining } from './format';
import type { RecordedWidget, Widget } from './types';

// A widget as the dataset records it, in every widget.updated annotation. The recorder rebases
// only an event's own t, so nothing here is an absolute time: a timer records the time it had
// left at the annotation's t instead of when it ends.

export function recordedWidget(w: Widget, t: number): RecordedWidget {
  const base = { id: w.id, seq: w.seq, status: w.status, scope: w.scope, stepId: w.stepId };
  switch (w.kind) {
    case 'timer':
      return {
        ...base,
        kind: 'timer',
        label: w.label,
        durationMs: w.durationMs,
        remainingMs: Math.round(timerRemaining(w, t)),
        objectId: w.objectId,
      };
    case 'progress':
      return {
        ...base,
        kind: 'progress',
        label: w.label,
        value: w.value,
        total: w.total,
        unit: w.unit,
      };
    case 'checklist':
      return {
        ...base,
        kind: 'checklist',
        title: w.title,
        items: w.items.map(({ text, done }) => ({ text, done })),
      };
    case 'choices':
      return {
        ...base,
        kind: 'choices',
        question: w.question,
        options: [...w.options],
        chosen: w.chosen,
        chosenVia: w.chosenVia,
      };
    case 'value':
      return { ...base, kind: 'value', label: w.label, value: w.value };
    case 'caution':
      return { ...base, kind: 'caution', text: w.text };
  }
}
