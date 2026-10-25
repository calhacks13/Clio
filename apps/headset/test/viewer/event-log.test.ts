import type { EpisodeEvent } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { logEntries, logEntry } from '../../src/viewer/event-log';

const at = <E extends Omit<EpisodeEvent, 't'>>(e: E) =>
  ({ t: 1500, ...e }) as unknown as EpisodeEvent;

describe('logEntry', () => {
  it('describes lesson, step and mistake events', () => {
    expect(
      logEntry(at({ type: 'procedure.started', procedureId: 'p', version: 1, stepCount: 5 })),
    ).toEqual({ t: 1500, kind: 'lesson', label: 'Lesson', text: 'Started, 5 steps' });
    expect(logEntry(at({ type: 'procedure.completed', durationMs: 65_000 }))?.text).toBe(
      'Completed in 1:05.0',
    );
    expect(logEntry(at({ type: 'procedure.aborted', reason: 'user quit' }))?.text).toBe(
      'Stopped: user quit',
    );
    expect(
      logEntry(
        at({ type: 'step.entered', stepId: 'a', index: 1, instruction: 'Pinch.', targets: [] }),
      ),
    ).toMatchObject({ kind: 'step', label: 'Step 2', text: 'Pinch.' });
    expect(
      logEntry(
        at({
          type: 'step.completed',
          stepId: 'a',
          index: 1,
          by: 'coach',
          forced: true,
          durationMs: 10,
        }),
      ),
    ).toMatchObject({ kind: 'done', label: 'Step 2', text: 'Coach advanced before its check' });
    expect(
      logEntry(
        at({
          type: 'mistake.detected',
          stepId: 'a',
          kind: 'wrong_cup',
          message: 'Use cup A',
          source: 'rule',
        }),
      ),
    ).toMatchObject({ kind: 'mistake', text: 'Use cup A' });
  });

  it('describes coach tool calls by their most telling argument', () => {
    const call = (name: string, args: Record<string, unknown>) =>
      logEntry(at({ type: 'coach.tool_call', callId: 'c1', name, args }))?.text;
    expect(call('advance_step', { reason: 'shirt is flat' })).toBe('advance step: shirt is flat');
    expect(call('highlight', { object_id: 'cup_a', style: 'target' })).toBe('highlight: cup_a');
    expect(call('show_demo', {})).toBe('show demo');
    expect(call('show_timer', { seconds: 120, label: 'Glue sets', object_id: 'cup_a' })).toBe(
      'show timer: Glue sets',
    );
    expect(call('show_choices', { question: 'Which one?', options: ['A', 'B'] })).toBe(
      'show choices: Which one?',
    );
    expect(call('show_checklist', { title: 'Gather', items: ['funnel', 'rag'] })).toBe(
      'show checklist: Gather',
    );
    expect(call('show_caution', { text: 'The pan stays hot' })).toBe(
      'show caution: The pan stays hot',
    );
    expect(call('show_value', { label: 'Torque', value: '25 N m' })).toBe('show value: Torque');
    expect(call('add_step', { text: 'Wipe the rim', done_when: 'the rim is dry' })).toBe(
      'add step',
    );
    expect(call('update_step', { step_id: 's2', text: 'Wipe it again' })).toBe('update step: s2');
    expect(call('clear_widget', { widget_id: 'all' })).toBe('clear widget: all');
    // Other calls keep the arguments they were named by before the widgets.
    expect(call('add_material', { label: 'funnel', look_for: 'a white funnel' })).toBe(
      'add material',
    );
    expect(call('look_closer', { question: 'Is the knife safe?' })).toBe('look closer');
  });

  it("lists the learner's answers and ticks on the widgets, and a timer running out", () => {
    const base = { seq: 1, status: 'done', scope: 'step', stepId: 'open' } as const;
    const widget = (data: Record<string, unknown>) =>
      logEntry(at({ type: 'annotation', label: 'widget.updated', data }));
    const choices = {
      ...base,
      id: 'choices',
      kind: 'choices',
      question: 'Which screwdriver do you have?',
      options: ['Phillips', 'Flat'],
      chosen: 0,
      chosenVia: 'touch',
    };
    expect(
      widget({
        op: 'choose',
        id: 'choices',
        kind: 'choices',
        by: 'learner',
        item: 0,
        hand: 'right',
        via: 'touch',
        widget: choices,
      }),
    ).toEqual({ t: 1500, kind: 'learner', label: 'Learner', text: 'Chose "Phillips"' });
    const checklist = {
      ...base,
      id: 'checklist',
      kind: 'checklist',
      title: 'Gather',
      items: [
        { text: 'Funnel', done: true },
        { text: 'Rag', done: false },
      ],
    };
    const ticked = {
      id: 'checklist',
      kind: 'checklist',
      by: 'learner',
      item: 0,
      widget: checklist,
    };
    expect(widget({ ...ticked, op: 'tick' })).toMatchObject({
      kind: 'learner',
      text: 'Ticked "Funnel"',
    });
    expect(widget({ ...ticked, op: 'untick', item: 1 })?.text).toBe('Unticked "Rag"');
    const timer = {
      ...base,
      id: 'timer',
      kind: 'timer',
      scope: 'lesson',
      label: 'Glue sets',
      durationMs: 120_000,
      remainingMs: 0,
      objectId: null,
    };
    expect(widget({ op: 'done', id: 'timer', kind: 'timer', by: 'app', widget: timer })).toEqual({
      t: 1500,
      kind: 'lesson',
      label: 'Timer',
      text: '"Glue sets" is up',
    });
  });

  it("leaves out the rest of a widget's life, other annotations and malformed data", () => {
    const timer = { id: 'timer', seq: 1, kind: 'timer', status: 'active', label: 'Tea' };
    const widget = (data: unknown) =>
      logEntry(at({ type: 'annotation', label: 'widget.updated', data }));
    expect(widget({ op: 'show', kind: 'timer', by: 'coach', widget: timer })).toBeNull();
    expect(widget({ op: 'update', kind: 'timer', by: 'coach', widget: timer })).toBeNull();
    expect(
      widget({ op: 'close', kind: 'timer', by: 'app', reason: 'done', widget: null }),
    ).toBeNull();
    expect(
      widget({ op: 'done', kind: 'progress', by: 'coach', widget: { kind: 'progress' } }),
    ).toBeNull();
    expect(
      widget({ op: 'choose', item: 5, widget: { kind: 'choices', options: ['A'] } }),
    ).toBeNull();
    expect(widget({ op: 'choose', item: 0, widget: { kind: 'choices' } })).toBeNull();
    expect(widget({ op: 'tick', item: 0, widget: { kind: 'checklist' } })).toBeNull();
    expect(widget({ op: 'done', widget: { kind: 'timer' } })).toBeNull();
    expect(widget(undefined)).toBeNull();
    expect(widget('choose')).toBeNull();
    expect(
      logEntry(
        at({ type: 'annotation', label: 'plan.updated', data: { op: 'done', widget: timer } }),
      ),
    ).toBeNull();
  });

  it('lists final speech by speaker and leaves out partials, pinches and narrations', () => {
    expect(
      logEntry(at({ type: 'transcript', role: 'user', text: 'Ready', final: true })),
    ).toMatchObject({ kind: 'learner', label: 'Learner', text: 'Ready' });
    expect(
      logEntry(at({ type: 'transcript', role: 'coach', text: 'Good', final: true })),
    ).toMatchObject({ kind: 'coach', label: 'Coach' });
    expect(
      logEntry(at({ type: 'transcript', role: 'coach', text: 'Go', final: false })),
    ).toBeNull();
    expect(logEntry(at({ type: 'coach.narration', kind: 'step', text: '[app] …' }))).toBeNull();
    expect(
      logEntry(
        at({ type: 'hand.pinch', hand: 'left', phase: 'start', point: [0, 0, 0], nearest: null }),
      ),
    ).toBeNull();
  });

  it('keeps event order and skips what it leaves out', () => {
    const events = [
      at({ type: 'coach.status', state: 'ready' }),
      at({ type: 'transcript', role: 'coach', text: 'Hi', final: true }),
      at({ type: 'procedure.aborted', reason: 'x' }),
    ];
    expect(logEntries(events).map((e) => e.kind)).toEqual(['coach', 'lesson']);
  });
});
