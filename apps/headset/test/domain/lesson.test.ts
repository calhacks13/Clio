import {
  type CoachToolArgs,
  type CoachToolName,
  HAND_LAYOUT,
  type PlanRequest,
  type PlanResponse,
  parseProcedure,
} from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import type { ToolOutcome } from '../../src/domain/coach/toolbox';
import { DemoLibrary } from '../../src/domain/demo/demo-library';
import type { AppEvents } from '../../src/domain/events';
import { EpisodeRecorder } from '../../src/domain/recording/recorder';
import { MemoryEpisodeSink } from '../../src/domain/recording/sink';
import { LessonController, type LessonPlanner } from '../../src/domain/session/lesson-controller';
import type { FindRequest, Grounder } from '../../src/domain/world/grounding';
import { ObjectRegistry } from '../../src/domain/world/object-registry';
import { Workspace } from '../../src/domain/world/workspace';

const generated = parseProcedure({
  schema: 'clio.procedure/1',
  id: 'refill-fluid',
  version: 1,
  origin: {
    kind: 'generated',
    goal: 'add wiper fluid',
    model: 'planner',
    createdAt: '2026-10-24T04:00:00.000Z',
  },
  title: 'Refill washer fluid',
  summary: 'S',
  workspace: { size: [1, 1] },
  objects: [
    { id: 'jug', label: 'fluid jug', placement: { method: 'layout', position: [0.3, 0.1, -0.3] } },
    { id: 'tank', label: 'reservoir', placement: { method: 'layout', position: [0.6, 0.2, -0.4] } },
  ],
  steps: [
    {
      id: 'grab',
      instruction: 'Pick up the jug.',
      targets: ['jug'],
      action: { verb: 'pick_up', object: 'jug' },
      success: { type: 'confirm' },
    },
    {
      id: 'pour',
      instruction: 'Pour into the reservoir.',
      targets: ['jug', 'tank'],
      action: { verb: 'pour', object: 'jug', target: 'tank' },
      success: { type: 'confirm' },
    },
  ],
});

/** Calls one of the lesson's coach tools, as the toolbox would. */
function call<N extends CoachToolName>(
  lesson: LessonController,
  name: N,
  args: CoachToolArgs<N>,
): Promise<ToolOutcome> {
  const handler = lesson.handlers()[name] as (
    a: CoachToolArgs<N>,
    c: { callId: string },
  ) => ToolOutcome | Promise<ToolOutcome>;
  return Promise.resolve(handler(args, { callId: `call-${name}` }));
}

/** start_lesson answers at once; this waits for the plan to arrive and the lesson to start. */
async function start(lesson: LessonController, goal = 'add wiper fluid') {
  const outcome = await call(lesson, 'start_lesson', { goal });
  await lesson.settled();
  return outcome;
}

function setup(planner?: LessonPlanner) {
  const bus = new Emitter<AppEvents>();
  const clock = new ManualClock(1000);
  const types: string[] = [];
  bus.onAny((type) => types.push(String(type)));
  const requests: PlanRequest[] = [];
  const defaultPlanner: LessonPlanner = {
    plan: async (req) => {
      requests.push(req);
      return { planId: 'refill-fluid', procedure: generated, warnings: [] } satisfies PlanResponse;
    },
  };
  const sink = new MemoryEpisodeSink();
  const registry = new ObjectRegistry(bus);
  const lesson = new LessonController({
    bus,
    clock,
    planner: planner ?? defaultPlanner,
    registry,
    workspace: () => new Workspace({ p: [0, 0.8, -0.4], q: [0, 0, 0, 1] }, 'default_in_front'),
    grounder: null,
    images: { snapshots: async () => [{ mimeType: 'image/jpeg', data: 'AAAA' }] },
    demos: new DemoLibrary(null),
    recorder: new EpisodeRecorder({ bus, clock, sink, sleep: async () => {} }),
    context: () => ({
      operator: { role: 'learner' },
      coach: { kind: 'scripted' },
      device: { userAgent: 'test', emulated: true, xrFeatures: [] },
      app: { version: 'test' },
    }),
  });
  return { bus, clock, types, requests, sink, lesson, registry };
}

