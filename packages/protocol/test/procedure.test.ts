import { describe, expect, it } from 'vitest';
import { checkObjectRefs, parseProcedure, safeParseProcedure } from '../src/index';

const base = {
  schema: 'clio.procedure/1',
  id: 'demo-task',
  version: 1,
  title: 'Demo task',
  summary: 'A tiny task for tests.',
  workspace: { size: [0.6, 0.4] },
  objects: [
    {
      id: 'cup_a',
      label: 'cup A',
      kind: 'container',
      placement: { method: 'layout', position: [0.1, 0, -0.1] },
    },
    { id: 'cup_b', label: 'cup B', placement: { method: 'register' } },
  ],
  steps: [
    {
      id: 'touch-a',
      instruction: 'Touch cup A.',
      targets: ['cup_a'],
      success: { type: 'hand_near', object: 'cup_a' },
    },
  ],
};

function withStep(step: Record<string, unknown>) {
  return { ...base, steps: [{ ...base.steps[0], ...step }] };
}

describe('procedures', () => {
  it('fills defaults so authors can write minimal steps', () => {
    const p = parseProcedure(base);
    expect(p.steps[0]?.success).toEqual({
      type: 'hand_near',
      object: 'cup_a',
      hand: 'either',
      point: 'pinch',
      radius: 0.06,
      dwellMs: 250,
    });
    expect(p.steps[0]?.mistakes).toEqual([]);
    expect(p.objects[1]?.kind).toBe('item');
    expect(p.objects[1]?.hidden).toBe(false);
  });

  it('accepts nested composite checks', () => {
    const p = parseProcedure(
      withStep({
        success: {
          type: 'sequence',
          of: [
            { type: 'pinch_near', object: 'cup_a', hand: 'left' },
            {
              type: 'all',
              of: [
                { type: 'pinch_near', object: 'cup_b', hand: 'right' },
                { type: 'lift', hand: 'left' },
              ],
            },
          ],
        },
      }),
    );
    const success = p.steps[0]?.success;
    expect(success?.type).toBe('sequence');
    expect(success && checkObjectRefs(success)).toEqual(['cup_a', 'cup_b']);
  });

  it('rejects a step that targets an undeclared object', () => {
    expect(() => parseProcedure(withStep({ targets: ['cup_z'] }))).toThrow(/cup_z/);
  });

  it('rejects an undeclared object inside a nested check', () => {
    const bad = withStep({
      success: {
        type: 'sequence',
        of: [
          { type: 'hand_near', object: 'cup_a' },
          { type: 'any', of: [{ type: 'pinch_near', object: 'ghost' }] },
        ],
      },
    });
    expect(() => parseProcedure(bad)).toThrow(/ghost/);
  });

  it('rejects an undeclared object inside a mistake rule', () => {
    const bad = withStep({
      mistakes: [
        { kind: 'wrong_cup', message: 'Other cup.', when: { type: 'hand_near', object: 'cup_q' } },
      ],
    });
    expect(() => parseProcedure(bad)).toThrow(/cup_q/);
  });

  it('rejects duplicate step ids', () => {
    const dup = { ...base, steps: [base.steps[0], base.steps[0]] };
    expect(() => parseProcedure(dup)).toThrow(/duplicate step id "touch-a"/i);
  });

  it('rejects duplicate object ids', () => {
    const dup = { ...base, objects: [base.objects[0], base.objects[0]] };
    expect(() => parseProcedure(dup)).toThrow(/duplicate object id "cup_a"/i);
  });

  it('rejects an unknown check type', () => {
    expect(() => parseProcedure(withStep({ success: { type: 'teleport' } }))).toThrow();
  });

  it('reports readable errors without throwing', () => {
    const r = safeParseProcedure(withStep({ targets: ['cup_z'] }));
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toMatch(/cup_z/);
  });
});

describe('object tracking specs', () => {
  it('lets an object declare a fiducial marker and a detector query', () => {
    const p = parseProcedure({
      ...base,
      objects: [
        {
          ...base.objects[0],
          tracking: { marker: { id: 7, sizeM: 0.04 }, query: 'white paper cup labeled A' },
        },
        base.objects[1],
      ],
    });
    expect(p.objects[0]?.tracking).toEqual({
      marker: { family: 'aruco_4x4_50', id: 7, sizeM: 0.04, offset: [0, 0, 0] },
      query: 'white paper cup labeled A',
      moves: false,
    });
    expect(p.objects[1]?.tracking).toBeUndefined();
  });

  it('rejects two objects sharing one marker', () => {
    const marked = (id: string) => ({
      id,
      label: id,
      placement: { method: 'register' },
      tracking: { marker: { id: 3, sizeM: 0.04 } },
    });
    expect(() => parseProcedure({ ...base, objects: [marked('cup_a'), marked('cup_b')] })).toThrow(
      /marker 3 is used by both "cup_a" and "cup_b"/,
    );
  });
});

