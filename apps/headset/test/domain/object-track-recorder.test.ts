import { LOCATION_FLAG, type ObjectObservation, type ObjectState } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import { quatFromAxisAngle, quatMultiply, type Vec3 } from '../../src/core/math';
import type { AppEvents } from '../../src/domain/events';
import {
  ObjectTrackRecorder,
  type ObjectTrackRecorderDeps,
} from '../../src/domain/recording/object-track-recorder';
import {
  TRACK_STATE_STATUS,
  type TrackedObjectSample,
} from '../../src/domain/world/tracked-object';
import { Workspace } from '../../src/domain/world/workspace';

// W sits 1 m to the right of the local-floor origin, 0.7 m up, turned 90° to the left: a world
// point (1, 0.8, -1.2) is W (0.2, 0.1, 0).
const YAW = quatFromAxisAngle([0, 1, 0], Math.PI / 2);
const workspace = new Workspace({ p: [1, 0.7, -1], q: YAW }, 'pinch_two_corners');
const WORLD: Vec3 = [1, 0.8, -1.2];
const IN_W: Vec3 = [0.2, 0.1, 0];

const IMAGE = {
  box: [0.4, 0.3, 0.5, 0.45],
  outline: [
    [0.4, 0.3],
    [0.5, 0.3],
    [0.45, 0.45],
  ],
  point: [0.45, 0.36],
  contact: [0.45, 0.45],
  frame: { seq: 42, width: 480, height: 360 },
} satisfies TrackedObjectSample['image'];

const sample = (over: Partial<TrackedObjectSample> = {}): TrackedObjectSample => ({
  objectId: 'mug',
  observedT: 1190,
  status: 'measured',
  role: 'tracker',
  source: 'yoloe-26l-seg',
  score: 0.81,
  trackId: '7',
  image: IMAGE,
  position: WORLD,
  orientation: null,
  ...over,
});

function setup(
  states: 'record' | 'none' = 'record',
  hasWorkspace = true,
  holderOf?: ObjectTrackRecorderDeps['holderOf'],
) {
  const bus = new Emitter<AppEvents>();
  const clock = new ManualClock(1250);
  const observed: ObjectObservation[] = [];
  const updated: { t: number; state: ObjectState }[] = [];
  bus.on('objects.observed', ({ observation }) => observed.push(observation));
  bus.on('objects.updated', ({ t, objects }) => {
    for (const state of objects) updated.push({ t, state });
  });
  const recorder = new ObjectTrackRecorder({
    bus,
    clock,
    workspace: () => (hasWorkspace ? workspace : null),
    states,
    ...(holderOf ? { holderOf } : {}),
  });
  return { clock, recorder, observed, updated, states: () => updated.map((u) => u.state) };
}

const near = (a: readonly number[] | null | undefined, b: readonly number[], eps = 1e-9) =>
  !!a && a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] ?? Number.NaN)) < eps);

