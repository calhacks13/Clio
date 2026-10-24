import type { StepCheckResponse } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import type { AppEvents } from '../../src/domain/events';
import { StepWatcher, type WatchTarget } from '../../src/domain/session/step-watcher';

function setup(answers: (StepCheckResponse | Error)[]) {
  const bus = new Emitter<AppEvents>();
  const clock = new ManualClock(0);
  const asked: string[] = [];
  const suggested: string[] = [];
  const watched: unknown[] = [];
  bus.on('step.looks_done', ({ stepId }) => suggested.push(stepId));
  bus.on('annotation', ({ label, data }) => {
    if (label === 'step.watch') watched.push(data);
  });
  let target: WatchTarget | null = {
    lesson: 1,
    goal: 'g',
    step: { id: 'a', instruction: 'Do A.' },
  };
  let enabled = true;
  const watcher = new StepWatcher({
    bus,
    clock,
    checker: {
      check: async (req) => {
        asked.push(req.step.id);
        const answer = answers.shift() ?? new Error('no answer');
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    frames: { snapshots: async () => [{ mimeType: 'image/jpeg', data: 'JPEG' }] },
    target: () => target,
    enabled: () => enabled,
    options: { intervalMs: 1000, quietMs: 500, repeatMs: 5000, maxFailures: 2, pauseMs: 10_000 },
  });
  const step = async (ms: number) => {
    await watcher.tick(clock.advance(ms));
  };
  return {
    bus,
    clock,
    asked,
    suggested,
    watched,
    step,
    setTarget: (t: WatchTarget | null) => {
      target = t;
    },
    setEnabled: (on: boolean) => {
      enabled = on;
    },
  };
}

const done: StepCheckResponse = {
  verdict: 'done',
  observation: 'A is done',
  model: 'm',
  latencyMs: 1,
};
const notDone: StepCheckResponse = { ...done, verdict: 'not_done', observation: 'not yet' };

describe('StepWatcher', () => {
  it('waits a full interval on a new step, then looks and suggests it once', async () => {
    const w = setup([done, done]);
    await w.step(0);
    await w.step(999);
    expect(w.asked).toEqual([]);
    await w.step(1);
    expect(w.asked).toEqual(['a']);
    expect(w.suggested).toEqual(['a']);
    await w.step(1000);
    expect(w.asked).toEqual(['a']); // not again so soon after a suggestion
    expect(w.watched).toEqual([
      { stepId: 'a', verdict: 'done', observation: 'A is done', model: 'm', latencyMs: 1 },
    ]);
  });

  it('keeps quiet while anyone is talking, and when not in charge', async () => {
    const w = setup([notDone, notDone]);
    await w.step(0);
    w.bus.emit('coach.caption', { t: w.clock.now() + 900, role: 'user', text: 'hm', final: false });
    await w.step(1000);
    expect(w.asked).toEqual([]);
    await w.step(500);
    expect(w.asked).toEqual(['a']);
    expect(w.suggested).toEqual([]);
    w.setEnabled(false);
    await w.step(5000);
    expect(w.asked).toEqual(['a']);
  });

  it('drops an answer for a step that is no longer the target', async () => {
    const w = setup([done]);
    await w.step(0);
    const look = w.step(1000); // the check is in flight...
    w.setTarget({ lesson: 1, goal: 'g', step: { id: 'b', instruction: 'Do B.' } }); // ...when focus moves
    await look;
    expect(w.asked).toEqual(['a']);
    expect(w.suggested).toEqual([]);
  });

  it('drops an answer that arrives after its lesson ended, even for a step with the same id', async () => {
    const w = setup([done]);
    await w.step(0);
    const look = w.step(1000);
    w.setTarget({ lesson: 2, goal: 'g', step: { id: 'a', instruction: 'Do A.' } });
    await look;
    expect(w.asked).toEqual(['a']);
    expect(w.suggested).toEqual([]);
    expect(w.watched).toEqual([]);
  });

  it('pauses after repeated failures', async () => {
    const w = setup([new Error('503'), new Error('503'), done]);
    await w.step(0);
    await w.step(1000);
    await w.step(1000);
    expect(w.asked).toEqual(['a', 'a']);
    await w.step(5000);
    expect(w.asked).toEqual(['a', 'a']);
    await w.step(6000);
    expect(w.asked).toEqual(['a', 'a', 'a']);
    expect(w.watched[0]).toEqual({ stepId: 'a', error: '503' });
  });
});