describe('object-centric checks', () => {
  it('references both the moving object and its target', () => {
    const p = parseProcedure(
      withStep({ success: { type: 'object_near', object: 'cup_b', target: 'cup_a' } }),
    );
    const success = p.steps[0]?.success;
    expect(success).toEqual({
      type: 'object_near',
      object: 'cup_b',
      target: 'cup_a',
      radius: 0.06,
      dwellMs: 500,
    });
    expect(success && checkObjectRefs(success)).toEqual(['cup_b', 'cup_a']);
  });

  it('rejects an undeclared target object', () => {
    const bad = withStep({ success: { type: 'object_near', object: 'cup_a', target: 'sink' } });
    expect(() => parseProcedure(bad)).toThrow(/sink/);
  });
});

describe('AI-generated plans', () => {
  const generated = {
    schema: 'clio.procedure/1',
    id: 'refill-washer-fluid',
    version: 1,
    title: 'Refill windshield washer fluid',
    summary: 'Open the reservoir, pour in fluid, close it.',
    origin: {
      kind: 'generated',
      goal: 'add wiper fluid',
      model: 'gemini-3.5-flash',
      createdAt: '2026-10-24T04:00:00.000Z',
    },
    workspace: { size: [1, 0.8] },
    objects: [
      {
        id: 'cap',
        label: 'blue reservoir cap',
        placement: { method: 'detect' },
        tracking: { query: 'blue cap with a windshield symbol' },
      },
      { id: 'reservoir', label: 'reservoir opening', placement: { method: 'detect' } },
      {
        id: 'jug',
        label: 'washer fluid jug',
        placement: { method: 'detect' },
        tracking: { query: 'washer fluid jug', moves: true },
      },
    ],
    steps: [
      {
        id: 'open-cap',
        instruction: 'Twist the blue cap counterclockwise to open it.',
        targets: ['cap'],
        action: { verb: 'twist', object: 'cap', direction: 'ccw', amount: 1.5 },
        success: { type: 'confirm', prompt: 'The cap is off' },
      },
      {
        id: 'pour-fluid',
        instruction: 'Pour the fluid into the reservoir.',
        targets: ['jug', 'reservoir'],
        action: { verb: 'pour', object: 'jug', target: 'reservoir' },
        success: { type: 'confirm', prompt: 'The reservoir is full' },
      },
    ],
  };

  it('marks hand-written procedures as curated by default', () => {
    expect(parseProcedure(base).origin).toEqual({ kind: 'curated' });
  });

  it('accepts camera-detected objects and action primitives', () => {
    const p = parseProcedure(generated);
    expect(p.origin.kind).toBe('generated');
    expect(p.objects[0]?.placement).toEqual({ method: 'detect' });
    expect(p.steps[0]?.action).toEqual({
      verb: 'twist',
      object: 'cap',
      direction: 'ccw',
      amount: 1.5,
      hand: 'either',
    });
  });

  it('rejects an action on an undeclared object', () => {
    const bad = structuredClone(generated);
    bad.steps[0] = { ...bad.steps[0], action: { verb: 'twist', object: 'bolt' } } as never;
    expect(() => parseProcedure(bad)).toThrow(/Unknown object "bolt"/);
  });

  it('rejects an action missing an argument its verb requires', () => {
    const bad = structuredClone(generated);
    bad.steps[1] = { ...bad.steps[1], action: { verb: 'pour', object: 'jug' } } as never;
    expect(() => parseProcedure(bad)).toThrow(/"pour" needs a target/);
  });
});

describe('what each step shows', () => {
  const step = {
    id: 'open-cap',
    instruction: 'Twist the blue cap counterclockwise to open it.',
    targets: ['cup_a'],
    success: { type: 'confirm' },
  };

  it('lets a step describe what to outline, for the object finder', () => {
    const p = parseProcedure({
      ...base,
      steps: [
        {
          ...step,
          show: [
            {
              object: 'cup_a',
              phrase: 'white paper cup',
              description:
                'The small white paper cup with a large letter A, front left of the tray.',
            },
          ],
        },
      ],
    });
    expect(p.steps[0]?.show).toEqual([
      {
        object: 'cup_a',
        phrase: 'white paper cup',
        description: 'The small white paper cup with a large letter A, front left of the tray.',
      },
    ]);
  });

  it('defaults to showing nothing extra', () => {
    expect(parseProcedure({ ...base, steps: [step] }).steps[0]?.show).toEqual([]);
  });

  it('rejects a show item for an undeclared object', () => {
    const bad = {
      ...base,
      steps: [
        { ...step, show: [{ object: 'funnel', phrase: 'funnel', description: 'A funnel.' }] },
      ],
    };
    expect(() => parseProcedure(bad)).toThrow(/Unknown object "funnel"/);
  });
});
