import {
  EpisodeBatchSchema,
  type EpisodeCreate,
  HAND_LAYOUT,
  type ObjectObservation,
  type ObjectState,
} from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import type { AppEvents } from '../../src/domain/events';
import { ObjectTrackRecorder } from '../../src/domain/recording/object-track-recorder';
import { EpisodeRecorder } from '../../src/domain/recording/recorder';
import { MemoryEpisodeSink } from '../../src/domain/recording/sink';
import { Workspace } from '../../src/domain/world/workspace';

const meta: EpisodeCreate = {
  schema: 'clio.episode/1',
  mode: 'free',
  procedure: null,
  operator: { role: 'collector' },
  clock: { timeline: 'performance.now', startEpochMs: 0 },
  space: {
    frame: 'workspace',
    units: 'm',
    upAxis: '+y',
    worldFromWorkspace: [0, 0, 0, 0, 0, 0, 1],
    calibration: 'default_in_front',
    anchored: false,
  },
  hands: HAND_LAYOUT,
  objects: [],
  coach: { kind: 'none' },
  device: { userAgent: 'test', emulated: true, xrFeatures: [] },
  app: { version: 'test' },
  features: ['object.observations'],
};

const observation = (over: Partial<ObjectObservation> = {}): ObjectObservation => ({
  t: 2250.123456,
  observedT: 2190.004321,
  objectId: 'syringe',
  status: 'measured',
  role: 'tracker',
  source: 'yoloe-26l-seg',
  box: [0.400004, 0.312345, 0.5, 0.456789],
  outline: [
    [0.411111, 0.300001],
    [0.5, 0.3],
    [0.456789, 0.45],
  ],
  point: [0.45, 0.363636],
  contact: [0.454545, 0.45],
  score: 0.812345,
  frame: { seq: 42, width: 480, height: 360 },
  trackId: '7',
  ...over,
});

const frame = (t: number) => ({
  t,
  head: {
    p: [0, 1.6, 0] as [number, number, number],
    q: [0, 0, 0, 1] as [number, number, number, number],
  },
  left: null,
  right: null,
});

function setup(options = {}) {
  const bus = new Emitter<AppEvents>();
  const clock = new ManualClock(1000);
  const sink = new MemoryEpisodeSink();
  const dropped: string[] = [];
  const recorder = new EpisodeRecorder({
    bus,
    clock,
    sink,
    sleep: async () => {},
    onDrop: (why) => dropped.push(why),
    ...options,
  });
  return { bus, clock, recorder, sink, dropped };
}

const observe = (bus: Emitter<AppEvents>, o: ObjectObservation) =>
  bus.emit('objects.observed', { t: o.t, observation: o });

