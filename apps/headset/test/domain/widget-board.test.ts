import { type CoachToolArgs, type Procedure, parseProcedure, parseToolArgs } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import type { LessonView } from '../../src/domain/coach/ports';
import type { ToolOutcome } from '../../src/domain/coach/toolbox';
import type { AppEvents } from '../../src/domain/events';
import type { PlanView } from '../../src/domain/plan/recital';
import { WidgetBoard } from '../../src/domain/widgets/board';
import type { Widget, WidgetAnnotation } from '../../src/domain/widgets/types';

// The widget board: what the coach's show and clear calls put on the learner's screen, how long
// each widget stays, the learner's answers, and what every change records.

const procedure: Procedure = parseProcedure({
  schema: 'clio.procedure/1',
  id: 'ph',
  version: 1,
  title: 'pH test',
  summary: 'S',
  workspace: { size: [1, 1] },
  objects: [
    { id: 'cup_a', label: 'cup A', placement: { method: 'detect' } },
    { id: 'cup_b', label: 'cup B', placement: { method: 'detect' } },
  ],
  steps: [
    { id: 'acid', instruction: 'Add vinegar to cup A.', success: { type: 'elapsed', ms: 10 } },
    { id: 'look', instruction: 'Check the color.', success: { type: 'elapsed', ms: 10 } },
  ],
});

function planView(over: Partial<PlanView> = {}): PlanView {
  return {
    goal: 'Test an acid',
    title: 'pH test',
    rev: 1,
    focusId: 'acid',
    materials: [
      { id: 'cup_a', label: 'cup A' },
      { id: 'cup_b', label: 'cup B' },
    ],
    steps: [
      { id: 'acid', instruction: 'Add vinegar to cup A.', status: 'todo', uses: [], demo: false },
      { id: 'look', instruction: 'Check the color.', status: 'todo', uses: [], demo: false },
    ],
    ...over,
  };
}

type Seen = { type: string; payload: Record<string, unknown> };

function setup(initial: PlanView | null = planView(), lesson: Procedure | null = procedure) {
  const bus = new Emitter<AppEvents>();
  const clock = new ManualClock(1000);
  const seen: Seen[] = [];
  bus.onAny((type, payload) =>
    seen.push({ type: String(type), payload: payload as Record<string, unknown> }),
  );
  let plan = initial;
  const view: LessonView = {
    procedure: () => lesson,
    label: (id) => id,
    plan: () => plan,
  };
  const board = new WidgetBoard({ bus, clock, view });
  board.attach();
  const tools = board.handlers();
  let calls = 0;
  /** The handler's answer, which must not be a promise. */
  const settled = (outcome: ToolOutcome | Promise<ToolOutcome>): ToolOutcome => {
    if (outcome instanceof Promise) throw new Error('a widget handler returned a promise');
    return outcome;
  };
  const call = () => ({ callId: `fc_${++calls}` });
  const tool = {
    timer: (args: CoachToolArgs<'show_timer'>) => settled(tools.show_timer(args, call())),
    progress: (args: CoachToolArgs<'show_progress'>) => settled(tools.show_progress(args, call())),
    checklist: (args: CoachToolArgs<'show_checklist'>) =>
      settled(tools.show_checklist(args, call())),
    choices: (args: CoachToolArgs<'show_choices'>) => settled(tools.show_choices(args, call())),
    value: (args: CoachToolArgs<'show_value'>) => settled(tools.show_value(args, call())),
    caution: (text: string) => settled(tools.show_caution({ text }, call())),
    clear: (widget_id: string) => settled(tools.clear_widget({ widget_id }, call())),
  };
  const annotations = () =>
    seen
      .filter((e) => e.type === 'annotation' && e.payload.label === 'widget.updated')
      .map((e) => e.payload.data as WidgetAnnotation);
  const events = (type: keyof AppEvents) =>
    seen.filter((e) => e.type === type).map((e) => e.payload);
  const ids = () => board.snapshot().widgets.map((w) => w.id);
  const get = (id: string): Widget | undefined => board.snapshot().widgets.find((w) => w.id === id);
  const entered = (stepId: string) =>
    bus.emit('step.entered', { t: clock.now(), stepId, index: 0, instruction: 'x', targets: [] });
  const setPlan = (next: PlanView | null) => {
    plan = next;
  };
  return { bus, clock, board, tool, seen, annotations, events, ids, get, entered, setPlan };
}

const result = (outcome: ToolOutcome) => {
  if (!outcome.ok) throw new Error(`expected ok, got: ${outcome.error}`);
  return outcome.result;
};
const error = (outcome: ToolOutcome) => (outcome.ok ? null : outcome.error);

const GLUE = { seconds: 120, label: 'Glue sets' };
const SCREWS = { label: 'Screws out', value: 2, total: 4 };
const GATHER = { title: 'Gather', items: ['funnel', 'rag', 'washer fluid'], done: ['funnel'] };
const GATHERED = { title: 'Gather', items: ['funnel', 'rag'], done: ['funnel', 'rag'] };
const DRIVER = { question: 'Which screwdriver do you have?', options: ['Phillips', 'Flat'] };
const TORQUE = { label: 'Torque', value: '25 N m' };
const HOT = 'The pan stays hot for 10 minutes';

