import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type EpisodeCreate, HAND_LAYOUT, LOCATION_FLAG, type ObjectState } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import type { AppEvents } from '../../src/domain/events';
import { quantizeObject } from '../../src/domain/recording/quantize';
import { EpisodeRecorder } from '../../src/domain/recording/recorder';
import { MemoryEpisodeSink, SinkError } from '../../src/domain/recording/sink';
import { EpisodeUploader } from '../../src/domain/recording/uploader';
import { makeHand } from '../support/hands';

const meta: EpisodeCreate = {
  schema: 'clio.episode/1',
  mode: 'learn',
  procedure: { id: 'p', version: 1, title: 'P' },
  operator: { role: 'learner' },
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
  coach: { kind: 'scripted' },
  device: { userAgent: 'test', emulated: true, xrFeatures: [] },
  app: { version: 'test' },
};

const noSleep = async () => {};

function setup(sink = new MemoryEpisodeSink(), options = {}) {
  const bus = new Emitter<AppEvents>();
  const clock = new ManualClock(1000);
  const recorder = new EpisodeRecorder({ bus, clock, sink, sleep: noSleep, ...options });
  return { bus, clock, recorder, sink };
}

const frame = (t: number) => ({
  t,
  head: {
    p: [0.123456, 1.6, 0] as [number, number, number],
    q: [0, 0, 0, 1] as [number, number, number, number],
  },
  left: makeHand({ wrist: [0.111111, 0.2, -0.3] }),
  right: null,
});

