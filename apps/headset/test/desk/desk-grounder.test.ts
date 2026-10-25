import { parseProcedure } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { Emitter } from '../../src/core/emitter';
import { DeskGrounder } from '../../src/desk/desk-grounder';
import type { AppEvents } from '../../src/domain/events';
import type { CameraFrame, LocateObject, VisionLocator } from '../../src/domain/world/grounding';
import { ObjectRegistry } from '../../src/domain/world/object-registry';

// The lesson's one-shot looks on the desk: the same finder, and a stand-in position for what it
// finds instead of a lift into the room.

const procedure = parseProcedure({
  schema: 'clio.procedure/1',
  id: 'basil',
  version: 1,
  title: 'Basil',
  summary: 'S',
  workspace: { size: [1, 1] },
  objects: [
    { id: 'can', label: 'watering can', placement: { method: 'detect' } },
    { id: 'pot', label: 'basil pot', placement: { method: 'detect' } },
  ],
  steps: [{ id: 'pour', instruction: 'Pour.', targets: ['can'], success: { type: 'confirm' } }],
});

const frame: CameraFrame = { t: 500, width: 1280, height: 720, jpegBase64: 'AAAA' };

function setup(locate: VisionLocator['locate']) {
  const registry = new ObjectRegistry(new Emitter<AppEvents>());
  registry.load(procedure.objects, 0);
  const asked: LocateObject[][] = [];
  const grounder = new DeskGrounder({
    camera: { capture: async () => frame },
    locator: {
      locate: (f, objects) => {
        asked.push(objects);
        return locate(f, objects);
      },
    },
    registry,
    size: [1, 1],
  });
  return { registry, grounder, asked };
}

describe('DeskGrounder', () => {
  it('asks the finder in the words given, else the object own, and places what it found', async () => {
    const { registry, grounder, asked } = setup(async () => ({
      model: 'jev',
      detections: [
        {
          id: 'can',
          found: true,
          point: [0.25, 0.75],
          box: [0.2, 0.6, 0.3, 0.9],
          outline: null,
          confidence: 0.9,
        },
        { id: 'pot', found: true, point: [0.5, 0.5], box: null, outline: null, confidence: 0.1 },
      ],
    }));
    const result = await grounder.ground([
      { id: 'can', description: 'green can on the left', phrase: 'green watering can' },
      { id: 'pot' },
      { id: 'unknown' },
    ]);
    expect(asked[0]).toEqual([
      { id: 'can', query: 'green can on the left', phrase: 'green watering can' },
      { id: 'pot', query: 'basil pot', phrase: 'basil pot' },
    ]);
    expect(result).toMatchObject({ ok: true, located: ['can'], missing: ['pot'], source: 'jev' });
    expect(registry.get('can')).toMatchObject({
      position: [0.25, 0, -0.25],
      source: 'detector',
      measured: false,
      t: 500,
    });
    // Too unsure: not placed.
    expect(registry.get('pot')).toBeUndefined();
    if (result.ok) expect(result.sightings.every((s) => s.outline === null)).toBe(true);
  });

  it('places the closer look answer (a frame it was given) the same way', () => {
    const { registry, grounder } = setup(async () => ({ model: 'x', detections: [] }));
    const placed = grounder.place(frame, [{ id: 'pot', query: 'where is the pot?' }], {
      model: 'robotics-er',
      detections: [
        {
          id: 'pot',
          found: true,
          point: null,
          box: [0.4, 0.4, 0.6, 0.8],
          outline: null,
          confidence: 0.5,
        },
      ],
    });
    expect(placed).toMatchObject({ ok: true, located: ['pot'] });
    const [x, y, z] = registry.position('pot') ?? [];
    expect([x, y]).toEqual([0.5, 0]);
    expect(z).toBeCloseTo(-0.4);
  });

  it('reports a missing frame, a failed finder and an answer for a lesson that ended', async () => {
    const registry = new ObjectRegistry(new Emitter<AppEvents>());
    registry.load(procedure.objects, 0);
    const noFrame = new DeskGrounder({
      camera: { capture: async () => null },
      locator: { locate: async () => ({ model: 'x', detections: [] }) },
      registry,
    });
    expect(await noFrame.ground([{ id: 'can' }])).toEqual({ ok: false, reason: 'no-camera-frame' });
    const failing = setup(async () => {
      throw new Error('503');
    });
    expect(await failing.grounder.ground([{ id: 'can' }])).toMatchObject({
      ok: false,
      reason: 'locator-failed',
    });
    const late = setup(async () => ({ model: 'x', detections: [] }));
    expect(await late.grounder.ground([{ id: 'can' }], { current: () => false })).toEqual({
      ok: false,
      reason: 'dropped',
    });
  });
});