describe('WidgetBoard tools', () => {
  it('shows a timer, with the exact result and record', () => {
    const { tool, board } = setup();
    expect(tool.timer(GLUE)).toEqual({
      ok: true,
      result: { widget_id: 'timer', ends_in: '2:00', on_screen: 'timer "Glue sets" 2:00 left' },
    });
    expect(board.snapshot().widgets).toEqual([
      {
        id: 'timer',
        seq: 1,
        kind: 'timer',
        rev: 1,
        createdT: 1000,
        updatedT: 1000,
        status: 'active',
        doneT: null,
        closeAt: null,
        leaving: false,
        stepId: 'acid',
        scope: 'lesson',
        label: 'Glue sets',
        durationMs: 120_000,
        endT: 121_000,
        objectId: null,
      },
    ]);
  });

  it('shows each other kind, with the exact result', () => {
    const { tool, clock } = setup();
    expect(result(tool.progress(SCREWS))).toEqual({
      widget_id: 'progress',
      progress: '2 of 4',
      done: false,
      on_screen: 'progress "Screws out" 2 of 4',
    });
    expect(result(tool.checklist(GATHER))).toEqual({
      widget_id: 'checklist',
      done: '1 of 3',
      on_screen:
        'progress "Screws out" 2 of 4; checklist "Gather" 1 of 3 done, left: rag, washer fluid',
    });
    expect(result(tool.clear('all'))).toEqual({
      cleared: ['progress', 'checklist'],
      on_screen: 'nothing',
    });
    clock.advance(10);
    expect(result(tool.choices(DRIVER))).toEqual({
      widget_id: 'choices',
      on_screen: 'choices "Which screwdriver do you have?" waiting',
    });
    expect(result(tool.value(TORQUE))).toEqual({
      widget_id: 'value',
      on_screen: 'choices "Which screwdriver do you have?" waiting; value "Torque" 25 N m',
    });
    expect(result(tool.caution(HOT))).toEqual({
      widget_id: 'caution',
      on_screen:
        'choices "Which screwdriver do you have?" waiting; value "Torque" 25 N m; caution "The pan stays hot for 10 minutes"',
    });
    expect(result(tool.clear('Torque'))).toEqual({
      cleared: ['value'],
      on_screen:
        'choices "Which screwdriver do you have?" waiting; caution "The pan stays hot for 10 minutes"',
    });
  });

  it('answers synchronously, never with a promise', () => {
    const { board } = setup();
    const tools = board.handlers();
    const info = { callId: 'fc_1' };
    const outcomes = [
      tools.show_timer(GLUE, info),
      tools.show_progress(SCREWS, info),
      tools.show_checklist(GATHER, info),
      tools.show_choices(DRIVER, info),
      tools.show_value(TORQUE, info),
      tools.show_caution({ text: HOT }, info),
      tools.clear_widget({ widget_id: 'all' }, info),
    ];
    for (const outcome of outcomes) {
      expect(outcome).not.toBeInstanceOf(Promise);
      expect(outcome).toHaveProperty('ok');
    }
  });

  it('gives exact errors', () => {
    const { tool } = setup();
    expect(error(tool.checklist({ title: 'Gather', items: ['Rag', 'rag.'] }))).toBe(
      'The items must be different.',
    );
    expect(error(tool.choices({ question: 'Which one?', options: ['Flat', 'FLAT!'] }))).toBe(
      'The options must be different.',
    );
    expect(error(tool.timer({ seconds: 60, label: '🔥' }))).toBe('label needs letters or numbers.');
    expect(error(tool.progress({ label: '✓', value: 1, total: 2 }))).toBe(
      'label needs letters or numbers.',
    );
    expect(error(tool.checklist({ title: '...', items: ['a', 'b'] }))).toBe(
      'title needs letters or numbers.',
    );
    expect(error(tool.checklist({ title: 'Gather', items: ['rag', '👍'] }))).toBe(
      'items needs letters or numbers.',
    );
    expect(error(tool.choices({ question: '???', options: ['a', 'b'] }))).toBe(
      'question needs letters or numbers.',
    );
    expect(error(tool.choices({ question: 'Which?', options: ['a', '✓'] }))).toBe(
      'options needs letters or numbers.',
    );
    expect(error(tool.value({ label: 'Torque', value: '••' }))).toBe(
      'value needs letters or numbers.',
    );
    expect(error(tool.caution('⚠️🔥'))).toBe('text needs letters or numbers.');
    expect(error(tool.clear('paint'))).toBe(
      'Nothing called "paint" is on screen. On screen: nothing.',
    );
    tool.timer(GLUE);
    expect(error(tool.clear('progress'))).toBe(
      'Nothing called "progress" is on screen. On screen: timer "Glue sets" 2:00 left.',
    );
    expect(result(tool.clear('all'))).toEqual({ cleared: ['timer'], on_screen: 'nothing' });
    expect(result(tool.clear('all'))).toEqual({ cleared: [], on_screen: 'nothing' });
  });

  it('refuses text that cleaning made longer than its limit, as the contract refuses long text', () => {
    const { tool, board, annotations } = setup();
    /** The contract's own error for the same fields too long. */
    const contract = (...args: Parameters<typeof parseToolArgs>) => {
      const parsed = parseToolArgs(...args);
      if (parsed.ok) throw new Error('expected the contract to refuse it');
      return parsed.error;
    };
    // 16 characters as written, 19 once the arrow is a word.
    expect(error(tool.timer({ seconds: 60, label: 'Cup A→cup B drip' }))).toBe(
      contract('show_timer', { seconds: 60, label: 'a'.repeat(17) }),
    );
    // Every field past its limit, as the contract lists them: 12 > 11, and the ligatures 26 > 24.
    expect(error(tool.checklist({ title: 'Pots→pans', items: ['rag', 'ﬁ'.repeat(13)] }))).toBe(
      contract('show_checklist', { title: 'a'.repeat(12), items: ['rag', 'a'.repeat(25)] }),
    );
    expect(error(tool.choices({ question: 'Which?', options: ['Pour→stir now', 'Flat'] }))).toBe(
      contract('show_choices', { question: 'Which?', options: ['a'.repeat(15), 'Flat'] }),
    );
    expect(error(tool.value({ label: 'Gap', value: '≥ 25 mm or more' }))).toBe(
      contract('show_value', { label: 'Gap', value: 'a'.repeat(17) }),
    );
    expect(error(tool.progress({ label: 'Salt', value: 1, total: 4, unit: 'kΩ→MΩ' }))).toBe(
      contract('show_progress', { label: 'Salt', value: 1, total: 4, unit: 'a'.repeat(9) }),
    );
    expect(error(tool.caution(`${'a'.repeat(57)}→ok`))).toBe(
      contract('show_caution', { text: 'a'.repeat(61) }),
    );
    expect(board.snapshot().widgets).toEqual([]);
    expect(annotations()).toEqual([]);
    // Up to the limit once cleaned, it shows.
    expect(result(tool.timer({ seconds: 60, label: 'Cup A→cup B' }))).toMatchObject({
      widget_id: 'timer',
    });
  });

  it('cleans what the coach writes before showing it', () => {
    const { tool, get } = setup();
    tool.checklist({ title: 'GATHER ALL.', items: ['Funnel.', 'Rag 🧽', 'Bottle → cap'] });
    expect(get('checklist')).toMatchObject({
      title: 'Gather all',
      items: [
        { text: 'Funnel', done: false },
        { text: 'Rag', done: false },
        { text: 'Bottle to cap', done: false },
      ],
    });
    tool.value({ label: 'Torque', value: '25 N·m' });
    expect(get('value')).toMatchObject({ value: '25 N m' });
  });

  it('clears by id, by kind, by label or everything', () => {
    const { tool, ids } = setup();
    tool.timer(GLUE);
    tool.timer({ seconds: 60, label: 'Paint' });
    tool.value(TORQUE);
    expect(result(tool.clear('timer-2'))).toMatchObject({ cleared: ['timer-2'] });
    tool.timer({ seconds: 60, label: 'Paint' });
    expect(result(tool.clear('glue sets'))).toMatchObject({ cleared: ['timer'] });
    expect(result(tool.clear(' Value '))).toMatchObject({ cleared: ['value'] });
    expect(ids()).toEqual(['timer-2']);
    expect(result(tool.clear('timer'))).toMatchObject({ cleared: ['timer-2'] });
    expect(ids()).toEqual([]);
    // A kind with nothing of it on screen falls through to the labels.
    tool.caution('Value');
    expect(result(tool.clear('value'))).toMatchObject({ cleared: ['caution'] });
  });
});

