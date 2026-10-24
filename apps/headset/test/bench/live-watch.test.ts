import { ProcedureSchema } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import {
  FAILED_LOOK_GAP_MS,
  MIN_LOOK_GAP_MS,
  nextLookDelay,
  stepCheckHints,
  WatchSession,
} from '../../src/bench/live-watch';

// The bench's live watch: progress through a plan from the step watcher's answers, how often it
// looks, what it tells the watcher about a step, and swapping in a refined plan mid-lesson.

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
    expect(s.progress[0]).toEqual({
      status: 'done',
      by: 'watcher',
      startedAt: 0,
      endedAt: 2000,
      percent: 100,
    });
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

describe('WatchSession, step check v2', () => {
  it('never counts a "done" that names a mistake, and counts the wrong answers', () => {
    const s = new WatchSession(steps, 0);
    const twice = { autoAdvance: true, needed: 2 };
    s.record({ at: 1, step: 0, verdict: 'done' }, twice);
    const outcome = s.record(
      { at: 2, step: 0, verdict: 'done', wrong: 'picked up the milk, not the yogurt drink' },
      twice,
    );
    expect(outcome).toEqual({ streak: 0, advanced: false, suggest: false });
    expect(s.focus).toBe(0);
    expect(s.wrongCount).toBe(1);
    expect(s.looks.map((l) => l.n)).toEqual([2, 1]);
  });

  it('keeps how far along the focused step looks, and fills it when done', () => {
    const s = new WatchSession(steps, 0);
    s.record({ at: 1, step: 0, verdict: 'not_done', progress: 40 }, AUTO);
    expect(s.progress[0]?.percent).toBe(40);
    s.record({ at: 2, step: 1, verdict: 'not_done', progress: 90 }, AUTO);
    expect(s.progress[1]?.percent).toBeUndefined();
    s.record({ at: 3, step: 0, verdict: 'done', progress: 95 }, AUTO);
    expect(s.progress[0]?.percent).toBe(100);
    s.focusOn(0, 4);
    expect(s.progress[0]?.percent).toBeUndefined();
  });

  it('bumps the focus turn whenever a step gains focus', () => {
    const s = new WatchSession(steps, 0);
    const first = s.focusTurn;
    s.record({ at: 1, step: 0, verdict: 'not_done' }, AUTO);
    expect(s.focusTurn).toBe(first);
    s.markDone(0, 2);
    expect(s.focusTurn).toBe(first + 1);
    s.focusOn(0, 3);
    expect(s.focusTurn).toBe(first + 2);
  });
});

describe('WatchSession.refine', () => {
  const refined = ProcedureSchema.parse({
    schema: 'clio.procedure/1',
    id: 'ph-2',
    version: 1,
    title: 'pH, refined',
    summary: 'Indicator colors.',
    workspace: { size: [0.8, 0.6] },
    objects: [{ id: 'cup_a', label: 'cup A', placement: { method: 'detect' } }],
    steps: ['draw', 'acid-pour', 'acid-check', 'base'].map((id) => ({
      id,
      instruction: `Do ${id} in full.`,
      success: { type: 'confirm' },
    })),
  }).steps;

  it('swaps in the refined steps after the first, keeping step 1 and its clock', () => {
    const s = new WatchSession(steps, 0);
    s.record({ at: 500, step: 0, verdict: 'not_done', progress: 30 }, AUTO);
    s.refine(refined, 1, 1000);
    expect(s.steps.map((x) => x.id)).toEqual(['draw', 'acid-pour', 'acid-check', 'base']);
    expect(s.steps[0]?.instruction).toBe('Do draw.');
    expect(s.focus).toBe(0);
    expect(s.progress[0]).toEqual({ status: 'todo', startedAt: 0, percent: 30 });
    expect(s.progress.slice(1)).toEqual([
      { status: 'todo' },
      { status: 'todo' },
      { status: 'todo' },
    ]);
  });

  it('keeps outline steps already finished and moves on from there', () => {
    const s = new WatchSession(steps, 0);
    s.markDone(0, 10);
    s.markDone(1, 20);
    s.record({ at: 30, step: 2, verdict: 'not_done' }, AUTO);
    s.refine(refined, 1, 40);
    expect(s.steps.map((x) => x.id)).toEqual(['draw', 'acid', 'acid-check', 'base']);
    expect(s.progress.map((p) => p.status)).toEqual(['done', 'done', 'todo', 'todo']);
    expect(s.focus).toBe(2);
    expect(s.progress[2]?.startedAt).toBe(20);
    expect(s.streak).toBe(0);
  });

  it('keeps a step finished out of order when the refined plan keeps its id', () => {
    const s = new WatchSession(steps, 0);
    s.focusOn(2, 5);
    s.markDone(2, 6);
    expect(s.focus).toBe(0);
    s.refine(refined, 1, 10);
    expect(s.progress[3]).toMatchObject({ status: 'done', by: 'you' });
    expect(s.doneCount).toBe(1);
  });

  it('reopens a lesson that was complete when the refined plan has more to do', () => {
    const s = new WatchSession(steps, 0);
    for (const i of [0, 1, 2]) s.markDone(i, i + 1);
    expect(s.complete).toBe(true);
    s.refine(refined, 1, 50);
    expect(s.focus).toBe(3);
    expect(s.finishedAt).toBeNull();
    expect(s.progress[3]).toEqual({ status: 'todo', startedAt: 50 });
  });
});

