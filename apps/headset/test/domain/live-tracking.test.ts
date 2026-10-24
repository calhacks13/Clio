import { type Procedure, parseProcedure, type Step } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import type { AppEvents, HighlightStyle } from '../../src/domain/events';
import { LiveTracking, MAX_LIVE_OBJECTS } from '../../src/domain/session/live-tracking';
import { Spotlight } from '../../src/domain/session/spotlight';
import type { Grounder } from '../../src/domain/world/grounding';
import { ObjectRegistry } from '../../src/domain/world/object-registry';

const lesson = (id: string, steps: unknown[], extra: unknown[] = []) =>
  parseProcedure({
    schema: 'clio.procedure/1',
    id,
    version: 1,
    title: 'Refill',
    summary: 'S',
    workspace: { size: [1, 1] },
    objects: [
      { id: 'cap', label: 'washer cap', placement: { method: 'detect' } },
      {
        id: 'jug',
        label: 'fluid jug',
        placement: { method: 'detect' },
        tracking: { query: 'blue jug with a white label', moves: true },
      },
      { id: 'rag', label: 'rag', placement: { method: 'detect' } },
      ...extra,
    ],
    steps,
  });

const procedure = lesson('washer', [
  {
    id: 'open',
    instruction: 'Open the cap.',
    targets: ['cap'],
    show: [{ object: 'cap', phrase: 'blue washer cap', description: 'Round blue cap, front left' }],
    success: { type: 'confirm' },
  },
  {
    id: 'pour',
    instruction: 'Pour.',
    targets: ['jug', 'cap'],
    show: [
      { object: 'jug', phrase: 'fluid jug', description: 'Blue jug in your hand' },
      { object: 'cap', phrase: 'open reservoir', description: 'The open reservoir neck' },
    ],
    success: { type: 'confirm' },
  },
  { id: 'done', instruction: 'Say done.', success: { type: 'confirm' } },
]);
const [OPEN, POUR, DONE] = procedure.steps as [Step, Step, Step];

function setup(plan: Procedure = procedure) {
  const bus = new Emitter<AppEvents>();
  const registry = new ObjectRegistry(bus);
  registry.load(plan.objects, 0);
  let current: Procedure | null = plan;
  const tracking = new LiveTracking({ bus, registry, procedure: () => current });
  tracking.attach();
  const events: string[] = [];
  bus.onAny((type) => events.push(String(type)));
  const start = (t = 0) =>
    bus.emit('procedure.started', {
      t,
      procedureId: plan.id,
      version: plan.version,
      stepCount: plan.steps.length,
    });
  const enter = (step: Step, t = 0) =>
    bus.emit('step.entered', {
      t,
      stepId: step.id,
      index: (current ?? plan).steps.indexOf(step),
      instruction: step.instruction,
      targets: step.targets,
    });
  const highlight = (
    objectId: string,
    style: HighlightStyle,
    t = 1000,
    source: 'coach' | 'auto' = 'coach',
  ) => bus.emit('overlay.highlight', { t, objectId, style, source });
  const replan = (next: Procedure) => {
    current = next;
  };
  return { bus, registry, tracking, events, start, enter, highlight, replan };
}

const ids = (tracking: LiveTracking) => tracking.objects.map((o) => o.id);

