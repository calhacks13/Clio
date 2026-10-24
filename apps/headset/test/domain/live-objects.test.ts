import { parseProcedure } from '@clio/protocol';
import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../src/core/emitter';
import { type Pose, quatFromAxisAngle, sub } from '../../src/core/math';
import type { AppEvents } from '../../src/domain/events';
import { type CameraModel, intersectPlaneY, type Ray } from '../../src/domain/world/camera-model';
import type { DepthHit, DepthSource } from '../../src/domain/world/depth-source';
import {
  type LiveDetection,
  type LiveFrame,
  LiveObjects,
  liveStatus,
} from '../../src/domain/world/live-objects';
import { DEFAULT_MOTION_OPTIONS } from '../../src/domain/world/motion-smoothing';
import { ObjectRegistry } from '../../src/domain/world/object-registry';
import { PoseHistory } from '../../src/domain/world/pose-history';
import type { TrackedObjectSample } from '../../src/domain/world/tracked-object';
import { Workspace } from '../../src/domain/world/workspace';

// A seated learner looking 20° down at a table 0.72 m up, through a Quest 3-like camera (as in
// placement-depth.test.ts). The table is what depth sensing sees along every ray.

const DEG = Math.PI / 180;
const model: CameraModel = {
  intrinsics: { width: 1280, height: 960, fx: 800, fy: 800, cx: 640, cy: 480 },
  headFromCamera: { p: [0.032, -0.02, -0.06], q: quatFromAxisAngle([1, 0, 0], -15 * DEG) },
};
const LOOKING_DOWN: Pose = { p: [0, 1.25, 0], q: quatFromAxisAngle([1, 0, 0], -20 * DEG) };
const LOOKING_UP: Pose = { p: [0, 1.25, 0], q: quatFromAxisAngle([1, 0, 0], 20 * DEG) };
const TABLE_Y = 0.72;

/** Depth along each ray: the table, facing up; `pending` holds the answers until released. */
function tableDepth() {
  const asked: Ray[][] = [];
  let hold: Promise<void> | null = null;
  let release = () => {};
  const source: DepthSource = {
    async measure(rays) {
      asked.push([...rays]);
      if (hold) await hold;
      return rays.map((ray): DepthHit | null => {
        const point = intersectPlaneY(ray, TABLE_Y);
        if (!point) return null;
        return { point, normal: [0, 1, 0], distance: Math.hypot(...sub(point, ray.origin)) };
      });
    },
  };
  const pause = () => {
    hold = new Promise<void>((resolve) => {
      release = () => {
        hold = null;
        resolve();
      };
    });
  };
  return { source, asked, pause, release: () => release() };
}

const objects = parseProcedure({
  schema: 'clio.procedure/1',
  id: 'p',
  version: 1,
  title: 'P',
  summary: 'S',
  workspace: { size: [1, 1] },
  objects: [
    { id: 'cap', label: 'washer cap', placement: { method: 'detect' } },
    { id: 'jug', label: 'fluid jug', placement: { method: 'detect' } },
  ],
  steps: [{ id: 's', instruction: 'Wait.', success: { type: 'confirm' } }],
}).objects;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup({ head = LOOKING_DOWN, depth = true }: { head?: Pose; depth?: boolean } = {}) {
  const bus = new Emitter<AppEvents>();
  const registry = new ObjectRegistry(bus);
  registry.load(objects, 0);
  const observe = vi.spyOn(registry, 'observe');
  const lose = vi.spyOn(registry, 'lose');
  const poses = new PoseHistory();
  poses.push(0, head);
  poses.push(100_000, head);
  const table = tableDepth();
  const samples: TrackedObjectSample[] = [];
  const clock = { now: 1000 };
  // The workspace sits on the table, half a meter ahead.
  const workspace = new Workspace({ p: [0, TABLE_Y, -0.5], q: [0, 0, 0, 1] });
  const live = new LiveObjects({
    registry,
    poses,
    camera: () => model,
    depth: () => (depth ? table.source : null),
    surfaces: null,
    workspace: () => workspace,
    now: () => clock.now,
    record: (sample) => samples.push(sample),
  });
  live.follow(['cap', 'jug']);
  return { live, registry, observe, lose, samples, clock, table, workspace };
}

const detection = (id: string, extra: Partial<LiveDetection> = {}): LiveDetection => ({
  id,
  found: true,
  state: 'tracking',
  box: [0.45, 0.55, 0.55, 0.7],
  outline: [
    [0.45, 0.7],
    [0.55, 0.7],
    [0.5, 0.55],
  ],
  point: [0.5, 0.64],
  contact: [0.5, 0.7],
  score: 0.9,
  track: 3,
  ...extra,
});

const lost = (id: string): LiveDetection => ({
  id,
  found: false,
  state: 'lost',
  box: null,
  outline: null,
  point: null,
  contact: null,
  score: null,
  track: null,
});

