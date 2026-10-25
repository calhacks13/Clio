import { parseProcedure } from '@clio/protocol';
import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../src/core/emitter';
import { distance, madd, type Pose, quatFromAxisAngle, sub } from '../../src/core/math';
import type { AppEvents } from '../../src/domain/events';
import { type CameraModel, intersectPlaneY, type Ray } from '../../src/domain/world/camera-model';
import type { DepthHit, DepthSource } from '../../src/domain/world/depth-source';
import {
  type LiveDetection,
  type LiveFrame,
  LiveObjects,
  liveStatus,
  SURFACE_MAX_POINTS,
  SURFACE_REACH_M,
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

/**
 * Depth along each ray: the table, facing up; `pause` holds the answers until released. After
 * `behind()`, every other ray of a batch of more than two (the surface samples) hits 1 m farther
 * along, as the floor or a wall behind a small object would.
 */
function tableDepth() {
  const asked: Ray[][] = [];
  let hold: Promise<void> | null = null;
  let release = () => {};
  let behind = false;
  const source: DepthSource = {
    async measure(rays) {
      asked.push([...rays]);
      if (hold) await hold;
      return rays.map((ray, i): DepthHit | null => {
        const point = intersectPlaneY(ray, TABLE_Y);
        if (!point) return null;
        const along = Math.hypot(...sub(point, ray.origin));
        if (behind && rays.length > 2 && i % 2 === 1) {
          const far = madd(ray.origin, ray.direction, along + 1);
          return { point: far, normal: [0, 1, 0], distance: along + 1 };
        }
        return { point, normal: [0, 1, 0], distance: along };
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
  const behindNow = () => {
    behind = true;
  };
  return { source, asked, pause, release: () => release(), behind: behindNow };
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

  it("draws the tracker's box with the outline, and says who placed the object and how sure", async () => {
    const { live, clock } = setup();
    live.handle(frame(41, 900, [detection('cap', { source: 'er', score: 0.8 })]));
    await flush();
    const [view] = live.views(clock.now);
    expect(view).toMatchObject({ state: 'tracking', source: 'er', score: 0.8 });
    const box = view?.placement.box;
    if (!view || !box) throw new Error('no box');
    // Four corners around the outline, on its plane, in the room.
    expect(box.corners).toHaveLength(4);
    expect(box.points).toHaveLength(4);
    const ys = view.placement.outline.points.map(([, y]) => y);
    expect(box.corners[0]?.[1]).toBeGreaterThanOrEqual(Math.max(...ys) - 1e-9);
    expect(box.corners[3]?.[1]).toBeLessThanOrEqual(Math.min(...ys) + 1e-9);

    // A tracker that omits the source, and a loss: the view keeps its last outline a moment,
    // saying what the tracker says now.
    live.handle(frame(42, 940, [detection('cap')]));
    expect(live.views(clock.now)[0]).toMatchObject({ source: null, score: 0.9 });
    live.handle(frame(43, 980, [lost('cap')]));
    expect(live.views(clock.now)[0]).toMatchObject({ state: 'lost', source: null, score: null });
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
    // Less than 200 ms after the last one: the registry is not told again, nor is depth.
    const placements = () => table.asked.filter((rays) => rays.length <= 2).length;
    expect(observe).toHaveBeenCalledTimes(1);
    expect(placements()).toBe(1);

    // Due again (5 Hz): told at once as not measured, then measured once depth answers.
    clock.now = 1250;
    live.handle(frame(3, 1150, [detection('cap')]));
    await flush();
    expect(placements()).toBe(2);
    expect(observe.mock.calls.map(([, o]) => [o.t, o.measured])).toEqual([
      [900, true],
      [1150, false],
      [1150, true],
    ]);
    expect(samples).toHaveLength(3);
  });

  it('tells the registry of a distance measured after a newer detection was drawn', async () => {
    const { live, observe, clock, table } = setup();
    live.handle(frame(1, 900, [detection('cap')]));
    await flush();
    // Due again: drawn at once, but its depth answers only after the next detection was drawn.
    table.pause();
    clock.now = 1250;
    live.handle(frame(2, 1150, [detection('cap')]));
    clock.now = 1290;
    live.handle(frame(3, 1190, [detection('cap')]));
    table.release();
    await flush();
    // Not drawn over the newer one, but frame 2 was measured all the same.
    expect(observe.mock.calls.map(([, o]) => [o.t, o.measured])).toEqual([
      [900, true],
      [1150, false],
      [1150, true],
    ]);
  });

  it('changes nothing with a distance measured after the object was lost or dropped', async () => {
    const { live, registry, observe, clock, table } = setup();
    live.handle(frame(1, 900, [detection('cap')]));
    await flush();
    table.pause();
    clock.now = 1250;
    live.handle(frame(2, 1150, [detection('cap')]));
    live.handle(frame(3, 1190, [lost('cap')]));
    table.release();
    await flush();
    expect(registry.get('cap')).toMatchObject({ t: 1150, lostAt: 1190, measured: false });
    // So the next sighting is told at once, measured.
    clock.now = 1300;
    live.handle(frame(4, 1240, [detection('cap')]));
    await flush();
    expect(observe.mock.calls.at(-1)?.[1]).toMatchObject({ t: 1240, measured: true });
    expect(registry.get('cap')).toMatchObject({ t: 1240 });
    expect(registry.get('cap')).not.toHaveProperty('lostAt');

    // A first sighting measured only after the loss that followed it.
    table.pause();
    clock.now = 1400;
    live.handle(frame(6, 1340, [detection('jug')]));
    live.handle(frame(7, 1380, [lost('jug')]));
    table.release();
    await flush();
    expect(registry.get('jug')).toBeUndefined();

    // No longer followed while its distance was measured.
    table.pause();
    clock.now = 1500;
    live.handle(frame(5, 1450, [detection('cap')]));
    live.follow(['jug']);
    observe.mockClear();
    table.release();
    await flush();
    expect(observe).not.toHaveBeenCalled();
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

  it('records a detection placed after its distance is measured as arriving when it was handled', async () => {
    const { live, samples, clock, table } = setup();
    table.pause();
    clock.now = 1050;
    live.handle(frame(1, 1000, [detection('cap')]));
    clock.now = 1070;
    live.handle(frame(2, 1020, [detection('cap')]));
    // Lost before the first one's distance came back: the loss is recorded at once, and the one
    // waiting is dropped.
    clock.now = 1090;
    live.handle(frame(3, 1040, [lost('cap')]));
    clock.now = 1100;
    table.release();
    await flush();
    // Recorded after the loss, but each says when it arrived, so the loss stays the newest.
    expect(samples.map((s) => [s.status, s.observedT, s.arrivedT])).toEqual([
      ['measured', 1020, 1070],
      ['lost', 1040, undefined],
      ['measured', 1000, 1050],
    ]);
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

  it('records depth samples inside the outline of a measured frame, within reach of its center', async () => {
    const { live, samples, table } = setup();
    live.handle(frame(1, 900, [detection('cap')]));
    await flush();
    // The two placement rays first, then one batch through the outline.
    expect(table.asked).toHaveLength(2);
    const rays = table.asked[1]?.length ?? 0;
    expect(rays).toBeGreaterThan(1);
    expect(rays).toBeLessThanOrEqual(SURFACE_MAX_POINTS);
    const [sample] = samples;
    const surface = sample?.surface ?? [];
    expect(surface).toHaveLength(rays);
    for (const p of surface) {
      expect(p[1]).toBeCloseTo(TABLE_Y, 6);
      expect(distance(p, sample?.position ?? [0, 0, 0])).toBeLessThanOrEqual(SURFACE_REACH_M);
    }
  });

  it('drops surface hits farther than 0.3 m from the measured center: the background behind', async () => {
    const { live, samples, table } = setup();
    table.behind();
    live.handle(frame(1, 900, [detection('cap')]));
    await flush();
    const rays = table.asked[1]?.length ?? 0;
    expect(rays).toBeGreaterThan(1);
    const surface = samples[0]?.surface ?? [];
    expect(surface).toHaveLength(Math.ceil(rays / 2));
    for (const p of surface) expect(p[1]).toBeCloseTo(TABLE_Y, 6);
  });

  it('samples the surface at most every 500 ms per object, and never from a coasting box', async () => {
    const { live, samples, clock, table } = setup();
    live.handle(frame(1, 900, [detection('cap')]));
    await flush();
    // Measured again in the background 250 ms later: too soon for more samples.
    clock.now = 1250;
    live.handle(frame(2, 1150, [detection('cap')]));
    await flush();
    clock.now = 1550;
    live.handle(frame(3, 1450, [detection('cap')]));
    await flush();
    clock.now = 2100;
    live.handle(frame(4, 2000, [detection('cap', { state: 'coasting' })]));
    await flush();
    expect(samples.map((s) => [s.observedT, s.positionMeasured, 'surface' in s])).toEqual([
      [900, true, true],
      [1150, true, false],
      [1450, true, true],
      [2000, false, false],
    ]);
    expect(table.asked.filter((rays) => rays.length > 2)).toHaveLength(2);
  });

  it('takes no surface samples for an object in hand, or without a depth source', async () => {
    const held = setup();
    held.registry.observe('cap', { position: [0, 0, 0], confidence: 1, source: 'pinch', t: 0 });
    held.registry.attach('cap', 'right', { p: [0, 1, 0], q: [0, 0, 0, 1] }, 10);
    held.live.handle(frame(1, 900, [detection('cap')]));
    await flush();
    expect(held.samples[0]).toMatchObject({ status: 'measured', positionMeasured: true });
    expect(held.samples[0]).not.toHaveProperty('surface');
    expect(held.table.asked.map((rays) => rays.length)).toEqual([2]);

    const blind = setup({ depth: false });
    blind.live.handle(frame(1, 900, [detection('cap')]));
    await flush();
    expect(blind.samples[0]).toMatchObject({ status: 'measured', positionMeasured: false });
    expect(blind.samples[0]).not.toHaveProperty('surface');
  });

  it('records a frame measured again in the background once measured, or where it was drawn if dropped', async () => {
    const { live, samples, clock, table } = setup();
    live.handle(frame(1, 900, [detection('cap')]));
    await flush();
    clock.now = 1250;
    live.handle(frame(2, 1150, [detection('cap')]));
    // Drawn at once at the remembered distance; recorded once its own distance is measured.
    expect(samples).toHaveLength(1);
    expect(live.views(1250)).toHaveLength(1);
    await flush();
    expect(samples[1]).toMatchObject({ observedT: 1150, arrivedT: 1250, positionMeasured: true });
    // One replaced while waiting is recorded at the distance it was drawn at.
    table.pause();
    clock.now = 1450;
    live.handle(frame(3, 1350, [detection('cap')]));
    clock.now = 1560;
    live.handle(frame(4, 1460, [detection('cap')]));
    clock.now = 1700;
    live.handle(frame(5, 1600, [detection('cap')]));
    expect(samples.map((s) => [s.observedT, s.arrivedT, s.positionMeasured])).toEqual([
      [900, 1000, true],
      [1150, 1250, true],
      [1460, 1560, false],
    ]);
    expect(samples[2]?.position).not.toBeNull();
    table.release();
    await flush();
    await flush();
    expect(samples.slice(3).map((s) => [s.observedT, s.arrivedT, s.positionMeasured])).toEqual([
      [1350, 1450, true],
      [1600, 1700, true],
    ]);
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