describe('LessonController', () => {
  it('plans from the goal and what the camera sees, then runs and records the lesson', async () => {
    const { lesson, requests, types, sink } = setup();
    const outcome = await start(lesson);
    expect(requests[0]).toMatchObject({
      goal: 'add wiper fluid',
      images: [{ mimeType: 'image/jpeg' }],
    });
    expect(outcome).toEqual({ ok: true, result: { status: 'planning', goal: 'add wiper fluid' } });
    expect(lesson.phase).toBe('lesson');
    expect(types).toEqual(
      expect.arrayContaining(['plan.requested', 'plan.ready', 'procedure.started', 'step.entered']),
    );
    await Promise.resolve();
    const [episode] = sink.episodes.values();
    expect(episode?.meta.plan?.id).toBe('refill-fluid');
    expect(episode?.meta.hands).toEqual(HAND_LAYOUT);
    expect(episode?.meta.objects.map((o) => o.id)).toEqual(['jug', 'tank']);
  });

  it('tells the coach when planning fails', async () => {
    const { lesson, types } = setup({
      plan: async () => Promise.reject(new Error('quota exceeded')),
    });
    const outcome = await start(lesson, 'juggle');
    expect(outcome).toMatchObject({ ok: true });
    expect(types).toContain('plan.failed');
    expect(lesson.phase).toBe('idle');
  });

  it('only highlights objects the plan declares', async () => {
    const { lesson, types } = setup();
    await start(lesson, 'add wiper fluid');
    const bad = await call(lesson, 'highlight', { object_id: 'hammer', style: 'target' });
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('jug, tank') });
    expect(
      await call(lesson, 'highlight', { object_id: 'tank', style: 'attention' }),
    ).toMatchObject({ ok: true });
    expect(types).toContain('overlay.highlight');
  });

  it('plays a synthesized demo for the current step and records when it starts and ends', async () => {
    const { lesson, bus, clock } = setup();
    const playback: string[] = [];
    bus.on('demo.playback', (e) => playback.push(`${e.phase}:${e.clipId}`));
    await start(lesson, 'add wiper fluid');
    playback.length = 0;
    const r = await call(lesson, 'show_demo', {});
    expect(r).toMatchObject({ ok: true, result: { source: 'synthesized' } });
    lesson.tick(clock.advance(60_000));
    expect(playback).toEqual(['start:synth:refill-fluid/grab', 'end:synth:refill-fluid/grab']);
  });

  it("stops a step's demo when the step ends", async () => {
    const { lesson, bus } = setup();
    const playback: string[] = [];
    bus.on('demo.playback', (e) => playback.push(`${e.phase}:${e.stepId}`));
    await start(lesson, 'add wiper fluid');
    await call(lesson, 'show_demo', {});
    await call(lesson, 'complete_step', {
      step_id: 'grab',
      reason: 'holding it',
      evidence: 'seen',
    });
    expect(playback).toEqual(['start:grab', 'end:grab']);
    expect(lesson.activeDemo).toBeNull();
  });

  it('advances through the runner and finishes the recording at the end', async () => {
    const { lesson, sink, clock } = setup();
    await start(lesson, 'add wiper fluid');
    clock.advance(500);
    expect(
      await call(lesson, 'complete_step', {
        step_id: 'grab',
        reason: 'holding the jug',
        evidence: 'seen',
      }),
    ).toMatchObject({
      ok: true,
    });
    clock.advance(500);
    await call(lesson, 'complete_step', {
      step_id: 'pour',
      reason: 'it is full',
      evidence: 'seen',
    });
    await lesson.settled();
    const [episode] = sink.episodes.values();
    expect(episode?.finish).toMatchObject({
      outcome: 'completed',
      stepsCompleted: 2,
      stepsTotal: 2,
    });
    expect(lesson.phase).toBe('done');
  });

  it('records the event that ends the procedure as the last event of the episode', async () => {
    const { lesson, sink } = setup();
    await start(lesson, 'add wiper fluid');
    await call(lesson, 'complete_step', {
      step_id: 'grab',
      reason: 'holding it',
      evidence: 'seen',
    });
    await lesson.stop('learner took the headset off');
    const [episode] = sink.episodes.values();
    const types = episode?.batches.flatMap((b) => b.events).map((e) => e.type) ?? [];
    expect(types.at(-1)).toBe('procedure.aborted');
  });

  it('records coach-flagged mistakes against the current step', async () => {
    const { lesson, bus } = setup();
    const mistakes: string[] = [];
    bus.on('mistake.detected', (e) => mistakes.push(`${e.stepId}:${e.kind}:${e.source}`));
    await start(lesson, 'add wiper fluid');
    await call(lesson, 'flag_mistake', { kind: 'spill', message: 'Slow down.' });
    expect(mistakes).toEqual(['grab:spill:coach']);
  });

  it('revises the rest of the plan without losing progress', async () => {
    const revised = parseProcedure({
      ...generated,
      id: 'refill-fluid-r1',
      steps: [
        generated.steps[0],
        {
          id: 'funnel',
          instruction: 'Pour slowly without a funnel.',
          targets: ['tank'],
          success: { type: 'confirm' },
        },
      ],
    });
    const calls: PlanRequest[] = [];
    const { lesson } = setup({
      plan: async (req) => {
        calls.push(req);
        return req.revise
          ? { planId: 'refill-fluid-r1', procedure: revised, warnings: [] }
          : { planId: 'refill-fluid', procedure: generated, warnings: [] };
      },
    });
    await start(lesson, 'add wiper fluid');
    await call(lesson, 'complete_step', {
      step_id: 'grab',
      reason: 'holding it',
      evidence: 'seen',
    });
    const r = await call(lesson, 'revise_plan', { reason: 'no funnel' });
    expect(r).toEqual({ ok: true, result: { status: 'replanning' } });
    await lesson.settled();
    expect(calls[1]?.revise).toMatchObject({
      planId: 'refill-fluid',
      fromStepIndex: 1,
      reason: 'no funnel',
      base: { id: 'refill-fluid' },
    });
    expect(lesson.currentStep()?.id).toBe('funnel');
    expect(lesson.runnerState?.statuses).toEqual({ grab: 'done', funnel: 'todo' });
  });
});

