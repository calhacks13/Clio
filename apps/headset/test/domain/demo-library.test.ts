import { type DemoClip, parseProcedure } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/core/math';
import { type ClipSource, DemoLibrary } from '../../src/domain/demo/demo-library';
import { makeHand } from '../support/hands';

const procedure = parseProcedure({
  schema: 'clio.procedure/1',
  id: 'refill',
  version: 1,
  title: 'Refill',
  summary: 'S',
  workspace: { size: [1, 1] },
  objects: [{ id: 'jug', label: 'jug', placement: { method: 'detect' } }],
  steps: [
    {
      id: 'lift-jug',
      instruction: 'Pick up the jug.',
      targets: ['jug'],
      action: { verb: 'pick_up', object: 'jug' },
      success: { type: 'confirm' },
    },
    { id: 'look', instruction: 'Look at the level.', success: { type: 'confirm' } },
  ],
});
const positions: Record<string, Vec3> = { jug: [0.3, 0.1, -0.3] };
const objects = { position: (id: string) => positions[id], spec: () => undefined };

const recorded: DemoClip = {
  schema: 'clio.clip/1',
  clipId: 'refill/lift-jug',
  procedureId: 'refill',
  procedureVersion: 1,
  stepId: 'lift-jug',
  source: { episodeId: 'ep-1', startT: 0, endT: 100 },
  durationMs: 100,
  frames: [
    { t: 0, left: null, right: makeHand({}) },
    { t: 100, left: null, right: makeHand({}) },
  ],
};

function source(clip: DemoClip | null) {
  const asked: string[] = [];
  const s: ClipSource = {
    fetch: async (id) => {
      asked.push(id);
      return clip;
    },
  };
  return { s, asked };
}

describe('DemoLibrary', () => {
  const step = procedure.steps[0];
  if (!step) throw new Error('fixture');

  it('prefers an expert recording of the step', async () => {
    const { s, asked } = source(recorded);
    const demo = await new DemoLibrary(s).forStep(procedure, step, objects);
    expect(asked).toEqual(['refill/lift-jug']);
    expect(demo?.source).toBe('recorded');
    expect(demo?.clip.durationMs).toBe(100);
  });

  it('synthesizes one from the action when there is no recording', async () => {
    const { s } = source(null);
    const demo = await new DemoLibrary(s).forStep(procedure, step, objects);
    expect(demo?.source).toBe('synthesized');
    expect(demo?.verb).toBe('pick_up');
  });

  it('asks the clip source only once per step', async () => {
    const { s, asked } = source(null);
    const lib = new DemoLibrary(s);
    await lib.forStep(procedure, step, objects);
    await lib.forStep(procedure, step, objects);
    expect(asked).toHaveLength(1);
  });

  it('works offline, and has nothing to show for steps without an action', async () => {
    const lib = new DemoLibrary(null);
    expect((await lib.forStep(procedure, step, objects))?.source).toBe('synthesized');
    const look = procedure.steps[1];
    expect(look && (await lib.forStep(procedure, look, objects))).toBeNull();
  });
});
