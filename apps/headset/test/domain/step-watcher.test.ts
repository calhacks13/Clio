import {
  type ObjectSpec,
  parseProcedure,
  type StepCheckRequest,
  type StepCheckResponse,
} from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import type { AppEvents } from '../../src/domain/events';
import {
  StepWatcher,
  type StepWatcherOptions,
  stepLooks,
  type WatchTarget,
} from '../../src/domain/session/step-watcher';

// The step watcher: looks again soon after each answer, compares with the frame from the step's
// start, and tells the coach only what a couple of answers in a row agree on.

const STEP_A: WatchTarget = { lesson: 1, goal: 'g', step: { id: 'a', instruction: 'Do A.' } };

function setup(answers: (StepCheckResponse | Error)[], options: StepWatcherOptions = {}) {
  const bus = new Emitter<AppEvents>();
  const clock = new ManualClock(0);
  const asked: StepCheckRequest[] = [];
  const suggested: string[] = [];
  const wrong: AppEvents['step.looks_wrong'][] = [];
  const hazards: AppEvents['step.hazard'][] = [];
  bus.on('step.hazard', (e) => hazards.push(e));
  const watched: unknown[] = [];
  bus.on('step.looks_done', ({ stepId, image }) => suggested.push(`${stepId}:${image}`));
  bus.on('step.looks_wrong', (e) => wrong.push(e));
  bus.on('annotation', ({ label, data }) => {
    if (label === 'step.watch') watched.push(data);
  });
  let target: WatchTarget | null = STEP_A;
  let enabled = true;
  let frame = 0;
  /** How long the model takes to answer (ms of the fake clock). */
  let latencyMs = 0;
  const watcher = new StepWatcher({
    bus,
    clock,
    checker: {
      check: async (req) => {
        asked.push(req);
        clock.advance(latencyMs);
        const answer = answers.shift() ?? new Error('no answer');
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    // Every snapshot is a new frame: F1, F2, ...
    frames: {
      snapshots: async (max) =>
        Array.from({ length: max }, () => ({
          mimeType: 'image/jpeg' as const,
          data: `F${++frame}`,
        })),
    },
    target: () => target,
    enabled: () => enabled,
    options: {
      gapMs: 1000,
      quietMs: 500,
      repeatMs: 5000,
      maxFailures: 2,
      pauseMs: 10_000,
      ...options,
    },
  });
  const step = async (ms: number) => {
    await watcher.tick(clock.advance(ms));
  };
  return {
    bus,
    clock,
    asked,
    suggested,
    wrong,
    hazards,
    watched,
    step,
    setTarget: (t: WatchTarget | null) => {
      target = t;
    },
    setEnabled: (on: boolean) => {
      enabled = on;
    },
    setLatency: (ms: number) => {
      latencyMs = ms;
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
const milk: StepCheckResponse = {
  ...done,
  verdict: 'not_done',
  observation: 'holding the milk carton',
  progress: 20,
  wrong: 'picked up the milk, not the yogurt drink',
  evidence: { label: 'milk carton', point: [0.6, 0.45] },
};

describe('StepWatcher', () => {
  it('keeps the view from when a step gains focus and sends it with every look', async () => {
    const w = setup([notDone, notDone]);
    await w.step(0); // focus: F1 is the start
    await w.step(999);
    expect(w.asked).toEqual([]);
    await w.step(1);
    await w.step(1000);
    expect(w.asked.map((r) => [r.before?.map((i) => i.data), r.images.map((i) => i.data)])).toEqual(
      [
        [['F1'], ['F2']],
        [['F1'], ['F3']],
      ],
    );
  });

  it('looks again a gap after each answer, however long the answer took', async () => {
    const w = setup([notDone, notDone, notDone]);
    w.setLatency(1500);
    await w.step(0);
    await w.step(1000); // asks; the answer comes 1.5 s later
    expect(w.clock.now()).toBe(2500);
    await w.step(999);
    expect(w.asked).toHaveLength(1);
    await w.step(1);
    expect(w.asked).toHaveLength(2);
  });

  it('suggests a step only after two "done" answers in a row', async () => {
    const w = setup([done, notDone, done, done]);
    await w.step(0);
    for (let i = 0; i < 3; i++) await w.step(1000);
    expect(w.asked).toHaveLength(3);
    expect(w.suggested).toEqual([]); // done, not done, done
    await w.step(1000);
    expect(w.suggested).toEqual(['a:F5']); // the frame it judged last
  });

  it('suggests a step once, then leaves it alone for a while', async () => {
    const w = setup([done, done, done, done], { confirmations: 2 });
    await w.step(0);
    await w.step(1000);
    await w.step(1000);
    expect(w.suggested).toEqual(['a:F3']);
    await w.step(1000);
    await w.step(3000);
    expect(w.asked).toHaveLength(2); // not again so soon after a suggestion
    await w.step(1000);
    expect(w.asked).toHaveLength(3);
  });

  it('can suggest after a single answer when told to', async () => {
    const w = setup([done], { confirmations: 1 });
    await w.step(0);
    await w.step(1000);
    expect(w.suggested).toEqual(['a:F2']);
  });

  it('tells the coach once when the learner did something else, and keeps watching', async () => {
    const w = setup([milk, milk, milk, notDone, done, done]);
    await w.step(0);
    await w.step(1000);
    expect(w.wrong).toEqual([]);
    await w.step(1000);
    expect(w.wrong).toEqual([
      {
        t: 2000,
        stepId: 'a',
        wrong: 'picked up the milk, not the yogurt drink',
        observation: 'holding the milk carton',
        image: 'F3',
      },
    ]);
    await w.step(1000); // the same mistake again: the coach already knows
    expect(w.wrong).toHaveLength(1);
    for (let i = 0; i < 3; i++) await w.step(1000); // put it back, took the right one
    expect(w.asked).toHaveLength(6);
    expect(w.suggested).toEqual(['a:F7']);
  });

  it('warns of a hazard as soon as an answer names it, then not again for a minute', async () => {
    const knife = { ...notDone, hazard: 'kitchen knife next to cup A' };
    const w = setup([notDone, knife, knife, notDone, knife, knife, knife, knife]);
    await w.step(0);
    await w.step(1000);
    expect(w.hazards).toEqual([]);
    await w.step(1000);
    expect(w.hazards).toEqual([
      { t: 2000, stepId: 'a', hazard: 'kitchen knife next to cup A', image: 'F3' },
    ]);
    for (let i = 0; i < 3; i++) await w.step(1000); // within the minute: the coach already knows
    expect(w.hazards).toHaveLength(1);
    expect(w.watched.at(-1)).toMatchObject({ hazard: 'kitchen knife next to cup A' });
    await w.step(60_000);
    expect(w.hazards).toHaveLength(2);
    expect(w.suggested).toEqual([]);
  });

  it('can ask for a hazard to be named several times in a row', async () => {
    const knife = { ...notDone, hazard: 'kitchen knife next to cup A' };
    const w = setup([knife, notDone, knife, knife], { hazardConfirmations: 2 });
    for (let i = 0; i < 4; i++) await w.step(i === 0 ? 0 : 1000);
    expect(w.hazards).toEqual([]);
    await w.step(1000);
    expect(w.hazards).toHaveLength(1);
  });

  it("sends what the step's objects look like and the mistakes that look like success", async () => {
    const w = setup([notDone]);
    const objects = [{ id: 'yogurt', label: 'yogurt drink', look: 'small bottle, pink cap' }];
    const confusions = ['That is the milk. Take the bottle with the pink cap.'];
    w.setTarget({ ...STEP_A, objects, confusions });
    await w.step(0);
    await w.step(1000);
    expect(w.asked[0]).toEqual({
      goal: 'g',
      step: { id: 'a', instruction: 'Do A.' },
      images: [{ mimeType: 'image/jpeg', data: 'F2' }],
      before: [{ mimeType: 'image/jpeg', data: 'F1' }],
      objects,
      confusions,
    });
  });

  it('records progress, what went wrong and the object that decided it', async () => {
    const w = setup([milk, done]);
    await w.step(0);
    await w.step(1000);
    await w.step(1000);
    expect(w.watched).toEqual([
      {
        stepId: 'a',
        verdict: 'not_done',
        observation: 'holding the milk carton',
        model: 'm',
        latencyMs: 1,
        progress: 20,
        wrong: 'picked up the milk, not the yogurt drink',
        evidence: { label: 'milk carton', point: [0.6, 0.45] },
      },
      { stepId: 'a', verdict: 'done', observation: 'A is done', model: 'm', latencyMs: 1 },
    ]);
  });

  it('starts over on a new step: its own start frame and its own count', async () => {
    const w = setup([done, done, done]);
    await w.step(0); // F1: the start of A
    await w.step(1000); // done once on A
    w.setTarget({ lesson: 1, goal: 'g', step: { id: 'b', instruction: 'Do B.' } });
    await w.step(1000); // F3: the start of B
    await w.step(1000); // done once on B
    expect(w.suggested).toEqual([]);
    expect(w.asked.at(-1)?.before).toEqual([{ mimeType: 'image/jpeg', data: 'F3' }]);
    await w.step(1000);
    expect(w.suggested).toEqual(['b:F5']);
  });

  it('sends no start frame when told not to', async () => {
    const none = setup([notDone], { beforeFrames: 0 });
    await none.step(0);
    await none.step(1000);
    expect(none.asked[0]?.before).toBeUndefined();
    expect(none.asked[0]?.images).toEqual([{ mimeType: 'image/jpeg', data: 'F1' }]);
  });

  it('keeps quiet while anyone is talking, and when not in charge', async () => {
    const w = setup([notDone, notDone]);
    await w.step(0);
    w.bus.emit('coach.caption', { t: w.clock.now() + 900, role: 'user', text: 'hm', final: false });
    await w.step(1000);
    expect(w.asked).toEqual([]);
    await w.step(400);
    expect(w.asked).toHaveLength(1);
    expect(w.suggested).toEqual([]);
    w.setEnabled(false);
    await w.step(5000);
    expect(w.asked).toHaveLength(1);
  });

  it('drops an answer for a step that is no longer the target', async () => {
    const w = setup([done], { confirmations: 1 });
    await w.step(0);
    const look = w.step(1000); // the check is in flight...
    w.setTarget({ lesson: 1, goal: 'g', step: { id: 'b', instruction: 'Do B.' } }); // ...when focus moves
    await look;
    expect(w.asked.map((r) => r.step.id)).toEqual(['a']);
    expect(w.suggested).toEqual([]);
  });

  it('drops an answer that arrives after its lesson ended, even for a step with the same id', async () => {
    const w = setup([done], { confirmations: 1 });
    await w.step(0);
    const look = w.step(1000);
    w.setTarget({ lesson: 2, goal: 'g', step: { id: 'a', instruction: 'Do A.' } });
    await look;
    expect(w.asked.map((r) => r.step.id)).toEqual(['a']);
    expect(w.suggested).toEqual([]);
    expect(w.watched).toEqual([]);
  });

  it('pauses after repeated failures', async () => {
    const w = setup([new Error('503'), new Error('503'), done]);
    await w.step(0);
    await w.step(1000);
    await w.step(1000);
    expect(w.asked).toHaveLength(2);
    await w.step(5000);
    expect(w.asked).toHaveLength(2);
    await w.step(5000);
    expect(w.asked).toHaveLength(3);
    expect(w.watched[0]).toEqual({ stepId: 'a', error: '503' });
  });
});

describe('stepLooks', () => {
  const cups = 'abcdefgh'.split('');
  const procedure = parseProcedure({
    schema: 'clio.procedure/1',
    id: 'cups',
    version: 1,
    origin: { kind: 'curated' },
    title: 'Cups',
    summary: 'S',
    workspace: { size: [1, 1] },
    objects: cups.map((c) => ({
      id: `cup_${c}`,
      label: `cup ${c.toUpperCase()}`,
      placement: { method: 'detect' },
      ...(c === 'b' ? { tracking: { query: 'clear cup with a big letter B' } } : {}),
    })),
    steps: [
      {
        id: 'pour',
        instruction: 'Pour into every cup.',
        targets: cups.map((c) => `cup_${c}`),
        show: [{ object: 'cup_h', phrase: 'cup H', description: 'x'.repeat(300) }],
        success: { type: 'confirm' },
        mistakes: ['one', ' two ', 'three', 'four', 'five'].map((message) => ({
          kind: 'wrong_cup',
          message,
          when: { type: 'hand_near', object: 'cup_a' },
        })),
      },
      { id: 'look', instruction: 'Look.', success: { type: 'confirm' } },
    ],
  });
  const [pour, look] = procedure.steps;
  const objects: readonly ObjectSpec[] = procedure.objects;

  it('describes what the step shows first, then its targets, as many as the check takes', () => {
    const { objects: described, confusions } = pour ? stepLooks(pour, objects) : {};
    expect(
      described?.map((o) => [o.id, o.label, o.look.length === 300 ? 'x * 300' : o.look]),
    ).toEqual([
      ['cup_h', 'cup H', 'x * 300'],
      ['cup_a', 'cup A', 'cup A'],
      ['cup_b', 'cup B', 'clear cup with a big letter B'],
      ['cup_c', 'cup C', 'cup C'],
      ['cup_d', 'cup D', 'cup D'],
      ['cup_e', 'cup E', 'cup E'],
    ]);
    expect(confusions).toEqual(['one', 'two', 'three', 'four']);
  });

  it('says nothing more for a step without objects or mistakes', () => {
    expect(look ? stepLooks(look, objects) : null).toEqual({});
  });
});