describe('LessonController without a camera', () => {
  it('asks for missing objects, then registers one where the learner pinches', async () => {
    const withCap = parseProcedure({
      ...generated,
      objects: [
        ...generated.objects,
        { id: 'cap', label: 'blue cap', placement: { method: 'detect' } },
      ],
      steps: [
        {
          ...generated.steps[0],
          id: 'open',
          targets: ['cap'],
          action: { verb: 'twist', object: 'cap' },
        },
      ],
    });
    const { lesson, registry, bus } = setup({
      plan: async () => ({ planId: 'p', procedure: withCap, warnings: [] }),
    });
    const missing: string[][] = [];
    bus.on('object.missing', (e) => missing.push(e.objectIds));
    await start(lesson, 'open the cap');
    expect(missing).toEqual([['cap']]);

    // A pinch next to a known object is not a registration...
    lesson.onPinch({ hand: 'right', phase: 'start', point: [0.3, 0.1, -0.3], t: 1500 });
    expect(registry.get('cap')).toBeUndefined();
    // ...a pinch in free space registers the next missing object.
    lesson.onPinch({ hand: 'right', phase: 'start', point: [0.9, 0.3, -0.5], t: 1600 });
    expect(registry.get('cap')).toMatchObject({ position: [0.9, 0.3, -0.5], source: 'pinch' });
  });
});

describe('LessonController missing-object announcements', () => {
  it('announces a missing object only once, however often it is looked for', async () => {
    const withCap = parseProcedure({
      ...generated,
      objects: [
        ...generated.objects,
        { id: 'cap', label: 'blue cap', placement: { method: 'detect' } },
      ],
      steps: [
        { ...generated.steps[0], id: 'one', targets: ['cap'] },
        { ...generated.steps[1], id: 'two', targets: ['cap'] },
      ],
    });
    const { lesson, bus } = setup({
      plan: async () => ({ planId: 'p', procedure: withCap, warnings: [] }),
    });
    const missing: string[][] = [];
    bus.on('object.missing', (e) => missing.push(e.objectIds));
    await start(lesson, 'open the cap');
    await call(lesson, 'complete_step', { step_id: 'one', reason: 'next', evidence: 'seen' });
    await call(lesson, 'highlight', { object_id: 'cap', style: 'target' });
    await lesson.settled();
    expect(missing).toEqual([['cap']]);
  });
});

describe('LessonController re-locating released objects', () => {
  it('asks the camera again for a released object, without telling the learner it is missing', async () => {
    const bus = new Emitter<AppEvents>();
    const asked: string[][] = [];
    const missing: string[][] = [];
    bus.on('object.missing', (e) => missing.push(e.objectIds));
    const clock = new ManualClock(0);
    const lesson = new LessonController({
      bus,
      clock,
      planner: { plan: async () => ({ planId: 'p', procedure: generated, warnings: [] }) },
      registry: new ObjectRegistry(bus),
      workspace: () => new Workspace({ p: [0, 0, 0], q: [0, 0, 0, 1] }),
      grounder: {
        ground: async (requests) => {
          const ids = requests.map((r) => r.id);
          asked.push(ids);
          return { ok: true, located: [], missing: ids, sightings: [], source: 'test', frameT: 0 };
        },
      },
      images: null,
      demos: new DemoLibrary(null),
      recorder: null,
      context: () => ({
        operator: { role: 'learner' },
        coach: { kind: 'none' },
        device: { userAgent: 't', emulated: true, xrFeatures: [] },
        app: { version: 't' },
      }),
    });
    await lesson.run(generated);
    lesson.relocate(['jug']);
    await lesson.settled();
    expect(asked.at(-1)).toEqual(['jug']);
    expect(missing).toEqual([]);
  });
});

