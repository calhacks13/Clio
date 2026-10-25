import { parseProcedure } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { Emitter } from '../../src/core/emitter';
import type { AppEvents } from '../../src/domain/events';
import { OverlayModel } from '../../src/domain/overlay/overlay-model';
import type { PlanView, StepStatus } from '../../src/domain/plan/recital';
import type { ObjectOutline } from '../../src/domain/world/outline';

const procedure = parseProcedure({
  schema: 'clio.procedure/1',
  id: 'p',
  version: 1,
  title: 'Refill',
  summary: 'S',
  workspace: { size: [1, 1] },
  objects: [
    { id: 'cap', label: 'cap', placement: { method: 'detect' } },
    { id: 'jug', label: 'jug', placement: { method: 'detect' } },
  ],
  steps: [
    {
      id: 'open',
      instruction: 'Open the cap.',
      detail: 'Turn it left.',
      targets: ['cap'],
      success: { type: 'confirm' },
    },
    { id: 'pour', instruction: 'Pour.', targets: ['jug', 'cap'], success: { type: 'confirm' } },
  ],
});

function setup() {
  const bus = new Emitter<AppEvents>();
  const model = new OverlayModel(bus, {
    procedure: () => procedure,
    label: (id) => id,
    plan: () => null,
  });
  model.attach();
  return { bus, model };
}

describe('OverlayModel', () => {
  it('shows the current instruction and highlights its targets', () => {
    const { bus, model } = setup();
    bus.emit('step.entered', {
      t: 0,
      stepId: 'open',
      index: 0,
      instruction: 'Open the cap.',
      targets: ['cap'],
    });
    model.setProgress(0.4);
    const s = model.snapshot(10);
    expect(s.instruction).toEqual({
      text: 'Open the cap.',
      detail: 'Turn it left.',
      index: 0,
      total: 2,
      progress: 0.4,
    });
    expect(s.highlights).toEqual([
      { objectId: 'cap', style: 'target', source: 'auto', until: null },
    ]);
  });

  it('lets coach highlights and toasts expire, but keeps step targets', () => {
    const { bus, model } = setup();
    bus.emit('step.entered', {
      t: 0,
      stepId: 'open',
      index: 0,
      instruction: 'Open the cap.',
      targets: ['cap'],
    });
    bus.emit('overlay.highlight', { t: 100, objectId: 'jug', style: 'warning', source: 'coach' });
    bus.emit('mistake.detected', {
      t: 100,
      stepId: 'open',
      kind: 'wrong',
      message: 'Not that one.',
      source: 'rule',
    });
    expect(model.snapshot(200).highlights.map((h) => h.objectId)).toEqual(['cap', 'jug']);
    expect(model.snapshot(200).toast).toEqual({ kind: 'mistake', text: 'Not that one.' });
    const later = model.snapshot(10_000);
    expect(later.highlights.map((h) => h.objectId)).toEqual(['cap']);
    expect(later.toast).toBeNull();
  });

  it('shows the procedure title for saved lessons that skipped planning', () => {
    const { bus, model } = setup();
    bus.emit('step.entered', {
      t: 0,
      stepId: 'open',
      index: 0,
      instruction: 'Open the cap.',
      targets: ['cap'],
    });
    expect(model.snapshot(1).title).toBe('Refill');
  });

  it('lists missing objects until they are found', () => {
    const { bus, model } = setup();
    bus.emit('object.missing', { t: 0, objectIds: ['cap', 'jug'] });
    bus.emit('object.registered', { t: 5, objectId: 'jug', position: [0, 0, 0], method: 'pinch' });
    expect(model.snapshot(10).missing).toEqual(['cap']);
  });

  it("carries the coach's connection and the conversation, off until a coach hears", () => {
    const { bus, model } = setup();
    expect(model.snapshot(0)).toMatchObject({ coach: 'off', voice: 'off' });
    bus.emit('coach.voice', { t: 0, voice: 'quiet' });
    bus.emit('coach.status', { t: 1, state: 'ready' });
    bus.emit('coach.voice', { t: 2, voice: 'hearing' });
    expect(model.snapshot(3)).toMatchObject({ coach: 'ready', voice: 'hearing' });
    bus.emit('coach.voice', { t: 4, voice: 'off' });
    expect(model.snapshot(5).voice).toBe('off');
  });

  it("keeps the outlines of what the step shows, most important first, for the step's length", () => {
    const { bus, model } = setup();
    const enter = (index: number, stepId: string) =>
      bus.emit('step.entered', { t: 0, stepId, index, instruction: 'x', targets: [] });
    enter(0, 'open');
    const outline: ObjectOutline = {
      points: [
        [-0.04, 0.04],
        [0.04, 0.04],
        [0, -0.04],
      ],
      shape: 'contour',
    };
    const brackets: ObjectOutline = { ...outline, shape: 'box' };
    const offset: [number, number, number] = [0, 0, 0];
    const show = (t: number, objectId: string, o: ObjectOutline, rank: number, phrase: string) =>
      bus.emit('overlay.outline', { t, objectId, outline: o, offset, rank, phrase });
    show(5, 'jug', outline, 1, 'jug');
    show(6, 'cap', outline, 0, 'blue cap');
    show(7, 'cap', brackets, 0, 'blue cap');
    expect(model.snapshot(10).outlines).toEqual([
      { objectId: 'cap', outline: brackets, offset, rank: 0, phrase: 'blue cap' },
      { objectId: 'jug', outline, offset, rank: 1, phrase: 'jug' },
    ]);
    enter(1, 'pour');
    expect(model.snapshot(20).outlines).toEqual([]);
    show(25, 'jug', outline, 0, 'jug');
    bus.emit('procedure.completed', { t: 30, durationMs: 30 });
    expect(model.snapshot(40).outlines).toEqual([]);
  });

  it('clears the lesson UI when the procedure completes', () => {
    const { bus, model } = setup();
    bus.emit('step.entered', {
      t: 0,
      stepId: 'open',
      index: 0,
      instruction: 'Open the cap.',
      targets: ['cap'],
    });
    bus.emit('procedure.completed', { t: 50, durationMs: 50 });
    const s = model.snapshot(60);
    expect(s.instruction).toBeNull();
    expect(s.highlights).toEqual([]);
    expect(s.toast?.kind).toBe('success');
  });

  it('cheers a finished step but not a skipped one', () => {
    const { bus, model } = setup();
    const complete = (t: number, by: 'coach' | 'skip') =>
      bus.emit('step.completed', { t, stepId: 'open', index: 0, by, forced: false, durationMs: 1 });
    complete(0, 'skip');
    expect(model.snapshot(1).toast).toBeNull();
    complete(10, 'coach');
    expect(model.snapshot(11).toast).toEqual({ kind: 'success', text: 'Nice!' });
  });
});