describe('WidgetBoard timers', () => {
  it('names timers timer then timer-2, and never reuses a seq', () => {
    const { tool, get, ids } = setup();
    expect(result(tool.timer(GLUE))).toMatchObject({ widget_id: 'timer' });
    expect(result(tool.timer({ seconds: 30, label: 'Paint' }))).toMatchObject({
      widget_id: 'timer-2',
    });
    tool.clear('timer');
    expect(result(tool.timer({ seconds: 30, label: 'Tea' }))).toMatchObject({
      widget_id: 'timer',
    });
    expect(ids()).toEqual(['timer-2', 'timer']);
    expect(get('timer')?.seq).toBe(3);
    expect(get('timer-2')?.seq).toBe(2);
  });

  it('restarts a timer called again with the same label', () => {
    const { tool, clock, get, annotations } = setup();
    tool.timer(GLUE);
    clock.advance(30_000);
    expect(result(tool.timer({ seconds: 60, label: 'glue sets.' }))).toEqual({
      widget_id: 'timer',
      ends_in: '1:00',
      restarted: true,
      on_screen: 'timer "glue sets" 1:00 left',
    });
    expect(get('timer')).toMatchObject({
      seq: 1,
      rev: 2,
      createdT: 1000,
      updatedT: 31_000,
      durationMs: 60_000,
      endT: 91_000,
      status: 'active',
    });
    expect(annotations().map((a) => a.op)).toEqual(['show', 'update']);
  });

  it('restarts a timer that already ran out', () => {
    const { tool, clock, board, get } = setup();
    tool.timer({ seconds: 10, label: 'Tea' });
    board.tick(clock.advance(10_000));
    expect(get('timer')?.status).toBe('done');
    expect(result(tool.timer({ seconds: 10, label: 'Tea' }))).toMatchObject({ restarted: true });
    expect(get('timer')).toMatchObject({ status: 'active', doneT: null, closeAt: null });
  });

  it('runs two timers at most: a done one makes room, two running refuse a third', () => {
    const { tool, clock, board, ids } = setup();
    tool.timer(GLUE);
    tool.timer({ seconds: 30, label: 'Paint' });
    expect(error(tool.timer({ seconds: 30, label: 'Tea' }))).toBe(
      'Two timers are running ("Glue sets", "Paint"). Clear one with clear_widget first.',
    );
    board.tick(clock.advance(30_000));
    expect(result(tool.timer({ seconds: 30, label: 'Tea' }))).toEqual({
      widget_id: 'timer-2',
      ends_in: '0:30',
      replaced: 'timer-2 "Paint" done',
      on_screen: 'timer "Glue sets" 1:30 left; timer-2 "Tea" 0:30 left',
    });
    expect(ids()).toEqual(['timer', 'timer-2']);
  });

  it('keeps a valid object and notes an unknown one', () => {
    const { tool, get } = setup();
    tool.timer({ ...GLUE, object_id: 'cup_a' });
    expect(get('timer')).toMatchObject({ objectId: 'cup_a' });
    expect(result(tool.timer({ seconds: 30, label: 'Paint', object_id: 'cup_z' }))).toEqual({
      widget_id: 'timer-2',
      ends_in: '0:30',
      note: 'No object "cup_z" in the plan, so it shows without one. Objects: cup_a, cup_b.',
      on_screen: 'timer "Glue sets" 2:00 left; timer-2 "Paint" 0:30 left',
    });
    expect(get('timer-2')).toMatchObject({ objectId: null });
    // A restart with an unknown object keeps the one it had.
    tool.timer({ ...GLUE, object_id: 'cup_z' });
    expect(get('timer')).toMatchObject({ objectId: 'cup_a' });

    const outside = setup(null, null);
    expect(result(outside.tool.timer({ ...GLUE, object_id: 'cup_a' }))).toMatchObject({
      note: 'No object "cup_a" in the plan, so it shows without one. Objects: none.',
    });
    expect(outside.get('timer')).toMatchObject({ stepId: null, objectId: null });

    const curated = setup(null);
    curated.tool.timer({ ...GLUE, object_id: 'cup_b' });
    expect(curated.get('timer')).toMatchObject({ objectId: 'cup_b' });
  });

  it('ends a timer once, at its exact end even on a late frame, and closes it 10 s later', () => {
    const { tool, board, get, annotations, events } = setup();
    tool.timer(GLUE);
    board.tick(120_999);
    expect(get('timer')?.status).toBe('active');
    board.tick(121_000);
    expect(get('timer')).toMatchObject({
      status: 'done',
      doneT: 121_000,
      closeAt: 131_000,
      updatedT: 1000,
    });
    board.tick(121_016);
    expect(events('widget.timer_done')).toEqual([
      { t: 121_000, widgetId: 'timer', label: 'Glue sets', duration: '2:00' },
    ]);
    board.tick(130_999);
    expect(get('timer')).toBeDefined();
    board.tick(131_000);
    expect(get('timer')).toBeUndefined();
    expect(annotations().map((a) => [a.op, a.by, a.reason])).toEqual([
      ['show', 'coach', undefined],
      ['done', 'app', undefined],
      ['close', 'app', 'done'],
    ]);

    const late = setup();
    late.tool.timer({ seconds: 10, label: 'Tea' });
    late.board.tick(15_000);
    expect(late.get('timer')).toMatchObject({ status: 'done', doneT: 11_000, closeAt: 21_000 });
    expect(late.events('widget.timer_done')).toEqual([
      { t: 15_000, widgetId: 'timer', label: 'Tea', duration: '0:10' },
    ]);
  });

  it('is waiting while a timer runs', () => {
    const { tool, clock, board } = setup();
    expect(board.waiting()).toBe(false);
    tool.value(TORQUE);
    expect(board.waiting()).toBe(false);
    tool.timer({ seconds: 10, label: 'Tea' });
    expect(board.waiting()).toBe(true);
    board.tick(clock.advance(10_000));
    expect(board.waiting()).toBe(false);
  });
});

