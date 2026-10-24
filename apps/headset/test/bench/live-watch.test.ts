import { ProcedureSchema } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { WatchSession } from '../../src/bench/live-watch';

// The bench's live watch: progress through a plan from the step watcher's answers.

const { steps } = ProcedureSchema.parse({
  schema: 'clio.procedure/1',
  id: 'ph',
  version: 1,
  title: 'pH',
  summary: 'Indicator colors.',
  workspace: { size: [0.8, 0.6] },
  objects: [{ id: 'cup_a', label: 'cup A', placement: { method: 'detect' } }],
  steps: ['draw', 'acid', 'base'].map((id) => ({
    id,
    instruction: `Do ${id}.`,
    doneWhen: `${id} is done.`,
    success: { type: 'confirm' },
  })),
});

const AUTO = { autoAdvance: true, needed: 1 };

describe('WatchSession', () => {
  it('starts on the first step and moves on when a step looks done', () => {
    const s = new WatchSession(steps, 0);
    expect(s.focus).toBe(0);
    expect(s.record({ at: 1000, step: 0, verdict: 'not_done' }, AUTO)).toEqual({
      streak: 0,
      advanced: false,
      suggest: false,
    });
    expect(s.record({ at: 2000, step: 0, verdict: 'done' }, AUTO).advanced).toBe(true);
    expect(s.focus).toBe(1);
    expect(s.progress[0]).toEqual({ status: 'done', by: 'watcher', startedAt: 0, endedAt: 2000 });
    expect(s.progress[1]?.startedAt).toBe(2000);
    expect(s.looks.map((l) => l.verdict)).toEqual(['done', 'not_done']);
  });

  it('can need several answers of done in a row, and only suggests when it may not move on', () => {
    const s = new WatchSession(steps, 0);
    const twice = { autoAdvance: true, needed: 2 };
    s.record({ at: 1, step: 0, verdict: 'done' }, twice);
    s.record({ at: 2, step: 0, verdict: 'unsure' }, twice);
    expect(s.streak).toBe(0);
    s.record({ at: 3, step: 0, verdict: 'done' }, twice);
    expect(s.record({ at: 4, step: 0, verdict: 'done' }, twice).advanced).toBe(true);

    const manual = new WatchSession(steps, 0);
    expect(
      manual.record({ at: 1, step: 0, verdict: 'done' }, { autoAdvance: false, needed: 1 }),
    ).toEqual({ streak: 1, advanced: false, suggest: true });
    expect(manual.focus).toBe(0);
  });

  it('logs but ignores an answer about a step that lost focus, and errors', () => {
    const s = new WatchSession(steps, 0);
    s.markDone(0, 500);
    expect(s.record({ at: 900, step: 0, verdict: 'done' }, AUTO).advanced).toBe(false);
    expect(s.record({ at: 950, step: 1, error: 'timeout' }, AUTO).advanced).toBe(false);
    expect(s.focus).toBe(1);
    expect(s.progress[0]?.by).toBe('you');
    expect(s.looks).toHaveLength(2);
  });

  it('completes when no step is left, and reopens with back', () => {
    const s = new WatchSession(steps, 0);
    s.markDone(0, 10);
    s.skip(1, 20);
    s.record({ at: 30, step: 2, verdict: 'done' }, AUTO);
    expect(s.complete).toBe(true);
    expect(s.finishedAt).toBe(30);
    expect(s.doneCount).toBe(2);
    expect(s.elapsed(99)).toEqual({ step: 0, total: 30 });
    s.back(40);
    expect(s.focus).toBe(2);
    expect(s.progress[2]?.status).toBe('todo');
    expect(s.finishedAt).toBeNull();
  });

  it('starts a re-plan with the kept steps done, and never goes back into them', () => {
    const s = new WatchSession(steps, 0, 2);
    expect(s.focus).toBe(2);
    expect(s.progress.map((p) => p.by)).toEqual(['before', 'before', undefined]);
    s.back(5);
    expect(s.focus).toBe(2);
  });

  it('works on any step on request, reopening it', () => {
    const s = new WatchSession(steps, 0);
    s.markDone(0, 10);
    s.focusOn(0, 20);
    expect(s.focus).toBe(0);
    expect(s.progress[0]).toEqual({ status: 'todo', startedAt: 20 });
    s.focusOn(2, 30);
    s.record({ at: 40, step: 2, verdict: 'done' }, AUTO);
    expect(s.focus).toBe(0);
  });
});
