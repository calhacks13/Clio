import {
  type CalibrationMethod,
  type CoachToolArgs,
  ObjectSpecSchema,
  type PlanRequest,
  type PlanResponse,
  type Procedure,
  parseProcedure,
  type StepCheckRequest,
} from '@clio/protocol';
import { describe, expect, it, vi } from 'vitest';
import { glowModeFor } from '../../src/adapters/render/presenters/outlines';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import { Narrator } from '../../src/domain/coach/narrator';
import type { LessonToolName, ToolOutcome } from '../../src/domain/coach/toolbox';
import { DemoLibrary } from '../../src/domain/demo/demo-library';
import type { AppEvents } from '../../src/domain/events';
import { OverlayModel } from '../../src/domain/overlay/overlay-model';
import { EpisodeRecorder } from '../../src/domain/recording/recorder';
import { MemoryEpisodeSink } from '../../src/domain/recording/sink';
import { ActionFocus } from '../../src/domain/session/action-focus';
import {
  type EpisodeContext,
  LessonController,
  type LessonOptions,
  type LessonPlanner,
  type PlanImageSource,
} from '../../src/domain/session/lesson-controller';
import { isShown, LiveTracking } from '../../src/domain/session/live-tracking';
import type { StepChecker } from '../../src/domain/session/step-watcher';
import type { TemplateSource } from '../../src/domain/session/templates';
import { WidgetBoard } from '../../src/domain/widgets/board';
import type { WidgetAnnotation } from '../../src/domain/widgets/types';
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
  images?: PlanImageSource;
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
    images: o.images ?? { snapshots: async () => [{ mimeType: 'image/jpeg', data: 'AAAA' }] },
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

