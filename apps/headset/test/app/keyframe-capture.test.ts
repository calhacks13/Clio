import { type EpisodeCreate, type EpisodeEventOf, HAND_LAYOUT } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import type { FrameImage } from '../../src/adapters/camera/frame-stream';
import { KeyframeCapture, scaled } from '../../src/app/keyframe-capture';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import { type Pose, quatFromAxisAngle, type Vec3 } from '../../src/core/math';
import type { AppEvents } from '../../src/domain/events';
import { EpisodeRecorder } from '../../src/domain/recording/recorder';
import { MemoryEpisodeSink } from '../../src/domain/recording/sink';
import type { CameraModel } from '../../src/domain/world/camera-model';
import { PoseHistory } from '../../src/domain/world/pose-history';
import { Workspace } from '../../src/domain/world/workspace';

// The capture side against a stand-in camera, encoder and timer queue. W is the world shifted by
// the table corner, so a camera pose in W is easy to check.

const DEG = Math.PI / 180;
const workspace = new Workspace({ p: [0, 0.75, -0.5], q: [0, 0, 0, 1] }, 'none');
const model: CameraModel = {
  intrinsics: { width: 1280, height: 960, fx: 870, fy: 868, cx: 641, cy: 479 },
  // A little forward and down from the eyes, as on the Quest.
  headFromCamera: { p: [0.03, -0.02, -0.05], q: [0, 0, 0, 1] },
};
/** Head pose looking at the table, 30 degrees down. */
const head: Pose = { p: [0.3, 1.25, 0], q: quatFromAxisAngle([1, 0, 0], -30 * DEG) };

interface Pending {
  image: FrameImage;
  width: number;
  height: number;
  quality: number;
  resolve: (jpeg: Blob) => void;
  reject: (err: unknown) => void;
}

function setup(focus: Vec3[] = []) {
  const bus = new Emitter<AppEvents>();
  const clock = new ManualClock(1000);
  const poses = new PoseHistory();
  for (let t = 0; t <= 1000; t += 14) poses.push(t, head);
  let frameT = 990;
  const image = { source: {} as CanvasImageSource, width: 1280, height: 960 };
  const camera = { frame: () => ({ ...image, t: frameT }), model: () => model };
  const timers: (() => void)[] = [];
  const encodes: Pending[] = [];
  const files = new Map<string, Blob>();
  const keyframes: Omit<EpisodeEventOf<'scene.keyframe'>, 'type'>[] = [];
  bus.on('scene.keyframe', (e) => keyframes.push(e));
  const capture = new KeyframeCapture({
    bus,
    clock,
    camera,
    poses,
    workspace: () => workspace,
    focus: () => focus,
    attach: (name, jpeg) => files.set(name, jpeg),
    encode: (img, width, height, quality) =>
      new Promise<Blob>((resolve, reject) =>
        encodes.push({ image: img, width, height, quality, resolve, reject }),
      ),
    setTimeout: (fn) => timers.push(fn),
  });
  /** Runs the looks queued after the XR frames so far, and lets their promises settle. */
  const afterFrame = async () => {
    for (const fn of timers.splice(0)) fn();
    for (let i = 0; i < 3; i++) await Promise.resolve();
  };
  /** One XR frame at `t`: the head where it is, the camera's newest frame `lagMs` older. */
  const xrFrame = async (t: number, pose: Pose = head, lagMs = 10) => {
    clock.set(t);
    poses.push(t, pose);
    frameT = t - lagMs;
    capture.update(t);
    await afterFrame();
  };
  const settle = async (jpeg = new Blob(['jpeg'], { type: 'image/jpeg' })) => {
    encodes.shift()?.resolve(jpeg);
    for (let i = 0; i < 3; i++) await Promise.resolve();
  };
  return {
    bus,
    clock,
    poses,
    capture,
    timers,
    encodes,
    files,
    keyframes,
    afterFrame,
    xrFrame,
    settle,
    setFrameT: (t: number) => {
      frameT = t;
    },
  };
}