describe('WidgetBoard capacity', () => {
  it('evicts the evictable widget changed least recently to show a fourth', () => {
    const { tool, clock, ids, annotations } = setup();
    tool.value(TORQUE);
    clock.advance(10);
    tool.progress(SCREWS);
    clock.advance(10);
    tool.checklist(GATHER);
    clock.advance(10);
    tool.value({ label: 'Torque', value: '30 N m' });
    clock.advance(10);
    expect(result(tool.timer(GLUE))).toEqual({
      widget_id: 'timer',
      ends_in: '2:00',
      replaced: 'progress "Screws out" 2 of 4',
      on_screen:
        'value "Torque" 30 N m; checklist "Gather" 1 of 3 done, left: rag, washer fluid; timer "Glue sets" 2:00 left',
    });
    expect(ids()).toEqual(['value', 'checklist', 'timer']);
    expect(annotations().find((a) => a.op === 'close')).toMatchObject({
      id: 'progress',
      by: 'coach',
      reason: 'evicted',
      callId: 'fc_5',
      widget: null,
    });
  });

  it('evicts an answered question or a done timer, never a running one, an open one or the caution', () => {
    const { tool, clock, board, ids } = setup();
    tool.caution(HOT);
    tool.timer(GLUE);
    tool.choices(DRIVER);
    expect(error(tool.value(TORQUE))).toBe(
      'Three widgets are on screen and none can go yet (caution "The pan stays hot for 10 minutes"; timer "Glue sets" 2:00 left; choices "Which screwdriver do you have?" waiting). Clear one with clear_widget first.',
    );
    clock.advance(1000);
    board.touch({ type: 'choose', widgetId: 'choices', index: 0, hand: 'right' });
    expect(result(tool.value(TORQUE))).toMatchObject({
      replaced: 'choices "Which screwdriver do you have?" answered "Phillips"',
    });
    expect(ids()).toEqual(['caution', 'timer', 'value']);
    board.tick(121_000);
    expect(result(tool.progress(SCREWS))).toMatchObject({ replaced: 'timer "Glue sets" done' });
    expect(ids()).toEqual(['caution', 'value', 'progress']);
  });

  it('updates a kind in place without needing room', () => {
    const { tool, ids } = setup();
    tool.timer(GLUE);
    tool.caution(HOT);
    tool.choices(DRIVER);
    expect(result(tool.caution('Mind the blade'))).toEqual({
      widget_id: 'caution',
      on_screen:
        'timer "Glue sets" 2:00 left; caution "Mind the blade"; choices "Which screwdriver do you have?" waiting',
    });
    expect(ids()).toEqual(['timer', 'caution', 'choices']);
  });
});

describe('WidgetBoard progress and checklists', () => {
  it('clamps a progress value, rounds it and lingers 4 s once done', () => {
    const { tool, clock, board, get } = setup();
    expect(
      result(tool.progress({ label: 'Poured', value: 120.46, total: 250, unit: 'mL' })),
    ).toEqual({
      widget_id: 'progress',
      progress: '120.5 of 250 mL',
      done: false,
      on_screen: 'progress "Poured" 120.5 of 250 mL',
    });
    clock.advance(1000);
    expect(result(tool.progress({ label: 'Poured', value: 300, total: 250, unit: 'mL' }))).toEqual({
      widget_id: 'progress',
      progress: '250 of 250 mL',
      done: true,
      note: 'value was more than total, so it shows 250 of 250 mL.',
      on_screen: 'progress "Poured" 250 of 250 mL done',
    });
    expect(get('progress')).toMatchObject({
      value: 250,
      status: 'done',
      doneT: 2000,
      closeAt: 6000,
    });
    clock.advance(1000);
    tool.progress({ label: 'Poured', value: 250, total: 250, unit: 'mL' });
    expect(get('progress')).toMatchObject({ doneT: 2000, closeAt: 6000 });
    board.tick(5999);
    expect(get('progress')).toBeDefined();
    board.tick(6000);
    expect(get('progress')).toBeUndefined();
  });

  it('judges done on the count as shown: a total rounds to one decimal as the value does', () => {
    const { tool, get } = setup();
    // 1.33 shows as 1.3: a value that reaches it must not read 1.3 of 1.3 and never finish.
    expect(
      result(tool.progress({ label: 'Flour', value: 1.33, total: 1.33, unit: 'cups' })),
    ).toEqual({
      widget_id: 'progress',
      progress: '1.3 of 1.3 cups',
      done: true,
      on_screen: 'progress "Flour" 1.3 of 1.3 cups done',
    });
    expect(get('progress')).toMatchObject({ value: 1.3, total: 1.3, status: 'done' });
    expect(result(tool.progress({ label: 'Flour', value: 1, total: 1.33, unit: 'cups' }))).toEqual({
      widget_id: 'progress',
      progress: '1 of 1.3 cups',
      done: false,
      on_screen: 'progress "Flour" 1 of 1.3 cups',
    });
    // A total too small to show stays the least it can show.
    expect(result(tool.progress({ label: 'Salt', value: 0, total: 0.04 }))).toMatchObject({
      progress: '0 of 0.1',
      done: false,
    });
  });

  it('goes back to active when the value drops below the total again', () => {
    const { tool, get } = setup();
    tool.progress({ label: 'Screws out', value: 4, total: 4 });
    tool.progress({ label: 'Screws out', value: 3, total: 4 });
    expect(get('progress')).toMatchObject({ status: 'active', doneT: null, closeAt: null });
    expect(get('progress')).toMatchObject({ unit: null });
  });

  it('keeps a unit that is a symbol alone, and drops one with nothing left', () => {
    const { tool, get } = setup();
    expect(
      result(tool.progress({ label: 'Charge', value: 40, total: 100, unit: '%' })),
    ).toMatchObject({ progress: '40 of 100 %' });
    expect(get('progress')).toMatchObject({ unit: '%' });
    tool.progress({ label: 'Charge', value: 50, total: 100, unit: '🔋' });
    expect(get('progress')).toMatchObject({ unit: null });
  });

  it('matches done entries to items, and lists the ones that match nothing', () => {
    const { tool, get } = setup();
    expect(
      result(
        tool.checklist({
          title: 'Gather',
          items: ['Small funnel', 'Rag', 'Washer fluid'],
          done: ['funnel', '2', 'sponge'],
        }),
      ),
    ).toEqual({
      widget_id: 'checklist',
      done: '2 of 3',
      unmatched: ['sponge'],
      on_screen: 'checklist "Gather" 2 of 3 done, left: Washer fluid',
    });
    expect(get('checklist')).toMatchObject({
      items: [
        { text: 'Small funnel', done: true },
        { text: 'Rag', done: true },
        { text: 'Washer fluid', done: false },
      ],
    });
  });

  it('keeps items ticked by touch across an upsert, and is done with a 4 s linger', () => {
    const { tool, clock, board, get, events } = setup();
    tool.checklist({ title: 'Gather', items: ['funnel', 'rag', 'washer fluid'] });
    board.touch({ type: 'tick', widgetId: 'checklist', index: 1, hand: 'left' });
    expect(events('widget.ticked')).toEqual([
      {
        t: 1000,
        widgetId: 'checklist',
        title: 'Gather',
        item: 'rag',
        done: true,
        doneCount: 1,
        total: 3,
      },
    ]);
    clock.advance(500);
    expect(
      result(tool.checklist({ title: 'Gather', items: ['funnel', 'Rag', 'washer fluid', 'cap'] })),
    ).toMatchObject({ done: '1 of 4' });
    expect(get('checklist')).toMatchObject({
      items: [
        { text: 'funnel', done: false },
        { text: 'Rag', done: true },
        { text: 'washer fluid', done: false },
        { text: 'cap', done: false },
      ],
    });
    result(
      tool.checklist({
        title: 'Gather',
        items: ['funnel', 'Rag', 'washer fluid', 'cap'],
        done: ['funnel', 'cap'],
      }),
    );
    board.touch({ type: 'tick', widgetId: 'checklist', index: 2, hand: 'right' });
    expect(get('checklist')).toMatchObject({ status: 'done', doneT: 1500, closeAt: 5500 });
    expect(events('widget.ticked').at(-1)).toMatchObject({ done: true, doneCount: 4, total: 4 });
    board.touch({ type: 'tick', widgetId: 'checklist', index: 2, hand: 'right' });
    expect(get('checklist')).toMatchObject({ status: 'active', doneT: null, closeAt: null });
    expect(events('widget.ticked').at(-1)).toMatchObject({
      item: 'washer fluid',
      done: false,
      doneCount: 3,
    });
  });

  it('ignores touches on stale ids and indices', () => {
    const { tool, board, seen } = setup();
    tool.checklist(GATHER);
    tool.choices(DRIVER);
    const before = seen.length;
    const rev = board.snapshot().rev;
    board.touch({ type: 'tick', widgetId: 'checklist', index: 3, hand: 'right' });
    board.touch({ type: 'tick', widgetId: 'checklist', index: -1, hand: 'right' });
    board.touch({ type: 'tick', widgetId: 'choices', index: 0, hand: 'right' });
    board.touch({ type: 'choose', widgetId: 'checklist', index: 0, hand: 'right' });
    board.touch({ type: 'choose', widgetId: 'choices', index: 2, hand: 'right' });
    board.touch({ type: 'choose', widgetId: 'choices', index: 0.5, hand: 'right' });
    board.touch({ type: 'choose', widgetId: 'value', index: 0, hand: 'right' });
    expect(seen.length).toBe(before);
    expect(board.snapshot().rev).toBe(rev);
  });
});