describe('EpisodeRecorder', () => {
  it('records frames relative to the episode start, quantized to 0.1 mm', async () => {
    const { recorder, sink } = setup();
    recorder.start(meta, 1000);
    recorder.recordFrame(frame(1016.66666));
    await recorder.stop('completed', { stepsCompleted: 1, stepsTotal: 1 }, 1100);
    const episode = sink.only();
    const f = episode.batches[0]?.frames[0];
    expect(f?.t).toBe(16.67);
    expect(f?.head[0]).toBe(0.1235);
    expect(f?.left?.joints[0]).toBe(0.1111);
    expect(f?.right).toBeNull();
    expect(episode.meta.clock.startEpochMs).toBe(new ManualClock().epochMs(1000));
  });

  it('records recordable bus events with rebased time, and nothing internal', async () => {
    const { bus, recorder, sink } = setup();
    recorder.start(meta, 1000);
    bus.emit('step.entered', {
      t: 1500,
      stepId: 's',
      index: 0,
      instruction: 'Do it.',
      targets: [],
    });
    bus.emit('lesson.phase', { t: 1500, phase: 'lesson' });
    await recorder.stop('completed', { stepsCompleted: 0, stepsTotal: 1 }, 2000);
    const events = sink.only().batches.flatMap((b) => b.events);
    expect(events).toEqual([
      { t: 500, type: 'step.entered', stepId: 's', index: 0, instruction: 'Do it.', targets: [] },
    ]);
  });

  it('quantizes numbers inside recorded events like frame data', async () => {
    const { bus, recorder, sink } = setup();
    recorder.start(meta, 1000);
    bus.emit('step.completed', {
      t: 2000.0000000001,
      stepId: 's',
      index: 0,
      by: 'check',
      forced: false,
      durationMs: 1000.0000000000005,
    });
    bus.emit('hand.pinch', {
      t: 2100,
      hand: 'left',
      phase: 'start',
      point: [0.142969980697, 0.0151765, -0.185053734],
      nearest: { objectId: 'dot', distance: 0.0262193 },
    });
    await recorder.stop('completed', { stepsCompleted: 1, stepsTotal: 1 }, 2200);
    const [done, pinch] = sink.only().batches.flatMap((b) => b.events);
    expect(done).toMatchObject({ t: 1000, durationMs: 1000 });
    expect(pinch).toMatchObject({ point: [0.143, 0.0152, -0.1851], nearest: { distance: 0.0262 } });
  });

  it('drops a malformed event instead of poisoning the batch', async () => {
    const dropped: string[] = [];
    const { bus, recorder, sink } = setup(new MemoryEpisodeSink(), {
      onDrop: (why: string) => dropped.push(why),
    });
    recorder.start(meta, 1000);
    bus.emit('step.completed', { t: 1100 } as never);
    bus.emit('annotation', { t: 1200, label: 'ok' });
    await recorder.stop('completed', { stepsCompleted: 0, stepsTotal: 0 }, 1300);
    expect(
      sink
        .only()
        .batches.flatMap((b) => b.events)
        .map((e) => e.type),
    ).toEqual(['annotation']);
    expect(dropped).toHaveLength(1);
  });

  it('records object tracks from registry updates', async () => {
    const { bus, recorder, sink } = setup();
    recorder.start(meta, 1000);
    bus.emit('objects.updated', {
      t: 1040,
      objects: [
        {
          id: 'jug',
          position: [0.123456, 0, 0],
          orientation: null,
          confidence: 0.5,
          source: 'detector',
        },
      ],
    });
    await recorder.stop('completed', { stepsCompleted: 0, stepsTotal: 0 }, 1100);
    expect(sink.only().batches.flatMap((b) => b.objects)).toEqual([
      {
        t: 40,
        objects: [
          {
            id: 'jug',
            position: [0.1235, 0, 0],
            orientation: null,
            confidence: 0.5,
            source: 'detector',
          },
        ],
      },
    ]);
  });

  it('records location flags, the holding hand and a rebased observation time', async () => {
    const { bus, recorder, sink } = setup();
    recorder.start(meta, 1000);
    const state = {
      id: 'jug',
      position: [0.3, 0, 0] as [number, number, number],
      orientation: null,
      confidence: 0.8,
      source: 'detector' as const,
      locationFlags: 10,
      heldBy: null,
    };
    bus.emit('objects.updated', {
      t: 2500,
      objects: [
        { ...state, observedT: 1180.123456 },
        { ...state, id: 'cup', observedT: 2499.5, heldBy: 'left', locationFlags: 2 },
      ],
    });
    await recorder.stop('completed', { stepsCompleted: 0, stepsTotal: 0 }, 2600);
    expect(sink.only().batches.flatMap((b) => b.objects)).toEqual([
      {
        t: 1500,
        objects: [
          { ...state, observedT: 180.12 },
          { ...state, id: 'cup', heldBy: 'left', locationFlags: 2 },
        ],
      },
    ]);
  });

  it('cuts a batch every N frames and numbers batches in order', async () => {
    const { recorder, sink } = setup(new MemoryEpisodeSink(), {
      batchFrames: 2,
      batchIntervalMs: 60_000,
    });
    recorder.start(meta, 1000);
    for (let i = 0; i < 5; i++) recorder.recordFrame(frame(1000 + i * 10));
    await recorder.stop('completed', { stepsCompleted: 1, stepsTotal: 1 }, 1100);
    const episode = sink.only();
    expect(episode.batches.map((b) => [b.seq, b.frames.length])).toEqual([
      [0, 2],
      [1, 2],
      [2, 1],
    ]);
    expect(episode.finish).toMatchObject({ outcome: 'completed', batches: 3, durationMs: 100 });
  });

  it('stops listening once the episode is over', async () => {
    const { bus, recorder, sink } = setup();
    recorder.start(meta, 1000);
    await recorder.stop('aborted', { stepsCompleted: 0, stepsTotal: 1 }, 1100);
    bus.emit('annotation', { t: 1200, label: 'late' });
    expect(sink.only().batches.flatMap((b) => b.events)).toEqual([]);
    expect(recorder.recording).toBe(false);
  });
});

describe('quantizeObject', () => {
  const state = {
    id: 'jug',
    position: [0.1, 0.2, 0.3] as [number, number, number],
    orientation: null,
    confidence: 1,
    source: 'layout' as const,
  };

  it('leaves out the optional fields of a legacy state', () => {
    expect(quantizeObject(state, 1000, 1500)).toEqual(state);
  });

  it('keeps an observation time from before the episode as a negative time', () => {
    expect(quantizeObject({ ...state, observedT: 400 }, 1000, 1500).observedT).toBe(-600);
  });
});

