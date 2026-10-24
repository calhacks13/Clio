import {
  type CalibrationMethod,
  type CoachToolArgs,
  type PlanRequest,
  type PlanResponse,
  type Procedure,
  parseProcedure,
  type StepCheckRequest,
} from '@clio/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import type { LessonToolName, ToolOutcome } from '../../src/domain/coach/toolbox';
import { DemoLibrary } from '../../src/domain/demo/demo-library';
import type { AppEvents } from '../../src/domain/events';
import { EpisodeRecorder } from '../../src/domain/recording/recorder';
import { MemoryEpisodeSink } from '../../src/domain/recording/sink';
import {
  type EpisodeContext,
  LessonController,
  type LessonOptions,
  type LessonPlanner,
} from '../../src/domain/session/lesson-controller';
import type { StepChecker } from '../../src/domain/session/step-watcher';
import type { TemplateSource } from '../../src/domain/session/templates';
import type { Grounder, GroundingResult } from '../../src/domain/world/grounding';
import { ObjectRegistry } from '../../src/domain/world/object-registry';
import { Workspace } from '../../src/domain/world/workspace';
import { ctx } from '../support/context';
import { pinchingHand } from '../support/hands';

// The coach's plan: tools that edit it, what they answer, what gets recorded, who may complete
// steps, and where the first draft comes from. See docs/coach-plan.md.

const plan = parseProcedure({
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
    { id: 'cap', label: 'blue cap', placement: { method: 'detect' } },
    { id: 'jug', label: 'fluid jug', placement: { method: 'layout', position: [0.3, 0.1, -0.3] } },
    { id: 'tank', label: 'reservoir', placement: { method: 'layout', position: [0.6, 0.2, -0.4] } },
  ],
  steps: [
    {
      id: 'open',
      instruction: 'Unscrew the blue cap.',
      doneWhen: 'the blue cap is off',
      targets: ['cap'],
      success: { type: 'hand_near', object: 'cap', dwellMs: 0 },
    },
    {
      id: 'pour',
      instruction: 'Pour fluid into the reservoir.',
      doneWhen: 'the reservoir is full',
      targets: ['jug', 'tank'],
      success: { type: 'confirm' },
    },
    {
      id: 'close',
      instruction: 'Screw the cap back on.',
      targets: ['cap'],
      success: { type: 'confirm' },
    },
  ],
});

interface SetupOptions {
  planner?: LessonPlanner;
  coach?: EpisodeContext['coach'];
  calibration?: CalibrationMethod;
  checker?: StepChecker;
  templates?: TemplateSource;
  grounder?: Grounder;
  options?: LessonOptions;
}

function setup(o: SetupOptions = {}) {
  const bus = new Emitter<AppEvents>();
  const clock = new ManualClock(1000);
  const sink = new MemoryEpisodeSink();
  const registry = new ObjectRegistry(bus);
  const annotations: { label: string; data: unknown }[] = [];
  bus.on('annotation', ({ label, data }) => annotations.push({ label, data }));
  const failed: { error: string; revision: boolean }[] = [];
  bus.on('plan.failed', ({ error, revision }) => failed.push({ error, revision }));
  const lesson = new LessonController({
    bus,
    clock,
    planner: o.planner ?? {
      plan: async () => ({ planId: 'refill-fluid', procedure: plan, warnings: [] }),
    },
    registry,
    workspace: () => new Workspace({ p: [0, 0.8, -0.4], q: [0, 0, 0, 1] }, o.calibration),
    grounder: o.grounder ?? null,
    images: { snapshots: async () => [{ mimeType: 'image/jpeg', data: 'AAAA' }] },
    demos: new DemoLibrary(null),
    recorder: new EpisodeRecorder({ bus, clock, sink, sleep: async () => {} }),
    context: () => ({
      operator: { role: 'learner' },
      coach: o.coach ?? { kind: 'scripted' },
      device: { userAgent: 'test', emulated: true, xrFeatures: [] },
      app: { version: 'test' },
    }),
    checker: o.checker ?? null,
    templates: o.templates ?? null,
    now: () => new Date('2026-10-24T05:00:00.000Z'),
    ...(o.options ? { options: o.options } : {}),
  });
  const tool = <N extends LessonToolName>(name: N, args: CoachToolArgs<N>) => {
    const handler = lesson.handlers()[name] as (
      a: CoachToolArgs<N>,
      c: { callId: string },
    ) => ToolOutcome | Promise<ToolOutcome>;
    return Promise.resolve(handler(args, { callId: `call-${name}` }));
  };
  const result = (outcome: ToolOutcome) =>
    (outcome.ok ? outcome.result : { error: outcome.error }) as Record<string, unknown>;
  const updates = () =>
    annotations
      .filter((a) => a.label === 'plan.updated')
      .map((a) => a.data as { rev: number; op: string; by: string; stepId?: string });
  const begin = async (goal = 'add wiper fluid') => {
    await tool('start_lesson', { goal });
    await lesson.settled();
  };
  return { bus, clock, sink, registry, lesson, tool, result, updates, failed, annotations, begin };
}

/** Gemini in charge: connected, in learn mode. */
const gemini = { coach: { kind: 'gemini' as const, model: 'live' } };