describe('WidgetBoard choices', () => {
  it('replaces a question in place, open again', () => {
    const { tool, clock, board, get } = setup();
    tool.choices(DRIVER);
    board.touch({ type: 'choose', widgetId: 'choices', index: 1, hand: 'right' });
    clock.advance(500);
    tool.choices({ question: 'Is the power off?', options: ['Yes', 'Not yet'] });
    expect(get('choices')).toMatchObject({
      seq: 1,
      question: 'Is the power off?',
      options: ['Yes', 'Not yet'],
      chosen: null,
      chosenVia: null,
      status: 'active',
      doneT: null,
      closeAt: null,
      expiresT: 91_500,
    });
  });

  it('closes an unanswered question after 90 s', () => {
    const { tool, board, get, annotations } = setup();
    tool.choices(DRIVER);
    board.tick(90_999);
    expect(get('choices')).toBeDefined();
    board.tick(91_000);
    expect(get('choices')).toBeUndefined();
    expect(annotations().at(-1)).toMatchObject({ op: 'close', by: 'app', reason: 'expired' });
  });

  it('takes an answer by touch, tells the coach, and closes 1.5 s later', () => {
    const { tool, clock, bus, board, get, events, annotations } = setup();
    tool.choices(DRIVER);
    clock.advance(2000);
    board.touch({ type: 'choose', widgetId: 'choices', index: 0, hand: 'right' });
    expect(get('choices')).toMatchObject({
      chosen: 0,
      chosenVia: 'touch',
      status: 'done',
      doneT: 3000,
      closeAt: 4500,
      updatedT: 3000,
    });
    expect(events('widget.chosen')).toEqual([
      {
        t: 3000,
        widgetId: 'choices',
        question: 'Which screwdriver do you have?',
        option: 'Phillips',
        via: 'touch',
      },
    ]);
    expect(annotations().at(-1)).toEqual({
      op: 'choose',
      id: 'choices',
      seq: 1,
      kind: 'choices',
      by: 'learner',
      stepId: 'acid',
      item: 0,
      hand: 'right',
      via: 'touch',
      widget: {
        id: 'choices',
        seq: 1,
        kind: 'choices',
        status: 'done',
        scope: 'step',
        stepId: 'acid',
        question: 'Which screwdriver do you have?',
        options: ['Phillips', 'Flat'],
        chosen: 0,
        chosenVia: 'touch',
      },
    });
    // A second answer, by touch or out loud, is ignored.
    board.touch({ type: 'choose', widgetId: 'choices', index: 1, hand: 'left' });
    bus.emit('transcript', { t: 3100, role: 'user', text: 'flat', final: true });
    expect(get('choices')).toMatchObject({ chosen: 0 });
    expect(events('widget.chosen')).toHaveLength(1);
    board.tick(4499);
    expect(get('choices')).toBeDefined();
    board.tick(4500);
    expect(get('choices')).toBeUndefined();
  });

  it('takes an answer said out loud, without a hand', () => {
    const { tool, bus, board, get, events, annotations } = setup();
    tool.choices(DRIVER);
    bus.emit('transcript', { t: 5000, role: 'coach', text: 'Phillips or flat?', final: true });
    bus.emit('transcript', { t: 5100, role: 'user', text: 'Not sure yet', final: true });
    expect(get('choices')).toMatchObject({ chosen: null });
    bus.emit('transcript', { t: 6000, role: 'user', text: 'The flat one.', final: true });
    expect(get('choices')).toMatchObject({ chosen: 1, chosenVia: 'voice', closeAt: 7500 });
    expect(events('widget.chosen')).toEqual([
      {
        t: 6000,
        widgetId: 'choices',
        question: 'Which screwdriver do you have?',
        option: 'Flat',
        via: 'voice',
      },
    ]);
    const choose = annotations().at(-1);
    expect(choose).toMatchObject({ op: 'choose', by: 'learner', item: 1, via: 'voice' });
    expect(choose).not.toHaveProperty('hand');
    bus.emit('transcript', { t: 6100, role: 'user', text: 'Phillips', final: true });
    board.touch({ type: 'choose', widgetId: 'choices', index: 0, hand: 'left' });
    expect(get('choices')).toMatchObject({ chosen: 1 });
    expect(events('widget.chosen')).toHaveLength(1);
  });

  it('never takes the words that led to the question as its answer', () => {
    const { tool, bus, clock, get } = setup();
    // "Do I need the Phillips?" streams in, the coach asks and shows the options, and the
    // transcript is final only once the coach's turn ends.
    bus.emit('coach.caption', { t: 500, role: 'user', text: 'Do I need', final: false });
    bus.emit('coach.caption', {
      t: 800,
      role: 'user',
      text: 'Do I need the Phillips?',
      final: false,
    });
    tool.choices(DRIVER);
    clock.advance(2000);
    bus.emit('coach.caption', {
      t: 3000,
      role: 'user',
      text: 'Do I need the Phillips?',
      final: true,
    });
    bus.emit('transcript', { t: 3000, role: 'user', text: 'Do I need the Phillips?', final: true });
    expect(get('choices')).toMatchObject({ chosen: null });
    // Their answer begins after the question went up.
    bus.emit('coach.caption', { t: 4000, role: 'user', text: 'Phillips', final: false });
    bus.emit('transcript', { t: 5000, role: 'user', text: 'Phillips', final: true });
    expect(get('choices')).toMatchObject({ chosen: 0, chosenVia: 'voice' });
  });

  it('starts no utterance on a blank partial, which never becomes a transcript', () => {
    const { tool, bus, clock, get } = setup();
    bus.emit('coach.caption', { t: 500, role: 'user', text: ' ', final: false });
    tool.choices(DRIVER);
    clock.advance(2000);
    bus.emit('coach.caption', { t: 3000, role: 'user', text: 'Flat', final: false });
    bus.emit('transcript', { t: 4000, role: 'user', text: 'Flat', final: true });
    expect(get('choices')).toMatchObject({ chosen: 1, chosenVia: 'voice' });
  });
});

