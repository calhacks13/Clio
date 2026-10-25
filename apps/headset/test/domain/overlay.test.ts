import { parseProcedure } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { Emitter } from '../../src/core/emitter';
import type { AppEvents } from '../../src/domain/events';
import { ACCENTS, HINT_OPACITY } from '../../src/domain/overlay/accents';
import { OverlayModel } from '../../src/domain/overlay/overlay-model';
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
  const model = new OverlayModel(bus, { procedure: () => procedure, label: (id) => id });
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