describe('OverlayModel between lessons', () => {
  const titled = (title: string) => ({ ...procedure, title });

  /** The view keeps returning the last lesson until the next one starts, as the controller does. */
  function lessonsSetup() {
    const bus = new Emitter<AppEvents>();
    const view = { current: titled('Refill') };
    const model = new OverlayModel(bus, {
      procedure: () => view.current,
      label: (id) => id,
      plan: () => null,
    });
    model.attach();
    const enter = (t: number) =>
      bus.emit('step.entered', { t, stepId: 'open', index: 0, instruction: 'x', targets: [] });
    const ready = (t: number, revision = false) =>
      bus.emit('plan.ready', { t, planId: 'p', procedure: view.current, warnings: [], revision });
    return { bus, model, view, enter, ready };
  }

  it("shows neither the last lesson's title nor its missing objects once it ends", () => {
    const { bus, model, view, enter, ready } = lessonsSetup();
    bus.emit('plan.requested', { t: 0, goal: 'refill', revision: false });
    ready(1);
    bus.emit('object.missing', { t: 2, objectIds: ['cap'] });
    enter(3);
    expect(model.snapshot(4)).toMatchObject({ title: 'Refill', missing: ['cap'] });

    bus.emit('procedure.completed', { t: 5, durationMs: 5 });
    expect(model.snapshot(6)).toMatchObject({ title: null, missing: [] });

    // The planner fails and the coach writes the next lesson, which sends no plan.ready.
    bus.emit('plan.requested', { t: 10, goal: 'wash', revision: false });
    bus.emit('plan.failed', { t: 11, goal: 'wash', error: 'down', revision: false });
    expect(model.snapshot(12).title).toBeNull();
    view.current = titled('Wash');
    enter(13);
    expect(model.snapshot(14)).toMatchObject({ title: 'Wash', missing: [] });
  });

  it('forgets the title and missing objects when a new lesson is requested, not a re-plan', () => {
    const { bus, model, ready } = lessonsSetup();
    ready(1);
    bus.emit('object.missing', { t: 2, objectIds: ['cap'] });
    bus.emit('plan.requested', { t: 3, goal: 'refill', revision: true });
    expect(model.snapshot(4)).toMatchObject({ title: 'Refill', missing: ['cap'] });
    bus.emit('plan.requested', { t: 5, goal: 'wash', revision: false });
    expect(model.snapshot(6)).toMatchObject({ title: null, missing: [] });
  });

  it('keeps objects reported missing before the plan arrives, and through a re-plan', () => {
    const { bus, model, ready } = lessonsSetup();
    bus.emit('plan.requested', { t: 0, goal: 'refill', revision: false });
    bus.emit('object.missing', { t: 1, objectIds: ['cap'] });
    ready(2);
    expect(model.snapshot(3).missing).toEqual(['cap']);
    ready(4, true);
    expect(model.snapshot(5).missing).toEqual(['cap']);
  });
});