describe('nextLookDelay', () => {
  it('looks again a moment after the answer, or on the interval', () => {
    expect(nextLookDelay(0, 1400)).toBe(MIN_LOOK_GAP_MS);
    expect(nextLookDelay(6000, 1500)).toBe(4500);
    expect(nextLookDelay(2000, 1900)).toBe(MIN_LOOK_GAP_MS);
    expect(nextLookDelay(0, 30, true)).toBe(FAILED_LOOK_GAP_MS);
    expect(nextLookDelay(10_000, 1000, true)).toBe(9000);
  });
});

describe('stepCheckHints', () => {
  const plan = ProcedureSchema.parse({
    schema: 'clio.procedure/1',
    id: 'fridge',
    version: 1,
    title: 'Yogurt drink',
    summary: 'Get a yogurt drink.',
    workspace: { size: [0.8, 0.6] },
    objects: [
      {
        id: 'yogurt',
        label: 'yogurt drink',
        placement: { method: 'detect' },
        tracking: { query: 'small pink bottle' },
      },
      { id: 'door', label: 'fridge door', placement: { method: 'detect' } },
      { id: 'milk', label: 'milk', placement: { method: 'detect' }, description: 'white carton' },
      { id: 'zone', label: 'zone', hidden: true, placement: { method: 'detect' } },
    ],
    steps: [
      {
        id: 'take',
        instruction: 'Take the yogurt drink.',
        targets: ['yogurt', 'door', 'zone', 'milk'],
        show: [
          {
            object: 'yogurt',
            phrase: 'pink yogurt bottle',
            description: 'Small pink plastic bottle with a foil lid, in the fridge door',
          },
        ],
        success: { type: 'confirm' },
        mistakes: [
          {
            kind: 'milk',
            message: 'That is the milk. Take the small pink bottle.',
            when: { type: 'hand_near', object: 'milk' },
          },
          {
            kind: 'milk_again',
            message: 'That is the milk. Take the small pink bottle.',
            when: { type: 'hand_near', object: 'milk' },
          },
        ],
      },
      { id: 'close', instruction: 'Close the door.', success: { type: 'confirm' } },
    ],
  });

  it('tells the watcher what the objects look like and the likely mix-ups', () => {
    expect(stepCheckHints(plan, 0)).toEqual({
      objects: [
        {
          id: 'yogurt',
          label: 'yogurt drink',
          look: 'Small pink plastic bottle with a foil lid, in the fridge door',
        },
        { id: 'door', label: 'fridge door', look: 'fridge door' },
        { id: 'milk', label: 'milk', look: 'white carton' },
      ],
      confusions: ['That is the milk. Take the small pink bottle.'],
    });
    expect(stepCheckHints(plan, 1)).toEqual({ objects: [], confusions: [] });
    expect(stepCheckHints(plan, 9)).toEqual({ objects: [], confusions: [] });
  });

  it('keeps within the step check limits', () => {
    const long = 'x'.repeat(400);
    const step = plan.steps[0];
    const show = step?.show[0];
    const mistake = step?.mistakes[0];
    if (!step || !show || !mistake) throw new Error('fixture');
    const many = {
      ...plan,
      steps: [
        {
          ...step,
          show: [{ ...show, description: long }],
          mistakes: [1, 2, 3, 4, 5].map((n) => ({
            ...mistake,
            kind: `m${n}`,
            message: `${n}${long}`,
          })),
        },
      ],
    };
    const hints = stepCheckHints(many, 0);
    expect(hints.objects[0]?.look).toHaveLength(300);
    expect(hints.confusions).toHaveLength(4);
    expect(hints.confusions.every((c) => c.length === 200)).toBe(true);
  });
});
