import {
  type FocusAction,
  type FocusDetection,
  type FocusRequest,
  type FocusResponse,
  type ObjectSpec,
  type Procedure,
  parseProcedure,
  type Step,
} from '@clio/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import type { Narration } from '../../src/domain/coach/agent';
import { Narrator } from '../../src/domain/coach/narrator';
import { DemoLibrary } from '../../src/domain/demo/demo-library';
import type { AppEvents } from '../../src/domain/events';
import { ACCENTS } from '../../src/domain/overlay/accents';
import { OverlayModel } from '../../src/domain/overlay/overlay-model';
import type { PlanView } from '../../src/domain/plan/recital';
import { EpisodeRecorder } from '../../src/domain/recording/recorder';
import { MemoryEpisodeSink } from '../../src/domain/recording/sink';
import {
  ActionFocus,
  type ActionFocusOptions,
  type FocusAnchor,
  type FocusFinder,
} from '../../src/domain/session/action-focus';
import { type DeclaredObject, LessonController } from '../../src/domain/session/lesson-controller';
import { isShown, LiveTracking } from '../../src/domain/session/live-tracking';
import { ObjectRegistry } from '../../src/domain/world/object-registry';
import { Workspace } from '../../src/domain/world/workspace';

// The action focus: when Robotics-ER 2 looks, what it is told, and where its answer goes (the
// tracker's anchors, jev's words, the lit action item), never to the coach.

const plan = parseProcedure({
  schema: 'clio.procedure/1',
  id: 'washer',
  version: 1,
  origin: {
    kind: 'generated',
    goal: 'top up the washer fluid',
    model: 'planner',
    createdAt: '2026-10-24T04:00:00.000Z',
  },
  title: 'Top up the washer fluid',
  summary: 'S',
  workspace: { size: [1, 1] },
  objects: [
    {
      id: 'cap',
      label: 'washer cap',
      placement: { method: 'detect' },
      tracking: { query: 'blue cap', moves: false },
    },
    {
      id: 'jug',
      label: 'fluid jug',
      placement: { method: 'detect' },
      tracking: { query: 'blue jug with a white label', moves: true },
    },
    { id: 'rag', label: 'rag', placement: { method: 'detect' } },
  ],
  steps: [
    {
      id: 'open',
      instruction: 'Open the washer cap.',
      doneWhen: 'the blue cap is off',
      targets: ['cap'],
      show: [{ object: 'cap', phrase: 'blue washer cap', description: 'Round blue cap, front' }],
      success: { type: 'confirm' },
    },
    {
      id: 'pour',
      instruction: 'Pour the fluid in.',
      targets: ['jug', 'cap'],
      success: { type: 'confirm' },
    },
  ],
});
const [OPEN, POUR] = plan.steps as [Step, Step];

/** One look the test answers when it likes. */
interface Look {
  request: FocusRequest;
  answer: (response: Partial<FocusResponse>) => Promise<void>;
  fail: (error: Error) => Promise<void>;
}

const found = (id: string, extra: Partial<FocusDetection> = {}): FocusDetection => ({
  id,
  found: true,
  box: [0.1, 0.2, 0.3, 0.4],
  point: [0.2, 0.3],
  confidence: 0.9,
  description: `${id} as ER sees it`,
  ...extra,
});

const action = (extra: Partial<FocusAction> = {}): FocusAction => ({
  id: null,
  label: 'red reset button',
  phrase: 'red reset button',
  description: 'Small round red button on the left of the dashboard',
  found: true,
  box: [0.5, 0.5, 0.6, 0.6],
  point: [0.55, 0.55],
  confidence: 0.8,
  ...extra,
});