describe('the coach edits the plan', () => {
  it('adds a step at the end and answers with the plan', async () => {
    const { lesson, tool, result, updates, begin } = setup();
    await begin();
    const r = result(
      await tool('add_step', { text: 'Wipe up any spills.', done_when: 'no fluid on the fender' }),
    );
    expect(r.step_id).toBe('wipe-up-any-spills');
    expect(r.now).toBeUndefined();
    expect(r.plan).toContain('Goal: add wiper fluid');
    expect(lesson.procedure?.steps.map((s) => s.id)).toEqual([
      'open',
      'pour',
      'close',
      'wipe-up-any-spills',
    ]);
    expect(lesson.procedure?.steps.at(-1)).toMatchObject({
      doneWhen: 'no fluid on the fender',
      success: { type: 'confirm', prompt: 'no fluid on the fender' },
    });
    expect(updates().map((u) => [u.rev, u.op, u.by, u.stepId])).toEqual([
      [0, 'start', 'planner', undefined],
      [1, 'add', 'coach', 'wipe-up-any-spills'],
    ]);
  });

  it('inserts after a given step and returns the same step for a repeated call', async () => {
    const { lesson, tool, result, begin } = setup();
    await begin();
    await tool('add_step', {
      text: 'Check the level.',
      done_when: 'fluid is at the line',
      after_step_id: 'pour',
    });
    const again = result(
      await tool('add_step', { text: 'check the level', done_when: 'fluid is at the line' }),
    );
    expect(again).toMatchObject({ step_id: 'check-the-level', already: true });
    expect(lesson.procedure?.steps.map((s) => s.id)).toEqual([
      'open',
      'pour',
      'check-the-level',
      'close',
    ]);
  });

  it('refuses materials the plan does not have, and adds new ones', async () => {
    const { lesson, tool, result, registry, begin } = setup();
    await begin();
    const bad = result(
      await tool('add_step', { text: 'Use the funnel.', done_when: 'x y z', objects: ['funnel'] }),
    );
    expect(bad.error).toMatch(/Unknown material "funnel". Materials: cap, jug, tank/);
    const added = result(await tool('add_material', { label: 'funnel', look_for: 'white funnel' }));
    expect(added.material_id).toBe('funnel');
    expect(registry.spec('funnel')).toMatchObject({ tracking: { query: 'white funnel' } });
    expect(lesson.procedure?.objects.map((o) => o.id)).toContain('funnel');
    expect(
      result(
        await tool('add_step', {
          text: 'Put the funnel in.',
          done_when: 'the funnel sits in the neck',
          objects: ['funnel'],
        }),
      ).step_id,
    ).toBe('put-the-funnel-in');
  });

  it('completes any step, briefing the next one only when the focus moves', async () => {
    const { lesson, tool, result, begin } = setup();
    await begin();
    const early = result(
      await tool('complete_step', { reason: 'done', evidence: 'heard', step_id: 'pour' }),
    );
    expect(early).toMatchObject({ done: true });
    expect(early.now).toBeUndefined();
    expect(lesson.currentStep()?.id).toBe('open');
    const next = result(
      await tool('complete_step', { step_id: 'open', reason: 'cap off', evidence: 'seen' }),
    );
    expect(next.now).toMatch(/2 of 3 done\. Now close: "Screw the cap back on\."/);
    expect(next.plan).toContain('Done: open, pour');
    expect(
      result(await tool('complete_step', { reason: 'again', evidence: 'seen', step_id: 'pour' })),
    ).toMatchObject({ already: true });
  });

  it('skips, reopens and rewords steps', async () => {
    const { lesson, tool, result, sink, begin } = setup();
    await begin();
    const skipped = result(
      await tool('update_step', { step_id: 'open', status: 'skipped', reason: 'cap is off' }),
    );
    expect(skipped.now).toMatch(/Now pour/);
    expect(lesson.runnerState?.statuses.open).toBe('skipped');
    expect(result(await tool('update_step', { step_id: 'pour' })).error).toMatch(
      /Nothing to change/,
    );
    await tool('update_step', {
      step_id: 'close',
      text: 'Close the cap tight.',
      note: 'arthritis',
    });
    expect(
      lesson
        .view()
        .plan()
        ?.steps.find((s) => s.id === 'close'),
    ).toMatchObject({
      instruction: 'Close the cap tight.',
      note: 'arthritis',
    });
    await tool('complete_step', { step_id: 'pour', reason: 'full', evidence: 'seen' });
    expect(
      result(await tool('update_step', { step_id: 'pour', text: 'Pour more.' })).error,
    ).toMatch(/already done/);
    const back = result(await tool('update_step', { step_id: 'pour', status: 'current' }));
    expect(back.now).toMatch(/Now pour/);
    await tool('complete_step', { step_id: 'pour', reason: 'full', evidence: 'seen' });
    await tool('complete_step', { step_id: 'close', reason: 'tight', evidence: 'seen' });
    await lesson.settled();
    const [episode] = sink.episodes.values();
    expect(episode?.finish).toMatchObject({ stepsCompleted: 2, stepsTotal: 2 });
  });

  it('records the Done button and checks as plan changes too', async () => {
    const { lesson, updates, begin } = setup();
    await begin();
    lesson.confirmByUser('Done button');
    expect(updates().at(-1)).toMatchObject({ op: 'complete', by: 'user', stepId: 'open' });
  });
});