describe('WidgetBoard lifecycle', () => {
  it('closes what belonged to a step when another takes focus, and keeps it on re-entry', () => {
    const { tool, clock, ids, entered, annotations } = setup();
    tool.timer(GLUE);
    tool.progress(SCREWS);
    tool.value({ ...TORQUE, whole_lesson: true });
    entered('acid');
    expect(ids()).toEqual(['timer', 'progress', 'value']);
    clock.advance(100);
    entered('look');
    expect(ids()).toEqual(['timer', 'value']);
    expect(annotations().at(-1)).toMatchObject({
      op: 'close',
      id: 'progress',
      by: 'app',
      reason: 'step',
      stepId: 'acid',
      widget: null,
    });
  });

  it('gives a finished widget 1.2 s to be seen when the step changes', () => {
    const { tool, clock, board, get, entered } = setup();
    tool.progress({ label: 'Screws out', value: 4, total: 4 });
    expect(get('progress')).toMatchObject({ closeAt: 5000 });
    clock.advance(1000);
    entered('look');
    expect(get('progress')).toMatchObject({ status: 'done', closeAt: 3200 });
    board.tick(3199);
    expect(get('progress')).toBeDefined();
    board.tick(3200);
    expect(get('progress')).toBeUndefined();

    // A grace never makes a linger longer.
    const short = setup();
    short.tool.progress({ label: 'Screws out', value: 4, total: 4 });
    short.clock.advance(3500);
    short.entered('look');
    expect(short.get('progress')).toMatchObject({ closeAt: 5000 });
  });

  it('ignores a touch on a widget leaving after a step change', () => {
    const { tool, clock, board, get, entered, seen } = setup();
    tool.checklist(GATHERED);
    expect(get('checklist')).toMatchObject({ status: 'done', closeAt: 5000 });
    clock.advance(1000);
    entered('look');
    const before = seen.length;
    const rev = board.snapshot().rev;
    board.touch({ type: 'tick', widgetId: 'checklist', index: 0, hand: 'right' });
    expect(seen.length).toBe(before);
    expect(board.snapshot().rev).toBe(rev);
    expect(get('checklist')).toMatchObject({ status: 'done', stepId: 'acid', closeAt: 3200 });
    board.tick(3200);
    expect(get('checklist')).toBeUndefined();

    // Its own linger is no grace: an untick still makes it active again.
    const lingering = setup();
    lingering.tool.checklist(GATHERED);
    lingering.board.touch({ type: 'tick', widgetId: 'checklist', index: 0, hand: 'right' });
    expect(lingering.get('checklist')).toMatchObject({ status: 'active', closeAt: null });
  });

  it('gives a widget leaving after a step change to the new step when the coach shows it again', () => {
    const { tool, clock, board, get, entered, setPlan, annotations } = setup();
    tool.checklist(GATHERED);
    clock.advance(1000);
    setPlan(planView({ focusId: 'look' }));
    entered('look');
    clock.advance(500);
    expect(
      result(tool.checklist({ title: 'Check', items: ['color', 'smell'], done: ['color'] })),
    ).toMatchObject({ done: '1 of 2' });
    expect(get('checklist')).toMatchObject({
      seq: 1,
      stepId: 'look',
      status: 'active',
      closeAt: null,
    });
    expect(annotations().at(-1)).toMatchObject({
      op: 'update',
      id: 'checklist',
      by: 'coach',
      stepId: 'look',
      widget: expect.objectContaining({ stepId: 'look', status: 'active' }),
    });
    // The grace's close is gone, and the learner can tick it again.
    board.tick(clock.advance(5000));
    expect(get('checklist')).toBeDefined();
    board.touch({ type: 'tick', widgetId: 'checklist', index: 1, hand: 'left' });
    expect(get('checklist')).toMatchObject({ status: 'done', doneT: 7500, closeAt: 11_500 });
    board.touch({ type: 'tick', widgetId: 'checklist', index: 1, hand: 'left' });
    expect(get('checklist')).toMatchObject({ status: 'active' });
    // It belongs to that step now: going back to the first closes it.
    setPlan(planView({ focusId: 'acid' }));
    entered('acid');
    expect(get('checklist')).toBeUndefined();
    expect(annotations().at(-1)).toMatchObject({ op: 'close', reason: 'step', stepId: 'look' });
  });

  it('rebinds an answered question or a finished count shown again in the grace', () => {
    const { tool, clock, board, get, entered, setPlan } = setup();
    tool.choices(DRIVER);
    board.touch({ type: 'choose', widgetId: 'choices', index: 0, hand: 'right' });
    tool.progress({ label: 'Screws out', value: 4, total: 4 });
    clock.advance(1000);
    setPlan(planView({ focusId: 'look' }));
    entered('look');
    expect(get('choices')).toMatchObject({ closeAt: 2500 });
    expect(get('progress')).toMatchObject({ closeAt: 3200 });
    tool.choices({ question: 'Is it pink?', options: ['Yes', 'No'] });
    expect(get('choices')).toMatchObject({ stepId: 'look', chosen: null, closeAt: null });
    // A finished count is the new step's: done from the call, with a whole linger of its own.
    tool.progress({ label: 'Screws out', value: 4, total: 4 });
    expect(get('progress')).toMatchObject({
      stepId: 'look',
      status: 'done',
      doneT: 2000,
      closeAt: 6000,
    });
    board.tick(5000);
    expect(get('choices')).toBeDefined();
    expect(get('progress')).toBeDefined();
    board.touch({ type: 'choose', widgetId: 'choices', index: 1, hand: 'right' });
    expect(get('choices')).toMatchObject({ chosen: 1, chosenVia: 'touch' });
  });

  it('starts a checklist given to a new step afresh, with none of the old ticks or times', () => {
    const { tool, clock, board, get, entered, setPlan } = setup();
    tool.checklist(GATHERED);
    expect(get('checklist')).toMatchObject({ status: 'done', doneT: 1000, closeAt: 5000 });
    clock.advance(1000);
    setPlan(planView({ focusId: 'look' }));
    entered('look');
    clock.advance(500);
    // The same items, unticked: the old step's ticks stay behind.
    expect(result(tool.checklist({ title: 'Gather', items: ['funnel', 'rag', 'cap'] }))).toEqual({
      widget_id: 'checklist',
      done: '0 of 3',
      on_screen: 'checklist "Gather" 0 of 3 done, left: funnel, rag, cap',
    });
    expect(get('checklist')).toMatchObject({
      seq: 1,
      stepId: 'look',
      status: 'active',
      items: [
        { text: 'funnel', done: false },
        { text: 'rag', done: false },
        { text: 'cap', done: false },
      ],
    });

    // Rebound all done, it is done from the call, with a whole linger.
    const again = setup();
    again.tool.checklist(GATHERED);
    again.clock.advance(1000);
    again.setPlan(planView({ focusId: 'look' }));
    again.entered('look');
    again.clock.advance(500);
    expect(result(again.tool.checklist(GATHERED))).toMatchObject({ done: '2 of 2' });
    expect(again.get('checklist')).toMatchObject({
      stepId: 'look',
      status: 'done',
      doneT: 2500,
      closeAt: 6500,
    });
    again.board.tick(5000);
    expect(again.get('checklist')).toBeDefined();
    again.board.tick(6500);
    expect(again.get('checklist')).toBeUndefined();

    // Updated within its own step, it keeps its ticks.
    board.touch({ type: 'tick', widgetId: 'checklist', index: 2, hand: 'right' });
    tool.checklist({ title: 'Gather', items: ['funnel', 'cap'] });
    expect(get('checklist')).toMatchObject({
      items: [
        { text: 'funnel', done: false },
        { text: 'cap', done: true },
      ],
    });
  });

  it('keeps the step of a widget shown again in the grace when no step is in focus', () => {
    const { tool, clock, get, entered, setPlan } = setup();
    tool.checklist(GATHERED);
    clock.advance(1000);
    entered('look');
    setPlan(planView({ focusId: null }));
    tool.checklist({ title: 'Gather', items: ['funnel', 'rag', 'cap'] });
    // Still its own step's list, so it keeps its ticks.
    expect(get('checklist')).toMatchObject({
      stepId: 'acid',
      status: 'active',
      closeAt: null,
      leaving: false,
      items: [
        { text: 'funnel', done: true },
        { text: 'rag', done: true },
        { text: 'cap', done: false },
      ],
    });
  });

  it('keeps a finished widget whose step takes focus again within the grace', () => {
    const { tool, clock, board, get, entered, annotations } = setup();
    tool.checklist(GATHERED);
    tool.choices(DRIVER);
    clock.advance(500);
    board.touch({ type: 'choose', widgetId: 'choices', index: 0, hand: 'right' });
    tool.progress({ label: 'Screws out', value: 4, total: 4 });
    expect(get('checklist')).toMatchObject({ closeAt: 5000 });
    expect(get('choices')).toMatchObject({ closeAt: 3000 });
    expect(get('progress')).toMatchObject({ closeAt: 5500 });
    clock.advance(100);
    entered('look');
    expect(get('checklist')).toMatchObject({ leaving: true, closeAt: 2800 });
    expect(get('choices')).toMatchObject({ leaving: true, closeAt: 2800 });
    expect(get('progress')).toMatchObject({ leaving: true, closeAt: 2800 });
    // Another step change in the grace keeps its close.
    clock.advance(300);
    entered('other');
    expect(get('checklist')).toMatchObject({ leaving: true, closeAt: 2800 });
    const recorded = annotations().length;
    clock.advance(200);
    entered('acid');
    // Each has the close it had before the grace, and the change is recorded.
    expect(get('checklist')).toMatchObject({ leaving: false, stepId: 'acid', closeAt: 5000 });
    expect(get('choices')).toMatchObject({ leaving: false, stepId: 'acid', closeAt: 3000 });
    expect(get('progress')).toMatchObject({ leaving: false, stepId: 'acid', closeAt: 5500 });
    expect(annotations().slice(recorded)).toEqual(
      ['checklist', 'choices', 'progress'].map((id) =>
        expect.objectContaining({
          op: 'update',
          id,
          by: 'app',
          stepId: 'acid',
          widget: expect.objectContaining({ status: 'done', stepId: 'acid' }),
        }),
      ),
    );
    board.tick(2800);
    expect(get('checklist')).toBeDefined();
    expect(get('choices')).toBeDefined();
    // It takes touches again: an untick makes the checklist active.
    board.touch({ type: 'tick', widgetId: 'checklist', index: 1, hand: 'left' });
    expect(get('checklist')).toMatchObject({ status: 'active', closeAt: null });
    board.tick(3000);
    expect(get('choices')).toBeUndefined();
    board.tick(5500);
    expect(get('progress')).toBeUndefined();
    expect(get('checklist')).toBeDefined();
  });

  it('says in its record that a widget is leaving, replacing the record and the snapshot', () => {
    const { tool, clock, board, get, entered, setPlan } = setup();
    tool.checklist(GATHERED);
    tool.value(TORQUE);
    const before = get('checklist');
    const snap = board.snapshot();
    expect(before).toMatchObject({ leaving: false });
    clock.advance(1000);
    setPlan(planView({ focusId: 'look' }));
    entered('look');
    const leaving = get('checklist');
    expect(leaving).toMatchObject({ leaving: true, rev: 2 });
    expect(leaving).not.toBe(before);
    expect(before).toMatchObject({ leaving: false, rev: 1 });
    expect(board.snapshot()).not.toBe(snap);
    expect(Object.isFrozen(board.snapshot().widgets)).toBe(true);
    // Only a finished widget leaves: an active one closes at once.
    expect(get('value')).toBeUndefined();
    // Shown again, it is the new step's and no longer leaving.
    tool.checklist({ title: 'Check', items: ['color', 'smell'] });
    expect(get('checklist')).toMatchObject({ leaving: false, stepId: 'look' });
    expect(leaving).toMatchObject({ leaving: true });
  });

  it('binds a widget shown outside a step to the next step that takes focus, unrecorded', () => {
    const { tool, get, entered, setPlan, annotations, board } = setup(null);
    tool.checklist(GATHER);
    expect(get('checklist')).toMatchObject({ stepId: null });
    const recorded = annotations().length;
    const rev = board.snapshot().rev;
    setPlan(planView({ focusId: 'look' }));
    entered('look');
    expect(get('checklist')).toMatchObject({ stepId: 'look', rev: 1 });
    expect(board.snapshot().rev).toBe(rev + 1);
    expect(annotations()).toHaveLength(recorded);
    entered('acid');
    expect(get('checklist')).toBeUndefined();
  });

  it('closes a widget whose step left the plan', () => {
    const { tool, bus, clock, ids, setPlan, annotations } = setup();
    tool.progress(SCREWS);
    tool.timer(GLUE);
    bus.emit('plan.changed', { t: clock.now(), rev: 2, op: 'edit', stepId: 'acid' });
    expect(ids()).toEqual(['progress', 'timer']);
    setPlan(planView({ focusId: 'look', steps: [planView().steps[1] as PlanView['steps'][0]] }));
    bus.emit('plan.changed', { t: clock.now(), rev: 3, op: 'revise', stepId: null });
    expect(ids()).toEqual(['timer']);
    expect(annotations().at(-1)).toMatchObject({ op: 'close', id: 'progress', reason: 'step' });
  });

  it('closes everything but a running timer when the lesson ends, aborts or another starts', () => {
    const lessonEnds = [
      (b: Emitter<AppEvents>) => b.emit('procedure.completed', { t: 2000, durationMs: 1000 }),
      (b: Emitter<AppEvents>) => b.emit('procedure.aborted', { t: 2000, reason: 'user' }),
      (b: Emitter<AppEvents>) =>
        b.emit('plan.requested', { t: 2000, goal: 'Fold a shirt', revision: false }),
    ];
    for (const end of lessonEnds) {
      const { tool, bus, board, ids, annotations } = setup();
      tool.timer(GLUE);
      tool.timer({ seconds: 10, label: 'Tea' });
      tool.caution(HOT);
      board.tick(11_000);
      end(bus);
      expect(ids()).toEqual(['timer']);
      expect(
        annotations()
          .filter((a) => a.op === 'close')
          .map((a) => [a.id, a.reason]),
      ).toEqual([
        ['timer-2', 'lesson'],
        ['caution', 'lesson'],
      ]);
    }

    // A timer from the lesson that ended holds back no nudge of the next one.
    const carried = setup();
    carried.tool.timer(GLUE);
    expect(carried.board.waiting()).toBe(true);
    carried.bus.emit('procedure.aborted', { t: 2000, reason: 'user' });
    expect(carried.ids()).toEqual(['timer']);
    expect(carried.board.waiting()).toBe(false);
    carried.tool.timer({ seconds: 10, label: 'Tea' });
    expect(carried.board.waiting()).toBe(true);

    const revision = setup();
    revision.tool.caution(HOT);
    revision.tool.progress(SCREWS);
    revision.bus.emit('plan.requested', { t: 2000, goal: 'Test an acid', revision: true });
    expect(revision.ids()).toEqual(['caution', 'progress']);
  });

  it('closes a step widget nobody bound after ten minutes', () => {
    const { tool, clock, board, get, annotations } = setup(null);
    tool.value(TORQUE);
    tool.caution(HOT);
    board.tick(600_999);
    expect(get('value')).toBeDefined();
    board.tick(601_000);
    expect(get('value')).toBeUndefined();
    expect(get('caution')).toBeDefined();
    expect(annotations().at(-1)).toMatchObject({ id: 'value', reason: 'stale', by: 'app' });
    clock.set(700_000);
    tool.value(TORQUE);
    board.tick(1_299_999);
    expect(get('value')).toBeDefined();
    board.tick(1_300_000);
    expect(get('value')).toBeUndefined();
  });

  it('stops listening once detached', () => {
    const { board, tool, entered, ids } = setup();
    tool.progress(SCREWS);
    board.detach();
    entered('look');
    expect(ids()).toEqual(['progress']);
  });
});

