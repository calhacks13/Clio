import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EpisodeEventSchema,
  EpisodeFinishSchema,
  EpisodeMetaSchema,
  FrameRecordSchema,
  LOCATION_FLAG,
  ObjectObservationSchema,
  ObjectTrackRecordSchema,
} from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { planBatches, RECORDER_BATCH_FRAMES, readRecording } from '../../scripts/replay-live';

// The synthetic tracked-objects episode (pnpm synth -- --scenario tracked-objects): a free capture
// whose objects come from a stand-in TrackedObjectSource through ObjectTrackRecorder, with the
// room's planes from EnvironmentRecorder and the mug's grasp and release recorded as events. Every
// file must parse with the protocol's schemas.

const DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'episodes',
  'synthetic-tracked-objects',
);
const read = (name: string) => readFileSync(join(DIR, name), 'utf8');
const lines = <T>(name: string, schema: z.ZodType<T>): T[] =>
  read(name)
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => schema.parse(JSON.parse(line)));

const meta = EpisodeMetaSchema.parse(JSON.parse(read('meta.json')));
const finish = EpisodeFinishSchema.parse(JSON.parse(read('finish.json')));
const frames = lines('frames.ndjson', FrameRecordSchema);
const events = lines('events.ndjson', EpisodeEventSchema);
const objects = lines('objects.ndjson', ObjectTrackRecordSchema);
const observations = lines('observations.ndjson', ObjectObservationSchema);
const states = objects.flatMap(({ t, objects }) => objects.map((state) => ({ t, state })));
const TRACKED = LOCATION_FLAG.positionTracked | LOCATION_FLAG.orientationTracked;

