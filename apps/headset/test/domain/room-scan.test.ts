import {
  type EpisodeCreate,
  type EpisodeEventOf,
  EpisodeEventSchema,
  HAND_LAYOUT,
} from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import { quatFromAxisAngle } from '../../src/core/math';
import type { AppEvents } from '../../src/domain/events';
import { EpisodeRecorder } from '../../src/domain/recording/recorder';
import { MemoryEpisodeSink } from '../../src/domain/recording/sink';
import {
  type DetectedMesh,
  ROOM_SCAN_INTERVAL_MS,
  RoomScanRecorder,
} from '../../src/domain/world/room-scan';
import { Workspace } from '../../src/domain/world/workspace';
import { parseGlb } from '../support/glb';

// W: the table corner 0.75 m up and 0.5 m ahead, not turned, so a world pose is W shifted by it.
const workspace = new Workspace({ p: [0, 0.75, -0.5], q: [0, 0, 0, 1] }, 'none');

/** A unit square on the floor, two triangles. */
const square = () => ({
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
});

const globalMesh = (over: Partial<DetectedMesh> = {}): DetectedMesh => ({
  key: 'mesh-1',
  label: 'global mesh',
  pose: { p: [0, 0, 0], q: [0, 0, 0, 1] },
  ...square(),
  changedAt: 100,
  ...over,
});

const table = (over: Partial<DetectedMesh> = {}): DetectedMesh => ({
  key: 'mesh-2',
  label: 'table',
  pose: { p: [0.4, 0.75, -0.8], q: [0, 0, 0, 1] },
  vertices: new Float32Array([-0.5, -0.75, -0.3, 0.5, -0.75, -0.3, 0.5, 0, 0.3, -0.5, 0, 0.3]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  changedAt: 120,
  ...over,
});

type Snapshot = Omit<EpisodeEventOf<'environment.meshes'>, 'type'>;

const near = (a: readonly number[] | undefined, b: readonly number[], eps = 1e-9) =>
  !!a && a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] ?? Number.NaN)) < eps);

function setup(deps: { minIntervalMs?: number; maxSnapshots?: number } = {}) {
  const bus = new Emitter<AppEvents>();
  const snapshots: Snapshot[] = [];
  const files = new Map<string, Blob>();
  bus.on('environment.meshes', (e) => snapshots.push(e));
  const scan = new RoomScanRecorder({ bus, attach: (name, glb) => files.set(name, glb), ...deps });
  const glb = async (name: string) =>
    parseGlb(new Uint8Array(await (files.get(name) ?? new Blob()).arrayBuffer()));
  return { scan, snapshots, files, glb };
}

/** Calls update() as the app does: only when the recorder wants to look. */
function frames(
  scan: RoomScanRecorder,
  from: number,
  to: number,
  meshes: () => DetectedMesh[],
  step = 14,
): number {
  let reads = 0;
  for (let t = from; t < to; t += step) {
    if (!scan.wants(t)) continue;
    reads++;
    scan.update(t, meshes(), workspace);
  }
  return reads;
}