describe('WidgetBoard records', () => {
  it('records every change before it tells the coach', () => {
    const { tool, bus, board, seen } = setup();
    tool.timer({ seconds: 10, label: 'Tea' });
    tool.checklist({ title: 'Gather', items: ['funnel', 'rag'] });
    tool.choices(DRIVER);
    board.tick(11_000);
    board.touch({ type: 'tick', widgetId: 'checklist', index: 0, hand: 'right' });
    board.touch({ type: 'choose', widgetId: 'choices', index: 1, hand: 'left' });
    bus.emit('transcript', { t: 12_000, role: 'user', text: 'phillips', final: true });
    const order = seen
      .filter((e) => e.type.startsWith('widget.') || e.payload.label === 'widget.updated')
      .map((e) =>
        e.type === 'annotation' ? `annotation ${(e.payload.data as WidgetAnnotation).op}` : e.type,
      );
    expect(order).toEqual([
      'annotation show',
      'annotation show',
      'annotation show',
      'annotation done',
      'widget.timer_done',
      'annotation tick',
      'widget.ticked',
      'annotation choose',
      'widget.chosen',
    ]);
  });

  it('records who changed what, with the coach call behind it', () => {
    const { tool, board, annotations } = setup();
    tool.timer({ seconds: 10, label: 'Tea', object_id: 'cup_a' });
    tool.checklist({ title: 'Gather', items: ['funnel', 'rag'] });
    board.touch({ type: 'tick', widgetId: 'checklist', index: 1, hand: 'left' });
    board.touch({ type: 'tick', widgetId: 'checklist', index: 1, hand: 'left' });
    board.tick(11_000);
    tool.clear('checklist');
    expect(annotations()).toEqual([
      {
        op: 'show',
        id: 'timer',
        seq: 1,
        kind: 'timer',
        by: 'coach',
        stepId: 'acid',
        callId: 'fc_1',
        widget: {
          id: 'timer',
          seq: 1,
          kind: 'timer',
          status: 'active',
          scope: 'lesson',
          stepId: 'acid',
          label: 'Tea',
          durationMs: 10_000,
          remainingMs: 10_000,
          objectId: 'cup_a',
        },
      },
      expect.objectContaining({ op: 'show', id: 'checklist', by: 'coach', callId: 'fc_2' }),
      expect.objectContaining({ op: 'tick', by: 'learner', item: 1, hand: 'left', via: 'touch' }),
      expect.objectContaining({ op: 'untick', by: 'learner', item: 1, hand: 'left', via: 'touch' }),
      expect.objectContaining({
        op: 'done',
        id: 'timer',
        by: 'app',
        widget: expect.objectContaining({ status: 'done', remainingMs: 0 }),
      }),
      {
        op: 'close',
        id: 'checklist',
        seq: 2,
        kind: 'checklist',
        by: 'coach',
        stepId: 'acid',
        callId: 'fc_3',
        reason: 'coach',
        widget: null,
      },
    ]);
  });

  it('keeps the same snapshot until something changes', () => {
    const { tool, board, clock } = setup();
    const empty = board.snapshot();
    expect(board.snapshot()).toBe(empty);
    expect(empty.widgets).toEqual([]);
    tool.timer(GLUE);
    const one = board.snapshot();
    expect(one).not.toBe(empty);
    expect(one.rev).toBe(empty.rev + 1);
    const timer = one.widgets[0];
    board.tick(clock.advance(1000));
    expect(board.snapshot()).toBe(one);
    tool.value(TORQUE);
    expect(board.snapshot()).not.toBe(one);
    expect(board.snapshot().widgets[0]).toBe(timer);
    expect(Object.isFrozen(board.snapshot().widgets)).toBe(true);
  });

  it('sums up what is on screen for the coach, or null', () => {
    const { tool, board, clock } = setup();
    expect(board.summary()).toBeNull();
    tool.timer(GLUE);
    clock.advance(8000);
    expect(board.summary()).toBe('timer "Glue sets" 1:52 left');
  });
});