function setup(o: { options?: ActionFocusOptions; enabled?: () => boolean } = {}) {
  const bus = new Emitter<AppEvents>();
  const clock = new ManualClock(1000);
  const registry = new ObjectRegistry(bus);
  registry.load(plan.objects, 0);
  let current: Procedure = plan;
  const tracking = new LiveTracking({ bus, registry, procedure: () => current });
  tracking.attach();
  const refined = vi.spyOn(tracking, 'refine');
  const view = {
    procedure: () => current,
    label: (id: string) => registry.spec(id)?.label ?? id,
    plan: (): PlanView => ({
      goal: 'top up the washer fluid',
      title: current.title,
      rev: 0,
      steps: [],
      focusId: null,
      materials: [],
    }),
  };
  // Declares the way the lesson does: a new object joins the plan and the registry.
  const declareObject = vi.fn(({ label, look }: DeclaredObject): string | null => {
    const spec: ObjectSpec = {
      id: label.replace(/\W+/g, '-'),
      label,
      kind: 'item',
      radius: 0.03,
      hidden: false,
      placement: { method: 'detect' },
      tracking: { query: look, moves: true },
    };
    current = { ...current, objects: [...current.objects, spec] };
    registry.add(spec, clock.now());
    bus.emit('plan.changed', { t: clock.now(), rev: 1, op: 'material', stepId: null });
    return spec.id;
  });
  const looks: Look[] = [];
  const finder: FocusFinder = {
    focus: (request) =>
      new Promise<FocusResponse>((resolve, reject) => {
        const settle = async (fn: () => void) => {
          fn();
          // Let the look apply its answer before the test goes on.
          await new Promise((r) => setTimeout(r, 0));
        };
        looks.push({
          request,
          answer: (response) =>
            settle(() =>
              resolve({ detections: [], action: null, model: 'er-2', latencyMs: 800, ...response }),
            ),
          fail: (error) => settle(() => reject(error)),
        });
      }),
  };
  let frames = 0;
  const grabbed: number[] = [];
  const anchors: FocusAnchor[] = [];
  const focus = new ActionFocus({
    bus,
    clock,
    finder,
    frames: {
      grab: async () => {
        const t = clock.now() - 30;
        grabbed.push(t);
        frames++;
        return { image: { mimeType: 'image/jpeg', data: `frame-${frames}` }, t };
      },
    },
    anchors: { anchor: (a) => anchors.push(a) },
    tracking,
    view,
    lesson: { declareObject },
    ...(o.enabled ? { enabled: o.enabled } : {}),
    ...(o.options ? { options: o.options } : {}),
  });
  focus.attach();
  const answered: AppEvents['focus.answered'][] = [];
  bus.on('focus.answered', (e) => answered.push(e));
  const annotations: unknown[] = [];
  bus.on('annotation', ({ label, data }) => {
    if (label === 'focus.answered') annotations.push(data);
  });
  const start = () =>
    bus.emit('procedure.started', {
      t: clock.now(),
      procedureId: plan.id,
      version: 1,
      stepCount: plan.steps.length,
    });
  const enter = (step: Step) =>
    bus.emit('step.entered', {
      t: clock.now(),
      stepId: step.id,
      index: plan.steps.indexOf(step),
      instruction: step.instruction,
      targets: step.targets,
    });
  /** Runs a tick and lets a look it starts reach the finder; true when it started one. */
  const tick = async (t = clock.now()) => {
    clock.set(t);
    const look = focus.tick(t);
    await new Promise((r) => setTimeout(r, 0));
    return look !== null;
  };
  return {
    bus,
    clock,
    registry,
    tracking,
    refined,
    declareObject,
    looks,
    grabbed,
    anchors,
    answered,
    annotations,
    start,
    enter,
    tick,
  };
}

describe('ActionFocus: when it looks', () => {
  it('looks as a step is entered, then every 5 s from the start of the last look', async () => {
    const { looks, start, enter, tick } = setup();
    expect(await tick()).toBe(false);
    start();
    expect(await tick()).toBe(false);
    enter(OPEN);
    expect(await tick()).toBe(true);
    expect(looks).toHaveLength(1);
    await looks[0]?.answer({});
    expect(await tick(1000 + 4999)).toBe(false);
    expect(await tick(1000 + 5000)).toBe(true);
    expect(looks).toHaveLength(2);
  });

  it('looks once more soon after a coach highlight, not after a step glow', async () => {
    const { bus, looks, start, enter, tick } = setup();
    start();
    enter(OPEN);
    await tick(1000);
    await looks[0]?.answer({});
    bus.emit('overlay.highlight', { t: 1500, objectId: 'jug', style: 'target', source: 'auto' });
    expect(await tick(2100)).toBe(false);
    bus.emit('overlay.highlight', { t: 2000, objectId: 'jug', style: 'target', source: 'coach' });
    expect(await tick(2499)).toBe(false);
    expect(await tick(2500)).toBe(true);
    await looks[1]?.answer({});
    // Then the usual rhythm from that look.
    expect(await tick(7499)).toBe(false);
    expect(await tick(7500)).toBe(true);
  });

  it('never looks twice at once: a look due meanwhile waits for the answer', async () => {
    const { bus, looks, start, enter, tick } = setup();
    start();
    enter(OPEN);
    await tick(1000);
    bus.emit('overlay.highlight', { t: 1100, objectId: 'jug', style: 'target', source: 'coach' });
    expect(await tick(9000)).toBe(false);
    expect(looks).toHaveLength(1);
    await looks[0]?.answer({});
    expect(await tick(9001)).toBe(true);
    expect(looks).toHaveLength(2);
  });

  it('stays idle while it may not look, and pauses after failures in a row', async () => {
    let enabled = false;
    const { looks, annotations, start, enter, tick } = setup({
      enabled: () => enabled,
      options: { maxFailures: 2, pauseMs: 30_000 },
    });
    start();
    enter(OPEN);
    expect(await tick(1000)).toBe(false);
    enabled = true;
    await tick(1001);
    await looks[0]?.fail(new Error('503 no Gemini key'));
    await tick(6001);
    await looks[1]?.fail(new Error('503 no Gemini key'));
    expect(await tick(11_001)).toBe(false);
    expect(await tick(36_000)).toBe(false);
    expect(await tick(36_001)).toBe(true);
    expect(annotations).toEqual([
      { stepId: 'open', error: '503 no Gemini key' },
      { stepId: 'open', error: '503 no Gemini key' },
    ]);
  });
});