describe('synthetic tracked-objects episode', () => {
  it('declares its features and the camera model the observations were made with', () => {
    expect(meta.mode).toBe('free');
    expect(meta.features).toEqual([
      'object.flags',
      'object.grasp',
      'object.observations',
      'object.surface',
      'environment.planes',
    ]);
    expect(meta.camera).toMatchObject({
      intrinsics: { width: 1280, height: 960 },
      source: 'default',
    });
    expect(finish).toMatchObject({ outcome: 'completed', durationMs: 8000 });
    expect(frames.at(-1)?.t).toBe(8000);
  });

  it('observes every object at about 20 Hz, 60 to 120 ms after each camera frame', () => {
    const tracker = observations.filter((o) => o.role === 'tracker');
    for (const o of tracker) {
      expect(o.t - o.observedT).toBeGreaterThanOrEqual(60);
      expect(o.t - o.observedT).toBeLessThanOrEqual(120);
      expect(o.frame).toMatchObject({ width: 1280, height: 960 });
    }
    const mugFrames = tracker.filter((o) => o.objectId === 'mug').map((o) => o.observedT);
    expect(mugFrames.length).toBeGreaterThan(150);
    expect((mugFrames[1] ?? 0) - (mugFrames[0] ?? 0)).toBe(50);
    expect(observations.map((o) => o.t)).toEqual(
      observations.map((o) => o.t).sort((a, b) => a - b),
    );
  });

  it('has coasting, a loss and a recovery under a new track, and jev naming objects', () => {
    const bottle = observations.filter((o) => o.objectId === 'bottle' && o.role === 'tracker');
    const runs = bottle.reduce<string[]>((acc, o) => {
      const tag = `${o.status}:${o.trackId}`;
      if (acc.at(-1) !== tag) acc.push(tag);
      return acc;
    }, []);
    expect(runs).toEqual(['measured:5', 'predicted:5', 'lost:null', 'measured:9']);
    expect(bottle.filter((o) => o.status === 'lost').every((o) => o.box === null)).toBe(true);
    const jev = observations.filter((o) => o.role === 'identifier');
    expect(new Set(jev.map((o) => o.status))).toEqual(new Set(['measured', 'absent']));
    expect(jev.every((o) => o.source === 'jev' && o.outline === null)).toBe(true);
  });

  it('never records a predicted observation as a tracked 3D state', () => {
    const predicted = new Set(
      observations
        .filter((o) => o.status === 'predicted')
        .map((o) => `${o.objectId}@${o.observedT}`),
    );
    const coasting = states.filter(({ state }) => predicted.has(`${state.id}@${state.observedT}`));
    expect(coasting.length).toBeGreaterThan(0);
    for (const { state } of coasting) expect((state.locationFlags ?? 0) & TRACKED).toBe(0);
  });

  it('records the mug carried by the right hand as a grasp and a release', () => {
    const grasps = events.flatMap((e) =>
      e.type === 'object.grasped' || e.type === 'object.released' ? [e] : [],
    );
    expect(grasps.map((e) => [e.type, e.t, e.objectId, e.hand])).toEqual([
      ['object.grasped', 2300, 'mug', 'right'],
      ['object.released', 4800, 'mug', 'right'],
    ]);
    expect(grasps[0]).toMatchObject({ grip: 'pinch', position: [0.22, 0.05, -0.2] });
    expect(grasps[1]).toMatchObject({ reason: 'opened', position: [0.48, 0.05, -0.13] });
  });

  it('never claims to know who holds an object from the tracker alone', () => {
    // heldBy null would say "no hand holds it"; the tracker cannot know, so it is left out.
    for (const { state } of states) expect(state).not.toHaveProperty('heldBy');
  });

  it('records the loss once with no flags and no frame time, and the marker with a full pose', () => {
    const lost = states.filter(({ state }) => state.locationFlags === 0);
    expect(lost.map(({ state }) => state.id)).toEqual(['bottle']);
    // Without a valid position the state is placed at its line's time, as ObjectRegistry writes.
    for (const { state } of states) {
      const valid = ((state.locationFlags ?? 0) & LOCATION_FLAG.positionValid) !== 0;
      expect(state.observedT !== undefined, `${state.id} flags ${state.locationFlags}`).toBe(valid);
    }
    const tape = states.filter(({ state }) => state.id === 'tape').map(({ state }) => state);
    expect(tape.every((s) => s.locationFlags === 15 && s.source === 'marker')).toBe(true);
  });

  it('gives every object state its own time, so readers keep each one', () => {
    const last = new Map<string, number>();
    for (const { t, state } of states) {
      const at = state.observedT ?? t;
      expect(at, `${state.id} at t ${t}`).toBeGreaterThan(last.get(state.id) ?? -Infinity);
      last.set(state.id, at);
    }
  });

  it('snapshots the room at the start and when the table plane grows', () => {
    const snapshots = events.flatMap((e) => (e.type === 'environment.planes' ? [e] : []));
    expect(snapshots.map((s) => s.t)).toEqual([0, 4100]);
    const [first, second] = snapshots;
    expect(first?.planes.map((p) => [p.id, p.kind, p.orientation])).toEqual([
      ['plane-1', 'floor', 'horizontal'],
      ['plane-2', 'table', 'horizontal'],
      ['plane-3', 'wall', 'vertical'],
      ['plane-4', 'wall', 'vertical'],
    ]);
    const changed = second?.planes.filter(
      (p, i) => JSON.stringify(p) !== JSON.stringify(first?.planes[i]),
    );
    expect(changed?.map((p) => p.id)).toEqual(['plane-2']);
  });

  it('turns the wrists while the hands move', () => {
    // The wrist's orientation, joint 0, fields 3 to 6: compare the start with the carry.
    const wristQ = (t: number) => frames.find((f) => f.t >= t)?.right?.joints.slice(3, 7) ?? [];
    const dot = wristQ(0).reduce((sum, v, i) => sum + v * (wristQ(3000)[i] ?? 0), 0);
    expect(Math.abs(dot)).toBeLessThan(Math.cos((20 * Math.PI) / 180 / 2));
  });

  it('replays in the batches it was recorded in, every observation once', async () => {
    const recording = await readRecording(DIR);
    const planned = [...planBatches(recording, { frames: RECORDER_BATCH_FRAMES, ms: 1000 })];
    expect(planned).toHaveLength(finish.batches);
    expect(planned.flatMap((p) => p.batch.observations)).toEqual(observations);
    expect(planned.flatMap((p) => p.batch.objects)).toEqual(objects);
  });
});