describe('LiveTracking', () => {
  it("follows the focused step's show items in rank order, in their words", () => {
    const { tracking, start, enter } = setup();
    expect(tracking.objects).toEqual([]);
    start();
    enter(OPEN);
    expect(tracking.objects).toEqual([
      {
        id: 'cap',
        phrase: 'blue washer cap',
        query: 'Round blue cap, front left',
        rank: 0,
        style: null,
      },
    ]);
    enter(POUR);
    expect(tracking.objects.map(({ id, rank }) => [id, rank])).toEqual([
      ['jug', 0],
      ['cap', 1],
    ]);
    // A step that shows nothing follows nothing, so no frames or jev calls go out.
    enter(DONE);
    expect(tracking.objects).toEqual([]);
  });

  it('keeps the first phrase it gave an object for the whole lesson, the words follow the step', () => {
    const { tracking, start, enter } = setup();
    start();
    enter(OPEN);
    enter(POUR);
    // The tracker starts a track over when the phrase changes; the query only adds context.
    expect(tracking.get('cap')).toMatchObject({
      phrase: 'blue washer cap',
      query: 'The open reservoir neck',
    });
    expect(tracking.get('jug')?.phrase).toBe('fluid jug');
    // A new lesson starts afresh.
    start();
    enter(POUR);
    expect(tracking.get('cap')?.phrase).toBe('open reservoir');
  });

  it('adds what the coach highlights for 5 s, with its style; the closer look is a coach highlight', () => {
    const { tracking, start, enter, highlight } = setup();
    start();
    enter(OPEN);
    highlight('jug', 'attention', 1000);
    highlight('rag', 'warning', 1200);
    expect(tracking.objects.slice(1)).toEqual([
      // The plan's first show phrase for it, and its own appearance as the words.
      {
        id: 'jug',
        phrase: 'fluid jug',
        query: 'blue jug with a white label',
        rank: null,
        style: 'attention',
      },
      { id: 'rag', phrase: 'rag', query: 'rag', rank: null, style: 'warning' },
    ]);
    tracking.update(5999);
    expect(ids(tracking)).toEqual(['cap', 'jug', 'rag']);
    tracking.update(6000);
    expect(ids(tracking)).toEqual(['cap', 'rag']);
    tracking.update(6200);
    expect(ids(tracking)).toEqual(['cap']);
  });

  it('styles a shown object it highlights without following it twice', () => {
    const { tracking, start, enter, highlight } = setup();
    start();
    enter(OPEN);
    highlight('cap', 'target', 1000);
    expect(tracking.objects).toEqual([expect.objectContaining({ id: 'cap', style: 'target' })]);
    tracking.update(6000);
    expect(tracking.objects).toEqual([expect.objectContaining({ id: 'cap', style: null })]);
  });

  it('ignores step highlights and unknown objects', () => {
    const { tracking, start, enter, highlight } = setup();
    start();
    enter(OPEN);
    highlight('jug', 'target', 1000, 'auto');
    highlight('kettle', 'target', 1000);
    expect(ids(tracking)).toEqual(['cap']);
  });

  it('drops a highlight when the focus moves, as the overlay does', () => {
    const { tracking, start, enter, highlight } = setup();
    start();
    enter(OPEN);
    highlight('rag', 'attention', 1000);
    enter(POUR);
    expect(ids(tracking)).toEqual(['jug', 'cap']);
  });

  it('follows a revised focused step from the plan as it is now', () => {
    const { tracking, start, enter, replan } = setup();
    start();
    enter(OPEN);
    const revised = lesson('washer', [
      {
        ...OPEN,
        show: [
          { object: 'rag', phrase: 'blue rag', description: 'Folded blue rag on the right' },
          { object: 'cap', phrase: 'cap', description: 'The cap, now loose' },
        ],
      },
      POUR,
    ]);
    replan(revised);
    enter(revised.steps[0] as Step);
    expect(tracking.objects.map(({ id, phrase, query }) => [id, phrase, query])).toEqual([
      ['rag', 'blue rag', 'Folded blue rag on the right'],
      ['cap', 'blue washer cap', 'The cap, now loose'],
    ]);
  });

  it('follows a highlighted object in the words a refined plan gives it, keeping its phrase', () => {
    const { bus, registry, tracking, start, enter, highlight, replan } = setup();
    start();
    enter(OPEN);
    highlight('jug', 'attention', 1000);
    expect(tracking.get('jug')).toMatchObject({
      phrase: 'fluid jug',
      query: 'blue jug with a white label',
    });
    // Stage rest writes the jug again, and words the step that shows it differently.
    const refined = lesson('washer', [
      OPEN,
      {
        ...POUR,
        show: [{ object: 'jug', phrase: 'washer fluid bottle', description: 'The bottle' }],
      },
    ]);
    const jug = refined.objects.find((o) => o.id === 'jug');
    if (!jug) throw new Error('fixture');
    const written = { ...jug, tracking: { query: 'tall blue jug, cap on top', moves: true } };
    registry.update(written, 1100);
    replan({ ...refined, objects: refined.objects.map((o) => (o.id === 'jug' ? written : o)) });
    bus.emit('plan.ready', {
      t: 1100,
      planId: 'washer-r1',
      procedure: refined,
      warnings: [],
      revision: true,
      stage: 'rest',
    });
    // The tracker keeps its track: same phrase, new query.
    expect(tracking.get('jug')).toMatchObject({
      phrase: 'fluid jug',
      query: 'tall blue jug, cap on top',
    });
  });

  it('follows nothing once the lesson ends', () => {
    const completed = setup();
    completed.start();
    completed.enter(OPEN);
    completed.highlight('rag', 'attention');
    completed.bus.emit('procedure.completed', { t: 2000, durationMs: 2000 });
    expect(completed.tracking.objects).toEqual([]);

    const aborted = setup();
    aborted.start();
    aborted.enter(OPEN);
    aborted.bus.emit('procedure.aborted', { t: 2000, reason: 'session ended' });
    expect(aborted.tracking.objects).toEqual([]);
  });

  it(`follows at most ${MAX_LIVE_OBJECTS} objects`, () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `part-${i}`,
      label: `part ${i}`,
      placement: { method: 'detect' },
    }));
    const plan = lesson(
      'parts',
      [
        {
          id: 'sort',
          instruction: 'Sort them.',
          show: many
            .slice(0, 4)
            .map((o) => ({ object: o.id, phrase: o.label, description: o.label })),
          success: { type: 'confirm' },
        },
      ],
      many,
    );
    const { tracking, start, enter, highlight } = setup(plan);
    start();
    enter(plan.steps[0] as Step);
    for (const o of many.slice(4)) highlight(o.id, 'attention');
    expect(tracking.objects).toHaveLength(MAX_LIVE_OBJECTS);
    expect(tracking.objects[0]?.id).toBe('part-0');
  });

  it('says nothing on the bus: what the tracker follows never reaches the coach', () => {
    const { tracking, events, start, enter, highlight } = setup();
    start();
    enter(OPEN);
    highlight('jug', 'attention');
    const before = events.length;
    tracking.update(10_000);
    expect(tracking.objects.length).toBe(1);
    expect(events.length).toBe(before);
  });
});

describe('Spotlight while live tracking follows the show items', () => {
  it('stops looking at them again, and starts again once the tracker is gone', async () => {
    const bus = new Emitter<AppEvents>();
    const clock = new ManualClock(1000);
    const registry = new ObjectRegistry(bus);
    registry.load(procedure.objects, 0);
    const asked: string[][] = [];
    const grounder: Grounder = {
      ground: async (requests) => {
        asked.push(requests.map((r) => r.id));
        return {
          ok: true,
          located: [],
          missing: requests.map((r) => r.id),
          sightings: [],
          source: 'test',
          frameT: clock.now(),
        };
      },
    };
    let live = true;
    const spotlight = new Spotlight({
      bus,
      clock,
      registry,
      grounder,
      live: () => live,
      options: { refreshMs: 3000 },
    });
    // The step's own look still goes out: it places the targets that are missing.
    await spotlight.enterStep(POUR);
    expect(asked).toEqual([['jug', 'cap']]);
    expect(spotlight.tick(clock.advance(60_000))).toBeNull();
    live = false;
    const look = spotlight.tick(clock.now());
    expect(look).not.toBeNull();
    await look;
    expect(asked).toHaveLength(2);
  });
});