describe('ActionFocus: what it asks', () => {
  it('sends a frame, the goal, the step and what the tracker follows, lit first', async () => {
    const { bus, looks, start, enter, tick } = setup();
    start();
    enter(OPEN);
    bus.emit('overlay.highlight', {
      t: 1000,
      objectId: 'rag',
      style: 'attention',
      source: 'coach',
    });
    await tick(1000);
    expect(looks[0]?.request).toEqual({
      image: { mimeType: 'image/jpeg', data: 'frame-1' },
      goal: 'top up the washer fluid',
      step: { instruction: 'Open the washer cap.', doneWhen: 'the blue cap is off' },
      objects: [
        {
          id: 'cap',
          label: 'washer cap',
          phrase: 'blue washer cap',
          query: 'Round blue cap, front',
        },
        { id: 'rag', label: 'rag', phrase: 'rag', query: 'rag' },
        {
          id: 'jug',
          label: 'fluid jug',
          phrase: 'fluid jug',
          query: 'blue jug with a white label',
        },
      ],
    });
  });
});

describe('ActionFocus: where the answer goes', () => {
  it("anchors the tracker on ER's sure boxes and tells jev its words for them", async () => {
    const { looks, grabbed, anchors, refined, tracking, answered, start, enter, tick } = setup();
    start();
    enter(OPEN);
    await tick(1000);
    await looks[0]?.answer({
      detections: [
        found('cap'),
        found('jug', { confidence: 0.4 }),
        found('rag', { found: false, box: null, point: null, confidence: 0, description: null }),
        found('kettle'),
      ],
    });
    expect(anchors).toEqual([
      { id: 'cap', box: [0.1, 0.2, 0.3, 0.4], t: grabbed[0], query: 'cap as ER sees it' },
    ]);
    expect(refined.mock.calls).toEqual([['cap', 'cap as ER sees it']]);
    expect(tracking.get('cap')).toMatchObject({
      phrase: 'blue washer cap',
      query: 'cap as ER sees it',
    });
    expect(answered).toEqual([
      expect.objectContaining({
        frameT: grabbed[0],
        stepId: 'open',
        actionId: null,
        model: 'er-2',
      }),
    ]);
  });

  it('drops an answer for a step that is over, or a lesson that ended', async () => {
    const { bus, clock, looks, anchors, answered, annotations, start, enter, tick } = setup();
    start();
    enter(OPEN);
    await tick(1000);
    enter(POUR);
    await looks[0]?.answer({ detections: [found('cap')], action: action({ id: 'cap' }) });
    expect(anchors).toEqual([]);
    expect(answered).toEqual([]);
    // The new step's look starts as soon as the old one is out of the way.
    await tick(1001);
    expect(looks).toHaveLength(2);
    bus.emit('procedure.aborted', { t: clock.now(), reason: 'a new lesson started' });
    await looks[1]?.answer({ detections: [found('jug')] });
    expect(await tick(60_000)).toBe(false);
    // Nor is a failure for a lesson that ended recorded.
    start();
    enter(OPEN);
    await tick(60_001);
    bus.emit('procedure.completed', { t: clock.now(), durationMs: 1 });
    await looks[2]?.fail(new Error('late'));
    expect([anchors, answered, annotations]).toEqual([[], [], []]);
  });

  it("lights the action item for the rest of the step, in ER's box", async () => {
    const { looks, anchors, tracking, answered, start, enter, tick } = setup();
    start();
    enter(OPEN);
    await tick(1000);
    await looks[0]?.answer({ action: action({ id: 'jug', label: 'fluid jug' }) });
    expect(answered[0]?.actionId).toBe('jug');
    expect(anchors.map((a) => a.id)).toEqual(['jug']);
    expect(tracking.objects.filter(isShown).map((o) => [o.id, o.rank, o.accent.color])).toEqual([
      ['cap', 0, ACCENTS.act],
      ['jug', 1, ACCENTS.act],
    ]);
  });

  it('declares an action item the plan lacks once, from words ER saw surely', async () => {
    const { looks, anchors, declareObject, tracking, answered, start, enter, tick } = setup();
    start();
    enter(OPEN);
    // Unsure: never joins the plan.
    await tick(1000);
    await looks[0]?.answer({ action: action({ confidence: 0.3 }) });
    expect(declareObject).not.toHaveBeenCalled();
    expect(answered[0]?.actionId).toBeNull();
    await tick(6000);
    await looks[1]?.answer({ action: action() });
    await tick(11_000);
    await looks[2]?.answer({ action: action({ label: 'Red reset button ', found: false }) });
    expect(declareObject.mock.calls).toEqual([
      [
        {
          label: 'red reset button',
          look: 'Small round red button on the left of the dashboard',
        },
      ],
    ]);
    expect(answered.map((a) => a.actionId)).toEqual([null, 'red-reset-button', 'red-reset-button']);
    expect(anchors).toEqual([
      expect.objectContaining({ id: 'red-reset-button', box: [0.5, 0.5, 0.6, 0.6] }),
    ]);
    // Followed from now on, lit as the thing to touch, and asked about by id next time.
    expect(tracking.get('red-reset-button')).toMatchObject({
      phrase: 'red reset button',
      query: 'Small round red button on the left of the dashboard',
      rank: 1,
    });
    expect(looks[2]?.request.objects.map((o) => o.id)).toContain('red-reset-button');
  });

  it('records every answer, with how old its frame was', async () => {
    const { looks, annotations, start, enter, tick } = setup();
    start();
    enter(OPEN);
    await tick(1000);
    await looks[0]?.answer({ detections: [found('cap')], action: action({ id: 'cap' }) });
    expect(annotations).toEqual([
      {
        stepId: 'open',
        model: 'er-2',
        latencyMs: 800,
        frameAgeMs: 30,
        detections: [found('cap')],
        action: action({ id: 'cap' }),
        actionId: 'cap',
      },
    ]);
  });
});