describe('where the first draft comes from', () => {
  it('lets the coach write the plan when the planner fails', async () => {
    const { lesson, tool, result, failed, begin } = setup({
      ...gemini,
      planner: { plan: async () => Promise.reject(new Error('quota')) },
    });
    await begin('fix my wiper');
    expect(failed).toEqual([{ error: 'quota', revision: false }]);
    expect(result(await tool('add_material', { label: 'wiper blade' })).material_id).toBe(
      'wiper-blade',
    );
    const first = result(
      await tool('add_step', {
        text: 'Lift the wiper arm.',
        done_when: 'the arm stands off the glass',
        objects: ['wiper-blade'],
      }),
    );
    expect(first).toMatchObject({ step_id: 'lift-the-wiper-arm', started: true });
    expect(first.now).toMatch(/Now lift-the-wiper-arm/);
    await tool('add_step', { text: 'Press the release tab.', done_when: 'the blade slides off' });
    await tool('add_step', { text: 'Slide the new blade on.', done_when: 'the blade clicks in' });
    expect(lesson.phase).toBe('lesson');
    expect(lesson.procedure).toMatchObject({
      title: 'fix my wiper',
      origin: { kind: 'generated', goal: 'fix my wiper', model: 'live' },
    });
    expect(lesson.procedure?.steps.map((s) => s.id)).toEqual([
      'lift-the-wiper-arm',
      'press-the-release-tab',
      'slide-the-new-blade',
    ]);
  });

  it('tells the coach planning is slow, then gives up and ignores a late plan', async () => {
    let resolve: (r: PlanResponse) => void = () => {};
    const late = new Promise<PlanResponse>((r) => (resolve = r));
    const { bus, clock, lesson, tool, failed } = setup({ planner: { plan: () => late } });
    const slow: number[] = [];
    bus.on('plan.slow', ({ elapsedMs }) => slow.push(elapsedMs));
    await tool('start_lesson', { goal: 'add wiper fluid' });
    expect(result(await tool('start_lesson', { goal: 'again' }))).toMatchObject({
      error: expect.stringMatching(/Already planning/),
    });
    lesson.tick(clock.advance(11_999));
    expect(slow).toEqual([]);
    lesson.tick(clock.advance(1));
    expect(slow).toEqual([12_000]);
    lesson.tick(clock.advance(33_000));
    expect(failed).toEqual([{ error: 'no plan after 45 s', revision: false }]);
    resolve({ planId: 'refill-fluid', procedure: plan, warnings: [] });
    await lesson.settled();
    expect(lesson.procedure).toBeNull();
    expect(lesson.phase).toBe('idle');

    function result(o: ToolOutcome) {
      return o.ok ? o.result : { error: o.error };
    }
  });

  it('starts from a curated lesson, finding its mat objects with the camera when uncalibrated', async () => {
    const curated: Procedure = parseProcedure({
      ...plan,
      id: 'washer',
      origin: { kind: 'curated' },
      objects: [
        ...plan.objects,
        {
          id: 'dot',
          kind: 'point',
          label: 'dot',
          placement: { method: 'layout', position: [0, 0, 0] },
        },
      ],
    });
    const asked: string[] = [];
    const templates: TemplateSource = {
      list: async () => [{ id: 'washer', title: 'Washer', summary: 'S' }],
      get: async (id) => {
        asked.push(id);
        return curated;
      },
    };
    const { lesson, tool } = setup({ templates });
    await tool('start_lesson', { goal: 'top up my washer fluid', template_id: 'washer' });
    await lesson.settled();
    expect(asked).toEqual(['washer']);
    expect(lesson.procedure?.objects.map((o) => [o.id, o.placement.method])).toEqual([
      ['cap', 'detect'],
      ['jug', 'detect'],
      ['tank', 'detect'],
      ['dot', 'layout'],
    ]);
    expect(lesson.view().plan()?.goal).toBe('top up my washer fluid');
  });
});

describe('re-planning', () => {
  it('keeps what was done meanwhile and refuses edits until the new plan lands', async () => {
    let resolve: (r: PlanResponse) => void = () => {};
    const revised = new Promise<PlanResponse>((r) => (resolve = r));
    const planner: LessonPlanner = {
      plan: (req) =>
        req.revise
          ? revised
          : Promise.resolve({ planId: 'refill-fluid', procedure: plan, warnings: [] }),
    };
    const { lesson, tool, result, begin } = setup({ planner });
    await begin();
    await tool('complete_step', { step_id: 'open', reason: 'off', evidence: 'seen' });
    expect(result(await tool('revise_plan', { reason: 'no jug' }))).toEqual({
      status: 'replanning',
    });
    expect(
      result(await tool('add_step', { text: 'Find a jug.', done_when: 'a jug is here' })).error,
    ).toMatch(/re-plan is running/);
    await tool('complete_step', {
      step_id: 'pour',
      reason: 'poured from the bottle',
      evidence: 'heard',
    });
    const [open] = plan.steps;
    resolve({
      planId: 'refill-fluid-r1',
      procedure: parseProcedure({
        ...plan,
        steps: [
          open,
          { id: 'bottle', instruction: 'Pour from the bottle.', success: { type: 'confirm' } },
          { id: 'close', instruction: 'Close the cap.', success: { type: 'confirm' } },
        ],
      }),
      warnings: [],
    });
    await lesson.settled();
    expect(lesson.procedure?.steps.map((s) => s.id)).toEqual(['open', 'pour', 'bottle', 'close']);
    expect(lesson.runnerState?.statuses).toEqual({
      open: 'done',
      pour: 'done',
      bottle: 'todo',
      close: 'todo',
    });
    expect(lesson.currentStep()?.id).toBe('bottle');
  });
});

