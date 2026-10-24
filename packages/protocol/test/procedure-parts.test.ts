import { describe, expect, it } from 'vitest';
import { parseProcedure } from '../src/index';

// A component of a larger object (a caliper's vernier scale) is an object of its own that says
// which declared object it is a part of, so the whole is followed and recorded with it.

const caliper = {
  id: 'caliper',
  label: 'caliper',
  kind: 'tool',
  placement: { method: 'detect' },
  tracking: { query: 'A silver steel vernier caliper lying open on the mat', moves: true },
};
const scale = {
  id: 'vernier_scale',
  label: 'vernier scale',
  placement: { method: 'detect' },
  tracking: { query: 'The engraved vernier scale on the sliding jaw of the caliper' },
};

const plan = (objects: unknown[], target: string) => ({
  schema: 'clio.procedure/1',
  id: 'measure',
  version: 1,
  title: 'Measure',
  summary: 'Read the caliper.',
  workspace: { size: [0.6, 0.4] },
  objects,
  steps: [
    {
      id: 'read',
      instruction: 'Read the scale.',
      targets: [target],
      success: { type: 'confirm' },
    },
  ],
});

describe('parts of objects', () => {
  it('lets a component say which declared object it is a part of', () => {
    const parsed = parseProcedure(
      plan([caliper, { ...scale, partOf: 'caliper' }], 'vernier_scale'),
    );
    expect(parsed.objects.map((o) => o.partOf)).toEqual([undefined, 'caliper']);
  });

  it('rejects a part of an undeclared object', () => {
    const bad = plan([{ ...scale, partOf: 'caliper' }], 'vernier_scale');
    expect(() => parseProcedure(bad)).toThrow(/Unknown object "caliper"/);
  });

  it('rejects an object that is a part of itself', () => {
    const bad = plan([{ ...caliper, partOf: 'caliper' }], 'caliper');
    expect(() => parseProcedure(bad)).toThrow(/part of itself/);
  });
});