describe('RoomScanRecorder', () => {
  it('records the first snapshot as soon as there are meshes: counts in the event, geometry in a GLB', async () => {
    const { scan, snapshots, files, glb } = setup();
    scan.update(0, [], workspace);
    expect(snapshots).toEqual([]);
    scan.update(14, [globalMesh(), table()], workspace);
    expect(snapshots).toEqual([
      {
        t: 14,
        media: 'room-scan-1.glb',
        meshes: [
          {
            id: 'mesh-1',
            kind: 'other',
            label: 'global mesh',
            global: true,
            vertices: 4,
            triangles: 2,
          },
          { id: 'mesh-2', kind: 'table', label: 'table', global: false, vertices: 4, triangles: 2 },
        ],
      },
    ]);
    expect(files.get('room-scan-1.glb')?.type).toBe('model/gltf-binary');
    const { doc, accessor } = await glb('room-scan-1.glb');
    expect(doc.scenes[0]?.nodes).toEqual([0, 1]);
    expect(doc.nodes.map((n) => [n.name, n.extras])).toEqual([
      ['mesh-1', { kind: 'other', label: 'global mesh', global: true }],
      ['mesh-2', { kind: 'table', label: 'table', global: false }],
    ]);
    // The pose in W; the positions stay mesh-local.
    expect(near(doc.nodes[0]?.translation, [0, -0.75, 0.5])).toBe(true);
    expect(near(doc.nodes[1]?.translation, [0.4, 0, -0.3])).toBe(true);
    expect(doc.nodes[1]?.rotation).toEqual([0, 0, 0, 1]);
    const tablePrim = doc.meshes?.[doc.nodes[1]?.mesh ?? -1]?.primitives[0];
    expect([...accessor(tablePrim?.attributes.POSITION ?? -1)]).toEqual([...table().vertices]);
    expect([...accessor(tablePrim?.indices ?? -1)]).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('puts each mesh in W through a turned workspace', async () => {
    const { scan, glb } = setup();
    const turned = new Workspace(
      { p: [0, 0.75, -0.5], q: quatFromAxisAngle([0, 1, 0], Math.PI / 2) },
      'none',
    );
    const leaning = quatFromAxisAngle([1, 0, 0], 0.2);
    scan.update(0, [table({ pose: { p: [1, 0.75, -0.5], q: leaning } })], turned);
    const { doc } = await glb('room-scan-1.glb');
    // W's +x points along world -z, so a mesh 1 m along world +x sits 1 m along W's +z.
    expect(near(doc.nodes[0]?.translation, [0, 0, 1], 1e-6)).toBe(true);
    const expected = turned.toWorkspacePose({ p: [1, 0.75, -0.5], q: leaning }).q;
    expect(near(doc.nodes[0]?.rotation, expected, 1e-9)).toBe(true);
    expect(near(expected, [0.0705, -0.7036, 0.0705, 0.7036], 1e-4)).toBe(true);
  });

  it('records again when a mesh appears, disappears or changes, at most every 10 s', () => {
    const { scan, snapshots } = setup();
    let meshes = [globalMesh()];
    frames(scan, 0, 5000, () => meshes);
    meshes = [globalMesh(), table()]; // appears, but waits for the interval
    frames(scan, 5000, 12_000, () => meshes);
    meshes = [table(), globalMesh()]; // same set, other order
    frames(scan, 12_000, 30_000, () => meshes);
    meshes = [globalMesh({ changedAt: 29_000 }), table()]; // changes
    frames(scan, 30_000, 45_000, () => meshes);
    meshes = [table()]; // disappears
    frames(scan, 45_000, 60_000, () => meshes);
    expect(snapshots.map((s) => [s.media, s.meshes.map((m) => m.id)])).toEqual([
      ['room-scan-1.glb', ['mesh-1']],
      ['room-scan-2.glb', ['mesh-1', 'mesh-2']],
      ['room-scan-3.glb', ['mesh-1', 'mesh-2']],
      ['room-scan-4.glb', ['mesh-2']],
    ]);
    expect(snapshots[1]?.t).toBeGreaterThanOrEqual(ROOM_SCAN_INTERVAL_MS);
    expect(snapshots[1]?.t).toBeLessThan(ROOM_SCAN_INTERVAL_MS + 1000 + 14);
    expect(snapshots[2]?.t).toBeGreaterThanOrEqual(30_000);
    expect(snapshots[2]?.t).toBeLessThan(31_014);
  });

  it('reads the meshes every frame until the first snapshot, then about once a second', () => {
    const { scan, snapshots } = setup();
    let meshes: DetectedMesh[] = [];
    expect(frames(scan, 0, 1400, () => meshes)).toBe(100); // none yet: look every frame
    meshes = [globalMesh()];
    expect(frames(scan, 1400, 11_400, () => meshes)).toBe(1); // the snapshot, then nothing
    expect(frames(scan, 11_400, 21_400, () => meshes)).toBe(10); // a look a second, no change
    expect(snapshots).toHaveLength(1);
  });

  it('stops after 8 snapshots an episode, and starts over after reset', () => {
    const { scan, snapshots } = setup({ minIntervalMs: 0 });
    for (let i = 0; i < 12; i++) scan.update(i * 1000, [globalMesh({ changedAt: i })], workspace);
    expect(snapshots).toHaveLength(8);
    expect(scan.wants(20_000)).toBe(false);
    scan.reset();
    scan.update(30_000, [globalMesh({ changedAt: 11 })], workspace);
    expect(snapshots.map((s) => s.media).slice(-2)).toEqual(['room-scan-8.glb', 'room-scan-1.glb']);
  });

  it('waits up to 2 s for a mesh the runtime cannot locate, then records it once it can', () => {
    const { scan, snapshots } = setup();
    const lost = table({ pose: null });
    scan.update(0, [globalMesh(), lost], workspace);
    scan.update(1000, [globalMesh(), lost], workspace);
    expect(snapshots).toEqual([]);
    scan.update(2000, [globalMesh(), lost], workspace);
    expect(snapshots.map((s) => s.meshes.map((m) => m.id))).toEqual([['mesh-1']]);
    frames(scan, 2000, 9000, () => [globalMesh(), lost]);
    frames(scan, 9000, 14_000, () => [globalMesh(), table()]);
    expect(snapshots.map((s) => s.meshes.map((m) => m.id))).toEqual([
      ['mesh-1'],
      ['mesh-1', 'mesh-2'],
    ]);
    // Found again in time, nothing is left out.
    const quick = setup();
    quick.scan.update(0, [globalMesh(), lost], workspace);
    quick.scan.update(500, [globalMesh(), table()], workspace);
    expect(quick.snapshots.map((s) => [s.t, s.meshes.length])).toEqual([[500, 2]]);
  });

  it('never replaces the room with an empty snapshot', () => {
    const { scan, snapshots } = setup({ minIntervalMs: 0 });
    scan.update(0, [globalMesh()], workspace);
    scan.update(2000, [], workspace);
    expect(snapshots).toHaveLength(1);
  });

  it('leaves out meshes whose geometry a reader cannot take', () => {
    const { scan, snapshots } = setup();
    const nan = globalMesh({
      key: 'mesh-3',
      vertices: new Float32Array([0, 0, 0, Number.NaN, 0, 0, 1, 0, 1]),
    });
    const outOfRange = table({ key: 'mesh-4', indices: new Uint32Array([0, 1, 4]) });
    const noTriangles = table({ key: 'mesh-5', indices: new Uint32Array([0, 1]) });
    scan.update(0, [globalMesh(), nan, outOfRange, noTriangles, table()], workspace);
    expect(snapshots[0]?.meshes.map((m) => m.id)).toEqual(['mesh-1', 'mesh-2']);
    // Nothing usable at all: no snapshot, and no GLB.
    const none = setup();
    none.scan.update(0, [nan], workspace);
    expect(none.snapshots).toEqual([]);
    expect(none.files.size).toBe(0);
  });

  it('leaves the runtime arrays alone and keeps its own copy in the GLB', async () => {
    const { scan, glb } = setup();
    const mesh = globalMesh();
    const before = [...mesh.vertices];
    scan.update(0, [mesh], workspace);
    expect([...mesh.vertices]).toEqual(before);
    mesh.vertices[0] = 42; // the runtime updates its mesh after the snapshot
    const { accessor } = await glb('room-scan-1.glb');
    expect([...accessor(0)]).toEqual(before);
  });

  it('writes snapshots the protocol accepts, with their GLB in the episode media', async () => {
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
    const scan = new RoomScanRecorder({
      bus,
      attach: (name, glb) => recorder.attachMedia(name, glb),
    });
    recorder.start(meta, 1000);
    scan.update(1016, [globalMesh(), table()], workspace);
    await recorder.stop('completed', { stepsCompleted: 0, stepsTotal: 0 }, 1300);
    expect(dropped).toEqual([]);
    const episode = sink.only();
    const [event] = episode.batches.flatMap((b) => b.events);
    expect(EpisodeEventSchema.parse(event)).toMatchObject({
      t: 16,
      type: 'environment.meshes',
      media: 'room-scan-1.glb',
      meshes: [
        { id: 'mesh-1', global: true },
        { id: 'mesh-2', kind: 'table' },
      ],
    });
    const stored = episode.media.get('room-scan-1.glb');
    expect(
      parseGlb(new Uint8Array(await (stored ?? new Blob()).arrayBuffer())).doc.nodes,
    ).toHaveLength(2);
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
  device: { userAgent: 'test', emulated: true, xrFeatures: ['mesh-detection'] },
  app: { version: 'test' },
  features: ['environment.meshes'],
};
