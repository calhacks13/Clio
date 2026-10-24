import { parseProcedure } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import { DemoLibrary } from '../../src/domain/demo/demo-library';
import type { AppEvents } from '../../src/domain/events';
import { EpisodeRecorder } from '../../src/domain/recording/recorder';
import { MemoryEpisodeSink } from '../../src/domain/recording/sink';
import { type EpisodeContext, LessonController } from '../../src/domain/session/lesson-controller';
import { ObjectRegistry } from '../../src/domain/world/object-registry';
import { Workspace } from '../../src/domain/world/workspace';

const procedure = parseProcedure({
  schema: 'clio.procedure/1',
  id: 'p',
  version: 1,
  title: 'P',
  summary: 'S',
  workspace: { size: [1, 1] },
  objects: [{ id: 'cup', label: 'cup', placement: { method: 'layout', position: [0.1, 0, -0.2] } }],
  steps: [{ id: 's', instruction: 'Wait.', success: { type: 'confirm' } }],
});

async function recordedFeatures(features?: string[]) {
  const bus = new Emitter<AppEvents>();
  const clock = new ManualClock(1000);
  const sink = new MemoryEpisodeSink();
  const context: EpisodeContext = {
    operator: { role: 'learner' },
    coach: { kind: 'scripted' },
    device: { userAgent: 'test', emulated: true, xrFeatures: [] },
    app: { version: 'test' },
    ...(features ? { features } : {}),
  };
  const lesson = new LessonController({
    bus,
    clock,
    planner: { plan: async () => Promise.reject(new Error('not used')) },
    registry: new ObjectRegistry(bus),
    workspace: () => new Workspace({ p: [0, 0.8, -0.4], q: [0, 0, 0, 1] }, 'default_in_front'),
    grounder: null,
    images: null,
    demos: new DemoLibrary(null),
    recorder: new EpisodeRecorder({ bus, clock, sink, sleep: async () => {} }),
    context: () => context,
  });
  await lesson.run(procedure);
  await lesson.stop('done');
  return sink.only().meta.features;
}

describe('LessonController episode features', () => {
  it('lists the features the lesson records itself', async () => {
    expect(await recordedFeatures()).toEqual(['object.flags', 'object.grasp']);
  });

  it('adds the features the app records, such as detected planes', async () => {
    expect(await recordedFeatures(['environment.planes'])).toEqual([
      'object.flags',
      'object.grasp',
      'environment.planes',
    ]);
  });
});
