// The test compile doesn't include src/, so the XRFrame batch APIs FrameSampler uses come from here.
/// <reference path="../../src/adapters/xr/webxr-ext.d.ts" />
import {
  EpisodeBatchSchema,
  EpisodeCreateSchema,
  type EpisodeEvent,
  EpisodeFinishSchema,
  type PrimaryResponse,
} from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/clock';
import type { Vec3 } from '../../src/core/math';
import type { TrackedFrame } from '../../src/domain/hands/types';
import { MemoryEpisodeSink } from '../../src/domain/recording/sink';
import { Workspace, workspaceInFrontOf } from '../../src/domain/world/workspace';
import { objectIdFor, PrimaryRecording, TARGET_ANNOTATION } from '../../src/primary/recording';
import { makeHand } from '../support/hands';

const info = { userAgent: 'test', emulated: true, xrFeatures: ['local-floor'], version: 'test' };

function setup() {
  const clock = new ManualClock(1000);
  const sink = new MemoryEpisodeSink();
  const drops: string[] = [];
  const recording = new PrimaryRecording({
    sink,
    clock,
    batchFrames: 30,
    sleep: async () => {},
    onDrop: (why) => drops.push(why),
  });
  return { clock, sink, recording, drops };
}

function worldFrame(t: number, hands = true): TrackedFrame {
  return {
    t,
    head: { p: [0, 1.6, 0.001 * (t - 1000)], q: [0, 0, 0, 1] },
    left: hands ? makeHand({ wrist: [-0.2, 1.1, -0.3] }) : null,
    right: hands ? makeHand({ wrist: [0.2, 1.1, -0.3] }) : null,
  };
}

function response(name: string | null, found = true): PrimaryResponse {
  return {
    name,
    description: name && `a ${name} on the table`,
    detection: name
      ? {
          id: 'main',
          found,
          point: found ? [0.5, 0.5] : null,
          box: found ? [0.4, 0.4, 0.6, 0.6] : null,
          outline: null,
          confidence: found ? 0.9 : 0,
        }
      : null,
    model: { picker: 'gemini', finder: 'jev' },
    timings: { pickMs: 300, findMs: 200 },
  };
}

/** Runs one XR frame every 14 ms from `from` to `to` (ms), calling `each` before it is recorded. */
function run(
  ctx: ReturnType<typeof setup>,
  from: number,
  to: number,
  each: (t: number) => void = () => {},
): void {
  for (let t = from; t < to; t += 14) {
    ctx.clock.set(t);
    each(t);
    ctx.recording.frame(worldFrame(t));
  }
}

function collect(sink: MemoryEpisodeSink) {
  const episode = sink.only();
  const batches = episode.batches;
  return {
    episode,
    frames: batches.flatMap((b) => b.frames),
    events: batches.flatMap((b) => b.events),
    objects: batches.flatMap((b) => b.objects.map((o) => ({ t: o.t, state: o.objects[0] }))),
  };
}

