import { type ProcedureInput, parseProcedure } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { Emitter } from '../../src/core/emitter';
import type { AppEvents } from '../../src/domain/events';
import { ProcedureRunner } from '../../src/domain/procedure/runner';
import { ctx } from '../support/context';
import { pinchingHand } from '../support/hands';

const shoulder: [number, number, number] = [0.14, 0, -0.18];
const zone: [number, number, number] = [0.4, 0, -0.08];

const input: ProcedureInput = {
  schema: 'clio.procedure/1',
  id: 'fold',
  version: 2,
  title: 'Fold',
  summary: 'Fold a shirt.',
  workspace: { size: [0.8, 0.6] },
  objects: [
    { id: 'shoulder', label: 'shoulder dot', placement: { method: 'layout', position: shoulder } },
    { id: 'zone', label: 'too low', hidden: true, placement: { method: 'layout', position: zone } },
  ],
  steps: [
    {
      id: 'lay-flat',
      instruction: 'Lay the shirt flat.',
      success: { type: 'confirm' },
    },
    {
      id: 'pinch-shoulder',
      instruction: 'Pinch the shoulder dot.',
      targets: ['shoulder'],
      success: { type: 'pinch_near', object: 'shoulder', hand: 'left' },
      mistakes: [
        {
          kind: 'too_low',
          message: 'Slide up to the dot.',
          when: { type: 'pinch_near', object: 'zone', hand: 'left', radius: 0.05 },
          cooldownMs: 1000,
        },
      ],
      stuckAfterMs: 5000,
    },
  ],
};

function setup(options = {}) {
  const bus = new Emitter<AppEvents>();
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  bus.onAny((type, payload) =>
    events.push({ type: String(type), payload: payload as Record<string, unknown> }),
  );
  const runner = new ProcedureRunner(parseProcedure(input), bus, options);
  const objects = { shoulder, zone };
  const frame = (t: number, extra = {}) => ctx({ t, objects, ...extra });
  return { runner, events, frame, types: () => events.map((e) => e.type) };
}