describe('two-stage plans', () => {
  // Stage first: the first step in full, the others an outline the coach or learner confirms.
  const outlined = parseProcedure({
    ...plan,
    steps: [
      plan.steps[0],
      {
        id: 'pour',
        instruction: 'Pour fluid into the reservoir.',
        doneWhen: 'the reservoir is full',
        targets: ['jug', 'tank'],
        success: { type: 'confirm', prompt: 'the reservoir is full' },
      },
      {
        id: 'close',
        instruction: 'Screw the cap back on.',
        doneWhen: 'the blue cap is on the reservoir',
        targets: ['cap'],
        success: { type: 'confirm', prompt: 'the blue cap is on the reservoir' },
      },
    ],
  });
  const first: PlanResponse = {
    planId: 'refill-fluid',
    procedure: outlined,
    warnings: ['A knife lies next to the jug: keep hands away from it.'],
    outlineFrom: 1,
    sightings: [],
  };
  // Stage rest: the outline written in full, with a step the outline didn't have.
  const rest: PlanResponse = {
    planId: 'refill-fluid-r1',
    procedure: parseProcedure({
      ...outlined,
      id: 'refill-fluid-r1',
      objects: [
        ...outlined.objects,
        {
          id: 'rag',
          label: 'rag',
          placement: { method: 'detect' },
          tracking: { query: 'blue rag' },
        },
      ],
      steps: [
        outlined.steps[0],
        {
          id: 'pour',
          instruction: 'Pour the blue fluid into the reservoir.',
          doneWhen: 'blue fluid reaches the top line of the white reservoir',
          targets: ['jug', 'tank'],
          action: { verb: 'pour', object: 'jug', target: 'tank' },
          show: [{ object: 'jug', phrase: 'fluid jug', description: 'Blue jug of washer fluid' }],
          success: { type: 'confirm', prompt: 'blue fluid reaches the top line' },
          mistakes: [
            {
              kind: 'wrong_tank',
              message: 'That is the coolant tank; the washer tank has the windshield symbol.',
              when: { type: 'hand_near', object: 'cap', dwellMs: 700 },
            },
          ],
        },
        {
          id: 'close',
          instruction: 'Screw the blue cap back on.',
          doneWhen: 'the blue cap sits flat on the reservoir',
          targets: ['cap'],
          success: { type: 'confirm', prompt: 'the blue cap sits flat on the reservoir' },
        },
        {
          id: 'wipe',
          instruction: 'Wipe any drips off the tank.',
          doneWhen: 'no blue fluid on the tank',
          targets: ['rag', 'tank'],
          success: { type: 'confirm', prompt: 'no blue fluid on the tank' },
        },
      ],
    }),
    warnings: ['A knife lies next to the jug: keep hands away from it.', 'Wear gloves.'],
  };

  /**
   * A planner whose stage rest answers when the test says (at once by default). Only the first
   * lesson comes in two stages; a re-plan or a later lesson gets the whole plan.
   */
  function stagedPlanner({ held = false } = {}) {
    const requests: PlanRequest[] = [];
    let answer: (r: PlanResponse) => void = () => {};
    const later = new Promise<PlanResponse>((r) => (answer = r));
    if (!held) answer(rest);
    const planner: LessonPlanner = {
      plan: async (req) => {
        requests.push(req);
        if (req.stage === 'rest') return later;
        const starts = requests.filter((r) => r.stage === 'first').length;
        if (req.revise || starts > 1) return { planId: 'whole', procedure: plan, warnings: [] };
        return first;
      },
    };
    return { planner, requests, answer: (r: PlanResponse = rest) => answer(r) };
  }

  function watch(bus: ReturnType<typeof setup>['bus']) {
    const ready: { stage?: string; revision: boolean; warnings: string[] }[] = [];
    bus.on('plan.ready', ({ stage, revision, warnings }) =>
      ready.push({ ...(stage ? { stage } : {}), revision, warnings }),
    );
    const entered: string[] = [];
    bus.on('step.entered', ({ stepId }) => entered.push(stepId));
    return { ready, entered };
  }

  const ids = (lesson: LessonController) => lesson.procedure?.steps.map((s) => s.id);

  it('starts on the first stage and swaps in the rest without restarting the step', async () => {
    const staged = stagedPlanner();
    const { bus, lesson, registry, updates, begin } = setup({ planner: staged.planner });
    const { ready, entered } = watch(bus);
    await begin();
    expect(staged.requests).toEqual([
      {
        goal: 'add wiper fluid',
        images: [{ mimeType: 'image/jpeg', data: 'AAAA' }],
        stage: 'first',
      },
      {
        goal: 'add wiper fluid',
        images: [{ mimeType: 'image/jpeg', data: 'AAAA' }],
        stage: 'rest',
        revise: {
          planId: 'refill-fluid',
          fromStepIndex: 1,
          reason: 'Write the outline steps in full while the learner does the first step',
          base: outlined,
        },
      },
    ]);
    expect(ids(lesson)).toEqual(['open', 'pour', 'close', 'wipe']);
    expect(lesson.procedure?.steps[1]).toEqual(rest.procedure.steps[1]);
    expect(lesson.currentStep()?.id).toBe('open');
    expect(entered).toEqual(['open']);
    expect(registry.spec('rag')?.label).toBe('rag');
    expect(ready).toEqual([
      { stage: 'first', revision: false, warnings: first.warnings },
      { stage: 'rest', revision: true, warnings: ['Wear gloves.'] },
    ]);
    expect(updates().map((u) => [u.op, u.by])).toEqual([
      ['start', 'planner'],
      ['refine', 'planner'],
    ]);
    expect(lesson.view().plan()?.steps[1]?.instruction).toBe(
      'Pour the blue fluid into the reservoir.',
    );
  });

  it('keeps the steps finished or started while the rest was being written', async () => {
    const staged = stagedPlanner({ held: true });
    const { bus, lesson, tool } = setup({ planner: staged.planner });
    const { entered } = watch(bus);
    await tool('start_lesson', { goal: 'add wiper fluid' });
    await vi.waitFor(() => expect(lesson.phase).toBe('lesson'));
    await tool('complete_step', { step_id: 'open', reason: 'cap off', evidence: 'seen' });
    expect(lesson.currentStep()?.id).toBe('pour');
    staged.answer();
    await lesson.settled();
    expect(ids(lesson)).toEqual(['open', 'pour', 'close', 'wipe']);
    expect(lesson.procedure?.steps[1]).toEqual(outlined.steps[1]);
    expect(lesson.procedure?.steps[2]).toEqual(rest.procedure.steps[2]);
    expect(lesson.runnerState?.statuses).toEqual({
      open: 'done',
      pour: 'todo',
      close: 'todo',
      wipe: 'todo',
    });
    expect(entered).toEqual(['open', 'pour']);
  });

  it('drops the rest when the coach changed the steps meanwhile, and says why', async () => {
    const staged = stagedPlanner({ held: true });
    const { lesson, tool, annotations } = setup({ planner: staged.planner });
    await tool('start_lesson', { goal: 'add wiper fluid' });
    await vi.waitFor(() => expect(lesson.phase).toBe('lesson'));
    await tool('add_step', { text: 'Check the level.', done_when: 'fluid at the line' });
    staged.answer();
    await lesson.settled();
    expect(ids(lesson)).toEqual(['open', 'pour', 'close', 'check-the-level']);
    expect(annotations.filter((a) => a.label === 'plan.refine_dropped')).toEqual([
      { label: 'plan.refine_dropped', data: { reason: 'the coach changed the steps meanwhile' } },
    ]);
  });

  it('keeps the outline, quietly, when the rest cannot be written', async () => {
    const { bus, lesson, annotations, begin } = setup({
      planner: {
        plan: async (req) => {
          if (req.stage === 'rest') throw new Error('quota exceeded');
          return first;
        },
      },
    });
    const { ready } = watch(bus);
    await begin();
    expect(lesson.procedure?.steps).toEqual(outlined.steps);
    expect(lesson.phase).toBe('lesson');
    expect(ready.map((r) => r.stage)).toEqual(['first']);
    expect(annotations.filter((a) => a.label === 'plan.refine_dropped')).toEqual([
      { label: 'plan.refine_dropped', data: { reason: 'quota exceeded' } },
    ]);
  });

  it('drops the rest after a re-plan or a new lesson, and never waits for it to stop', async () => {
    const replanned = stagedPlanner({ held: true });
    const a = setup({ planner: replanned.planner });
    await a.tool('start_lesson', { goal: 'add wiper fluid' });
    await vi.waitFor(() => expect(a.lesson.phase).toBe('lesson'));
    expect(a.result(await a.tool('revise_plan', { reason: 'no jug' }))).toEqual({
      status: 'replanning',
    });
    await vi.waitFor(() => expect(a.updates().at(-1)?.op).toBe('revise'));
    replanned.answer();
    await a.lesson.settled();
    expect(ids(a.lesson)).toEqual(['open', 'pour', 'close']);
    expect(a.lesson.procedure?.steps[1]).toEqual(plan.steps[1]);

    const restarted = stagedPlanner({ held: true });
    const b = setup({ planner: restarted.planner });
    await b.tool('start_lesson', { goal: 'add wiper fluid' });
    await vi.waitFor(() => expect(b.lesson.phase).toBe('lesson'));
    await b.tool('start_lesson', { goal: 'add wiper fluid again' });
    restarted.answer();
    await b.lesson.settled();
    expect(ids(b.lesson)).toEqual(['open', 'pour', 'close']);
    expect(b.updates().map((u) => u.op)).toEqual(['start', 'start']);

    const stopped = stagedPlanner({ held: true });
    const c = setup({ planner: stopped.planner });
    await c.tool('start_lesson', { goal: 'add wiper fluid' });
    await vi.waitFor(() => expect(c.lesson.phase).toBe('lesson'));
    await c.lesson.stop('headset off');
    stopped.answer();
    await c.lesson.settled();
    expect(ids(c.lesson)).toEqual(['open', 'pour', 'close']);
  });
});