/** What highlight adds while its light is off: the call worked, and the light comes by itself. */
const NOT_LIT =
  'Highlighted, not lit yet: it lights up by itself once it is in view. Say where it is meanwhile.';

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

  it('declares an object the action focus named, as the app, once, and only in a lesson', async () => {
    const { lesson, registry, updates, begin } = setup();
    const button = { label: 'red reset button', look: 'Small round red button, left of the cap' };
    expect(lesson.declareObject(button)).toBeNull();
    await begin();
    expect(lesson.declareObject({ label: 'Blue cap.', look: 'a cap' })).toBe('cap');
    expect(lesson.declareObject(button)).toBe('red-reset-button');
    expect(lesson.declareObject({ ...button, label: 'Red reset button' })).toBe('red-reset-button');
    expect(registry.spec('red-reset-button')).toMatchObject({
      label: 'red reset button',
      placement: { method: 'detect' },
      tracking: { query: 'Small round red button, left of the cap', moves: true },
    });
    expect(updates().map((u) => [u.op, u.by])).toEqual([
      ['start', 'planner'],
      ['material', 'app'],
    ]);
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
    // The same call again (a replay after a reconnect) is the lesson already on its way.
    expect(result(await tool('start_lesson', { goal: 'Add wiper fluid.' }))).toEqual({
      status: 'planning',
      goal: 'Add wiper fluid.',
      already: true,
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

  it("fills in the card's objects, keeping where they are and the hand holding them", async () => {
    // Stage rest writes the jug again in full (a bigger container, in better words), lists the
    // objects in its own order, and declares a rag the coach added meanwhile as its own.
    const jug = ObjectSpecSchema.parse({
      ...outlined.objects.find((o) => o.id === 'jug'),
      kind: 'container',
      radius: 0.12,
      description: 'Blue washer fluid jug',
      tracking: { query: 'blue jug with a white label', moves: true },
    });
    const upgraded: PlanResponse = {
      ...rest,
      procedure: parseProcedure({
        ...rest.procedure,
        objects: [...rest.procedure.objects].reverse().map((o) => (o.id === 'jug' ? jug : o)),
      }),
    };
    const staged = stagedPlanner({ held: true });
    const { bus, lesson, registry, tool } = setup({ planner: staged.planner });
    const plans: Procedure[] = [];
    bus.on('plan.ready', ({ procedure }) => plans.push(procedure));
    const released: string[] = [];
    bus.on('object.released', ({ objectId }) => released.push(objectId));
    await tool('start_lesson', { goal: 'add wiper fluid' });
    await vi.waitFor(() => expect(lesson.phase).toBe('lesson'));
    await tool('add_material', { label: 'rag', look_for: 'grey cloth' });
    registry.attach('jug', 'right', { p: [0.3, 0.1, -0.2], q: [0, 0, 0, 1] }, 1500);
    staged.answer(upgraded);
    await lesson.settled();
    expect(lesson.procedure?.objects.map((o) => o.id)).toEqual(['cap', 'jug', 'tank', 'rag']);
    expect(lesson.procedure?.objects[1]).toEqual(jug);
    expect(plans.at(-1)?.objects[1]).toEqual(jug);
    // The registry has the new spec, and nothing else about the jug changed: still in hand.
    expect(registry.spec('jug')).toEqual(jug);
    expect(registry.get('jug')).toMatchObject({
      spec: jug,
      position: [0.3, 0.1, -0.3],
      heldBy: 'right',
    });
    expect(registry.heldBy('right')).toEqual(['jug']);
    expect(released).toEqual([]);
    // A whole container glows around itself now, not on the surface it marks.
    const spec = registry.get('jug')?.spec;
    expect(spec && glowModeFor(spec)).toBe('object');
    // Only the card's objects are filled in: the coach's rag keeps its words.
    expect(registry.spec('rag')?.tracking?.query).toBe('rag, grey cloth');
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

  it('says a highlight is not lit yet before the object is placed, never that it cannot be', async () => {
    const { lesson, tool, result, begin } = setup(gemini);
    await begin();
    const r = result(await tool('highlight', { object_id: 'cap', style: 'target' }));
    expect(r).toEqual({ shown: false, note: NOT_LIT });
    expect(JSON.stringify(r)).not.toMatch(/locat|detect|found|camera|cannot/i);
    expect(lesson.phase).toBe('lesson');
  });

  it('says a highlight is not lit while the object is lost from view, and lit once it is back', async () => {
    const { registry, clock, tool, result, begin } = setup(gemini);
    await begin();
    const seen = () =>
      registry.observe('cap', {
        position: [0.1, 0, -0.2],
        confidence: 0.9,
        source: 'detector',
        t: clock.now(),
      });
    const highlight = async () =>
      result(await tool('highlight', { object_id: 'cap', style: 'target' }));
    seen();
    expect(await highlight()).toEqual({ shown: true });
    clock.advance(500);
    registry.lose('cap', clock.now());
    expect(await highlight()).toEqual({ shown: false, note: NOT_LIT });
    clock.advance(500);
    seen();
    expect(await highlight()).toEqual({ shown: true });
  });
});

describe('the step watcher', () => {
  it('completes a step that looks done twice in a row, as the app, while Gemini is in charge', async () => {
    const checks: StepCheckRequest[] = [];
    const checker: StepChecker = {
      check: async (req) => {
        checks.push(req);
        return { verdict: 'done', observation: 'the cap is off', model: 'm', latencyMs: 5 };
      },
    };
    const { bus, clock, lesson, annotations, begin } = setup({ ...gemini, checker });
    const seen: string[] = [];
    bus.on('step.looks_done', ({ stepId, observation, image }) =>
      seen.push(`${stepId}:${observation}:${image}`),
    );
    const completed: string[] = [];
    bus.on('step.completed', ({ stepId, by }) => completed.push(`${stepId}:${by}`));
    await begin();
    lesson.tick(clock.advance(10_000));
    await lesson.settled();
    expect(checks).toEqual([]); // the coach is not connected yet
    bus.emit('coach.status', { t: clock.now(), state: 'ready' });
    lesson.tick(clock.advance(100)); // first sight of the step: the frame it starts from
    await lesson.settled();
    lesson.tick(clock.advance(1000));
    await lesson.settled();
    expect(seen).toEqual([]); // once is not enough
    expect(lesson.currentStep()?.id).toBe('open');
    lesson.tick(clock.advance(1000));
    await lesson.settled();
    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({
      goal: 'add wiper fluid',
      step: { id: 'open', instruction: 'Unscrew the blue cap.', doneWhen: 'the blue cap is off' },
      before: [{ mimeType: 'image/jpeg', data: 'AAAA' }],
      objects: [{ id: 'cap', label: 'blue cap', look: 'blue cap' }],
    });
    expect(seen).toEqual(['open:the cap is off:AAAA']);
    expect(annotations.find((a) => a.label === 'step.watch')?.data).toMatchObject({
      stepId: 'open',
      verdict: 'done',
    });
    expect(completed).toEqual(['open:check']);
    expect(lesson.currentStep()?.id).toBe('pour');
    expect(annotations.filter((a) => a.label === 'plan.updated').at(-1)?.data).toMatchObject({
      op: 'complete',
      by: 'app',
      stepId: 'open',
      reason: 'the cap is off',
      evidence: 'seen',
    });
  });

  it('leaves alone a step it saw done once that step has lost focus', async () => {
    const { bus, clock, lesson, begin } = setup(gemini);
    const completed: string[] = [];
    bus.on('step.completed', ({ stepId }) => completed.push(stepId));
    bus.emit('step.looks_done', { t: clock.now(), stepId: 'open', observation: 'o', image: null });
    await begin();
    bus.emit('step.looks_done', { t: clock.now(), stepId: 'pour', observation: 'o', image: null });
    expect(completed).toEqual([]);
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
  it('starts the lesson and briefs step 1 while its objects are still being located', async () => {
    // The first look (the step's, for the cap) waits; later looks answer at once. Each places
    // what it was asked about.
    const asked: string[][] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const grounder: Grounder = {
      ground: async (requests) => {
        const ids = requests.map((r) => r.id);
        if (asked.push(ids) === 1) await held;
        for (const id of ids) {
          lab.registry.observe(id, {
            position: [0.2, 0.05, -0.3],
            confidence: 0.9,
            source: 'detector',
            t: lab.clock.now(),
          });
        }
        return { ok: true, located: ids, missing: [], sightings: [], source: 't', frameT: 0 };
      },
    };
    const lab = setup({ grounder });
    const { bus, lesson, tool, result, sink, registry } = lab;
    const briefed: string[] = [];
    new Narrator(bus, lesson.view(), (n) => briefed.push(n.kind)).attach();
    const missing: string[][] = [];
    bus.on('object.missing', (e) => missing.push(e.objectIds));
    await tool('start_lesson', { goal: 'add wiper fluid' });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(lesson.phase).toBe('lesson');
    expect(lesson.currentStep()?.id).toBe('open');
    expect(briefed).toEqual(['plan', 'step']);
    // The lesson's own look joined the step's: the finder was asked about the cap once.
    expect(asked).toEqual([['cap']]);
    // The tools work meanwhile. A highlight joins the look already out instead of a second one,
    // and nothing is called missing before that look answers.
    expect(result(await tool('highlight', { object_id: 'cap', style: 'target' }))).toEqual({
      shown: false,
      note: NOT_LIT,
    });
    expect(
      result(await tool('add_step', { text: 'Wipe up.', done_when: 'dry fender' })),
    ).toMatchObject({ step_id: 'wipe-up' });
    expect(asked).toEqual([['cap']]);
    expect(missing).toEqual([]);
    release();
    await lesson.settled();
    expect(registry.get('cap')).toMatchObject({ source: 'detector' });
    expect(asked).toEqual([['cap']]);
    expect(missing).toEqual([]);
    expect(sink.episodes.size).toBe(1);
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

  it('keeps the objects the lesson declared when a re-plan writes them again', async () => {
    const [cap] = plan.objects;
    const { lesson, registry, tool, updates, begin } = setup({
      planner: {
        plan: async (req) => ({
          planId: req.revise ? 'p-r1' : 'p',
          procedure: req.revise
            ? parseProcedure({
                ...plan,
                objects: plan.objects.map((o) =>
                  o.id === 'cap' ? { ...o, label: 'red cap', kind: 'tool' } : o,
                ),
              })
            : plan,
          warnings: [],
        }),
      },
    });
    await begin();
    await tool('revise_plan', { reason: 'different cap' });
    await lesson.settled();
    expect(updates().at(-1)?.op).toBe('revise');
    expect(lesson.procedure?.objects[0]).toEqual(cap);
    expect(registry.spec('cap')).toEqual(cap);
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

  it('records no placement in the next episode for an object the live tracker lost', async () => {
    const { clock, registry, sink, begin } = setup();
    await begin();
    registry.observe('cap', {
      position: [0.1, 0, -0.2],
      confidence: 0.9,
      source: 'detector',
      t: clock.now(),
    });
    registry.lose('cap', clock.advance(500));
    // The same lesson again: the lesson still reads where the cap was last seen.
    await begin();
    expect(registry.get('cap')).toMatchObject({ position: [0.1, 0, -0.2], lostAt: 1500 });
    const [first, next] = [...sink.episodes.values()];
    expect(first?.meta.objects.map((o) => o.id)).toEqual(['jug', 'tank']);
    expect(next?.meta.objects.map((o) => o.id)).toEqual(['jug', 'tank']);
  });
});

describe('starting quickly', () => {
  /** Lets the plan arrive and the lesson start, without waiting for looks that are held. */
  const arrive = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  /** A finder that answers once `held` resolves, placing everything it was asked about. */
  function placing(lab: () => ReturnType<typeof setup>, held: Promise<void>): Grounder {
    return {
      ground: async (requests) => {
        await held;
        const ids = requests.map((r) => r.id);
        for (const id of ids) {
          lab().registry.observe(id, {
            position: [0.2, 0.05, -0.3],
            confidence: 0.9,
            source: 'detector',
            t: lab().clock.now(),
          });
        }
        return { ok: true, located: ids, missing: [], sightings: [], source: 't', frameT: 0 };
      },
    };
  }

  const twist = parseProcedure({
    ...plan,
    steps: [{ ...plan.steps[0], action: { verb: 'twist', object: 'cap' } }, ...plan.steps.slice(1)],
  });

  it('records how long start_lesson took to reach step 1, and when its objects were found', async () => {
    const nothing = (ids: string[]): GroundingResult => ({
      ok: true,
      located: [],
      missing: ids,
      sightings: [],
      source: 't',
      frameT: 0,
    });
    const lab = setup({
      planner: {
        plan: async () => {
          lab.clock.advance(3000);
          return { planId: 'refill-fluid', procedure: plan, warnings: [] };
        },
      },
      grounder: {
        ground: async (requests) => {
          await Promise.resolve();
          lab.clock.advance(1500);
          return nothing(requests.map((r) => r.id));
        },
      },
    });
    const { lesson, annotations, sink, begin } = lab;
    await begin();
    const data = (label: string) => annotations.filter((a) => a.label === label).map((a) => a.data);
    expect(data('lesson.first_step')).toEqual([
      {
        stepId: 'open',
        source: 'planner',
        frames: 'fresh',
        captureMs: 0,
        planMs: 3000,
        totalMs: 3000,
        locate: 'background',
      },
    ]);
    expect(data('lesson.first_locate')).toEqual([
      { locateMs: 1500, sinceStartMs: 4500, located: [], missing: ['cap'] },
    ]);
    await lesson.stop('done');
    const [episode] = sink.episodes.values();
    const labels = episode?.batches
      .flatMap((b) => b.events)
      .flatMap((e) => (e.type === 'annotation' ? [e.label] : []));
    expect(labels).toEqual(expect.arrayContaining(['lesson.first_step', 'lesson.first_locate']));
  });

  it('plans from the frames it kept since the learner spoke, and keeps none during a lesson', async () => {
    const shots: number[] = [];
    const images: PlanImageSource = {
      snapshots: async (max) => {
        shots.push(max);
        return Array.from({ length: max }, (_, i) => ({
          mimeType: 'image/jpeg' as const,
          data: `F${shots.length}${i}`,
        }));
      },
    };
    const requests: PlanRequest[] = [];
    const lab = setup({
      images,
      options: { planFrameMs: 450 },
      planner: {
        plan: async (req) => {
          requests.push(req);
          return { planId: 'refill-fluid', procedure: plan, warnings: [] };
        },
      },
    });
    const { bus, clock, lesson, annotations, begin } = lab;
    lesson.tick(clock.now());
    expect(shots).toEqual([]);
    bus.emit('coach.caption', { t: clock.now(), role: 'user', text: 'I want to', final: false });
    lesson.tick(clock.now());
    await lesson.settled();
    lesson.tick(clock.advance(449));
    lesson.tick(clock.advance(1));
    await lesson.settled();
    expect(shots).toEqual([1, 1]);
    await begin();
    expect(requests[0]?.images?.map((i) => i.data)).toEqual(['F10', 'F20']);
    expect(shots).toEqual([1, 1]);
    expect(annotations.find((a) => a.label === 'lesson.first_step')?.data).toMatchObject({
      frames: 'buffered',
      captureMs: 0,
    });
    bus.emit('coach.caption', { t: clock.now(), role: 'user', text: 'what now', final: false });
    lesson.tick(clock.advance(1000));
    await lesson.settled();
    expect(shots).toEqual([1, 1]);
  });

  it("plays step 1's demonstration once the step's look has placed its object", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const lab: ReturnType<typeof setup> = setup({
      options: { autoDemo: true },
      planner: { plan: async () => ({ planId: 'p', procedure: twist, warnings: [] }) },
      grounder: placing(() => lab, held),
    });
    const { bus, clock, lesson, tool } = lab;
    const demos: unknown[] = [];
    bus.on('demo.playback', ({ t, stepId, phase }) => demos.push({ t, stepId, phase }));
    await tool('start_lesson', { goal: 'add wiper fluid' });
    await arrive();
    expect(lesson.currentStep()?.id).toBe('open');
    expect(lesson.activeDemo).toBeNull();
    clock.advance(800);
    release();
    await lesson.settled();
    expect(lesson.activeDemo).toMatchObject({ stepId: 'open', source: 'synthesized' });
    expect(demos).toEqual([{ t: 1800, stepId: 'open', phase: 'start' }]);
  });

  it('plays no late demonstration once the step is over', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const lab: ReturnType<typeof setup> = setup({
      options: { autoDemo: true },
      planner: { plan: async () => ({ planId: 'p', procedure: twist, warnings: [] }) },
      grounder: placing(() => lab, held),
    });
    const { lesson, tool } = lab;
    await tool('start_lesson', { goal: 'add wiper fluid' });
    await arrive();
    await tool('complete_step', { step_id: 'open', reason: 'off', evidence: 'seen' });
    release();
    await lesson.settled();
    expect(lesson.currentStep()?.id).toBe('pour');
    expect(lesson.activeDemo).toBeNull();
  });

  const tea = parseProcedure({
    ...plan,
    id: 'tea',
    title: 'Make tea',
    objects: plan.objects.filter((o) => o.id !== 'cap'),
    steps: [plan.steps[1]],
  });

  /**
   * Lesson A (the refill, which looks for the cap) whose first look waits for releaseLook() (with
   * `all`, every look does) and then finds nothing; plan() makes the next lesson the tea, whose
   * planner waits for releasePlan() when `held`. The HUD and a scripted coach listen.
   */
  function lateLook(o: { all?: boolean } = {}) {
    let next: Procedure = plan;
    let held = false;
    let releaseLook: () => void = () => {};
    const look = new Promise<void>((r) => (releaseLook = r));
    let releasePlan: () => void = () => {};
    const planned = new Promise<void>((r) => (releasePlan = r));
    let looks = 0;
    const lab = setup({
      planner: {
        plan: async () => {
          const procedure = next;
          if (held) await planned;
          return { planId: procedure.id, procedure, warnings: [] };
        },
      },
      grounder: {
        ground: async (requests) => {
          if (looks++ === 0 || o.all) await look;
          const ids = requests.map((r) => r.id);
          return { ok: true, located: [], missing: ids, sightings: [], source: 't', frameT: 0 };
        },
      },
    });
    const overlay = new OverlayModel(lab.bus, lab.lesson.view());
    overlay.attach();
    const told: string[] = [];
    new Narrator(lab.bus, lab.lesson.view(), (n) => told.push(n.text)).attach();
    const missing: string[][] = [];
    lab.bus.on('object.missing', (e) => missing.push(e.objectIds));
    return {
      ...lab,
      overlay,
      missing,
      /** What a coach was told it can't see. */
      unseen: () => told.filter((text) => text.includes("can't see")),
      locates: () => lab.annotations.filter((a) => a.label === 'lesson.first_locate'),
      looks: () => looks,
      teaNext: (opts: { held?: boolean } = {}) => {
        next = tea;
        held = opts.held ?? false;
      },
      releaseLook: () => releaseLook(),
      releasePlan: () => releasePlan(),
    };
  }

  it("never announces an old lesson's late look in the next lesson", async () => {
    const lab = lateLook();
    const { lesson, tool, missing } = lab;
    await tool('start_lesson', { goal: 'add wiper fluid' });
    await arrive();
    expect(lesson.currentStep()?.id).toBe('open');
    lab.teaNext();
    await tool('start_lesson', { goal: 'make tea' });
    await arrive();
    expect(lesson.procedure?.id).toBe('tea');
    lab.releaseLook();
    await lesson.settled();
    expect(lab.looks()).toBe(1);
    expect(missing).toEqual([]);
    expect(lab.locates()).toHaveLength(1);
  });

  it("never announces an old lesson's late look while the next one is being planned", async () => {
    const lab = lateLook();
    const { clock, lesson, tool, result, overlay, missing } = lab;
    await tool('start_lesson', { goal: 'add wiper fluid' });
    await arrive();
    expect(lesson.currentStep()?.id).toBe('open');
    lab.teaNext({ held: true });
    expect(result(await tool('start_lesson', { goal: 'make tea' }))).toMatchObject({
      status: 'planning',
    });
    await arrive();
    expect(lesson.phase).toBe('planning');
    // The refill's look answers "not found" while the tea is still being planned.
    lab.releaseLook();
    await arrive();
    expect(missing).toEqual([]);
    lab.releasePlan();
    await lesson.settled();
    expect(lesson.procedure?.id).toBe('tea');
    expect(missing).toEqual([]);
    expect(overlay.snapshot(clock.now()).missing).toEqual([]);
    expect(lab.unseen()).toEqual([]);
    // Only the tea's, which had nothing to find.
    expect(lab.locates().map((a) => a.data)).toEqual([
      expect.objectContaining({ located: [], missing: [] }),
    ]);
  });

  it('says nothing of a look that answers after the lesson is complete', async () => {
    const lab = lateLook({ all: true });
    const { clock, lesson, tool, overlay, missing } = lab;
    await tool('start_lesson', { goal: 'add wiper fluid' });
    await arrive();
    for (const step_id of ['open', 'pour', 'close']) {
      await tool('complete_step', { step_id, reason: 'done', evidence: 'seen' });
    }
    await arrive();
    expect(lesson.phase).toBe('done');
    lab.releaseLook();
    await lesson.settled();
    expect(missing).toEqual([]);
    // Once "Lesson complete!" is gone, the HUD asks for no object.
    expect(overlay.snapshot(clock.advance(4000)).missing).toEqual([]);
    expect(lab.unseen()).toEqual([]);
    expect(lab.locates()).toEqual([]);
  });
});

describe('the learner wants something else', () => {
  const tea = parseProcedure({
    ...plan,
    id: 'tea',
    title: 'Make tea',
    origin: { ...plan.origin, goal: 'make tea' },
  });

  /** A planner that answers each request when the test says so. */
  function heldPlanner() {
    const asked: { goal: string; answer: (procedure: Procedure) => void }[] = [];
    const planner: LessonPlanner = {
      plan: (req) =>
        new Promise<PlanResponse>((resolve) =>
          asked.push({
            goal: req.goal,
            answer: (procedure) => resolve({ planId: procedure.id, procedure, warnings: [] }),
          }),
        ),
    };
    return { asked, planner };
  }

  it('replaces a lesson still being planned, and drops its late plan', async () => {
    const held = heldPlanner();
    const { lesson, tool, result, sink } = setup({ planner: held.planner });
    await tool('start_lesson', { goal: 'add wiper fluid' });
    expect(result(await tool('start_lesson', { goal: 'make tea' }))).toEqual({
      status: 'planning',
      goal: 'make tea',
      replaced: 'add wiper fluid',
    });
    await vi.waitFor(() =>
      expect(held.asked.map((a) => a.goal)).toEqual(['add wiper fluid', 'make tea']),
    );
    held.asked[0]?.answer(plan);
    held.asked[1]?.answer(tea);
    await lesson.settled();
    expect(lesson.procedure?.title).toBe('Make tea');
    expect([...sink.episodes.values()].map((e) => e.meta.procedure?.title)).toEqual(['Make tea']);
  });

  it('replaces a lesson the coach was writing itself', async () => {
    let first = true;
    const { lesson, tool, result } = setup({
      ...gemini,
      planner: {
        plan: async () => {
          if (first) {
            first = false;
            throw new Error('planner down');
          }
          return { planId: 'tea', procedure: tea, warnings: [] };
        },
      },
    });
    await tool('start_lesson', { goal: 'add wiper fluid' });
    await lesson.settled();
    expect(result(await tool('start_lesson', { goal: 'make tea' }))).toMatchObject({
      replaced: 'add wiper fluid',
    });
    await lesson.settled();
    expect(lesson.procedure?.title).toBe('Make tea');
  });

  it('ends the running lesson at once: its steps, its lights and its recording', async () => {
    const held = heldPlanner();
    const { bus, clock, lesson, registry, tool, result, sink } = setup({ planner: held.planner });
    const tracking = new LiveTracking({ bus, registry, procedure: () => lesson.procedure });
    tracking.attach();
    const overlay = new OverlayModel(bus, lesson.view());
    overlay.attach();
    await tool('start_lesson', { goal: 'add wiper fluid' });
    await vi.waitFor(() => expect(held.asked).toHaveLength(1));
    held.asked[0]?.answer(plan);
    await vi.waitFor(() => expect(lesson.phase).toBe('lesson'));
    expect(tracking.objects.filter(isShown).map((o) => o.id)).toEqual(['cap']);
    const aborted: string[] = [];
    bus.on('procedure.aborted', ({ reason }) => aborted.push(reason));
    // Before the new plan exists, the old lesson is gone.
    expect(result(await tool('start_lesson', { goal: 'make tea' }))).toEqual({
      status: 'planning',
      goal: 'make tea',
      replaced: 'add wiper fluid',
    });
    expect(aborted).toEqual(['a new lesson was requested']);
    expect(lesson.procedure).toBeNull();
    expect(lesson.view().plan()).toBeNull();
    expect(lesson.phase).toBe('planning');
    expect(tracking.objects).toEqual([]);
    expect(overlay.snapshot(clock.now())).toMatchObject({ instruction: null, highlights: [] });
    await vi.waitFor(() => expect(held.asked).toHaveLength(2));
    held.asked[1]?.answer(tea);
    await lesson.settled();
    // A new lesson is a new episode.
    const [first, next] = [...sink.episodes.values()];
    expect(first?.meta.procedure?.title).toBe('Refill washer fluid');
    expect(first?.finish?.outcome).toBe('aborted');
    expect(next?.meta.procedure?.title).toBe('Make tea');
    expect(next?.finish).toBeNull();
  });
});

describe('ending a lesson without another', () => {
  it('ends the running lesson at once: its episode, its steps and every light', async () => {
    const { bus, clock, lesson, registry, tool, result, sink, begin } = setup();
    const tracking = new LiveTracking({ bus, registry, procedure: () => lesson.procedure });
    tracking.attach();
    const overlay = new OverlayModel(bus, lesson.view());
    overlay.attach();
    const looks: string[] = [];
    const focus = new ActionFocus({
      bus,
      clock,
      finder: {
        focus: async (r) => {
          looks.push(r.step.instruction);
          return { detections: [], action: null, model: 'er', latencyMs: 1 };
        },
      },
      frames: { grab: async () => ({ image: { mimeType: 'image/jpeg', data: 'AAAA' }, t: 0 }) },
      anchors: { anchor: () => {} },
      tracking,
      view: lesson.view(),
      lesson,
    });
    focus.attach();
    await begin();
    expect(tracking.objects.filter(isShown).map((o) => o.id)).toEqual(['cap']);
    const aborted: string[] = [];
    bus.on('procedure.aborted', ({ reason }) => aborted.push(reason));
    expect(result(await tool('end_lesson', { reason: 'not what they want' }))).toEqual({
      ended: 'add wiper fluid',
    });
    expect(aborted).toEqual(['not what they want']);
    expect(lesson.procedure).toBeNull();
    expect(lesson.view().plan()).toBeNull();
    expect(result(await tool('show_demo', {}))).toEqual({ error: 'No lesson is running.' });
    // The HUD asks what they want to do, not "Lesson complete!".
    expect(lesson.phase).toBe('idle');
    expect(tracking.objects).toEqual([]);
    expect(overlay.snapshot(clock.now())).toMatchObject({
      phase: 'idle',
      title: null,
      instruction: null,
      highlights: [],
    });
    expect(focus.tick(clock.advance(10_000))).toBeNull();
    expect(looks).toEqual([]);
    await lesson.settled();
    expect(sink.only().finish?.outcome).toBe('aborted');
    // Another lesson starts as usual.
    await begin();
    expect(lesson.phase).toBe('lesson');
  });

  it('cancels a lesson being planned or written, and says so when there is none', async () => {
    let answer: (r: PlanResponse) => void = () => {};
    const held = setup({ planner: { plan: () => new Promise((r) => (answer = r)) } });
    expect(held.result(await held.tool('end_lesson', { reason: 'stop' }))).toEqual({
      ended: null,
      note: 'No lesson was running.',
    });
    await held.tool('start_lesson', { goal: 'add wiper fluid' });
    expect(held.result(await held.tool('end_lesson', { reason: 'stop' }))).toEqual({
      ended: 'add wiper fluid',
    });
    expect(held.lesson.phase).toBe('idle');
    answer({ planId: 'refill-fluid', procedure: plan, warnings: [] });
    await held.lesson.settled();
    expect(held.lesson.procedure).toBeNull();
    expect(held.sink.episodes.size).toBe(0);

    const writing = setup({
      ...gemini,
      planner: { plan: async () => Promise.reject(new Error('planner down')) },
    });
    await writing.tool('start_lesson', { goal: 'add wiper fluid' });
    await writing.lesson.settled();
    expect(writing.result(await writing.tool('end_lesson', { reason: 'stop' }))).toEqual({
      ended: 'add wiper fluid',
    });
    expect(
      writing.result(await writing.tool('add_step', { text: 'Open it.', done_when: 'it is open' })),
    ).toEqual({ error: 'No lesson is running. Call start_lesson first.' });
  });

  it("closes the coach's widgets as an abort does, also for a lesson still being planned", async () => {
    /** A board on the lesson's bus, its tools, and what it shows and has closed. */
    const widgetsOn = ({ bus, clock, lesson, annotations }: ReturnType<typeof setup>) => {
      const board = new WidgetBoard({ bus, clock, view: lesson.view() });
      board.attach();
      return {
        tools: board.handlers(),
        shown: () => board.snapshot().widgets.map((w) => w.id),
        closed: () =>
          annotations
            .filter((a) => a.label === 'widget.updated')
            .map((a) => a.data as WidgetAnnotation)
            .filter((a) => a.op === 'close')
            .map((a) => [a.id, a.reason]),
      };
    };

    // Ended while it is planned, nothing is aborted: the lesson goes back to idle.
    let answer: (r: PlanResponse) => void = () => {};
    const held = setup({ planner: { plan: () => new Promise((r) => (answer = r)) } });
    const planning = widgetsOn(held);
    await held.tool('start_lesson', { goal: 'add wiper fluid' });
    planning.tools.show_timer({ seconds: 120, label: 'Glue sets' }, { callId: 'w1' });
    planning.tools.show_value({ label: 'Torque', value: '25 N m' }, { callId: 'w2' });
    planning.tools.show_caution({ text: 'The pan stays hot' }, { callId: 'w3' });
    expect(planning.shown()).toEqual(['timer', 'value', 'caution']);
    await held.tool('end_lesson', { reason: 'stop' });
    // A running timer stays: nothing silently stops the learner's clock.
    expect(planning.shown()).toEqual(['timer']);
    expect(planning.closed()).toEqual([
      ['value', 'lesson'],
      ['caution', 'lesson'],
    ]);
    answer({ planId: 'refill-fluid', procedure: plan, warnings: [] });
    await held.lesson.settled();

    // A running lesson is aborted, as before.
    const live = setup();
    const running = widgetsOn(live);
    await live.begin();
    running.tools.show_caution({ text: 'The pan stays hot' }, { callId: 'w4' });
    await live.tool('end_lesson', { reason: 'stop' });
    expect(running.shown()).toEqual([]);
    expect(running.closed()).toEqual([['caution', 'lesson']]);
  });
});

describe('highlights the coach asks for', () => {
  it('adds something the plan lacks as a material when the coach says what it looks like', async () => {
    const { bus, lesson, registry, tool, result, updates, begin } = setup();
    const lit: string[] = [];
    bus.on('overlay.highlight', ({ objectId, style }) => lit.push(`${objectId}:${style}`));
    await begin();
    expect(result(await tool('highlight', { object_id: 'red_button', style: 'target' }))).toEqual({
      error:
        'Unknown object "red_button". Objects in this lesson: cap, jug, tank. To light something the plan lacks, call highlight again with look_for.',
    });
    const look = 'small round, left of the steering wheel';
    expect(
      result(await tool('highlight', { object_id: 'red_button', style: 'target', look_for: look })),
    ).toEqual({
      shown: false,
      material_id: 'red_button',
      added: true,
      note: NOT_LIT,
    });
    expect(registry.spec('red_button')).toMatchObject({
      label: 'red button',
      placement: { method: 'detect' },
      tracking: { query: 'red button, small round, left of the steering wheel', moves: true },
    });
    expect(
      lesson
        .view()
        .plan()
        ?.materials.map((m) => m.id),
    ).toContain('red_button');
    // Known now: lit as it is. An id that is not one becomes one; a name it has is that material.
    await tool('highlight', { object_id: 'red_button', style: 'attention', look_for: 'other' });
    expect(
      result(
        await tool('highlight', { object_id: 'Wiper Arm', style: 'target', look_for: 'black arm' }),
      ),
    ).toMatchObject({ material_id: 'wiper-arm' });
    expect(
      result(
        await tool('highlight', { object_id: 'blue-cap', style: 'target', look_for: 'blue cap' }),
      ),
    ).toMatchObject({ material_id: 'cap' });
    expect(lit).toEqual([
      'red_button:target',
      'red_button:attention',
      'wiper-arm:target',
      'cap:target',
    ]);
    expect(updates().map((u) => [u.op, u.by])).toEqual([
      ['start', 'planner'],
      ['material', 'coach'],
      ['material', 'coach'],
    ]);
  });

  it('adds nothing outside a lesson', async () => {
    const { tool, result } = setup();
    expect(
      result(await tool('highlight', { object_id: 'cup', style: 'target', look_for: 'a cup' })),
    ).toEqual({ error: 'Unknown object "cup". Objects in this lesson: none.' });
  });

  it("names the thing in the words a coach's material is found by", async () => {
    const { registry, tool, result, begin, lesson } = setup();
    await begin();
    await tool('add_material', { label: 'funnel', look_for: 'White plastic, on the fender.' });
    await tool('add_material', { label: 'rag' });
    expect(registry.spec('funnel')?.tracking?.query).toBe('funnel, White plastic, on the fender');
    expect(registry.spec('rag')?.tracking?.query).toBe('rag');
    const added = result(
      await tool('add_step', {
        text: 'Put the funnel in the neck.',
        done_when: 'the funnel sits in the neck',
        objects: ['funnel', 'tank'],
      }),
    );
    expect(lesson.procedure?.steps.find((s) => s.id === added.step_id)?.show).toEqual([
      {
        object: 'funnel',
        phrase: 'funnel',
        description: 'funnel, White plastic, on the fender',
      },
      { object: 'tank', phrase: 'reservoir', description: 'reservoir' },
    ]);
  });
});
