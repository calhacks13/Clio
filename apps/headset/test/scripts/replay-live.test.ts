import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type EpisodeCreate,
  type EpisodeEvent,
  type FrameRecord,
  HAND_LAYOUT,
  type ObjectState,
} from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import {
  parseArgs,
  planBatches,
  RECORDER_BATCH_FRAMES,
  type Recording,
  readRecording,
  repeatCount,
  repeatPeriod,
  replayFinish,
  replayMeta,
} from '../../scripts/replay-live';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import type { AppEvents } from '../../src/domain/events';
import { EpisodeRecorder } from '../../src/domain/recording/recorder';
import { MemoryEpisodeSink } from '../../src/domain/recording/sink';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SHIRT_FOLD = join(ROOT, 'fixtures', 'episodes', 'synthetic-shirt-fold');
const RULE = { frames: RECORDER_BATCH_FRAMES, ms: 1000 };

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

const jug = (x: number): ObjectState => ({
  id: 'jug',
  position: [x, 0, -0.2],
  orientation: null,
  confidence: 0.5,
  source: 'detector',
});

const frameAt = (t: number): FrameRecord => ({
  t,
  head: [0, 0.5, 0.3, 0, 0, 0, 1],
  left: null,
  right: null,
});

const annotation = (t: number, label: string): EpisodeEvent => ({ t, type: 'annotation', label });

const recordingOf = (parts: Partial<Recording>): Recording => ({
  meta,
  frames: [],
  events: [],
  objects: [],
  finish: null,
  ...parts,
});

/**
 * Records a session through the real EpisodeRecorder: a frame every 1000/hz ms (exact to 0.01 ms,
 * so quantizing changes nothing), an event every 7th frame, an object update every 11th, and one
 * event after the last frame.
 */
async function recordSession(hz: number, durationMs: number) {
  const bus = new Emitter<AppEvents>();
  const sink = new MemoryEpisodeSink();
  const recorder = new EpisodeRecorder({
    bus,
    clock: new ManualClock(0),
    sink,
    sleep: async () => {},
  });
  recorder.start(meta, 0);
  const dt = 1000 / hz;
  for (let i = 0; i * dt <= durationMs; i++) {
    const t = i * dt;
    if (i % 7 === 0) bus.emit('annotation', { t, label: `frame ${i}` });
    if (i % 11 === 0) bus.emit('objects.updated', { t, objects: [jug(i / 1000)] });
    recorder.recordFrame({
      t,
      head: { p: [0, 0.5, 0.3], q: [0, 0, 0, 1] },
      left: null,
      right: null,
    });
  }
  bus.emit('annotation', { t: durationMs + 5, label: 'after the last frame' });
  await recorder.stop('completed', { stepsCompleted: 1, stepsTotal: 1 }, durationMs + 10);
  const stored = sink.only();
  const recording = recordingOf({
    frames: stored.batches.flatMap((b) => b.frames),
    events: stored.batches.flatMap((b) => b.events),
    objects: stored.batches.flatMap((b) => b.objects),
    finish: stored.finish,
  });
  return { stored, recording };
}

describe('planBatches', () => {
  it('cuts by age like EpisodeRecorder when frames are slow (25 Hz)', async () => {
    const { stored, recording } = await recordSession(25, 3000);
    const planned = [...planBatches(recording, RULE)];
    expect(planned.map((p) => p.batch)).toEqual(stored.batches);
    expect(planned.map((p) => [p.t, p.batch.frames.length])).toEqual([
      [1000, 26],
      [2000, 25],
      [3000, 25],
      [3005, 0], // the leftover event, like EpisodeRecorder.stop
    ]);
    expect(stored.finish?.batches).toBe(planned.length);
  });

  it('cuts by frame count like EpisodeRecorder when frames are fast (125 Hz)', async () => {
    const { stored, recording } = await recordSession(125, 3000);
    const planned = [...planBatches(recording, RULE)];
    expect(planned.map((p) => p.batch)).toEqual(stored.batches);
    expect(planned[0]?.t).toBe(712);
    expect(planned.slice(0, -1).every((p) => p.batch.frames.length === 90)).toBe(true);
  });

  it('numbers batches from 0 and keeps each channel in file order', () => {
    const recording = recordingOf({
      frames: Array.from({ length: 21 }, (_, i) => frameAt(i * 100)),
      // The 900 ms event comes after the 1500 ms one in the file, so it waits for it.
      events: [annotation(500, 'a'), annotation(1500, 'b'), annotation(900, 'c')],
    });
    const planned = [...planBatches(recording, RULE)];
    expect(planned.map((p) => p.batch.seq)).toEqual([0, 1]);
    expect(planned.map((p) => p.batch.events.map((e) => e.t))).toEqual([[500], [1500, 900]]);
  });

  it('repeats the recording one period later each time, seq counting on', () => {
    const finish = {
      durationMs: 1000,
      outcome: 'completed',
      stepsCompleted: 1,
      stepsTotal: 1,
      batches: 2,
    } as const;
    const recording = recordingOf({
      frames: Array.from({ length: 11 }, (_, i) => frameAt(i * 100)),
      events: [annotation(0, 'start'), annotation(1000, 'end')],
      objects: [{ t: 500, objects: [{ ...jug(0.1), observedT: 450 }] }],
      finish,
    });
    expect(repeatPeriod(recording)).toBe(1100); // the last t plus one frame
    const planned = [...planBatches(recording, RULE, 3)];
    const batches = planned.map((p) => p.batch);
    expect(batches.map((b) => b.seq)).toEqual(batches.map((_, i) => i));
    expect(batches.flatMap((b) => b.frames.map((f) => f.t))).toEqual(
      [0, 1100, 2200].flatMap((offset) => recording.frames.map((f) => f.t + offset)),
    );
    expect(batches.flatMap((b) => b.events.map((e) => e.t))).toEqual([
      0, 1000, 1100, 2100, 2200, 3200,
    ]);
    expect(batches.flatMap((b) => b.objects.map((o) => [o.t, o.objects[0]?.observedT]))).toEqual([
      [500, 450],
      [1600, 1550],
      [2700, 2650],
    ]);
    expect(replayFinish(finish, 3, 1100, batches.length)).toEqual({
      durationMs: 3200,
      outcome: 'completed',
      stepsCompleted: 1,
      stepsTotal: 1,
      batches: batches.length,
    });
  });
});

