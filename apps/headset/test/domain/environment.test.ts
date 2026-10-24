import { type EpisodeCreate, type EpisodeEventOf, HAND_LAYOUT } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import { type Pose, quatFromAxisAngle } from '../../src/core/math';
import type { AppEvents } from '../../src/domain/events';
import { EpisodeRecorder } from '../../src/domain/recording/recorder';
import { MemoryEpisodeSink } from '../../src/domain/recording/sink';
import {
  type DetectedPlane,
  EnvironmentRecorder,
  surfaceKindOf,
} from '../../src/domain/world/environment';
import { Workspace } from '../../src/domain/world/workspace';
import { surfaceKind } from '../../src/tracking/palette';

// W: the table corner 0.75 m up and 0.5 m ahead, not turned, so a world pose is W shifted by it.
const workspace = new Workspace({ p: [0, 0.75, -0.5], q: [0, 0, 0, 1] }, 'none');

const square: [number, number][] = [
  [-0.5, -0.3],
  [0.5, -0.3],
  [0.5, 0.3],
  [-0.5, 0.3],
];

const plane = (over: Partial<DetectedPlane> = {}): DetectedPlane => ({
  key: 'plane-1',
  orientation: 'horizontal',
  label: 'Table',
  pose: { p: [0.4, 0.75, -0.8], q: [0, 0, 0, 1] },
  polygon: square,
  changedAt: 100,
  ...over,
});

type Snapshot = Omit<EpisodeEventOf<'environment.planes'>, 'type'>;

const near = (a: readonly number[] | undefined, b: readonly number[], eps = 1e-9) =>
  !!a && a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] ?? Number.NaN)) < eps);

function setup(minIntervalMs?: number) {
  const bus = new Emitter<AppEvents>();
  const snapshots: Snapshot[] = [];
  bus.on('environment.planes', (e) => snapshots.push(e));
  const environment = new EnvironmentRecorder({
    bus,
    ...(minIntervalMs === undefined ? {} : { minIntervalMs }),
  });
  return { bus, environment, snapshots };
}

describe('surfaceKindOf', () => {
  it('groups WebXR semantic labels, ignoring case', () => {
    expect(surfaceKindOf('desk')).toBe('table');
    expect(surfaceKindOf('Table')).toBe('table');
    expect(surfaceKindOf('door frame')).toBe('wall');
    expect(surfaceKindOf('FLOOR')).toBe('floor');
    expect(surfaceKindOf('ceiling')).toBe('ceiling');
    expect(surfaceKindOf('couch')).toBe('couch');
    expect(surfaceKindOf('bed')).toBe('other');
    expect(surfaceKindOf(null)).toBe('other');
    expect(surfaceKindOf('')).toBe('other');
  });

  it('uses the same label table as the tracking page', () => {
    const labels = [
      'table',
      'desk',
      'floor',
      'wall',
      'door',
      'door frame',
      'window',
      'window frame',
      'wall art',
      'invisible wall face',
      'ceiling',
      'couch',
      'bed',
      'screen',
      'storage',
      'lamp',
      'plant',
      'other',
      'global mesh',
    ];
    for (const label of labels) expect(surfaceKindOf(label), label).toBe(surfaceKind(label));
  });
});