describe('coach authority', () => {
  it('lets only trusted positions complete steps while Gemini is in charge', async () => {
    const { bus, lesson, registry, begin } = setup(gemini);
    await begin();
    bus.emit('coach.status', { t: 0, state: 'ready' });
    expect(lesson.authority()).toBe('coach');
    registry.observe('cap', { position: [0, 0, 0], confidence: 1, source: 'detector', t: 0 });
    const nearCap = ctx({ t: 2000, right: pinchingHand([0, 0, 0]), objects: { cap: [0, 0, 0] } });
    lesson.update(nearCap);
    expect(lesson.currentStep()?.id).toBe('open');
    bus.emit('coach.status', { t: 0, state: 'reconnecting' });
    expect(lesson.authority()).toBe('local');
    lesson.update({ ...nearCap, t: 2100 });
    expect(lesson.currentStep()?.id).toBe('pour');
  });

  it('trusts the taped mat only on a calibrated workspace', async () => {
    const touchJug = parseProcedure({
      ...plan,
      steps: [
        {
          id: 'grab',
          instruction: 'Grab the jug.',
          targets: ['jug'],
          success: { type: 'hand_near', object: 'jug', dwellMs: 0 },
        },
        ...plan.steps,
      ],
    });
    const run = async (calibration: CalibrationMethod) => {
      const { bus, lesson, begin } = setup({
        ...gemini,
        calibration,
        planner: { plan: async () => ({ planId: 'p', procedure: touchJug, warnings: [] }) },
      });
      await begin();
      bus.emit('coach.status', { t: 0, state: 'ready' });
      lesson.update(
        ctx({ t: 2000, right: pinchingHand([0.3, 0.1, -0.3]), objects: { jug: [0.3, 0.1, -0.3] } }),
      );
      return lesson.runnerState?.statuses.grab;
    };
    expect(await run('pinch_two_corners')).toBe('done');
    expect(await run('default_in_front')).toBe('todo');
  });

  it('says only what the learner can see when a highlight cannot be shown', async () => {
    const { lesson, tool, result, begin } = setup(gemini);
    await begin();
    const r = result(await tool('highlight', { object_id: 'cap', style: 'target' }));
    expect(r).toEqual({
      shown: false,
      note: 'The headset cannot show it yet; describe where it is.',
    });
    expect(JSON.stringify(r)).not.toMatch(/locat|detect|found|camera/i);
    expect(lesson.phase).toBe('lesson');
  });
});