const near = (a: readonly number[] | undefined, b: readonly number[], eps = 1e-9) =>
  !!a && a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] ?? Number.NaN)) < eps);

describe('KeyframeCapture', () => {
  it('stores a still frame of the work: its camera pose in W at its capture time, and the JPEG', async () => {
    const ctx = setup([[0.3, 0, -0.2]]);
    await ctx.xrFrame(1014);
    expect(ctx.encodes).toHaveLength(1);
    expect(ctx.encodes[0]).toMatchObject({ width: 960, height: 720, quality: 0.85 });
    ctx.clock.set(1400);
    await ctx.settle();
    expect(ctx.keyframes).toHaveLength(1);
    const [keyframe] = ctx.keyframes;
    expect(keyframe).toMatchObject({
      t: 1400,
      media: 'keyframe-0001.jpg',
      capturedT: 1004,
      width: 960,
      height: 720,
      intrinsics: { fx: 652.5, fy: 651, cx: 480.75, cy: 359.25 },
    });
    // head ∘ headFromCamera, then W: the offset turned with the head, shifted by the corner.
    const down = quatFromAxisAngle([1, 0, 0], -30 * DEG);
    const s = Math.sin(30 * DEG);
    const c = Math.cos(30 * DEG);
    // R_x(-30°) turns the offset [x, y, z]: y' = c·y + s·z, z' = c·z - s·y.
    const offset: Vec3 = [0.03, c * -0.02 + s * -0.05, -s * -0.02 + c * -0.05];
    expect(
      near(keyframe?.pose, [0.3 + offset[0], 0.5 + offset[1], 0.5 + offset[2], ...down], 1e-9),
    ).toBe(true);
    expect(ctx.files.get('keyframe-0001.jpg')?.type).toBe('image/jpeg');
    expect(ctx.capture.stats).toMatchObject({ kept: 1, failures: 0, encodeMs: 386 });
  });

  it('looks about ten times a second while a keyframe is due, and never encodes two at once', async () => {
    const ctx = setup();
    await ctx.xrFrame(1000);
    expect(ctx.encodes).toHaveLength(1);
    // The encode takes seconds (Quest Browser's async JPEG encoder): nothing else is looked at,
    // though the learner has stepped to a new place.
    const there: Pose = { ...head, p: [1.2, 1.25, 0] };
    for (let t = 1014; t < 5000; t += 14) await ctx.xrFrame(t, there);
    expect(ctx.encodes).toHaveLength(1);
    expect(ctx.capture.stats.verdicts.keep).toBe(1);
    await ctx.settle();
    // Then the next one: a single look, and a keyframe from there.
    let looks = 0;
    for (let t = 5000; t < 6000; t += 14) {
      ctx.clock.set(t);
      ctx.poses.push(t, there);
      ctx.setFrameT(t - 10);
      ctx.capture.update(t);
      looks += ctx.timers.length;
      await ctx.afterFrame();
    }
    expect(looks).toBe(1);
    expect(ctx.encodes).toHaveLength(1);
    await ctx.settle();
    expect(ctx.keyframes.map((k) => [k.media, k.capturedT])).toEqual([
      ['keyframe-0001.jpg', 990],
      ['keyframe-0002.jpg', 4990],
    ]);
  });

  it('waits for the head to be still, and looks again 100 ms later', async () => {
    const ctx = setup();
    const turning = (t: number): Pose => ({
      ...head,
      q: quatFromAxisAngle([0, 1, 0], t * 0.1 * DEG),
    });
    for (let t = 1000; t < 1100; t += 14) await ctx.xrFrame(t, turning(t));
    expect(ctx.encodes).toHaveLength(0);
    expect(ctx.capture.stats.verdicts.moving).toBe(1);
    for (let t = 1100; t < 1300; t += 14) await ctx.xrFrame(t, turning(1100));
    expect(ctx.capture.stats.verdicts.moving).toBe(2);
    expect(ctx.encodes).toHaveLength(1);
  });

  it('takes a camera time from before the frame clock stopped as captured now', async () => {
    const ctx = setup();
    await ctx.xrFrame(1014, head, 900);
    await ctx.settle();
    expect(ctx.keyframes[0]?.capturedT).toBe(1014);
  });

  it('drops a still that finishes after the episode ended, but still waits for it', async () => {
    const ctx = setup();
    await ctx.xrFrame(1014);
    ctx.capture.reset();
    for (let t = 1028; t < 1500; t += 14) await ctx.xrFrame(t);
    expect(ctx.timers).toHaveLength(0);
    await ctx.settle();
    expect(ctx.keyframes).toEqual([]);
    expect(ctx.files.size).toBe(0);
    // The next episode numbers its own from 1.
    await ctx.xrFrame(1514);
    await ctx.settle();
    expect(ctx.keyframes.map((k) => k.media)).toEqual(['keyframe-0001.jpg']);
  });

  it('stores nothing for a failed encode, and keeps the next good frame', async () => {
    const ctx = setup();
    await ctx.xrFrame(1014);
    ctx.encodes.shift()?.reject(new Error('encoder busy'));
    await ctx.afterFrame();
    expect(ctx.keyframes).toEqual([]);
    expect(ctx.capture.stats.failures).toBe(1);
    await ctx.xrFrame(1200);
    await ctx.settle();
    expect(ctx.keyframes.map((k) => k.media)).toEqual(['keyframe-0001.jpg']);
  });

  it('does nothing until the camera has a frame and the head a pose', async () => {
    const ctx = setup();
    const camera = { frame: () => null, model: () => model };
    const timers: (() => void)[] = [];
    const capture = new KeyframeCapture({
      bus: ctx.bus,
      clock: ctx.clock,
      camera,
      poses: new PoseHistory(),
      workspace: () => workspace,
      focus: () => [],
      attach: () => {},
      encode: async () => new Blob(),
      setTimeout: (fn) => timers.push(fn),
    });
    capture.update(1000);
    for (const fn of timers) fn();
    await Promise.resolve();
    expect(capture.stats.verdicts).toEqual({
      keep: 0,
      full: 0,
      soon: 0,
      moving: 0,
      away: 0,
      seen: 0,
    });
  });

  it('records keyframes the protocol accepts, with their JPEG in the episode media', async () => {
    const ctx = setup();
    const sink = new MemoryEpisodeSink();
    const dropped: string[] = [];
    const recorder = new EpisodeRecorder({
      bus: ctx.bus,
      clock: ctx.clock,
      sink,
      sleep: async () => {},
      onDrop: (why) => dropped.push(why),
    });
    recorder.start(meta, 1000);
    await ctx.xrFrame(1014);
    ctx.clock.set(1300);
    await ctx.settle();
    for (const [name, jpeg] of ctx.files) recorder.attachMedia(name, jpeg);
    await recorder.stop('completed', { stepsCompleted: 0, stepsTotal: 0 }, 1400);
    expect(dropped).toEqual([]);
    const episode = sink.only();
    const [event] = episode.batches.flatMap((b) => b.events);
    expect(event).toMatchObject({ t: 300, type: 'scene.keyframe', capturedT: 4 });
    expect([...episode.media.keys()]).toEqual(['keyframe-0001.jpg']);
  });
});

describe('scaled', () => {
  it('scales the intrinsics to the stored image', () => {
    expect(scaled(model.intrinsics, 640, 480)).toEqual({ fx: 435, fy: 434, cx: 320.5, cy: 239.5 });
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
  device: { userAgent: 'test', emulated: true, xrFeatures: [] },
  app: { version: 'test' },
  features: ['scene.keyframes'],
};
