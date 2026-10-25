import { parseProcedure } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { Emitter } from '../../src/core/emitter';
import type { AppEvents, HighlightStyle } from '../../src/domain/events';
import { ACCENTS, HINT_OPACITY, stepRole } from '../../src/domain/overlay/accents';
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
      bus.emit('overlay.outline', {
        t,
        objectId,
        outline: o,
        offset,
        rank,
        role: rank === 0 ? 'act' : 'destination',
        phrase,
      });
    show(5, 'jug', outline, 1, 'jug');
    show(6, 'cap', outline, 0, 'blue cap');
    show(7, 'cap', brackets, 0, 'blue cap');
    const act = { color: ACCENTS.act, opacity: 1 };
    const destination = { color: ACCENTS.destination, opacity: 1 };
    expect(model.snapshot(10).outlines).toEqual([
      {
        objectId: 'cap',
        outline: brackets,
        offset,
        rank: 0,
        role: 'act',
        phrase: 'blue cap',
        accent: act,
      },
      {
        objectId: 'jug',
        outline,
        offset,
        rank: 1,
        role: 'destination',
        phrase: 'jug',
        accent: destination,
      },
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
      role: 'act',
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

describe('OverlayModel highlight accents', () => {
  it('colors each outline by its role, a part taking the color of the item before it', () => {
    const { bus, model } = setup();
    bus.emit('step.entered', { t: 0, stepId: 'pour', index: 1, instruction: 'x', targets: [] });
    const o: ObjectOutline = {
      points: [
        [0, 0],
        [0.01, 0],
        [0, 0.01],
      ],
      shape: 'contour',
    };
    const offset: [number, number, number] = [0, 0, 0];
    const show = (objectId: string, rank: number, role: 'act' | 'destination' | 'part' | 'level') =>
      bus.emit('overlay.outline', {
        t: 1,
        objectId,
        outline: o,
        offset,
        rank,
        role,
        phrase: objectId,
      });
    show('jug', 0, 'destination');
    show('spout', 1, 'part');
    show('cap', 2, 'act');
    show('line', 3, 'level');
    expect(model.snapshot(2).outlines.map((x) => [x.objectId, x.accent.color])).toEqual([
      ['jug', ACCENTS.destination],
      ['spout', ACCENTS.destination],
      ['cap', ACCENTS.act],
      ['line', ACCENTS.level],
    ]);
  });

  it('restyles an outline while a highlight lasts: a white hint, a red pulse that ends', () => {
    const { bus, model } = setup();
    bus.emit('step.entered', {
      t: 0,
      stepId: 'open',
      index: 0,
      instruction: 'x',
      targets: ['cap'],
    });
    const o: ObjectOutline = {
      points: [
        [0, 0],
        [0.01, 0],
        [0, 0.01],
      ],
      shape: 'contour',
    };
    bus.emit('overlay.outline', {
      t: 1,
      objectId: 'cap',
      outline: o,
      offset: [0, 0, 0],
      rank: 0,
      role: 'act',
      phrase: 'cap',
    });
    const accent = (t: number) => model.snapshot(t).outlines[0]?.accent;
    expect(accent(2)).toEqual({ color: ACCENTS.act, opacity: 1 });
    bus.emit('overlay.highlight', { t: 10, objectId: 'cap', style: 'attention', source: 'coach' });
    expect(accent(11)).toEqual({ color: ACCENTS.hint, opacity: HINT_OPACITY });
    expect(accent(6000)).toEqual({ color: ACCENTS.act, opacity: 1 });
    bus.emit('overlay.highlight', { t: 7000, objectId: 'cap', style: 'warning', source: 'coach' });
    expect(accent(7100)).toEqual({ color: ACCENTS.stop, opacity: 1 });
    expect(accent(7700)).toEqual({ color: ACCENTS.act, opacity: 1 });
  });
});

describe('OverlayModel lights what the live tracker would, for when it is down', () => {
  const lit = parseProcedure({
    schema: 'clio.procedure/1',
    id: 'lit',
    version: 1,
    title: 'Refill',
    summary: 'S',
    workspace: { size: [1, 1] },
    objects: [
      { id: 'cap', label: 'cap', placement: { method: 'detect' } },
      { id: 'jug', label: 'jug', placement: { method: 'detect' } },
      { id: 'rag', label: 'rag', placement: { method: 'detect' } },
    ],
    steps: [
      {
        id: 'open',
        instruction: 'Open the cap.',
        targets: ['cap', 'rag'],
        show: [{ object: 'cap', phrase: 'blue cap', description: 'Round blue cap' }],
        success: { type: 'confirm' },
      },
      {
        id: 'pour',
        instruction: 'Pour.',
        targets: ['cap'],
        action: { verb: 'pour', object: 'jug', target: 'cap' },
        success: { type: 'confirm' },
      },
    ],
  });

  function litSetup() {
    const bus = new Emitter<AppEvents>();
    const model = new OverlayModel(bus, {
      procedure: () => lit,
      label: (id) => id,
      plan: () => null,
    });
    model.attach();
    const enter = (stepId: string, t = 0) =>
      bus.emit('step.entered', {
        t,
        stepId,
        index: lit.steps.findIndex((s) => s.id === stepId),
        instruction: 'x',
        targets: lit.steps.find((s) => s.id === stepId)?.targets ?? [],
      });
    const answer = (stepId: string, actionId: string | null, t = 10) =>
      bus.emit('focus.answered', {
        t,
        frameT: t - 5,
        stepId,
        detections: [],
        action: null,
        actionId,
        model: 'er',
        latencyMs: 5,
      });
    const highlight = (objectId: string, style: HighlightStyle, t: number) =>
      bus.emit('overlay.highlight', { t, objectId, style, source: 'coach' });
    const lights = (t: number) =>
      model.snapshot(t).highlights.map((h) => [h.objectId, h.style, h.source]);
    return { model, enter, answer, highlight, lights };
  }

  it("lights a step's show items, else its targets and then its action's objects", () => {
    const { enter, lights } = litSetup();
    // The rag is a target the step does not show: not lit, as the tracker would not light it.
    enter('open');
    expect(lights(1)).toEqual([['cap', 'target', 'auto']]);
    enter('pour');
    expect(lights(1)).toEqual([
      ['cap', 'target', 'auto'],
      ['jug', 'target', 'auto'],
    ]);
  });

  it("lights the action focus's item for the rest of the step, until it names another", () => {
    const { enter, answer, lights } = litSetup();
    enter('open');
    answer('open', 'rag');
    expect(lights(60_000)).toEqual([
      ['cap', 'target', 'auto'],
      ['rag', 'target', 'auto'],
    ]);
    // Another step's answer, nothing to touch, an object the lesson lacks: no change.
    answer('pour', 'jug');
    answer('open', null);
    answer('open', 'kettle');
    answer('open', 'jug');
    expect(lights(60_000)).toEqual([
      ['cap', 'target', 'auto'],
      ['jug', 'target', 'auto'],
    ]);
    // The step's own item stays lit when the focus moves past it.
    answer('open', 'cap');
    answer('open', 'rag');
    expect(lights(60_000)).toEqual([
      ['cap', 'target', 'auto'],
      ['rag', 'target', 'auto'],
    ]);
    enter('pour');
    expect(lights(60_000)).toEqual([
      ['cap', 'target', 'auto'],
      ['jug', 'target', 'auto'],
    ]);
  });

  it("keeps the coach's target for the step, one at a time; a hint 5 s; a warning a pulse", () => {
    const { enter, highlight, lights } = litSetup();
    enter('open');
    highlight('jug', 'target', 100);
    highlight('rag', 'attention', 100);
    expect(lights(60_000)).toEqual([
      ['cap', 'target', 'auto'],
      ['jug', 'target', 'coach'],
    ]);
    highlight('rag', 'target', 61_000);
    highlight('jug', 'warning', 61_000);
    expect(lights(61_100)).toEqual([
      ['cap', 'target', 'auto'],
      ['rag', 'target', 'coach'],
      ['jug', 'warning', 'coach'],
    ]);
    expect(lights(61_600)).toEqual([
      ['cap', 'target', 'auto'],
      ['rag', 'target', 'coach'],
    ]);
    enter('pour');
    expect(lights(61_700).filter(([, , source]) => source === 'coach')).toEqual([]);
  });
});

describe('stepRole', () => {
  const pickUp = { action: { verb: 'pick_up' as const, object: 'mug', hand: 'either' as const } };
  const pour = {
    action: { verb: 'pour' as const, object: 'jug', target: 'mug', hand: 'either' as const },
  };

  it("takes what the step's hands do before an object's kind, and an explicit role first", () => {
    expect(stepRole(pickUp, 'mug', 0, 'container')).toBe('act');
    expect(stepRole(pour, 'mug', 0, 'container')).toBe('destination');
    expect(stepRole(pour, 'jug', 1, 'container')).toBe('act');
    expect(stepRole(pickUp, 'mug', 0, 'container', 'level')).toBe('level');
    // Anything else by its place and kind.
    expect(stepRole(pickUp, 'tray', 0, 'container')).toBe('destination');
    expect(stepRole({}, 'cap', 0, 'item')).toBe('act');
    expect(stepRole(null, 'cap', 1, 'item')).toBe('destination');
  });
});