describe('the step watcher', () => {
  it('suggests a step that looks done twice in a row, while Gemini is in charge', async () => {
    const checks: StepCheckRequest[] = [];
    const checker: StepChecker = {
      check: async (req) => {
        checks.push(req);
        return { verdict: 'done', observation: 'the cap is off', model: 'm', latencyMs: 5 };
      },
    };
    const { bus, clock, lesson, annotations, begin } = setup({ ...gemini, checker });
    const suggested: string[] = [];
    bus.on('step.looks_done', ({ stepId, observation, image }) =>
      suggested.push(`${stepId}:${observation}:${image}`),
    );
    await begin();
    lesson.tick(clock.advance(10_000));
    await lesson.settled();
    expect(checks).toEqual([]); // the coach is not connected yet
    bus.emit('coach.status', { t: clock.now(), state: 'ready' });
    lesson.tick(clock.advance(100)); // first sight of the step: the frame it starts from
    await lesson.settled();
    lesson.tick(clock.advance(1000));
    await lesson.settled();
    expect(suggested).toEqual([]); // once is not enough
    lesson.tick(clock.advance(1000));
    await lesson.settled();
    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({
      goal: 'add wiper fluid',
      step: { id: 'open', instruction: 'Unscrew the blue cap.', doneWhen: 'the blue cap is off' },
      before: [{ mimeType: 'image/jpeg', data: 'AAAA' }],
      objects: [{ id: 'cap', label: 'blue cap', look: 'blue cap' }],
    });
    expect(suggested).toEqual(['open:the cap is off:AAAA']);
    expect(annotations.find((a) => a.label === 'step.watch')?.data).toMatchObject({
      stepId: 'open',
      verdict: 'done',
    });
    expect(lesson.currentStep()?.id).toBe('open');
  });

  it("tells the watcher what the step's objects look like and the mistakes to tell apart", async () => {
    const fridge = parseProcedure({
      ...plan,
      objects: [
        {
          id: 'yogurt',
          label: 'yogurt drink',
          placement: { method: 'detect' },
          tracking: { query: 'yogurt drink bottle' },
        },
        {
          id: 'fridge',
          label: 'fridge',
          placement: { method: 'detect' },
          tracking: { query: 'white fridge with its door open' },
        },
        { id: 'milk', label: 'milk', placement: { method: 'detect' } },
        { id: 'zone', label: 'shelf zone', hidden: true, placement: { method: 'detect' } },
      ],
      steps: [
        {
          id: 'take',
          instruction: 'Take the yogurt drink off the shelf.',
          doneWhen: 'the yogurt drink is in their hand',
          targets: ['fridge', 'yogurt', 'zone', 'milk'],
          show: [
            {
              object: 'yogurt',
              phrase: 'yogurt drink',
              description: 'small white bottle with a pink cap, left of the milk',
            },
          ],
          success: { type: 'confirm' },
          mistakes: [
            {
              kind: 'took_milk',
              message: 'That is the milk. Take the small bottle with the pink cap.',
              when: { type: 'hand_near', object: 'milk' },
            },
          ],
        },
      ],
    });
    const checks: StepCheckRequest[] = [];
    const checker: StepChecker = {
      check: async (req) => {
        checks.push(req);
        return { verdict: 'not_done', observation: 'not yet', model: 'm', latencyMs: 5 };
      },
    };
    const planner: LessonPlanner = {
      plan: async () => ({ planId: 'fridge', procedure: fridge, warnings: [] }),
    };
    const { bus, clock, lesson, begin } = setup({ ...gemini, checker, planner });
    await begin('get a yogurt drink');
    bus.emit('coach.status', { t: clock.now(), state: 'ready' });
    lesson.tick(clock.advance(100));
    await lesson.settled();
    lesson.tick(clock.advance(1000));
    await lesson.settled();
    expect(checks[0]?.objects).toEqual([
      {
        id: 'yogurt',
        label: 'yogurt drink',
        look: 'small white bottle with a pink cap, left of the milk',
      },
      { id: 'fridge', label: 'fridge', look: 'white fridge with its door open' },
      { id: 'milk', label: 'milk', look: 'milk' },
    ]);
    expect(checks[0]?.confusions).toEqual([
      'That is the milk. Take the small bottle with the pink cap.',
    ]);
  });
});