describe('LessonController and the camera', () => {
  const shown = parseProcedure({
    ...generated,
    objects: [
      { id: 'jug', label: 'fluid jug', placement: { method: 'detect' } },
      { id: 'tank', label: 'reservoir', placement: { method: 'detect' } },
    ],
    steps: [
      {
        ...generated.steps[0],
        show: [{ object: 'jug', phrase: 'fluid jug', description: 'Blue jug on the fender' }],
      },
      generated.steps[1],
    ],
  });

  function withCamera(options: { showRefreshMs?: number } = {}) {
    const bus = new Emitter<AppEvents>();
    const clock = new ManualClock(1000);
    const registry = new ObjectRegistry(bus);
    const sink = new MemoryEpisodeSink();
    const asked: FindRequest[][] = [];
    const outlined: string[] = [];
    bus.on('overlay.outline', (e) => outlined.push(`${e.objectId}#${e.rank}`));
    const grounder: Grounder = {
      ground: async (requests) => {
        asked.push([...requests]);
        const sightings = requests.map((r) => {
          registry.observe(r.id, {
            position: [0.2, 0.05, -0.3],
            confidence: 0.9,
            source: 'detector',
            t: clock.now(),
          });
          return {
            id: r.id,
            description: r.description ?? r.id,
            phrase: r.phrase ?? r.id,
            detection: {
              id: r.id,
              found: true,
              point: [0.5, 0.5] as [number, number],
              box: null,
              outline: null,
              confidence: 0.9,
            },
            position: [0.2, 0.05, -0.3] as [number, number, number],
            outline: {
              points: [
                [-0.04, 0.04],
                [0.04, 0.04],
                [0, -0.04],
              ] as [number, number][],
              shape: 'contour' as const,
            },
          };
        });
        const ids = requests.map((r) => r.id);
        return {
          ok: true,
          located: ids,
          missing: [],
          sightings,
          source: 'jev',
          frameT: clock.now(),
        };
      },
    };
    const lesson = new LessonController({
      bus,
      clock,
      planner: { plan: async () => ({ planId: 'p', procedure: shown, warnings: [] }) },
      registry,
      workspace: () => new Workspace({ p: [0, 0.8, -0.4], q: [0, 0, 0, 1] }, 'default_in_front'),
      grounder,
      images: null,
      demos: new DemoLibrary(null),
      recorder: new EpisodeRecorder({ bus, clock, sink, sleep: async () => {} }),
      context: () => ({
        operator: { role: 'learner' },
        coach: { kind: 'scripted' },
        device: { userAgent: 'test', emulated: true, xrFeatures: [] },
        app: { version: 'test' },
      }),
      options,
    });
    return { lesson, clock, asked, outlined, sink };
  }

  it('outlines what each step shows, in its words, and records what the camera saw', async () => {
    const { lesson, asked, outlined, sink } = withCamera();
    await start(lesson, 'add wiper fluid');
    await lesson.settled();
    expect(asked.at(-1)).toEqual([
      { id: 'jug', description: 'Blue jug on the fender', phrase: 'fluid jug' },
    ]);
    expect(outlined).toEqual(['jug#0']);
    await call(lesson, 'complete_step', {
      step_id: 'grab',
      reason: 'holding it',
      evidence: 'seen',
    });
    await call(lesson, 'complete_step', { step_id: 'pour', reason: 'poured', evidence: 'seen' });
    await lesson.settled();
    const [episode] = sink.episodes.values();
    const detected = episode?.batches
      .flatMap((b) => b.events)
      .filter((e) => e.type === 'object.detected');
    expect(detected?.map((e) => e.type === 'object.detected' && [e.objectId, e.stepId])).toEqual([
      ['jug', 'grab'],
    ]);
  });

  it('keeps looking at what the step shows while it runs', async () => {
    const { lesson, clock, asked } = withCamera({ showRefreshMs: 2000 });
    await start(lesson, 'add wiper fluid');
    await lesson.settled();
    const before = asked.length;
    lesson.tick(clock.advance(1999));
    await lesson.settled();
    expect(asked).toHaveLength(before);
    lesson.tick(clock.advance(1));
    await lesson.settled();
    expect(asked).toHaveLength(before + 1);
  });
});