const frame = (seq: number, t: number, detections: LiveDetection[]): LiveFrame => ({
  seq,
  t,
  model: 'yoloe-26l-seg',
  size: { width: 480, height: 360 },
  detections,
});

describe('liveStatus', () => {
  it('maps the tracker state, and is never measured or predicted for an object not found', () => {
    expect(liveStatus({ found: true, state: 'tracking' })).toBe('measured');
    expect(liveStatus({ found: true, state: 'coasting' })).toBe('predicted');
    expect(liveStatus({ found: true, state: null })).toBe('measured');
    expect(liveStatus({ found: false, state: 'lost' })).toBe('lost');
    expect(liveStatus({ found: false, state: 'unknown' })).toBe('unknown');
    expect(liveStatus({ found: false, state: 'tracking' })).toBe('lost');
    expect(liveStatus({ found: false, state: null })).toBe('lost');
  });
});

describe('LiveObjects', () => {
  it('places a detection at its measured distance: drawn, told to the registry, recorded', async () => {
    const { live, observe, samples, workspace } = setup();
    live.handle(frame(41, 900, [detection('cap')]));
    await flush();

    expect(observe).toHaveBeenCalledTimes(1);
    const [id, obs] = observe.mock.calls[0] ?? [];
    expect(id).toBe('cap');
    expect(obs).toMatchObject({ source: 'detector', confidence: 0.9, t: 900, measured: true });
    // On the table, in the workspace frame.
    expect(obs?.position[1]).toBeCloseTo(0, 6);
    expect(workspace.toWorldPoint(obs?.position ?? [0, 0, 0])[1]).toBeCloseTo(TABLE_Y, 6);

    expect(samples).toEqual([
      expect.objectContaining({
        objectId: 'cap',
        observedT: 900,
        status: 'measured',
        role: 'tracker',
        source: 'yoloe-26l-seg',
        score: 0.9,
        trackId: '3',
        positionMeasured: true,
        orientation: null,
        image: {
          box: [0.45, 0.55, 0.55, 0.7],
          outline: detection('cap').outline,
          point: [0.5, 0.64],
          contact: [0.5, 0.7],
          frame: { seq: 41, width: 480, height: 360 },
        },
      }),
    ]);
    expect(samples[0]?.position?.[1]).toBeCloseTo(TABLE_Y, 6);

    const [view] = live.views(1000);
    expect(view?.id).toBe('cap');
    expect(live.lit('cap')).toBe(true);
    expect(live.lit('jug')).toBe(false);
  });

  it('draws the next detections at once at the remembered distance, as not measured', async () => {
    const { live, observe, samples, clock, table } = setup();
    live.handle(frame(1, 900, [detection('cap')]));
    await flush();
    clock.now = 1050;
    live.handle(frame(2, 950, [detection('cap')]));
    // Placed and recorded on arrival, without waiting for depth.
    expect(samples).toHaveLength(2);
    expect(samples[1]).toMatchObject({ observedT: 950, positionMeasured: false });
    expect(samples[1]?.position).not.toBeNull();
    // Less than 200 ms after the last one: the registry is not told again.
    expect(observe).toHaveBeenCalledTimes(1);
    expect(table.asked).toHaveLength(1);

    // Due again (5 Hz): told at once as not measured, then measured once depth answers.
    clock.now = 1250;
    live.handle(frame(3, 1150, [detection('cap')]));
    await flush();
    expect(table.asked).toHaveLength(2);
    expect(observe.mock.calls.map(([, o]) => [o.t, o.measured])).toEqual([
      [900, true],
      [1150, false],
      [1150, true],
    ]);
    expect(samples).toHaveLength(3);
  });

  it('never calls a coasting box measured', async () => {
    const { live, observe, samples } = setup();
    live.handle(frame(1, 900, [detection('cap', { state: 'coasting', score: 0.4 })]));
    await flush();
    expect(observe.mock.calls[0]?.[1]).toMatchObject({ measured: false, confidence: 0.4 });
    expect(samples[0]).toMatchObject({ status: 'predicted', positionMeasured: false });
    expect(live.views(1000)).toHaveLength(1);
  });

  it('calls a distance guessed from a surface not measured', async () => {
    const { live, observe, samples } = setup({ depth: false });
    live.handle(frame(1, 900, [detection('cap')]));
    await flush();
    expect(observe.mock.calls[0]?.[1]).toMatchObject({ measured: false });
    expect(samples[0]).toMatchObject({ status: 'measured', positionMeasured: false });
    expect(samples[0]?.position).not.toBeNull();
  });

  it('gives a guessed fixed distance no 3D at all, though the light is still drawn', async () => {
    // Looking up at something above the horizon: no ray meets a surface.
    const { live, observe, samples } = setup({ head: LOOKING_UP, depth: false });
    const high = detection('cap', {
      box: [0.45, 0.05, 0.55, 0.15],
      outline: [
        [0.45, 0.15],
        [0.55, 0.15],
        [0.5, 0.05],
      ],
      point: [0.5, 0.1],
      contact: [0.5, 0.15],
    });
    live.handle(frame(1, 900, [high]));
    await flush();
    expect(observe).not.toHaveBeenCalled();
    expect(samples[0]).toMatchObject({ status: 'measured', position: null });
    expect(samples[0]).not.toHaveProperty('positionMeasured');
    expect(live.views(1000)).toHaveLength(1);
  });

  it('loses an object once: registry.lose(), one lost observation, then the light fades', async () => {
    const { live, lose, samples, clock } = setup();
    live.handle(frame(1, 900, [detection('cap'), lost('jug')]));
    await flush();
    clock.now = 1100;
    live.handle(frame(2, 1000, [lost('cap'), lost('jug')]));
    live.handle(frame(3, 1040, [lost('cap'), lost('jug')]));
    // jug was never found: nothing to lose.
    expect(lose.mock.calls).toEqual([['cap', 1000]]);
    const losses = samples.filter((s) => s.status === 'lost');
    expect(losses.map((s) => [s.objectId, s.observedT])).toEqual([
      ['jug', 900],
      ['cap', 1000],
    ]);
    expect(losses[1]).toMatchObject({
      score: null,
      position: null,
      image: { box: null, outline: null, point: null, contact: null, frame: { seq: 2 } },
    });
    // Held a moment through the loss, then gone.
    expect(live.views(1100)).toHaveLength(1);
    expect(live.views(1100 + DEFAULT_MOTION_OPTIONS.holdMs + 1)).toHaveLength(0);
    expect(live.lit('cap')).toBe(false);
  });

  it('records an object jev has not placed yet without telling anyone where it is', () => {
    const { live, observe, lose, samples } = setup();
    const unknown = { ...lost('cap'), state: 'unknown' };
    live.handle(frame(1, 900, [unknown]));
    live.handle(frame(2, 940, [unknown]));
    expect(samples).toEqual([expect.objectContaining({ status: 'unknown', image: null })]);
    expect(observe).not.toHaveBeenCalled();
    expect(lose).not.toHaveBeenCalled();
  });

  it('never tells the registry about an object in hand, but keeps drawing it', async () => {
    const { live, registry, observe } = setup();
    registry.observe('cap', { position: [0, 0, 0], confidence: 1, source: 'pinch', t: 0 });
    registry.attach('cap', 'right', { p: [0, 1, 0], q: [0, 0, 0, 1] }, 10);
    observe.mockClear();
    live.handle(frame(1, 900, [detection('cap')]));
    await flush();
    expect(observe).not.toHaveBeenCalled();
    expect(live.views(1000)).toHaveLength(1);
  });

  it('follows only the objects it is told to', async () => {
    const { live, observe, samples } = setup();
    live.follow(['jug']);
    live.handle(frame(1, 900, [detection('cap'), detection('jug', { track: null })]));
    await flush();
    expect(samples.map((s) => [s.objectId, s.trackId])).toEqual([['jug', null]]);
    expect(observe.mock.calls.map(([id]) => id)).toEqual(['jug']);
  });

  it('measures one frame at a time per object: one replaced while waiting is recorded without 3D', async () => {
    const { live, samples, table } = setup();
    table.pause();
    live.handle(frame(1, 900, [detection('cap')]));
    live.handle(frame(2, 940, [detection('cap')]));
    live.handle(frame(3, 980, [detection('cap')]));
    await flush();
    expect(table.asked).toHaveLength(1);
    expect(samples.map((s) => [s.observedT, s.position])).toEqual([[940, null]]);
    table.release();
    await flush();
    await flush();
    expect(samples.map((s) => s.observedT)).toEqual([940, 900, 980]);
    expect(samples.every((s) => s.status === 'measured')).toBe(true);
  });

  it('loses every found object when the tracker goes away', async () => {
    const { live, lose, clock } = setup();
    live.handle(frame(1, 900, [detection('cap'), lost('jug')]));
    await flush();
    clock.now = 1500;
    live.reset();
    expect(lose.mock.calls).toEqual([['cap', 1500]]);
    expect(live.views(1500 + DEFAULT_MOTION_OPTIONS.holdMs + 1)).toHaveLength(0);
  });

  it('records a detection it cannot place (no head pose yet) without 3D', async () => {
    const bus = new Emitter<AppEvents>();
    const registry = new ObjectRegistry(bus);
    registry.load(objects, 0);
    const samples: TrackedObjectSample[] = [];
    const live = new LiveObjects({
      registry,
      poses: new PoseHistory(),
      camera: () => model,
      depth: () => null,
      surfaces: null,
      workspace: () => new Workspace({ p: [0, 0, 0], q: [0, 0, 0, 1] }),
      now: () => 1000,
      record: (sample) => samples.push(sample),
    });
    live.follow(['cap']);
    live.handle(frame(1, 900, [detection('cap')]));
    await flush();
    expect(samples).toEqual([expect.objectContaining({ status: 'measured', position: null })]);
    expect(live.views(1000)).toEqual([]);
  });
});
