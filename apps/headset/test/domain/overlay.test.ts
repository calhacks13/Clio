import { parseProcedure } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { Emitter } from '../../src/core/emitter';
import type { AppEvents } from '../../src/domain/events';
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
});