describe('EpisodeRecorder observations', () => {
  it('rebases both times onto the episode start and keeps image coordinates to 1e-4', async () => {
    const { bus, recorder, sink } = setup();
    recorder.start(meta, 1000);
    observe(bus, observation());
    await recorder.stop('completed', { stepsCompleted: 0, stepsTotal: 0 }, 3000);
    expect(sink.only().batches.flatMap((b) => b.observations)).toEqual([
      {
        t: 1250.12,
        observedT: 1190,
        objectId: 'syringe',
        status: 'measured',
        role: 'tracker',
        source: 'yoloe-26l-seg',
        box: [0.4, 0.3123, 0.5, 0.4568],
        outline: [
          [0.4111, 0.3],
          [0.5, 0.3],
          [0.4568, 0.45],
        ],
        point: [0.45, 0.3636],
        contact: [0.4545, 0.45],
        score: 0.8123,
        frame: { seq: 42, width: 480, height: 360 },
        trackId: '7',
      },
    ]);
  });

  it('writes depth samples to 1e-4, and none for an observation without them', async () => {
    const { bus, recorder, sink } = setup();
    recorder.start(meta, 1000);
    observe(
      bus,
      observation({
        surface: [
          [0.123456, 0.05, -0.2000001],
          [0.1, 0.02, -0.19],
        ],
      }),
    );
    observe(bus, observation({ objectId: 'cup' }));
    await recorder.stop('completed', { stepsCompleted: 0, stepsTotal: 0 }, 3000);
    const [first, second] = sink.only().batches.flatMap((b) => b.observations);
    expect(first?.surface).toEqual([
      [0.1235, 0.05, -0.2],
      [0.1, 0.02, -0.19],
    ]);
    expect(second).not.toHaveProperty('surface');
  });

  it('keeps a camera frame from before the episode as a negative observation time', async () => {
    const { bus, recorder, sink } = setup();
    recorder.start(meta, 1000);
    observe(bus, observation({ t: 1050, observedT: 940 }));
    await recorder.stop('completed', { stepsCompleted: 0, stepsTotal: 0 }, 1100);
    const [recorded] = sink.only().batches.flatMap((b) => b.observations);
    expect([recorded?.t, recorded?.observedT]).toEqual([50, -60]);
  });

  it('records a lost answer with its nulls, and never as an event', async () => {
    const { bus, recorder, sink } = setup();
    recorder.start(meta, 1000);
    const lost = { status: 'lost', box: null, outline: null, point: null, contact: null } as const;
    observe(bus, observation({ ...lost, score: null, frame: null, trackId: null }));
    await recorder.stop('completed', { stepsCompleted: 0, stepsTotal: 0 }, 3000);
    const batches = sink.only().batches;
    expect(batches.flatMap((b) => b.observations)).toMatchObject([
      { status: 'lost', box: null, score: null, frame: null, trackId: null },
    ]);
    expect(batches.flatMap((b) => b.events)).toEqual([]);
  });

  it('drops a malformed observation instead of getting the batch rejected', async () => {
    const { bus, recorder, sink, dropped } = setup();
    recorder.start(meta, 1000);
    observe(bus, observation({ point: [1.2, 0.5] }));
    observe(bus, observation({ objectId: 'cup' }));
    await recorder.stop('completed', { stepsCompleted: 0, stepsTotal: 0 }, 3000);
    expect(sink.only().batches.flatMap((b) => b.observations.map((o) => o.objectId))).toEqual([
      'cup',
    ]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatch(/^observation syringe: /);
  });

  it('cuts batches by frames and age exactly as before, observations riding along', async () => {
    const { bus, recorder, sink } = setup({ batchFrames: 2, batchIntervalMs: 60_000 });
    recorder.start(meta, 1000);
    for (let i = 0; i < 5; i++) {
      // Many observations never cut a batch on their own.
      for (let k = 0; k < 3; k++) observe(bus, observation({ t: 1000 + i * 10, observedT: 990 }));
      recorder.recordFrame(frame(1000 + i * 10));
    }
    observe(bus, observation({ t: 1095, observedT: 1050 }));
    await recorder.stop('completed', { stepsCompleted: 0, stepsTotal: 0 }, 1100);
    const episode = sink.only();
    expect(episode.batches.map((b) => [b.seq, b.frames.length, b.observations.length])).toEqual([
      [0, 2, 6],
      [1, 2, 6],
      [2, 1, 4],
    ]);
    expect(episode.finish?.batches).toBe(3);
  });

  it('sends a last batch that holds only observations when the episode stops', async () => {
    const { bus, recorder, sink } = setup({ batchFrames: 1 });
    recorder.start(meta, 1000);
    recorder.recordFrame(frame(1010));
    observe(bus, observation({ t: 1020, observedT: 1000 }));
    await recorder.stop('completed', { stepsCompleted: 0, stepsTotal: 0 }, 1030);
    expect(sink.only().batches.map((b) => [b.frames.length, b.observations.length])).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it('records what ObjectTrackRecorder reports: the 2D answer and the 3D state it implies', async () => {
    const { bus, clock, recorder, sink } = setup();
    const workspace = new Workspace({ p: [0, 0.75, -0.5], q: [0, 0, 0, 1] }, 'none');
    const tracks = new ObjectTrackRecorder({
      bus,
      clock,
      workspace: () => workspace,
      states: 'record',
    });
    recorder.start(meta, 1000);
    clock.set(1500);
    tracks.record({
      objectId: 'mug',
      observedT: 1420,
      status: 'measured',
      role: 'tracker',
      source: 'yoloe-26l-seg',
      score: 0.9,
      trackId: '3',
      image: { box: [0.4, 0.3, 0.5, 0.45], outline: null, point: null, contact: null, frame: null },
      position: [0.2, 0.8, -0.7],
      orientation: null,
    });
    await recorder.stop('completed', { stepsCompleted: 0, stepsTotal: 0 }, 2000);
    const [batch] = sink.only().batches;
    expect(batch?.observations).toMatchObject([{ t: 500, observedT: 420, objectId: 'mug' }]);
    expect(batch?.objects).toEqual([
      {
        t: 500,
        objects: [
          {
            id: 'mug',
            position: [0.2, 0.05, -0.2],
            orientation: null,
            confidence: 0.9,
            source: 'detector',
            locationFlags: 10,
            observedT: 420,
          },
        ],
      },
    ]);
  });
});

describe('EpisodeRecorder object states', () => {
  const state = (over: Partial<ObjectState> = {}): ObjectState => ({
    id: 'mug',
    position: [0.2, 0.05, -0.2],
    orientation: null,
    confidence: 0.9,
    source: 'detector',
    locationFlags: 10,
    observedT: 1420,
    ...over,
  });

  it('drops only a malformed state instead of getting the batch rejected', async () => {
    const { bus, recorder, sink, dropped } = setup();
    recorder.start(meta, 1000);
    recorder.recordFrame(frame(1400));
    bus.emit('objects.updated', {
      t: 1500,
      objects: [state({ confidence: Number.NaN }), state({ id: 'cup' })],
    });
    bus.emit('objects.updated', { t: 1550, objects: [state({ position: [Infinity, 0, 0] })] });
    bus.emit('objects.updated', {
      t: 1600,
      objects: [state({ id: 'tape', locationFlags: 15 })], // flags say oriented, no orientation
    });
    bus.emit('objects.updated', { t: 1650, objects: [state({ observedT: Number.NaN })] });
    await recorder.stop('completed', { stepsCompleted: 0, stepsTotal: 0 }, 2000);
    const [batch] = sink.only().batches;
    expect(batch?.frames).toHaveLength(1);
    expect(batch?.objects).toEqual([
      { t: 500, objects: [{ ...state({ id: 'cup' }), observedT: 420 }] },
    ]);
    expect(dropped.map((why) => why.split(':')[0])).toEqual([
      'object mug',
      'object mug',
      'object tape',
      'object mug',
    ]);
    // What reaches the server is a valid batch.
    expect(EpisodeBatchSchema.safeParse(JSON.parse(JSON.stringify(batch))).success).toBe(true);
  });
});