describe('ObjectTrackRecorder', () => {
  it('records the 2D answer as an observation with absolute times, unchanged', () => {
    const { recorder, observed } = setup();
    recorder.record(sample());
    expect(observed).toEqual([
      {
        t: 1250,
        observedT: 1190,
        objectId: 'mug',
        status: 'measured',
        role: 'tracker',
        source: 'yoloe-26l-seg',
        ...IMAGE,
        score: 0.81,
        trackId: '7',
      },
    ]);
  });

  it('records a lost or absent answer without image data, and nothing for an empty one', () => {
    const { recorder, observed } = setup();
    recorder.record(sample({ status: 'lost', image: null, position: null, score: null }));
    recorder.record(sample({ status: 'absent', role: 'identifier', image: null, position: null }));
    recorder.record(sample({ status: 'unknown', image: null, position: null }));
    recorder.record(sample({ status: 'predicted', image: null, position: null }));
    expect(observed.map((o) => [o.status, o.box, o.frame])).toEqual([
      ['lost', null, null],
      ['absent', null, null],
    ]);
  });

  it('records a measured position as tracked, in the workspace frame, with its frame time', () => {
    const { recorder, updated } = setup();
    recorder.record(sample());
    expect(updated).toHaveLength(1);
    const [{ t, state }] = updated as [{ t: number; state: ObjectState }];
    expect(t).toBe(1250);
    expect(near(state.position, IN_W)).toBe(true);
    expect(state).toMatchObject({
      id: 'mug',
      orientation: null,
      confidence: 0.81,
      source: 'detector',
      locationFlags: LOCATION_FLAG.positionValid | LOCATION_FLAG.positionTracked,
      observedT: 1190,
    });
    // The tracker cannot tell who carries the mug: unknown, not "no hand".
    expect(state).not.toHaveProperty('heldBy');
  });

  it('names the hand carrying an object only when the caller knows it', () => {
    const holders: Record<string, 'left' | 'right' | null | undefined> = {
      mug: 'right',
      cup: null,
      tape: undefined,
    };
    const { recorder, states } = setup('record', true, (id) => holders[id]);
    recorder.record(sample());
    recorder.record(sample({ objectId: 'cup' }));
    recorder.record(sample({ objectId: 'tape' }));
    expect(states().map((s) => [s.id, 'heldBy' in s, s.heldBy])).toEqual([
      ['mug', true, 'right'],
      ['cup', true, null],
      ['tape', false, undefined],
    ]);
  });

  it('records a measured orientation as a marker pose with every flag, rotated into W', () => {
    const { recorder, states } = setup();
    const inW = quatFromAxisAngle([1, 0, 0], 0.3);
    recorder.record(sample({ orientation: quatMultiply(YAW, inW) }));
    const [state] = states();
    expect(state?.source).toBe('marker');
    expect(state?.locationFlags).toBe(15);
    expect(near(state?.orientation, inW)).toBe(true);
  });

  it('never marks a predicted position or orientation as tracked', () => {
    const { recorder, states } = setup();
    recorder.record(sample({ status: 'predicted', score: 0.4 }));
    recorder.record(sample({ status: 'predicted', observedT: 1240, orientation: YAW }));
    expect(states().map((s) => [s.locationFlags, s.confidence])).toEqual([
      [LOCATION_FLAG.positionValid, 0.4],
      [LOCATION_FLAG.positionValid | LOCATION_FLAG.orientationValid, 0.81],
    ]);
  });

  it('records a box seen on its frame but placed without a fresh depth as valid, not tracked', () => {
    const { recorder, states } = setup();
    recorder.record(sample({ positionMeasured: false }));
    recorder.record(sample({ observedT: 1240, positionMeasured: true }));
    recorder.record(sample({ observedT: 1290, positionMeasured: false, orientation: YAW }));
    expect(states().map((s) => [s.locationFlags, s.source, s.observedT])).toEqual([
      [LOCATION_FLAG.positionValid, 'detector', 1190],
      [LOCATION_FLAG.positionValid | LOCATION_FLAG.positionTracked, 'detector', 1240],
      // The orientation was measured with the box; only the position is a guess.
      [
        LOCATION_FLAG.positionValid |
          LOCATION_FLAG.orientationValid |
          LOCATION_FLAG.orientationTracked,
        'marker',
        1290,
      ],
    ]);
  });

  it('never upgrades a predicted sample that claims a measured position', () => {
    const { recorder, states } = setup();
    recorder.record(sample({ status: 'predicted', positionMeasured: true }));
    expect(states().map((s) => s.locationFlags)).toEqual([LOCATION_FLAG.positionValid]);
  });

  it('carries the last position over once while the tracker coasts without a 3D estimate', () => {
    const { recorder, states } = setup();
    recorder.record(sample());
    for (const observedT of [1240, 1290, 1340])
      recorder.record(sample({ status: 'predicted', observedT, position: null, score: 0.5 }));
    expect(states()).toHaveLength(2);
    const carried = states()[1];
    expect(carried).toMatchObject({ locationFlags: 2, observedT: 1240, orientation: null });
    expect(near(carried?.position, IN_W)).toBe(true);
  });

  it('records a loss once, keeping the last position with no flags and no frame time', () => {
    const { recorder, states } = setup();
    recorder.record(sample());
    const lost = { status: 'lost', image: null, position: null, score: null } as const;
    recorder.record(sample({ ...lost, observedT: 1240 }));
    recorder.record(sample({ ...lost, observedT: 1290 }));
    recorder.record(sample({ status: 'absent', observedT: 1340, image: null, position: null }));
    // Coasting after the loss does not bring the stale position back.
    recorder.record(sample({ status: 'predicted', observedT: 1390, position: null }));
    // Without a valid position the state says what is true when written: readers place it at t.
    expect(states().map((s) => [s.locationFlags, s.confidence, 'observedT' in s])).toEqual([
      [10, 0.81, true],
      [0, 0, false],
    ]);
    expect(near(states()[1]?.position, IN_W)).toBe(true);
  });

  it('records an absent answer like a loss, with no frame time', () => {
    const { recorder, updated } = setup();
    recorder.record(sample());
    recorder.record(sample({ status: 'absent', role: 'identifier', observedT: 1200, image: null }));
    expect(updated.map(({ t, state }) => [t, state.locationFlags, state.observedT])).toEqual([
      [1250, 10, 1190],
      [1250, 0, undefined],
    ]);
  });

  it('ignores a found answer about a frame from before the loss was written, so states keep order', () => {
    const { clock, recorder, updated } = setup();
    recorder.record(sample());
    clock.set(1330);
    recorder.record(sample({ status: 'lost', observedT: 1240, image: null, position: null }));
    clock.set(1380);
    // Taken at 1290, before readers place the loss (1330): recording it would put it first.
    recorder.record(sample({ observedT: 1290 }));
    clock.set(1430);
    recorder.record(sample({ observedT: 1340 }));
    expect(updated.map(({ t, state }) => [state.locationFlags, state.observedT ?? t])).toEqual([
      [10, 1190],
      [0, 1330],
      [10, 1340],
    ]);
  });

  it('records the next loss again once the object is found', () => {
    const { recorder, states } = setup();
    const lost = { status: 'lost', image: null, position: null } as const;
    recorder.record(sample());
    recorder.record(sample({ ...lost, observedT: 1240 }));
    recorder.record(sample({ observedT: 1290, trackId: '9' }));
    recorder.record(sample({ ...lost, observedT: 1340 }));
    expect(states().map((s) => s.locationFlags)).toEqual([10, 0, 10, 0]);
  });

  it('records nothing 3D for an unknown answer, a lost object it never saw, or a 2D-only answer', () => {
    const { recorder, states } = setup();
    recorder.record(sample({ status: 'unknown' }));
    recorder.record(sample({ status: 'lost', image: null, position: null }));
    recorder.record(sample({ role: 'identifier', position: null }));
    expect(states()).toEqual([]);
  });

  it('ignores a 3D answer about a frame no later than the last state, keeping its observation', () => {
    const { recorder, states, observed } = setup();
    recorder.record(sample({ observedT: 1200 }));
    recorder.record(sample({ observedT: 1100, role: 'identifier', source: 'jev' }));
    recorder.record(sample({ observedT: 1150, status: 'absent', image: null, position: null }));
    expect(states().map((s) => s.observedT)).toEqual([1200]);
    expect(observed).toHaveLength(3);
  });

  it('records no 3D state without a score, keeping its observation, and clamps a confidence to 0..1', () => {
    const { recorder, states, observed } = setup();
    recorder.record(sample({ score: null }));
    recorder.record(sample({ score: null, status: 'predicted', observedT: 1200 }));
    recorder.record(sample({ objectId: 'cup', score: 3.2 }));
    expect(observed.map((o) => [o.objectId, o.score])).toEqual([
      ['mug', null],
      ['mug', null],
      ['cup', 3.2],
    ]);
    expect(states().map((s) => [s.id, s.confidence])).toEqual([['cup', 1]]);
  });

  it('records no carried coasting state without a score', () => {
    const { recorder, states } = setup();
    recorder.record(sample());
    recorder.record(sample({ status: 'predicted', observedT: 1240, position: null, score: null }));
    expect(states().map((s) => s.locationFlags)).toEqual([10]);
  });

  it('records no 3D state for a non-finite score, position or orientation', () => {
    const { recorder, states, observed } = setup();
    recorder.record(sample({ score: Number.NaN }));
    recorder.record(sample({ observedT: 1191, position: [Number.POSITIVE_INFINITY, 0.8, -1.2] }));
    recorder.record(sample({ observedT: 1192, position: [1, Number.NaN, -1.2] }));
    recorder.record(sample({ observedT: 1193, orientation: [0, Number.NaN, 0, 1] }));
    recorder.record(sample({ observedT: 1194 }));
    expect(observed).toHaveLength(5);
    expect(states().map((s) => [s.observedT, s.locationFlags])).toEqual([[1194, 10]]);
  });

  it('records only observations when the lesson registry owns the 3D estimates', () => {
    const { recorder, observed, updated } = setup('none');
    recorder.record(sample());
    recorder.record(sample({ status: 'lost', observedT: 1240, image: null, position: null }));
    expect(observed).toHaveLength(2);
    expect(updated).toEqual([]);
  });

  it('records only observations until there is a workspace', () => {
    const { recorder, observed, updated } = setup('record', false);
    recorder.record(sample());
    expect(observed).toHaveLength(1);
    expect(updated).toEqual([]);
  });

  it('forgets every last position on reset', () => {
    const { recorder, states } = setup();
    recorder.record(sample());
    recorder.reset();
    recorder.record(sample({ status: 'lost', observedT: 1240, image: null, position: null }));
    recorder.record(sample({ observedT: 1100 }));
    expect(states().map((s) => [s.locationFlags, s.observedT])).toEqual([
      [10, 1190],
      [10, 1100],
    ]);
  });
});

describe('TRACK_STATE_STATUS', () => {
  it('reads a coasting /track mask as predicted, an absent one as absent, an idle one as unknown', () => {
    expect(TRACK_STATE_STATUS).toEqual({
      tracking: 'measured',
      coasting: 'predicted',
      lost: 'lost',
      absent: 'absent',
      unknown: 'unknown',
      idle: 'unknown',
    });
  });
});