describe('ProcedureRunner', () => {
  it('announces the procedure and enters the first step', () => {
    const { runner, events } = setup();
    runner.start(100);
    expect(events.map((e) => e.type)).toEqual(['procedure.started', 'step.entered']);
    expect(events[1]?.payload).toMatchObject({
      t: 100,
      stepId: 'lay-flat',
      index: 0,
      instruction: 'Lay the shirt flat.',
    });
  });

  it('completes a confirm step when the coach advances, without marking it forced', () => {
    const { runner, events, frame } = setup();
    runner.start(0);
    runner.update(frame(10));
    expect(runner.advance('coach', 'shirt is flat', 20)).toEqual({ ok: true, forced: false });
    expect(events.find((e) => e.type === 'step.completed')?.payload).toMatchObject({
      stepId: 'lay-flat',
      by: 'coach',
      forced: false,
      durationMs: 20,
    });
    expect(runner.state.step?.id).toBe('pinch-shoulder');
  });

  it('advances by itself when a step check passes', () => {
    const { runner, events, frame } = setup();
    runner.start(0);
    runner.advance('user', 'ready', 0);
    runner.update(frame(50, { left: pinchingHand(shoulder), pinching: { left: true } }));
    const completed = events.filter((e) => e.type === 'step.completed').map((e) => e.payload);
    expect(completed[1]).toMatchObject({ stepId: 'pinch-shoulder', by: 'check', forced: false });
    expect(events.at(-1)?.type).toBe('procedure.completed');
    expect(runner.state.status).toBe('completed');
  });

  it('labels a coach advance as forced when the check has not passed', () => {
    const { runner, frame } = setup();
    runner.start(0);
    runner.advance('coach', 'flat', 0);
    runner.update(frame(10));
    expect(runner.advance('coach', 'looked done to me', 20)).toEqual({ ok: true, forced: true });
  });

  it('refuses a forced coach advance when the policy forbids it', () => {
    const { runner, frame } = setup({ coachCanForce: false });
    runner.start(0);
    runner.advance('coach', 'flat', 0);
    runner.update(frame(10));
    const r = runner.advance('coach', 'trust me', 20);
    expect(r.ok).toBe(false);
    expect(runner.state.step?.id).toBe('pinch-shoulder');
  });

  it('fires a mistake on its rising edge and then respects the cooldown', () => {
    const { runner, events, frame } = setup();
    runner.start(0);
    runner.advance('user', 'ready', 0);
    const low = { left: pinchingHand(zone), pinching: { left: true } };
    runner.update(frame(100, low));
    runner.update(frame(200, low)); // still in the zone: no new edge
    runner.update(frame(300)); // left the zone
    runner.update(frame(400, low)); // new edge, but inside the cooldown
    runner.update(frame(700)); // left again
    runner.update(frame(1200, low)); // new edge after the cooldown
    const mistakes = events.filter((e) => e.type === 'mistake.detected').map((e) => e.payload.t);
    expect(mistakes).toEqual([100, 1200]);
  });

  it('tells the coach once when the learner seems stuck', () => {
    const { runner, events, frame } = setup();
    runner.start(0);
    runner.advance('user', 'ready', 1000);
    runner.update(frame(5999));
    runner.update(frame(6000));
    runner.update(frame(9000));
    expect(events.filter((e) => e.type === 'step.stuck').map((e) => e.payload.elapsedMs)).toEqual([
      5000,
    ]);
  });

  it('can jump to a step and abort', () => {
    const { runner, types } = setup();
    runner.start(0);
    expect(runner.goTo('pinch-shoulder', 10)).toBe(true);
    expect(runner.state.step?.id).toBe('pinch-shoulder');
    runner.abort('learner left', 20);
    expect(types().at(-1)).toBe('procedure.aborted');
    expect(runner.state.status).toBe('aborted');
  });

  it('completes steps in any order and focuses the first one still to do', () => {
    const { runner, events } = setup();
    runner.start(0);
    expect(runner.complete('pinch-shoulder', 'coach', 10)).toEqual({
      ok: true,
      forced: true,
      already: false,
    });
    expect(runner.state.step?.id).toBe('lay-flat');
    expect(runner.state.statuses).toEqual({ 'lay-flat': 'todo', 'pinch-shoulder': 'done' });
    expect(runner.complete('pinch-shoulder', 'coach', 20)).toMatchObject({
      ok: true,
      already: true,
    });
    runner.complete(null, 'user', 30);
    expect(events.at(-1)?.type).toBe('procedure.completed');
    const completed = events.filter((e) => e.type === 'step.completed').map((e) => e.payload);
    expect(completed.map((c) => [c.stepId, c.index, c.durationMs])).toEqual([
      ['pinch-shoulder', 1, 0],
      ['lay-flat', 0, 30],
    ]);
  });

  it('skips a step with a skip completion and moves on when it had focus', () => {
    const { runner, events } = setup();
    runner.start(0);
    expect(runner.skip('lay-flat', 40)).toEqual({ ok: true });
    expect(events.find((e) => e.type === 'step.completed')?.payload).toMatchObject({
      stepId: 'lay-flat',
      by: 'skip',
      forced: true,
      durationMs: 40,
    });
    expect(runner.state.step?.id).toBe('pinch-shoulder');
    expect(runner.skip('nope', 50)).toMatchObject({ ok: false });
  });

  it('reopens and refocuses a done step', () => {
    const { runner, types } = setup();
    runner.start(0);
    runner.complete(null, 'user', 10);
    expect(runner.focus('lay-flat', 20)).toEqual({ ok: true });
    expect(runner.state.step?.id).toBe('lay-flat');
    expect(runner.state.statuses['lay-flat']).toBe('todo');
    expect(types().filter((t) => t === 'step.entered')).toHaveLength(3);
    runner.complete(null, 'user', 30);
    expect(runner.reopen('lay-flat')).toEqual({ ok: true });
    expect(runner.state.step?.id).toBe('pinch-shoulder');
  });

  it('inserts and rewords steps without moving the focus, and validates them', () => {
    const { runner } = setup();
    runner.start(0);
    const step = {
      id: 'smooth',
      instruction: 'Smooth out the wrinkles.',
      doneWhen: 'the shirt has no wrinkles',
      targets: [],
      hand: 'either' as const,
      show: [],
      success: { type: 'confirm' as const, by: 'either' as const },
      mistakes: [],
    };
    expect(runner.insert(step, 'lay-flat')).toEqual({ ok: true });
    expect(runner.state.procedure.steps.map((s) => s.id)).toEqual([
      'lay-flat',
      'smooth',
      'pinch-shoulder',
    ]);
    expect(runner.state.step?.id).toBe('lay-flat');
    expect(runner.insert({ ...step, id: 'bad', targets: ['ghost'] }, null)).toMatchObject({
      ok: false,
    });
    expect(runner.edit('smooth', { instruction: 'Smooth it flat.' })).toEqual({ ok: true });
    runner.complete('smooth', 'coach', 5);
    expect(runner.edit('smooth', { instruction: 'Again.' })).toMatchObject({ ok: false });
  });

  it('matches a revised plan by step id, keeping statuses and the focus', () => {
    const { runner, types } = setup();
    runner.start(0);
    runner.complete('pinch-shoulder', 'coach', 10);
    const [layFlat] = runner.state.procedure.steps;
    if (!layFlat) throw new Error('no step');
    const revised = parseProcedure({
      ...input,
      steps: [
        { ...layFlat },
        { id: 'pinch-shoulder', instruction: 'Pinch it.', success: { type: 'confirm' } },
        { id: 'fold', instruction: 'Fold it.', success: { type: 'confirm' } },
      ],
    });
    const entered = types().filter((t) => t === 'step.entered').length;
    runner.replacePlan(revised, 20);
    expect(runner.state.statuses).toEqual({
      'lay-flat': 'todo',
      'pinch-shoulder': 'done',
      fold: 'todo',
    });
    expect(types().filter((t) => t === 'step.entered')).toHaveLength(entered);
    runner.complete(null, 'user', 30);
    expect(runner.state.step?.id).toBe('fold');
  });

  it('progresses on trusted positions only, while every position decides forced', () => {
    const { runner, frame } = setup();
    runner.start(0);
    runner.complete(null, 'user', 0);
    const pinch = { left: pinchingHand(shoulder), pinching: { left: true } };
    const none = { positions: { position: () => undefined }, inCharge: true };
    runner.update(frame(50, pinch), none);
    expect(runner.state.step?.id).toBe('pinch-shoulder');
    expect(runner.complete(null, 'coach', 60)).toMatchObject({ ok: true, forced: false });
  });

  it('never lets check state built on every position complete a step once trust is required', () => {
    const { runner, frame, types } = setup();
    runner.start(0);
    runner.complete(null, 'user', 0);
    const pinch = { left: pinchingHand(shoulder), pinching: { left: true } };
    const none = { position: () => undefined };
    // A frame where only the full tree sees the shoulder, while trust is not required...
    runner.update(frame(50), { positions: none, inCharge: true });
    // ...then the shoulder is pinched on positions only the full tree sees, with trust required.
    runner.update(frame(60, pinch), { positions: none, inCharge: true });
    expect(runner.state.step?.id).toBe('pinch-shoulder');
    expect(types().filter((t) => t === 'mistake.detected')).toEqual([]);
    // Without the requirement, the same frame completes it.
    runner.update(frame(70, pinch), { positions: none, inCharge: false });
    expect(runner.state.status).toBe('completed');
  });

  it('applies the no-forcing policy to steps that are not focused too', () => {
    const { runner } = setup({ coachCanForce: false });
    runner.start(0);
    expect(runner.complete('pinch-shoulder', 'coach', 10)).toMatchObject({ ok: false });
    expect(runner.state.statuses['pinch-shoulder']).toBe('todo');
    expect(runner.complete('pinch-shoulder', 'user', 20)).toMatchObject({ ok: true, forced: true });
  });
});