describe('EnvironmentRecorder', () => {
  it('records every plane in W on the first update, with its kind and raw label', () => {
    const { environment, snapshots } = setup();
    const wall: DetectedPlane = plane({
      key: 'plane-2',
      orientation: 'vertical',
      label: null,
      pose: { p: [0, 1.25, -2], q: quatFromAxisAngle([1, 0, 0], Math.PI / 2) },
    });
    environment.update(500, [plane(), wall], workspace);
    expect(snapshots).toHaveLength(1);
    const [table, other] = snapshots[0]?.planes ?? [];
    expect(snapshots[0]?.t).toBe(500);
    expect(table).toMatchObject({
      id: 'plane-1',
      kind: 'table',
      label: 'Table',
      orientation: 'horizontal',
      polygon: square,
    });
    expect(near(table?.pose, [0.4, 0, -0.3, 0, 0, 0, 1])).toBe(true);
    expect(other).toMatchObject({ id: 'plane-2', kind: 'other', label: null });
    expect(near(other?.pose, [0, 0.5, -1.5, ...quatFromAxisAngle([1, 0, 0], Math.PI / 2)])).toBe(
      true,
    );
  });

  it('records an empty snapshot when nothing is detected yet', () => {
    const { environment, snapshots } = setup();
    environment.update(0, [], workspace);
    expect(snapshots).toEqual([{ t: 0, planes: [] }]);
  });

  it('records again only when a plane appears, disappears or changes', () => {
    const { environment, snapshots } = setup();
    const wall = plane({ key: 'plane-2', label: 'wall', orientation: 'vertical' });
    environment.update(0, [plane()], workspace);
    environment.update(1500, [plane()], workspace);
    environment.update(3000, [plane(), wall], workspace); // appears
    environment.update(4500, [wall, plane()], workspace); // same set, other order
    environment.update(6000, [plane({ changedAt: 5900 }), wall], workspace); // changes
    environment.update(7500, [wall], workspace); // disappears
    expect(snapshots.map((s) => [s.t, s.planes.map((p) => p.id)])).toEqual([
      [0, ['plane-1']],
      [3000, ['plane-1', 'plane-2']],
      [6000, ['plane-1', 'plane-2']],
      [7500, ['plane-2']],
    ]);
  });

  it('records at most once per interval, and a change that waited once the interval is over', () => {
    const { environment, snapshots } = setup(1000);
    environment.update(0, [plane()], workspace);
    environment.update(200, [plane({ changedAt: 150 })], workspace);
    environment.update(600, [plane({ changedAt: 550 })], workspace);
    environment.update(999, [plane({ changedAt: 550 })], workspace);
    environment.update(1000, [plane({ changedAt: 550 })], workspace);
    environment.update(1100, [plane({ changedAt: 550 })], workspace);
    expect(snapshots.map((s) => s.t)).toEqual([0, 1000]);
  });

  it('records a new snapshot after reset, as at the start of the next episode', () => {
    const { environment, snapshots } = setup();
    environment.update(0, [plane()], workspace);
    environment.reset();
    environment.update(10, [plane()], workspace);
    expect(snapshots.map((s) => s.t)).toEqual([0, 10]);
  });

  it('keeps at most 128 planes and 256 outline points, and skips outlines of fewer than 3', () => {
    const { environment, snapshots } = setup();
    const circle = Array.from({ length: 1000 }, (_, i): [number, number] => [
      Math.cos(i / 159),
      Math.sin(i / 159),
    ]);
    const planes = [
      plane({ key: 'sliver', polygon: square.slice(0, 2) }),
      plane({ key: 'round', polygon: circle }),
      ...Array.from({ length: 200 }, (_, i) => plane({ key: `plane-${i + 2}` })),
    ];
    environment.update(0, planes, workspace);
    const recorded = snapshots[0]?.planes ?? [];
    expect(recorded).toHaveLength(128);
    expect(recorded.map((p) => p.id)).not.toContain('sliver');
    const round = recorded.find((p) => p.id === 'round');
    expect(round?.polygon).toHaveLength(256);
    expect(round?.polygon[0]).toEqual(circle[0]);
    expect(round?.polygon[1]).toEqual(circle[3]);
  });

  it('writes snapshots the protocol accepts, through the episode recorder', async () => {
    const bus = new Emitter<AppEvents>();
    const sink = new MemoryEpisodeSink();
    const dropped: string[] = [];
    const recorder = new EpisodeRecorder({
      bus,
      clock: new ManualClock(1000),
      sink,
      sleep: async () => {},
      onDrop: (why) => dropped.push(why),
    });
    const environment = new EnvironmentRecorder({ bus });
    recorder.start(meta, 1000);
    const turned: Pose = { p: [0.1234567, 0.75, -1], q: quatFromAxisAngle([0, 1, 0], 0.3) };
    environment.update(1200, [plane({ pose: turned })], workspace);
    await recorder.stop('completed', { stepsCompleted: 0, stepsTotal: 0 }, 1300);
    expect(dropped).toEqual([]);
    const [event] = sink.only().batches.flatMap((b) => b.events);
    expect(event).toMatchObject({
      t: 200,
      type: 'environment.planes',
      planes: [{ kind: 'table' }],
    });
    expect(event?.type === 'environment.planes' ? event.planes[0]?.pose[0] : null).toBe(0.1235);
  });
});

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
    worldFromWorkspace: [0, 0.75, -0.5, 0, 0, 0, 1],
    calibration: 'none',
    anchored: false,
  },
  hands: HAND_LAYOUT,
  objects: [],
  coach: { kind: 'none' },
  device: { userAgent: 'test', emulated: true, xrFeatures: ['plane-detection'] },
  app: { version: 'test' },
  features: ['environment.planes'],
};