describe('PrimaryRecording', () => {
  it('records a session with a moving target, a lost period and a target switch', async () => {
    const ctx = setup();
    const { recording, sink, clock } = ctx;
    recording.begin(info);
    expect(recording.recording).toBe(false);

    // The mug moves 1 cm to the right per tracked frame, captured 40 ms before it is placed.
    const mugAt = (t: number): Vec3 => [0.01 * ((t - 1000) / 14), 0.8, -0.5];
    run(ctx, 1000, 1300, (t) => {
      if (t === 1014) recording.answer(response('Red mug'), t - 300);
      if (t > 1014) recording.placed('Red mug', mugAt(t), t - 40, 0.8);
    });
    // Lost for a while: the tracker reports it missing on every frame.
    run(ctx, 1300, 1600, (t) => recording.lost('Red mug', t - 40));
    // Found again.
    run(ctx, 1600, 1800, (t) => recording.placed('Red mug', mugAt(t), t - 40));
    // The next answer names something else; its masks follow.
    run(ctx, 1800, 2100, (t) => {
      if (t === 1800) recording.answer(response('Syringe'), t - 250);
      else recording.placed('Syringe', [0.1, 0.82, -0.45], t - 40, null);
    });
    // An answer that names nothing.
    clock.set(2100);
    recording.answer(response(null), 2050);
    await recording.end();
    expect(recording.recording).toBe(false);

    const { episode, frames, events, objects } = collect(sink);
    // Everything stored is valid clio.episode/1 (the memory sink parses batches like the server).
    expect(EpisodeCreateSchema.safeParse(episode.meta).success).toBe(true);
    for (const batch of episode.batches)
      expect(EpisodeBatchSchema.safeParse(batch).success).toBe(true);
    expect(EpisodeFinishSchema.safeParse(episode.finish).success).toBe(true);
    expect(ctx.drops).toEqual([]);

    expect(episode.meta).toMatchObject({
      mode: 'free',
      procedure: null,
      features: ['object.flags'],
      space: { calibration: 'default_in_front' },
    });
    expect(episode.finish).toMatchObject({
      outcome: 'completed',
      batches: episode.batches.length,
      durationMs: 1100,
    });
    expect(episode.batches.map((b) => b.seq)).toEqual(episode.batches.map((_, i) => i));

    // Frames: every XR frame, rebased, in the workspace in front of the first head pose.
    const framesIn = (from: number, to: number) => Math.ceil((to - from) / 14);
    expect(frames.length).toBe(
      framesIn(1000, 1300) + framesIn(1300, 1600) + framesIn(1600, 1800) + framesIn(1800, 2100),
    );
    expect(frames[0]?.t).toBe(0);
    const workspace = new Workspace(workspaceInFrontOf(worldFrame(1000).head));
    const wrist = workspace.toWorkspacePoint([-0.2, 1.1, -0.3]);
    expect(frames[0]?.left?.joints.slice(0, 3)).toEqual(wrist.map((v) => round4(v)));
    expect(frames[0]?.right).not.toBeNull();

    // Object track: tracked (10) while seen, 0 once when lost, tracked again, 2 when switched away.
    const mug = objects.filter((o) => o.state?.id === 'red-mug');
    const flags = runs(mug.map((o) => o.state?.locationFlags));
    expect(flags).toEqual([10, 0, 10, 2]);
    const tracked = mug.filter((o) => o.state?.locationFlags === 10);
    const xs = tracked.map((o) => o.state?.position[0] ?? Number.NaN);
    expect(xs.every((x, i) => i === 0 || x > (xs[i - 1] ?? 0))).toBe(true);
    expect(tracked.every((o) => o.state?.observedT === round2(o.t - 40))).toBe(true);
    const lost = mug.find((o) => o.state?.locationFlags === 0);
    const lastBefore = tracked.filter((o) => o.t < (lost?.t ?? 0)).at(-1)?.state;
    expect(lost?.state?.position).toEqual(lastBefore?.position);
    expect(lost?.state?.confidence).toBe(0);
    expect(lost?.t).toBe(300);
    const syringe = objects.filter((o) => o.state?.id === 'syringe');
    expect(syringe.length).toBeGreaterThan(0);
    // Tracked without a score, then no longer followed once an answer names nothing.
    expect(runs(syringe.map((o) => o.state?.locationFlags))).toEqual([10, 2]);
    expect(syringe.every((o) => o.state?.confidence === 1)).toBe(true);
    expect(syringe[0]?.state?.position).toEqual(
      workspace.toWorkspacePoint([0.1, 0.82, -0.45]).map(round4),
    );

    // Events: registrations, a detection per named answer, and an annotation per target change.
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'object.registered')).toHaveLength(2);
    const detected = events.filter(
      (e): e is Extract<EpisodeEvent, { type: 'object.detected' }> => e.type === 'object.detected',
    );
    expect(detected.map((d) => [d.objectId, d.phrase, d.source, d.found])).toEqual([
      ['red-mug', 'Red mug', 'jev', true],
      ['syringe', 'Syringe', 'jev', true],
    ]);
    expect(detected[0]).toMatchObject({ t: 14, latencyMs: 300, stepId: null, position: null });
    const targets = events.filter(
      (e): e is Extract<EpisodeEvent, { type: 'annotation' }> =>
        e.type === 'annotation' && e.label === TARGET_ANNOTATION,
    );
    expect(targets.map((e) => e.data)).toEqual([
      { objectId: 'red-mug', name: 'Red mug', previous: null },
      { objectId: 'syringe', name: 'Syringe', previous: 'red-mug' },
      { objectId: null, name: null, previous: 'syringe' },
    ]);
    // Every channel is in time order.
    for (const series of [frames.map((f) => f.t), events.map((e) => e.t), objects.map((o) => o.t)])
      expect(series).toEqual([...series].sort((a, b) => a - b));
  });

  it('ignores masks still in flight for a target the demo has moved on from', async () => {
    const ctx = setup();
    const { recording, clock } = ctx;
    recording.begin(info);
    const mug: Vec3 = [0.3, 0.8, -0.5];
    run(ctx, 1000, 1100, (t) => {
      // The first frame starts the episode; the answer comes on the next.
      if (t === 1014) recording.answer(response('Red mug'), t - 300);
      else if (t > 1014) recording.placed('Red mug', mug, t - 40, 0.8);
    });
    // The answer names the syringe; masks captured before the tracker switched still arrive.
    run(ctx, 1100, 1200, (t) => {
      if (t === 1100) recording.answer(response('Syringe'), t - 250);
      else recording.placed('Red mug', mug, t - 40, 0.8);
    });
    recording.lost('Red mug', 1190);
    run(ctx, 1200, 1300, (t) => recording.placed('Syringe', [0.1, 0.82, -0.45], t - 40));
    // An answer naming nothing clears the tracker; a late mug mask must not revive it.
    clock.set(1300);
    recording.answer(response(null), 1250);
    run(ctx, 1300, 1400, (t) => {
      recording.placed('Red mug', mug, t - 40, 0.8);
      recording.placed('Syringe', [0.1, 0.82, -0.45], t - 40);
    });
    await recording.end();

    const { events, objects } = collect(ctx.sink);
    const flagsOf = (id: string) =>
      runs(objects.filter((o) => o.state?.id === id).map((o) => o.state?.locationFlags));
    expect(flagsOf('red-mug')).toEqual([10, 2]);
    expect(flagsOf('syringe')).toEqual([10, 2]);
    const registered = events.filter(
      (e): e is Extract<EpisodeEvent, { type: 'object.registered' }> =>
        e.type === 'object.registered',
    );
    const workspace = new Workspace(workspaceInFrontOf(worldFrame(1000).head));
    expect(registered.map((e) => [e.objectId, e.position])).toEqual([
      ['red-mug', workspace.toWorkspacePoint(mug).map(round4)],
      ['syringe', workspace.toWorkspacePoint([0.1, 0.82, -0.45]).map(round4)],
    ]);
  });

  it('records nothing before begin() and nothing after end()', async () => {
    const ctx = setup();
    ctx.recording.frame(worldFrame(1000));
    ctx.recording.placed('Cup', [0, 1, -0.5], 990);
    expect(ctx.sink.episodes.size).toBe(0);
    ctx.recording.begin(info);
    run(ctx, 1000, 1100);
    await ctx.recording.end();
    run(ctx, 1100, 1200, (t) => ctx.recording.placed('Cup', [0, 1, -0.5], t));
    await ctx.recording.end();
    const { frames, objects } = collect(ctx.sink);
    expect(frames.length).toBe(Math.ceil(100 / 14));
    expect(objects).toEqual([]);
  });

  it('starts a new episode for each session, interrupting one left open', async () => {
    const ctx = setup();
    ctx.recording.begin(info);
    run(ctx, 1000, 1050);
    ctx.recording.begin(info);
    run(ctx, 1050, 1100);
    await ctx.recording.end();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [first, second] = [...ctx.sink.episodes.values()];
    expect(first?.finish?.outcome).toBe('interrupted');
    expect(second?.finish?.outcome).toBe('completed');
    expect(second?.batches[0]?.frames[0]?.t).toBe(0);
  });

  it('samples XR frames for head and hands', async () => {
    const ctx = setup();
    ctx.recording.begin(info);
    const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.5, 0, 1]);
    const frame = {
      getViewerPose: () => ({ transform: { matrix } }),
      session: { inputSources: [] },
    } as unknown as XRFrame;
    ctx.recording.xrFrame(frame, {} as XRReferenceSpace, 1000);
    await ctx.recording.end();
    const { episode, frames } = collect(ctx.sink);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.left).toBeNull();
    // The workspace is 45 cm below and 45 cm ahead of that head, so the head sits above its middle.
    expect(frames[0]?.head.slice(0, 3)).toEqual([0.3, 0.45, 0.45]);
    expect(episode.meta.space.worldFromWorkspace.slice(0, 3)).toEqual([-0.3, 1.05, -0.45]);
  });

  it('records an outline not measured on its frame as valid, never tracked', async () => {
    const ctx = setup();
    const { recording } = ctx;
    recording.begin(info);
    const mug: Vec3 = [0.3, 0.8, -0.5];
    run(ctx, 1000, 1200, (t) => {
      if (t === 1014) recording.answer(response('Red mug'), t - 300);
      // A coasting tracker, a reused distance or a surface cast: placed, but not measured there.
      else if (t > 1014 && t < 1100) recording.placed('Red mug', mug, t - 40, 0.8, false);
      else if (t > 1014) recording.placed('Red mug', mug, t - 40, 0.8, t > 1150);
    });
    ctx.clock.set(1200);
    recording.answer(response('Syringe'), 1150);
    await recording.end();
    const { objects } = collect(ctx.sink);
    const mugStates = objects.filter((o) => o.state?.id === 'red-mug').map((o) => o.state);
    expect(runs(mugStates.map((s) => s?.locationFlags))).toEqual([2, 10, 2]);
    // Placed ones keep their frame time; the switch away says what is true when it is written.
    expect(mugStates.slice(0, -1).every((s) => s?.observedT !== undefined)).toBe(true);
  });

  it('records detected planes and the camera model, when the session has them', async () => {
    const plane = {
      key: 'plane-1',
      orientation: 'horizontal' as const,
      label: 'table',
      pose: { p: [0, 0.75, -0.5] as Vec3, q: [0, 0, 0, 1] as [number, number, number, number] },
      polygon: [[-0.4, -0.3] as const, [0.4, -0.3] as const, [0.4, 0.3] as const],
      changedAt: 900,
    };
    const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.5, 0, 1]);
    const frame = {
      getViewerPose: () => ({ transform: { matrix } }),
      session: { inputSources: [] },
    } as unknown as XRFrame;
    const model = {
      intrinsics: { width: 1280, height: 960, fx: 800, fy: 800, cx: 640, cy: 480 },
      headFromCamera: { p: [0.032, 0.02, -0.025] as Vec3, q: [0, 0, 0, 1] as const },
    };
    const record = async (withPlanes: boolean) => {
      const sink = new MemoryEpisodeSink();
      const clock = new ManualClock(1000);
      const reads: number[] = [];
      const recording = new PrimaryRecording({
        sink,
        clock,
        sleep: async () => {},
        planes: {
          read: () => {
            reads.push(1);
            return [plane];
          },
        },
      });
      recording.begin({
        ...info,
        planes: withPlanes,
        camera: withPlanes
          ? {
              model: { ...model, headFromCamera: { ...model.headFromCamera, q: [0, 0, 0, 1] } },
              source: 'override',
            }
          : null,
      });
      for (const t of [1000, 1014, 1028]) {
        clock.set(t);
        recording.xrFrame(frame, {} as XRReferenceSpace, t);
      }
      await recording.end();
      const episode = sink.only();
      const events = episode.batches.flatMap((b) => b.events);
      return { episode, events, reads: reads.length };
    };

    const on = await record(true);
    expect(EpisodeCreateSchema.safeParse(on.episode.meta).success).toBe(true);
    expect(on.episode.meta.features).toEqual(['object.flags', 'environment.planes']);
    expect(on.episode.meta.camera).toEqual({
      intrinsics: model.intrinsics,
      headFromCamera: [0.032, 0.02, -0.025, 0, 0, 0, 1],
      source: 'override',
    });
    // One snapshot at the start, in W; the unchanged plane is not recorded again.
    const planes = on.events.filter((e) => e.type === 'environment.planes');
    expect(planes).toHaveLength(1);
    expect(planes[0]).toMatchObject({ t: 0, planes: [{ id: 'plane-1', kind: 'table' }] });
    for (const batch of on.episode.batches)
      expect(EpisodeBatchSchema.safeParse(batch).success).toBe(true);

    const off = await record(false);
    expect(off.episode.meta.features).toEqual(['object.flags']);
    expect(off.episode.meta).not.toHaveProperty('camera');
    expect(off.events.filter((e) => e.type === 'environment.planes')).toEqual([]);
    expect(off.reads).toBe(0);
  });

  it('turns target names into object ids', () => {
    expect(objectIdFor('Red mug')).toBe('red-mug');
    expect(objectIdFor('  Syringe (10 ml) ')).toBe('syringe-10-ml');
    expect(objectIdFor('???')).toBe('object');
  });
});

const round4 = (v: number) => {
  const r = Math.round(v * 1e4) / 1e4;
  return r === 0 ? 0 : r;
};
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Collapses consecutive repeats: [10, 10, 0, 10] becomes [10, 0, 10]. */
function runs<T>(values: T[]): T[] {
  return values.filter((v, i) => i === 0 || v !== values[i - 1]);
}
