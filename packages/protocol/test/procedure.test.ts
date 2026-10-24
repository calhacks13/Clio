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
