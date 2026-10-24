import { parseProcedure } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { Emitter } from '../../src/core/emitter';
import type { AppEvents } from '../../src/domain/events';
import type { TrackedFrame } from '../../src/domain/hands/types';
import { GraspTracker } from '../../src/domain/world/holding';
import { ObjectRegistry } from '../../src/domain/world/object-registry';
import { makeHand, pinchingHand } from '../support/hands';

const procedure = parseProcedure({
  schema: 'clio.procedure/1',
  id: 'p',
  version: 1,
  title: 'P',
  summary: 'S',
  workspace: { size: [1, 1] },
  objects: [
    {
      id: 'jug',
      label: 'jug',
      kind: 'container',
      radius: 0.05,
      placement: { method: 'layout', position: [0.3, 0.1, -0.3] },
    },
    {
      id: 'dot',
      label: 'dot',
      kind: 'point',
      placement: { method: 'layout', position: [0.1, 0, -0.2] },
    },
  ],
  steps: [{ id: 's', instruction: 'Wait.', success: { type: 'elapsed', ms: 10 } }],
});

function setup() {
  const registry = new ObjectRegistry(new Emitter<AppEvents>());
  registry.load(procedure.objects, 0);
  return { registry, grasp: new GraspTracker(registry) };
}

const frameWith = (t: number, right: TrackedFrame['right']): TrackedFrame => ({
  t,
  head: { p: [0, 0.5, 0.3], q: [0, 0, 0, 1] },
  left: null,
  right,
});

describe('GraspTracker', () => {
  it('picks up a movable object pinched near it, carries it, and lets go on release', () => {
    const { registry, grasp } = setup();
    const atJug = pinchingHand([0.3, 0.1, -0.3]);
    grasp.onPinch(
      { hand: 'right', phase: 'start', point: [0.3, 0.1, -0.3], t: 10 },
      frameWith(10, atJug),
    );
    expect(registry.get('jug')?.heldBy).toBe('right');

    const moved = pinchingHand([0.5, 0.2, -0.3]);
    grasp.update(frameWith(20, moved));
    expect(registry.get('jug')?.position[0]).toBeCloseTo(0.5);

    const released = grasp.onPinch(
      { hand: 'right', phase: 'end', point: [0.5, 0.2, -0.3], t: 30 },
      frameWith(30, moved),
    );
    expect(released).toEqual(['jug']);
    expect(registry.get('jug')?.heldBy).toBeNull();
  });

  it('never picks up fixed points', () => {
    const { registry, grasp } = setup();
    grasp.onPinch(
      { hand: 'right', phase: 'start', point: [0.1, 0, -0.2], t: 10 },
      frameWith(10, pinchingHand([0.1, 0, -0.2])),
    );
    expect(registry.get('dot')?.heldBy).toBeNull();
  });

  it('picks up with a closed fist around the object', () => {
    const { registry, grasp } = setup();
    // Fingertips curled onto the palm, palm at the jug.
    const fist = makeHand(
      { wrist: [0.3, 0.1, -0.24], 'middle-finger-phalanx-proximal': [0.3, 0.1, -0.36] },
      [0.3, 0.1, -0.3],
    );
    grasp.update(frameWith(10, fist));
    expect(registry.get('jug')?.heldBy).toBe('right');
  });
});
