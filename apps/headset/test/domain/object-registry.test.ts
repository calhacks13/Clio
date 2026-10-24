import { parseProcedure } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { Emitter } from '../../src/core/emitter';
import { quatFromAxisAngle, type Vec3 } from '../../src/core/math';
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

  it('keeps a measured layout position over a camera guess, until the object is moved', () => {
    const { registry } = setup();
    const guess = { position: [0.13, 0.05, -0.24] as [number, number, number], confidence: 0.9 };
    expect(registry.observe('cup', { ...guess, source: 'detector', t: 1 })).toBe(false);
    expect(registry.get('cup')).toMatchObject({ position: [0.1, 0.07, -0.2], source: 'layout' });
    // Picked up and put down somewhere else: the layout no longer says where it is.
    registry.attach('cup', 'right', { p: [0.1, 0.07, -0.2], q: [0, 0, 0, 1] }, 2);
    registry.updateHeld({ right: { p: [0.3, 0.07, -0.2], q: [0, 0, 0, 1] } }, 3);
    registry.detach('cup', 4);
    expect(registry.observe('cup', { ...guess, source: 'detector', t: 5 })).toBe(true);
    expect(registry.get('cup')?.position).toEqual([0.13, 0.05, -0.24]);
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
        locationFlags: 10,
        heldBy: null,
        observedT: 5,
      },
    ]);
    expect(registry.drainChanges()).toEqual([]);
  });

  it('says how valid each estimate is', () => {
    const { registry } = setup();
    const flags = () =>
      Object.fromEntries(registry.drainChanges().map((s) => [s.id, s.locationFlags]));
    expect(flags()).toEqual({ cup: 2, zone: 2 });
    registry.observe('jug', {
      position: [0.3, 0.1, -0.3],
      confidence: 1,
      source: 'detector',
      t: 1,
    });
    expect(flags()).toEqual({ jug: 10 });
    const q = quatFromAxisAngle([0, 1, 0], 0.3);
    registry.observe('jug', {
      position: [0.3, 0.1, -0.3],
      orientation: q,
      confidence: 1,
      source: 'marker',
      t: 2,
    });
    expect(flags()).toEqual({ jug: 15 });
    registry.observe('jug', { position: [0.3, 0.1, -0.3], confidence: 1, source: 'pinch', t: 3 });
    expect(flags()).toEqual({ jug: 2 });
  });

  it('marks a held object as carried, and as lost while its wrist is untracked', () => {
    const { registry } = setup();
    registry.observe('jug', {
      position: [0.3, 0.1, -0.3],
      orientation: [0, 0, 0, 1],
      confidence: 1,
      source: 'marker',
      t: 0,
    });
    registry.drainChanges();
    const wrist = { p: [0.3, 0.1, -0.2] as [number, number, number], q: [0, 0, 0, 1] as const };
    registry.attach('jug', 'right', { ...wrist, q: [...wrist.q] }, 1);
    registry.updateHeld({ right: { ...wrist, q: [...wrist.q] } }, 2);
    expect(registry.drainChanges()).toEqual([
      expect.objectContaining({ locationFlags: 3, heldBy: 'right', observedT: 2 }),
    ]);
    // The wrist drops out: one state with nothing valid (and no orientation), at the last place.
    // It has no observedT, so it is not placed at the time of the last carried state.
    registry.updateHeld({}, 3);
    const [lost] = registry.drainChanges();
    expect(lost).toEqual(
      expect.objectContaining({
        position: [0.3, 0.1, -0.3],
        orientation: null,
        locationFlags: 0,
        heldBy: 'right',
      }),
    );
    expect(lost).not.toHaveProperty('observedT');
    registry.updateHeld({}, 4);
    expect(registry.drainChanges()).toEqual([]);
    // Back: carried again, with its orientation.
    registry.updateHeld({ right: { ...wrist, q: [...wrist.q] } }, 5);
    expect(registry.drainChanges()).toEqual([
      expect.objectContaining({ orientation: [0, 0, 0, 1], locationFlags: 3, observedT: 5 }),
    ]);
  });

  it('announces grasps and releases with the grip, the reason and where the object was', () => {
    const { bus, registry } = setup();
    const seen: string[] = [];
    bus.on('object.grasped', (e) => seen.push(`grasped ${e.objectId} ${e.hand} ${e.grip} @${e.t}`));
    bus.on('object.released', (e) =>
      seen.push(`released ${e.objectId} ${e.hand} ${e.reason} ${e.position.join(',')} @${e.t}`),
    );
    const wrist = { p: [0.1, 0.07, -0.1] as [number, number, number], q: [0, 0, 0, 1] as const };
    expect(registry.attach('cup', 'left', { ...wrist, q: [...wrist.q] }, 1, 'fist')).toBe(true);
    expect(registry.attach('cup', 'right', { ...wrist, q: [...wrist.q] }, 2)).toBe(false);
    registry.updateHeld({ left: { p: [0.2, 0.07, -0.1], q: [0, 0, 0, 1] } }, 3);
    registry.detach('cup', 4, 'hand_lost');
    registry.detach('cup', 5);
    expect(seen).toEqual([
      'grasped cup left fist @1',
      'released cup left hand_lost 0.2,0.07,-0.2 @4',
    ]);
  });

  it('lets go of held objects when a new plan is loaded', () => {
    const { bus, registry } = setup();
    const released: string[] = [];
    bus.on('object.released', (e) => released.push(`${e.objectId}:${e.reason}@${e.t}`));
    registry.attach('cup', 'right', { p: [0.1, 0.07, -0.1], q: [0, 0, 0, 1] }, 1);
    registry.drainChanges();
    registry.load(procedure.objects, 7);
    expect(released).toEqual(['cup:plan_changed@7']);
    expect(registry.heldBy('right')).toEqual([]);
    expect(registry.drainChanges()).toEqual([
      expect.objectContaining({ id: 'cup', heldBy: null, locationFlags: 2, observedT: 7 }),
    ]);
  });

  it('drops a camera answer about a moment older than what it already knows', () => {
    const { registry } = setup();
    registry.observe('jug', {
      position: [0.3, 0.1, -0.3],
      confidence: 1,
      source: 'detector',
      t: 0,
    });
    registry.attach('jug', 'right', { p: [0.3, 0.1, -0.2], q: [0, 0, 0, 1] }, 10);
    registry.updateHeld({ right: { p: [0.5, 0.1, -0.2], q: [0, 0, 0, 1] } }, 20);
    registry.detach('jug', 30);
    // Captured at 25 (still in the hand), answered after the release: stale.
    expect(
      registry.observe('jug', {
        position: [0.4, 0.1, -0.3],
        confidence: 1,
        source: 'detector',
        t: 25,
      }),
    ).toBe(false);
    expect(registry.get('jug')?.position).toEqual([0.5, 0.1, -0.3]);
    expect(
      registry.observe('jug', {
        position: [0.52, 0.1, -0.3],
        confidence: 1,
        source: 'detector',
        t: 31,
      }),
    ).toBe(true);
  });

  it('announces a slow camera answer when it arrives, keeping its frame time in the estimate', () => {
    const { bus, registry } = setup();
    const times: number[] = [];
    bus.on('object.registered', (e) => times.push(e.t));
    registry.drainChanges();
    registry.updateHeld({}, 1500);
    registry.observe('jug', {
      position: [0.3, 0.1, -0.3],
      confidence: 1,
      source: 'detector',
      t: 300,
    });
    expect(times).toEqual([1500]);
    expect(registry.drainChanges()).toEqual([
      expect.objectContaining({ id: 'jug', observedT: 300 }),
    ]);
  });

  it('records a camera position not measured on its frame as valid, never tracked', () => {
    const { registry, registered } = setup();
    registry.drainChanges();
    const at = { position: [0.3, 0.1, -0.3] as Vec3, confidence: 0.6, source: 'detector' as const };
    registry.observe('jug', { ...at, t: 1, measured: false });
    expect(registry.drainChanges()).toEqual([
      expect.objectContaining({ id: 'jug', locationFlags: 2, observedT: 1, confidence: 0.6 }),
    ]);
    registry.observe('jug', { ...at, t: 2, measured: true });
    expect(registry.drainChanges()).toEqual([
      expect.objectContaining({ locationFlags: 10, observedT: 2 }),
    ]);
    registry.observe('jug', { ...at, t: 3, measured: false });
    expect(registry.drainChanges()).toEqual([expect.objectContaining({ locationFlags: 2 })]);
    // Measured or not, it is the same camera placement: announced once.
    expect(registered).toEqual(['cup:layout', 'zone:layout', 'jug:detector']);
  });

  it('records a loss once at the last position, and tracks again once the object is seen', () => {
    const { registry } = setup();
    const at = { position: [0.3, 0.1, -0.3] as Vec3, confidence: 0.8, source: 'detector' as const };
    registry.observe('jug', { ...at, t: 10 });
    registry.drainChanges();
    registry.lose('jug', 20);
    const [lost] = registry.drainChanges();
    expect(lost).toEqual(
      expect.objectContaining({
        id: 'jug',
        position: [0.3, 0.1, -0.3],
        orientation: null,
        confidence: 0,
        locationFlags: 0,
        heldBy: null,
      }),
    );
    expect(lost).not.toHaveProperty('observedT');
    registry.lose('jug', 30);
    expect(registry.drainChanges()).toEqual([]);
    // The lesson still knows where it was last seen; it is not unplaced, so nothing re-finds it.
    expect(registry.position('jug')).toEqual([0.3, 0.1, -0.3]);
    expect(registry.unplaced()).toEqual([]);
    expect(registry.get('jug')?.lostAt).toBe(20);
    // An answer about a frame from before the loss is stale; a later one tracks it again.
    expect(registry.observe('jug', { ...at, position: [0.4, 0.1, -0.3], t: 15 })).toBe(false);
    expect(registry.observe('jug', { ...at, position: [0.4, 0.1, -0.3], t: 40 })).toBe(true);
    expect(registry.get('jug')?.lostAt).toBeUndefined();
    expect(registry.drainChanges()).toEqual([
      expect.objectContaining({ locationFlags: 10, confidence: 0.8, observedT: 40 }),
    ]);
  });

  it('ignores a loss of a held object, of a layout or hand placement, or older than the estimate', () => {
    const { registry } = setup();
    registry.drainChanges();
    // A layout spot is not where a camera put it.
    registry.lose('cup', 5);
    // Held: the hand owns the estimate, and a hand hiding the object is no loss.
    registry.observe('jug', {
      position: [0.3, 0.1, -0.3],
      confidence: 1,
      source: 'detector',
      t: 0,
    });
    registry.attach('jug', 'right', { p: [0.3, 0.1, -0.2], q: [0, 0, 0, 1] }, 10);
    registry.drainChanges();
    registry.lose('jug', 11);
    expect(registry.drainChanges()).toEqual([]);
    // Released where the hand let go: carried, and the tracker losing sight of it changes nothing.
    registry.updateHeld({ right: { p: [0.5, 0.1, -0.2], q: [0, 0, 0, 1] } }, 20);
    registry.detach('jug', 30);
    registry.drainChanges();
    registry.lose('jug', 31);
    expect(registry.drainChanges()).toEqual([]);
    // Seen again at 40: a loss reported about frame 35 is older than that.
    registry.observe('jug', {
      position: [0.5, 0.1, -0.3],
      confidence: 1,
      source: 'detector',
      t: 40,
    });
    registry.drainChanges();
    registry.lose('jug', 35);
    expect(registry.drainChanges()).toEqual([]);
    expect(registry.get('jug')?.lostAt).toBeUndefined();
  });

  it('grasps a lost object at its last position and carries it, valid again', () => {
    const { registry } = setup();
    registry.observe('jug', {
      position: [0.3, 0.1, -0.3],
      confidence: 1,
      source: 'detector',
      t: 0,
    });
    registry.lose('jug', 5);
    registry.drainChanges();
    // Hands hide what they grab: the pinch still finds it where it was last seen.
    expect(registry.nearest([0.31, 0.1, -0.3], 0.05)?.objectId).toBe('jug');
    expect(registry.attach('jug', 'left', { p: [0.3, 0.1, -0.2], q: [0, 0, 0, 1] }, 6)).toBe(true);
    expect(registry.get('jug')?.lostAt).toBeUndefined();
    expect(registry.drainChanges()).toEqual([
      expect.objectContaining({ locationFlags: 2, heldBy: 'left', confidence: 1, observedT: 6 }),
    ]);
  });

  it('records where a hand let go as carried, even when the wrist never moved it', () => {
    const { registry } = setup();
    registry.drainChanges();
    registry.observe('jug', {
      position: [0.3, 0.1, -0.3],
      confidence: 1,
      source: 'detector',
      t: 0,
    });
    registry.attach('jug', 'right', { p: [0.3, 0.1, -0.2], q: [0, 0, 0, 1] }, 1);
    registry.detach('jug', 2);
    expect(registry.drainChanges()).toEqual([
      expect.objectContaining({ source: 'detector', locationFlags: 2, heldBy: null, observedT: 2 }),
    ]);
  });
});