describe('OverlayModel with the coach plan', () => {
  const lesson = parseProcedure({
    schema: 'clio.procedure/1',
    id: 'p',
    version: 1,
    title: 'Refill',
    summary: 'S',
    workspace: { size: [1, 1] },
    objects: [{ id: 'cap', label: 'cap', placement: { method: 'detect' } }],
    steps: [
      {
        id: 'open',
        instruction: 'Open the cap.',
        detail: 'Turn it left.',
        targets: ['cap'],
        success: { type: 'confirm' },
      },
      { id: 'pour', instruction: 'Pour.', success: { type: 'confirm' } },
      {
        id: 'close',
        instruction: 'Close the cap.',
        targets: ['cap'],
        success: { type: 'confirm' },
      },
    ],
  });

  /** A lesson whose plan the test edits as the coach would. */
  function planSetup() {
    const bus = new Emitter<AppEvents>();
    const state = {
      procedure: lesson,
      statuses: { open: 'todo', pour: 'todo', close: 'todo' } as Record<string, StepStatus>,
      focusId: 'open' as string | null,
      rev: 0,
    };
    const plan = (): PlanView => ({
      goal: 'Refill the washer fluid',
      title: state.procedure.title,
      rev: state.rev,
      steps: state.procedure.steps.map((s) => ({
        id: s.id,
        instruction: s.instruction,
        status: state.statuses[s.id] ?? 'todo',
        uses: [],
        demo: false,
      })),
      focusId: state.focusId,
      materials: [],
    });
    const model = new OverlayModel(bus, {
      procedure: () => state.procedure,
      label: (id) => id,
      plan,
    });
    model.attach();
    const changed = (stepId: string | null) =>
      bus.emit('plan.changed', { t: 1, rev: ++state.rev, op: 'edit', stepId });
    return { bus, model, state, changed };
  }

  it('counts done steps out of the steps not skipped', () => {
    const { bus, model, state } = planSetup();
    state.statuses = { open: 'done', pour: 'skipped', close: 'todo' };
    state.focusId = 'close';
    bus.emit('step.entered', {
      t: 0,
      stepId: 'close',
      index: 2,
      instruction: 'Close the cap.',
      targets: ['cap'],
    });
    expect(model.snapshot(1).instruction).toEqual({
      text: 'Close the cap.',
      index: 1,
      total: 2,
      progress: 0,
    });
  });

  it("refreshes the step's text, detail and count when the plan changes, and keeps the rest", () => {
    const { bus, model, state, changed } = planSetup();
    bus.emit('step.entered', {
      t: 0,
      stepId: 'open',
      index: 0,
      instruction: 'Open the cap.',
      targets: ['cap'],
    });
    const outline: ObjectOutline = {
      points: [
        [-0.04, 0.04],
        [0.04, 0.04],
        [0, -0.04],
      ],
      shape: 'contour',
    };
    bus.emit('overlay.outline', {
      t: 1,
      objectId: 'cap',
      outline,
      offset: [0, 0, 0],
      rank: 0,
      phrase: 'blue cap',
    });
    bus.emit('overlay.highlight', { t: 1, objectId: 'cap', style: 'attention', source: 'coach' });
    model.setProgress(0.4);
    const before = model.snapshot(2);
    expect(before.instruction).toMatchObject({ index: 0, total: 3 });

    // The coach skips a step and finishes another out of order.
    state.statuses = { open: 'todo', pour: 'skipped', close: 'done' };
    changed('close');
    expect(model.snapshot(2).instruction).toEqual({
      text: 'Open the cap.',
      detail: 'Turn it left.',
      index: 1,
      total: 2,
      progress: 0.4,
    });

    // The coach rewrites the focused step.
    state.procedure = {
      ...lesson,
      steps: lesson.steps.map((s) =>
        s.id === 'open' ? { ...s, instruction: 'Twist the blue cap off.', detail: 'Lefty.' } : s,
      ),
    };
    changed('open');
    const after = model.snapshot(2);
    expect(after.instruction).toEqual({
      text: 'Twist the blue cap off.',
      detail: 'Lefty.',
      index: 1,
      total: 2,
      progress: 0.4,
    });
    expect(after.outlines).toEqual(before.outlines);
    expect(after.highlights).toEqual(before.highlights);
  });

  it('shows the focused step after a change moves the focus, dropping a detail it lacks', () => {
    const { bus, model, state, changed } = planSetup();
    bus.emit('step.entered', {
      t: 0,
      stepId: 'open',
      index: 0,
      instruction: 'Open the cap.',
      targets: ['cap'],
    });
    state.statuses = { open: 'done', pour: 'todo', close: 'todo' };
    state.focusId = 'pour';
    changed('open');
    expect(model.snapshot(1).instruction).toEqual({
      text: 'Pour.',
      index: 1,
      total: 3,
      progress: 0,
    });
  });

  it('shows no instruction for a plan change before any step starts', () => {
    const { model, changed } = planSetup();
    changed(null);
    expect(model.snapshot(1).instruction).toBeNull();
  });
});