describe('review regressions', () => {
  it('keeps a lesson that is still being located from being joined by another', async () => {
    // The first look (locating the plan's objects) waits; later looks answer at once.
    const nothing: GroundingResult = {
      ok: true,
      located: [],
      missing: ['cap'],
      sightings: [],
      source: 't',
      frameT: 0,
    };
    let found: (r: GroundingResult) => void = () => {};
    let looks = 0;
    const grounder: Grounder = {
      ground: () => (looks++ === 0 ? new Promise((r) => (found = r)) : Promise.resolve(nothing)),
    };
    const { lesson, tool, result, sink } = setup({ grounder });
    await tool('start_lesson', { goal: 'add wiper fluid' });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(lesson.phase).toBe('locating');
    expect(result(await tool('start_lesson', { goal: 'fold a shirt' })).error).toMatch(
      /Already planning/,
    );
    expect(
      result(await tool('add_step', { text: 'Wipe up.', done_when: 'dry fender' })).error,
    ).toMatch(/being written/);
    found(nothing);
    await lesson.settled();
    expect(lesson.phase).toBe('lesson');
    expect(sink.episodes.size).toBe(1);
    expect(result(await tool('start_lesson', { goal: 'fold a shirt' }))).toMatchObject({
      status: 'planning',
    });
  });

  it('announces a new plan with that plan, not the lesson before it', async () => {
    const tea = parseProcedure({ ...plan, id: 'tea', title: 'Make tea' });
    let next: Procedure = plan;
    const { bus, lesson, tool, begin } = setup({
      planner: { plan: async () => ({ planId: next.id, procedure: next, warnings: [] }) },
    });
    await begin();
    for (const id of ['open', 'pour', 'close']) {
      await tool('complete_step', { step_id: id, reason: 'done', evidence: 'seen' });
    }
    expect(lesson.phase).toBe('done');
    const announced: (string | undefined)[] = [];
    bus.on('plan.requested', () => announced.push(lesson.view().plan()?.title));
    bus.on('plan.ready', () => announced.push(lesson.view().plan()?.title));
    next = tea;
    await tool('start_lesson', { goal: 'make tea' });
    await lesson.settled();
    expect(announced).toEqual([undefined, 'Make tea']);
    expect(lesson.view().plan()?.goal).toBe('make tea');
  });

  it('keeps a step finished during a re-plan as one done step', async () => {
    let resolve: (r: PlanResponse) => void = () => {};
    const revised = new Promise<PlanResponse>((r) => (resolve = r));
    const { lesson, tool, begin } = setup({
      planner: {
        plan: (req) =>
          req.revise ? revised : Promise.resolve({ planId: 'p', procedure: plan, warnings: [] }),
      },
    });
    await begin();
    await tool('revise_plan', { reason: 'different cap' });
    await tool('complete_step', { step_id: 'open', reason: 'off', evidence: 'seen' });
    resolve({
      planId: 'p-r1',
      procedure: parseProcedure({
        ...plan,
        steps: [
          { ...plan.steps[0], instruction: 'Twist the cap off.' },
          plan.steps[1],
          plan.steps[2],
        ],
      }),
      warnings: [],
    });
    await lesson.settled();
    expect(lesson.procedure?.steps.map((s) => s.id)).toEqual(['open', 'pour', 'close']);
    expect(lesson.runnerState?.statuses.open).toBe('done');
  });

  it('drops a re-plan for a lesson that ended, and can start another', async () => {
    let resolve: (r: PlanResponse) => void = () => {};
    const revised = new Promise<PlanResponse>((r) => (resolve = r));
    const { lesson, tool, result, begin } = setup({
      planner: {
        plan: (req) =>
          req.revise ? revised : Promise.resolve({ planId: 'p', procedure: plan, warnings: [] }),
      },
    });
    await begin();
    await tool('revise_plan', { reason: 'r' });
    for (const id of ['open', 'pour', 'close']) {
      await tool('complete_step', { step_id: id, reason: 'done', evidence: 'seen' });
    }
    expect(result(await tool('start_lesson', { goal: 'again' }))).toMatchObject({
      status: 'planning',
    });
    resolve({ planId: 'p-r1', procedure: plan, warnings: [] });
    await lesson.settled();
    expect(lesson.view().plan()?.goal).toBe('again');
  });

  it('keeps an object the camera found untrusted while it is held', async () => {
    const { bus, lesson, registry, begin } = setup(gemini);
    await begin();
    bus.emit('coach.status', { t: 0, state: 'ready' });
    registry.observe('cap', { position: [0, 0, 0], confidence: 1, source: 'detector', t: 0 });
    registry.attach('cap', 'right', { p: [0, 0, 0.08], q: [0, 0, 0, 1] }, 1);
    registry.updateHeld({ right: { p: [0, 0, 0.08], q: [0, 0, 0, 1] } }, 2);
    expect(registry.get('cap')?.source).toBe('pinch');
    lesson.update(ctx({ t: 2000, right: pinchingHand([0, 0, 0]), objects: { cap: [0, 0, 0] } }));
    expect(lesson.currentStep()?.id).toBe('open');
  });

  it('adds a new step when the words match a skipped one', async () => {
    const { lesson, tool, result, begin } = setup();
    await begin();
    await tool('update_step', { step_id: 'close', status: 'skipped' });
    const r = result(
      await tool('add_step', { text: 'Screw the cap back on.', done_when: 'the cap is tight' }),
    );
    expect(r.already).toBeUndefined();
    expect(r.step_id).toBe('screw-the-cap-back');
    expect(lesson.runnerState?.statuses).toMatchObject({
      close: 'skipped',
      'screw-the-cap-back': 'todo',
    });
  });

  it('skips the last step and drops the rewording without an error', async () => {
    const { lesson, tool, result, updates, begin } = setup();
    await begin();
    await tool('complete_step', { step_id: 'open', reason: 'r', evidence: 'seen' });
    await tool('complete_step', { step_id: 'pour', reason: 'r', evidence: 'seen' });
    const r = result(
      await tool('update_step', { step_id: 'close', status: 'skipped', text: 'Leave it.' }),
    );
    expect(r).toMatchObject({ finished: true });
    expect(lesson.phase).toBe('done');
    expect(updates().at(-1)).toMatchObject({ op: 'skip', stepId: 'close' });
  });

  it('takes notes only on finished steps while a re-plan runs', async () => {
    const pending = new Promise<PlanResponse>(() => {});
    const { tool, result, begin } = setup({
      planner: {
        plan: (req) =>
          req.revise ? pending : Promise.resolve({ planId: 'p', procedure: plan, warnings: [] }),
      },
    });
    await begin();
    await tool('complete_step', { step_id: 'open', reason: 'r', evidence: 'seen' });
    await tool('revise_plan', { reason: 'r' });
    expect(result(await tool('update_step', { step_id: 'pour', note: 'n' })).error).toMatch(
      /re-plan is running/,
    );
    expect(result(await tool('update_step', { step_id: 'open', note: 'n' })).error).toBeUndefined();
  });

  it('records the call that started a coach-written lesson', async () => {
    const { tool, updates, begin } = setup({
      planner: { plan: async () => Promise.reject(new Error('down')) },
    });
    await begin('fix my wiper');
    await tool('add_step', { text: 'Lift the arm.', done_when: 'the arm stands up' });
    expect(updates()[0]).toMatchObject({
      rev: 0,
      op: 'start',
      by: 'coach',
      callId: 'call-add_step',
    });
  });

  it('stops without waiting for a plan in flight, and starts no lesson afterwards', async () => {
    let resolve: (r: PlanResponse) => void = () => {};
    const late = new Promise<PlanResponse>((r) => (resolve = r));
    const { lesson, tool, sink } = setup({ planner: { plan: () => late } });
    await tool('start_lesson', { goal: 'add wiper fluid' });
    await lesson.stop('headset off');
    resolve({ planId: 'p', procedure: plan, warnings: [] });
    await lesson.settled();
    expect(lesson.procedure).toBeNull();
    expect(sink.episodes.size).toBe(0);
  });

  it('lets a new lesson replace a re-plan still in flight', async () => {
    const pending = new Promise<PlanResponse>(() => {});
    const tea = parseProcedure({ ...plan, id: 'tea', title: 'Make tea' });
    let first = true;
    const { lesson, tool, result } = setup({
      planner: {
        plan: (req) => {
          if (req.revise) return pending;
          const procedure = first ? plan : tea;
          first = false;
          return Promise.resolve({ planId: procedure.id, procedure, warnings: [] });
        },
      },
    });
    await tool('start_lesson', { goal: 'add wiper fluid' });
    await lesson.settled();
    await tool('revise_plan', { reason: 'r' });
    expect(result(await tool('start_lesson', { goal: 'make tea' }))).toMatchObject({
      status: 'planning',
    });
    await lesson.settled();
    expect(lesson.procedure?.title).toBe('Make tea');
  });

  it('does not trust a free-space pinch that had to guess which object it was', async () => {
    const twoMissing = parseProcedure({
      ...plan,
      objects: [
        { id: 'cap', label: 'blue cap', placement: { method: 'detect' } },
        { id: 'jug', label: 'fluid jug', placement: { method: 'detect' } },
        { id: 'tank', label: 'reservoir', placement: { method: 'detect' } },
      ],
    });
    const { bus, lesson, registry, begin } = setup({
      ...gemini,
      planner: { plan: async () => ({ planId: 'p', procedure: twoMissing, warnings: [] }) },
    });
    await begin();
    bus.emit('coach.status', { t: 0, state: 'ready' });
    lesson.onPinch({ hand: 'right', phase: 'start', point: [0, 0, 0], t: 1500 });
    expect(registry.get('cap')?.source).toBe('pinch');
    lesson.update(ctx({ t: 2000, right: pinchingHand([0, 0, 0]), objects: { cap: [0, 0, 0] } }));
    expect(lesson.currentStep()?.id).toBe('open');
  });

  it('announces a revision with the new plan rev', async () => {
    const { bus, lesson, tool, updates } = setup({
      planner: {
        plan: async (req) => ({
          planId: req.revise ? 'p-r1' : 'p',
          procedure: plan,
          warnings: [],
        }),
      },
    });
    await tool('start_lesson', { goal: 'add wiper fluid' });
    await lesson.settled();
    const revs: number[] = [];
    bus.on('plan.ready', ({ revision }) => {
      if (revision) revs.push(lesson.view().plan()?.rev ?? -1);
    });
    await tool('revise_plan', { reason: 'r' });
    await lesson.settled();
    expect(revs).toEqual([updates().at(-1)?.rev]);
  });

  it('repeats the plan for a material it already has', async () => {
    const { tool, result, begin } = setup();
    await begin();
    expect(result(await tool('add_material', { label: 'Blue cap' }))).toMatchObject({
      material_id: 'cap',
      already: true,
      plan: expect.stringContaining('Goal: add wiper fluid'),
    });
  });

  it('keeps the HUD on planning while a Gemini coach writes the plan itself', async () => {
    const { lesson, begin } = setup({
      ...gemini,
      planner: { plan: async () => Promise.reject(new Error('down')) },
    });
    await begin('fix my wiper');
    expect(lesson.phase).toBe('planning');
  });
});