describe('ActionFocus in a lesson', () => {
  it('adds a new action item to the plan as the app, lights it, and tells the coach nothing', async () => {
    const bus = new Emitter<AppEvents>();
    const clock = new ManualClock(1000);
    const registry = new ObjectRegistry(bus);
    const lesson = new LessonController({
      bus,
      clock,
      planner: { plan: async () => ({ planId: 'washer', procedure: plan, warnings: [] }) },
      registry,
      workspace: () => new Workspace({ p: [0, 0.8, -0.4], q: [0, 0, 0, 1] }),
      grounder: null,
      images: null,
      demos: new DemoLibrary(null),
      recorder: new EpisodeRecorder({
        bus,
        clock,
        sink: new MemoryEpisodeSink(),
        sleep: async () => {},
      }),
      context: () => ({
        operator: { role: 'learner' },
        coach: { kind: 'gemini', model: 'live' },
        device: { userAgent: 'test', emulated: true, xrFeatures: [] },
        app: { version: 'test' },
      }),
    });
    const view = lesson.view();
    const tracking = new LiveTracking({ bus, registry, procedure: () => lesson.procedure });
    tracking.attach();
    const overlay = new OverlayModel(bus, view);
    overlay.attach();
    let answer: (r: FocusResponse) => void = () => {};
    const focus = new ActionFocus({
      bus,
      clock,
      finder: { focus: () => new Promise((resolve) => (answer = resolve)) },
      frames: { grab: async () => ({ image: { mimeType: 'image/jpeg', data: 'AAAA' }, t: 990 }) },
      anchors: { anchor: () => {} },
      tracking,
      view,
      lesson,
    });
    focus.attach();
    await lesson.run(plan);
    // A Gemini coach's narrator, attached once step 1 is briefed: it hears nothing of the focus.
    const told: Narration[] = [];
    new Narrator(bus, view, (n) => told.push(n), { perception: 'trusted' }).attach();
    const updates: unknown[] = [];
    bus.on('annotation', ({ label, data }) => {
      if (label === 'plan.updated') updates.push(data);
    });
    const look = focus.tick(clock.now());
    await new Promise((r) => setTimeout(r, 0));
    answer({ detections: [], action: action(), model: 'er-2', latencyMs: 700 });
    await look;
    expect(lesson.procedure?.objects.at(-1)).toMatchObject({
      id: 'red-reset-button',
      label: 'red reset button',
      tracking: { query: 'Small round red button on the left of the dashboard', moves: true },
    });
    expect(updates).toEqual([
      expect.objectContaining({ op: 'material', by: 'app', materialId: 'red-reset-button' }),
    ]);
    expect(view.plan()?.materials.map((m) => m.id)).toContain('red-reset-button');
    expect(tracking.objects.filter(isShown).map((o) => o.id)).toEqual(['cap', 'red-reset-button']);
    expect(overlay.snapshot(clock.now()).highlights.map((h) => h.objectId)).toEqual([
      'cap',
      'red-reset-button',
    ]);
    expect(told).toEqual([]);
  });
});
