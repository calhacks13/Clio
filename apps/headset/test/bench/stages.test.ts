import { type BenchRun, ProcedureSchema } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import {
  firstOf,
  pairStages,
  REFINE_REASON,
  restRevise,
  stageTiming,
} from '../../src/bench/stages';

// Plans in two stages: asking for the rest, pairing the two runs again, and their timing.

const procedure = ProcedureSchema.parse({
  schema: 'clio.procedure/1',
  id: 'coffee',
  version: 1,
  title: 'Coffee',
  summary: 'Pour-over coffee.',
  workspace: { size: [0.8, 0.6] },
  objects: [{ id: 'kettle', label: 'kettle', placement: { method: 'detect' } }],
  steps: ['boil', 'grind', 'pour'].map((id) => ({
    id,
    instruction: `Do ${id}.`,
    success: { type: 'confirm' },
  })),
});

function run(
  id: string,
  createdAt: string,
  extra: { stage?: 'first' | 'rest'; outlineFrom?: number; from?: number; model?: string } = {},
): BenchRun {
  return {
    id,
    createdAt,
    model: extra.model ?? 'gemini-robotics-er-2-preview',
    latencyMs: 4000,
    attempts: 1,
    request: {
      goal: 'Make coffee',
      views: 2,
      ...(extra.stage ? { stage: extra.stage } : {}),
      ...(extra.from === undefined ? {} : { revise: { fromStepIndex: extra.from, reason: 'x' } }),
    },
    result: {
      ok: true,
      planId: id,
      procedure,
      warnings: [],
      ...(extra.outlineFrom === undefined ? {} : { outlineFrom: extra.outlineFrom }),
    },
  };
}

describe('restRevise', () => {
  it('asks for the outline of a stage-first plan in full', () => {
    expect(restRevise(run('a', '2026-10-24T10:00:00.000Z', { outlineFrom: 1 }))).toEqual({
      base: procedure,
      fromStepIndex: 1,
      reason: REFINE_REASON,
    });
  });

  it('has nothing to ask without an outline', () => {
    expect(restRevise(run('a', '2026-10-24T10:00:00.000Z'))).toBeNull();
    expect(restRevise(run('a', '2026-10-24T10:00:00.000Z', { outlineFrom: 3 }))).toBeNull();
    const failed: BenchRun = {
      ...run('a', '2026-10-24T10:00:00.000Z'),
      result: { ok: false, code: 'timeout', message: 'too slow' },
    };
    expect(restRevise(failed)).toBeNull();
  });
});

describe('pairStages', () => {
  it('pairs each rest with the latest stage-first run of its model and outline', () => {
    const older = run('first-1', '2026-10-24T10:00:00.000Z', { stage: 'first', outlineFrom: 1 });
    const first = run('first-2', '2026-10-24T10:01:00.000Z', { stage: 'first', outlineFrom: 1 });
    const other = run('first-3', '2026-10-24T10:01:00.500Z', {
      stage: 'first',
      outlineFrom: 1,
      model: 'gemini-3.8-flash',
    });
    const rest = run('rest-1', '2026-10-24T10:01:04.000Z', { stage: 'rest', from: 1 });
    const full = run('full', '2026-10-24T10:02:00.000Z');
    const pairs = pairStages([full, rest, other, first, older]);
    expect([...pairs.entries()].map(([f, r]) => [f, r.id])).toEqual([['first-2', 'rest-1']]);
    expect(firstOf(pairs, rest)).toBe('first-2');
    expect(firstOf(pairs, full)).toBeNull();
  });

  it('leaves a rest alone when no first run outlines from where it starts', () => {
    const first = run('first', '2026-10-24T10:00:00.000Z', { stage: 'first', outlineFrom: 2 });
    const rest = run('rest', '2026-10-24T10:00:05.000Z', { stage: 'rest', from: 1 });
    expect(pairStages([rest, first]).size).toBe(0);
  });
});

describe('stageTiming', () => {
  it('says when step 1 was ready and how much later the rest', () => {
    const first = { ...run('f', '2026-10-24T10:00:00.000Z'), latencyMs: 3200 };
    const rest = { ...run('r', '2026-10-24T10:00:03.300Z'), latencyMs: 8000 };
    expect(stageTiming(first, rest)).toEqual({ firstMs: 3200, restMs: 8100 });
  });
});
