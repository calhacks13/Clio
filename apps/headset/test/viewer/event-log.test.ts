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
