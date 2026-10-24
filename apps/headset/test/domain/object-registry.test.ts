import { parseProcedure } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { Emitter } from '../../src/core/emitter';
import { quatFromAxisAngle } from '../../src/core/math';
import type { AppEvents } from '../../src/domain/events';
import { ObjectRegistry } from '../../src/domain/world/object-registry';

const procedure = parseProcedure({
  schema: 'clio.procedure/1',
  id: 'p',
  version: 1,
  title: 'P',
  summary: 'S',
  workspace: { size: [1, 1] },
  objects: [
    { id: 'cup', label: 'cup', placement: { method: 'layout', position: [0.1, 0.07, -0.2] } },
    {
      id: 'jug',
      label: 'jug',
      placement: { method: 'detect' },
      tracking: { query: 'jug', moves: true },
    },
    {
      id: 'zone',
      label: 'zone',
      hidden: true,
      placement: { method: 'layout', position: [0, 0, 0] },
    },
  ],
  steps: [{ id: 's', instruction: 'Wait.', success: { type: 'elapsed', ms: 10 } }],
});

function setup() {
  const bus = new Emitter<AppEvents>();
  const registered: string[] = [];
  bus.on('object.registered', (e) => registered.push(`${e.objectId}:${e.method}`));
  const registry = new ObjectRegistry(bus);
  registry.load(procedure.objects, 0);
  return { bus, registry, registered };
}

const near = (a: readonly number[] | undefined, b: readonly number[], eps = 1e-6) =>
  !!a && a.every((v, i) => Math.abs(v - (b[i] ?? Number.NaN)) < eps);

describe('ObjectRegistry', () => {
  it('places layout objects immediately and leaves detect objects unplaced', () => {
    const { registry, registered } = setup();
    expect(registry.get('cup')?.position).toEqual([0.1, 0.07, -0.2]);
    expect(registry.get('jug')).toBeUndefined();
    expect(registry.unplaced()).toEqual(['jug']);
    expect(registered).toEqual(['cup:layout', 'zone:layout']);
  });

  it('records a camera observation once, then tracks it silently', () => {
    const { registry, registered } = setup();
    registry.observe('jug', {
      position: [0.3, 0.1, -0.3],
      confidence: 0.8,
      source: 'detector',
      t: 5,
    });
    registry.observe('jug', {
      position: [0.31, 0.1, -0.3],
      confidence: 0.9,
      source: 'detector',
      t: 6,
    });
    expect(registry.get('jug')?.position).toEqual([0.31, 0.1, -0.3]);
    expect(registry.get('jug')?.source).toBe('detector');
    expect(registered).toEqual(['cup:layout', 'zone:layout', 'jug:detector']);
  });

  it('carries a held object with the wrist, keeping the grip offset', () => {
    const { registry } = setup();
    registry.observe('jug', {
      position: [0.3, 0.1, -0.3],
      confidence: 1,
      source: 'detector',
      t: 0,
    });
    registry.attach('jug', 'right', { p: [0.3, 0.1, -0.2], q: [0, 0, 0, 1] }, 1);
    // Wrist moves +10 cm in x and turns 90° about +y: the 10 cm forward grip offset (-z) now
    // points along -x.
    registry.updateHeld(
      { right: { p: [0.4, 0.1, -0.2], q: quatFromAxisAngle([0, 1, 0], Math.PI / 2) } },
      2,
    );
    expect(near(registry.get('jug')?.position, [0.3, 0.1, -0.2])).toBe(true);
    expect(registry.get('jug')?.heldBy).toBe('right');
  });

  it('ignores camera updates while an object is held, and resumes after release', () => {
    const { registry } = setup();
    registry.observe('jug', {
      position: [0.3, 0.1, -0.3],
      confidence: 1,
      source: 'detector',
      t: 0,
    });
    registry.attach('jug', 'left', { p: [0.3, 0.1, -0.2], q: [0, 0, 0, 1] }, 1);
    registry.observe('jug', { position: [9, 9, 9], confidence: 1, source: 'detector', t: 2 });
    expect(registry.get('jug')?.position).toEqual([0.3, 0.1, -0.3]);
    registry.detach('jug', 3);
    registry.observe('jug', {
      position: [0.5, 0.1, -0.3],
      confidence: 1,
      source: 'detector',
      t: 4,
    });
    expect(registry.get('jug')?.position).toEqual([0.5, 0.1, -0.3]);
  });

  it('finds the nearest visible object within range', () => {
    const { registry } = setup();
    expect(registry.nearest([0.12, 0.07, -0.2], 0.1)).toEqual({
      objectId: 'cup',
      distance: expect.closeTo(0.02),
    });
    expect(registry.nearest([0.9, 0.9, 0.9], 0.1)).toBeNull();
  });

  it('collects changed estimates for the object track stream', () => {
    const { registry } = setup();
    registry.drainChanges();
    registry.observe('jug', {
      position: [0.3, 0.1, -0.3],
      confidence: 0.7,
      source: 'detector',
      t: 5,
    });
    expect(registry.drainChanges()).toEqual([
      {
        id: 'jug',
        position: [0.3, 0.1, -0.3],
        orientation: null,
        confidence: 0.7,
        source: 'detector',
      },
    ]);
    expect(registry.drainChanges()).toEqual([]);
  });
});