describe('EpisodeUploader', () => {
  it('delivers every batch in order through transient failures, backing off', async () => {
    const sink = new MemoryEpisodeSink();
    let failures = 2;
    const append = sink.append.bind(sink);
    sink.append = async (id, batch) => {
      if (batch.seq === 1 && failures-- > 0) throw new SinkError('network down', true);
      return append(id, batch);
    };
    const delays: number[] = [];
    const up = new EpisodeUploader(sink, meta, { sleep: async (ms) => void delays.push(ms) });
    for (const seq of [0, 1, 2]) up.push({ seq, frames: [], events: [], objects: [] });
    await up.finish({
      durationMs: 1,
      outcome: 'completed',
      stepsCompleted: 0,
      stepsTotal: 0,
      batches: 3,
    });
    expect(sink.only().batches.map((b) => b.seq)).toEqual([0, 1, 2]);
    expect(delays).toEqual([500, 1000]);
  });

  it('keeps retrying the episode creation before sending anything', async () => {
    const sink = new MemoryEpisodeSink();
    let failures = 1;
    const create = sink.create.bind(sink);
    sink.create = async (m) => {
      if (failures-- > 0) throw new SinkError('server starting', true);
      return create(m);
    };
    const up = new EpisodeUploader(sink, meta, { sleep: noSleep });
    up.push({ seq: 0, frames: [], events: [], objects: [] });
    await up.finish({
      durationMs: 1,
      outcome: 'completed',
      stepsCompleted: 0,
      stepsTotal: 0,
      batches: 1,
    });
    expect(sink.only().batches).toHaveLength(1);
    expect(up.episodeId).toBe(sink.only().id);
  });

  it('drops a batch the server rejects as invalid and carries on', async () => {
    const sink = new MemoryEpisodeSink();
    const append = sink.append.bind(sink);
    sink.append = async (id, batch) => {
      if (batch.seq === 0) throw new SinkError('400: invalid batch', false);
      return append(id, batch);
    };
    const dropped: string[] = [];
    const up = new EpisodeUploader(sink, meta, {
      sleep: noSleep,
      onDrop: (why) => dropped.push(why),
    });
    up.push({ seq: 0, frames: [], events: [], objects: [] });
    up.push({ seq: 1, frames: [], events: [], objects: [] });
    await up.finish({
      durationMs: 1,
      outcome: 'completed',
      stepsCompleted: 0,
      stepsTotal: 0,
      batches: 2,
    });
    expect(sink.only().batches.map((b) => b.seq)).toEqual([1]);
    expect(dropped).toEqual(['batch 0: 400: invalid batch']);
  });

  it('drops the oldest batches beyond the queue limit, and says so', async () => {
    const sink = new MemoryEpisodeSink();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const create = sink.create.bind(sink);
    sink.create = async (m) => {
      await gate; // server unreachable until released
      return create(m);
    };
    const dropped: string[] = [];
    const up = new EpisodeUploader(sink, meta, {
      sleep: noSleep,
      maxQueued: 2,
      onDrop: (why) => dropped.push(why),
    });
    for (const seq of [0, 1, 2, 3]) up.push({ seq, frames: [], events: [], objects: [] });
    release();
    await up.finish({
      durationMs: 1,
      outcome: 'completed',
      stepsCompleted: 0,
      stepsTotal: 0,
      batches: 4,
    });
    expect(sink.only().batches.map((b) => b.seq)).toEqual([2, 3]);
    expect(dropped).toEqual(['batch 0: upload queue full', 'batch 1: upload queue full']);
  });
});

describe('synthetic ph-syringe episode', () => {
  const file = join(
    import.meta.dirname,
    '../../../../fixtures/episodes/synthetic-ph-syringe/objects.ndjson',
  );
  const records = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { t: number; objects: ObjectState[] });

  it('gives every object state its own time, so readers keep the tracking-lost state', () => {
    // Readers place a state at `observedT ?? t` and drop a second state of an object at the same
    // time, so these times must strictly increase per object.
    const last = new Map<string, number>();
    const lost: number[] = [];
    for (const { t, objects } of records) {
      for (const o of objects) {
        const at = o.observedT ?? t;
        expect(at, `${o.id} at line t ${t}`).toBeGreaterThan(last.get(o.id) ?? -Infinity);
        last.set(o.id, at);
        if (!((o.locationFlags ?? LOCATION_FLAG.positionValid) & LOCATION_FLAG.positionValid))
          lost.push(at);
      }
    }
    // The 300 ms hand dropout while the syringe is held.
    expect(lost).toHaveLength(1);
  });
});