describe('repeatCount', () => {
  const recording = recordingOf({ frames: Array.from({ length: 11 }, (_, i) => frameAt(i * 100)) });

  it('repeats whole recordings until they last the requested minutes', () => {
    expect(repeatCount(recording, null)).toBe(1);
    expect(repeatCount(recording, 0.001)).toBe(1);
    expect(repeatCount(recording, 0.05)).toBe(3); // 3000 ms of 1100 ms repeats
  });
});

describe('readRecording', () => {
  it('replays the shirt-fold fixture in the batches it was recorded in, every line once', async () => {
    const recording = await readRecording(SHIRT_FOLD);
    const lines = async (file: string) =>
      (await readFile(join(SHIRT_FOLD, file), 'utf8')).trim().split('\n').length;
    expect(recording.frames).toHaveLength(await lines('frames.ndjson'));
    expect(recording.events).toHaveLength(await lines('events.ndjson'));
    expect(recording.objects).toHaveLength(await lines('objects.ndjson'));

    const planned = [...planBatches(recording, RULE)];
    expect(planned).toHaveLength(recording.finish?.batches ?? -1);
    expect(planned.flatMap((p) => p.batch.frames)).toEqual(recording.frames);
    expect(planned.flatMap((p) => p.batch.events)).toEqual(recording.events);
    expect(planned.flatMap((p) => p.batch.objects)).toEqual(recording.objects);
    expect(recording.meta).not.toHaveProperty('episodeId');
    expect(recording.meta).not.toHaveProperty('createdAt');
  });

  it('names the file when a directory is not an episode', async () => {
    await expect(readRecording(join(ROOT, 'procedures'))).rejects.toThrow(/No meta\.json/);
  });
});

describe('replayMeta', () => {
  it('starts the meta now and marks the device as a replay, keeping everything else', () => {
    const quest = { ...meta, device: { userAgent: 'Quest 3', emulated: false, xrFeatures: ['x'] } };
    expect(replayMeta(quest, 1234)).toEqual({
      ...quest,
      clock: { timeline: 'performance.now', startEpochMs: 1234 },
      device: { userAgent: 'clio-replay (Quest 3)', emulated: true, xrFeatures: ['x'] },
    });
    expect(quest.device.emulated).toBe(false);
  });
});

describe('parseArgs', () => {
  it('defaults to the Vite proxy at recording speed', () => {
    expect(parseArgs(['--from', 'ep'])).toEqual({
      from: 'ep',
      base: 'http://127.0.0.1:5173',
      speed: 1,
      batchMs: 1000,
      repeatMinutes: null,
      stallAfterS: null,
      finish: true,
    });
  });

  it('reads every option', () => {
    expect(
      parseArgs([
        '--from',
        'ep',
        '--base',
        'http://127.0.0.1:8788/',
        '--speed',
        '4',
        '--batch-ms',
        '250',
        '--repeat-minutes',
        '10',
        '--stall-after-s',
        '20',
        '--no-finish',
      ]),
    ).toEqual({
      from: 'ep',
      base: 'http://127.0.0.1:8788',
      speed: 4,
      batchMs: 250,
      repeatMinutes: 10,
      stallAfterS: 20,
      finish: false,
    });
  });

  it('rejects a missing --from, bad numbers and unknown flags', () => {
    expect(() => parseArgs([])).toThrow(/--from is required/);
    expect(() => parseArgs(['--from'])).toThrow(/incomplete/);
    expect(() => parseArgs(['--from', 'ep', '--speed', '0'])).toThrow(/--speed/);
    expect(() => parseArgs(['--from', 'ep', '--batch-ms', 'soon'])).toThrow(/--batch-ms/);
    expect(() => parseArgs(['--from', 'ep', '--no-finsh'])).toThrow(/--no-finsh/);
    expect(parseArgs(['--from', 'ep', '--stall-after-s', '0']).stallAfterS).toBe(0);
  });
});
