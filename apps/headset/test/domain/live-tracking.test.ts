import { type Procedure, parseProcedure, type Step } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import type { AppEvents, HighlightStyle } from '../../src/domain/events';
import { ACCENTS, HINT_OPACITY } from '../../src/domain/overlay/accents';
import { isShown, LiveTracking, MAX_LIVE_OBJECTS } from '../../src/domain/session/live-tracking';
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
/** The followed objects whose light is on: the step's show items and the coach's highlights. */
const shown = (tracking: LiveTracking) => tracking.objects.filter(isShown).map((o) => o.id);

describe('LiveTracking', () => {
  it('resolves explicit roles and part inheritance in show order, independent of detector order', () => {
    const plan = lesson(
      'roles',
      [
        {
          id: 'roles',
          instruction: 'Pour to the line.',
          success: { type: 'confirm' },
          show: [
            { object: 'jug', phrase: 'jug', description: 'jug', role: 'destination' },
            { object: 'rag', phrase: 'rim', description: 'rim', role: 'part' },
            { object: 'cap', phrase: 'tool', description: 'tool', role: 'act' },
            { object: 'line', phrase: 'line', description: 'line', role: 'level' },
          ],
        },
      ],
      [{ id: 'line', label: 'line', kind: 'region', placement: { method: 'detect' } }],
    );
    const { tracking, start, enter, highlight } = setup(plan);
    start();
    enter(plan.steps[0] as Step);
    const accents = () => tracking.objects.map(({ id, accent }) => [id, accent]);
    expect(accents()).toEqual([
      ['jug', { color: ACCENTS.destination, opacity: 1 }],
      ['rag', { color: ACCENTS.destination, opacity: 1 }],
      ['cap', { color: ACCENTS.act, opacity: 1 }],
      ['line', { color: ACCENTS.level, opacity: 1 }],
    ]);
    highlight('jug', 'target');
    expect(tracking.get('jug')?.accent.color).toBe(ACCENTS.destination);
    highlight('rag', 'attention');
    expect(tracking.get('rag')?.accent).toEqual({ color: ACCENTS.hint, opacity: HINT_OPACITY });
    tracking.update(6000);
    expect(tracking.get('rag')?.accent.color).toBe(ACCENTS.destination);
  });

  it("follows every declared object for the whole lesson, the step's show items first in their words", () => {
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
        accent: { color: ACCENTS.act, opacity: 1 },
      },
      // The plan's other objects, in its order: the phrase a step will show them by, else the
      // label, and their own appearance as the words. Followed and recorded, never lit.
      {
        id: 'jug',
        phrase: 'fluid jug',
        query: 'blue jug with a white label',
        rank: null,
        style: null,
        accent: { color: ACCENTS.act, opacity: 1 },
      },
      {
        id: 'rag',
        phrase: 'rag',
        query: 'rag',
        rank: null,
        style: null,
        accent: { color: ACCENTS.act, opacity: 1 },
      },
    ]);
    enter(POUR);
    expect(tracking.objects.map(({ id, rank }) => [id, rank])).toEqual([
      ['jug', 0],
      ['cap', 1],
      ['rag', null],
    ]);
    // A step with nothing to do lights nothing, but the recording covers the whole lesson.
    enter(DONE);
    expect(tracking.objects.map(({ id, rank }) => [id, rank])).toEqual([
      ['cap', null],
      ['jug', null],
      ['rag', null],
    ]);
    expect(tracking.objects.filter(isShown)).toEqual([]);
  });

  it('follows them from the moment the lesson starts, before its first step', () => {
    const { tracking, start } = setup();
    start();
    expect(ids(tracking)).toEqual(['cap', 'jug', 'rag']);
    expect(tracking.objects.filter(isShown)).toEqual([]);
  });

  it('leaves out what the camera cannot find: hidden zones and points', () => {
    const plan = lesson(
      'washer',
      [OPEN],
      [
        {
          id: 'zone',
          label: 'spill zone',
          kind: 'region',
          hidden: true,
          placement: { method: 'layout', position: [0.2, 0, -0.1] },
        },
        {
          id: 'spot',
          label: 'the spot',
          kind: 'point',
          placement: { method: 'layout', position: [0.1, 0, -0.1] },
        },
      ],
    );
    const { tracking, start, enter } = setup(plan);
    start();
    enter(plan.steps[0] as Step);
    expect(ids(tracking)).toEqual(['cap', 'jug', 'rag']);
  });

  it('follows the whole object a part belongs to along with the part, lighting only the part', () => {
    const plan = lesson(
      'measure',
      [
        {
          id: 'read',
          instruction: 'Read the scale.',
          targets: ['scale'],
          show: [
            {
              object: 'scale',
              phrase: 'vernier scale',
              description: 'The engraved scale on the sliding jaw',
            },
          ],
          success: { type: 'confirm' },
        },
      ],
      [
        {
          id: 'caliper',
          label: 'caliper',
          kind: 'tool',
          placement: { method: 'detect' },
          tracking: { query: 'A silver vernier caliper lying open on the mat' },
        },
        {
          id: 'scale',
          label: 'vernier scale',
          partOf: 'caliper',
          placement: { method: 'detect' },
          tracking: { query: 'The engraved vernier scale on the sliding jaw of the caliper' },
        },
      ],
    );
    const { tracking, start, enter } = setup(plan);
    start();
    enter(plan.steps[0] as Step);
    expect(ids(tracking)).toEqual(['scale', 'cap', 'jug', 'rag', 'caliper']);
    expect(tracking.objects.filter(isShown).map((o) => o.id)).toEqual(['scale']);
    expect(tracking.get('caliper')).toEqual({
      id: 'caliper',
      phrase: 'caliper',
      query: 'A silver vernier caliper lying open on the mat',
      rank: null,
      style: null,
      accent: { color: ACCENTS.act, opacity: 1 },
    });
  });

  it('keeps the first phrase it gave an object for the whole lesson, the words follow the step', () => {
    const { tracking, start, enter, replan } = setup();
    start();
    enter(OPEN);
    enter(POUR);
    // The tracker starts a track over when the phrase changes; the query only adds context.
    expect(tracking.get('cap')).toMatchObject({
      phrase: 'blue washer cap',
      query: 'The open reservoir neck',
    });
    expect(tracking.get('jug')?.phrase).toBe('fluid jug');
    // A new lesson starts afresh: the phrase is the first one its plan shows the object by.
    replan(lesson('washer-2', [POUR, DONE]));
    start();
    expect(tracking.get('cap')?.phrase).toBe('open reservoir');
  });

  it('keeps coach hints for 5 s and warning pulses for 600 ms while following every object', () => {
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
        accent: { color: ACCENTS.hint, opacity: HINT_OPACITY },
      },
      {
        id: 'rag',
        phrase: 'rag',
        query: 'rag',
        rank: null,
        style: 'warning',
        accent: { color: ACCENTS.stop, opacity: 1 },
      },
    ]);
    tracking.update(1799);
    expect(shown(tracking)).toEqual(['cap', 'jug', 'rag']);
    tracking.update(1800);
    expect(shown(tracking)).toEqual(['cap', 'jug']);
    expect(ids(tracking)).toEqual(['cap', 'jug', 'rag']);
    tracking.update(5999);
    expect(shown(tracking)).toEqual(['cap', 'jug']);
    tracking.update(6000);
    expect(ids(tracking)).toEqual(['cap', 'jug', 'rag']);
    expect(shown(tracking)).toEqual(['cap']);
  });

  it('styles a shown object it highlights without following it twice', () => {
    const { tracking, start, enter, highlight } = setup();
    start();
    enter(OPEN);
    highlight('cap', 'attention', 1000);
    expect(ids(tracking)).toEqual(['cap', 'jug', 'rag']);
    expect(tracking.objects.filter(isShown)).toEqual([
      expect.objectContaining({ id: 'cap', style: 'attention' }),
    ]);
    tracking.update(6000);
    expect(tracking.objects.filter(isShown)).toEqual([
      expect.objectContaining({ id: 'cap', style: null }),
    ]);
  });

  it("keeps the coach's target lit for the step, until another target replaces it", () => {
    const { tracking, start, enter, highlight } = setup();
    start();
    enter(OPEN);
    highlight('jug', 'target', 1000);
    tracking.update(600_000);
    expect(tracking.get('jug')).toMatchObject({ style: 'target', rank: null });
    expect(shown(tracking)).toEqual(['cap', 'jug']);
    // One next thing to touch: the new target takes over, a hint beside it does not.
    highlight('rag', 'attention', 2000);
    highlight('cap', 'target', 2000);
    expect(tracking.objects.map(({ id, style }) => [id, style])).toEqual([
      ['cap', 'target'],
      ['rag', 'attention'],
      ['jug', null],
    ]);
    enter(POUR);
    expect(tracking.objects.filter((o) => o.style !== null)).toEqual([]);
  });

  it("lights a step's targets, then its action's objects, when it shows nothing", () => {
    const plan = lesson(
      'wipe',
      [
        {
          id: 'top-up',
          instruction: 'Top up the reservoir.',
          targets: ['cap', 'rag'],
          action: { verb: 'pour', object: 'jug', target: 'cap' },
          success: { type: 'confirm' },
        },
        {
          id: 'press',
          instruction: 'Press the point.',
          targets: ['dot'],
          success: { type: 'confirm' },
        },
      ],
      [
        {
          id: 'dot',
          label: 'the dot',
          kind: 'point',
          placement: { method: 'layout', position: [0.1, 0, -0.1] },
        },
      ],
    );
    const { tracking, start, enter } = setup(plan);
    start();
    enter(plan.steps[0] as Step);
    // In the plan's words for each, lit in order: where the jug pours is the destination, the
    // jug is what to act on, and anything else takes its place's role.
    expect(tracking.objects).toEqual([
      {
        id: 'cap',
        phrase: 'washer cap',
        query: 'washer cap',
        rank: 0,
        style: null,
        accent: { color: ACCENTS.destination, opacity: 1 },
      },
      {
        id: 'rag',
        phrase: 'rag',
        query: 'rag',
        rank: 1,
        style: null,
        accent: { color: ACCENTS.destination, opacity: 1 },
      },
      {
        id: 'jug',
        phrase: 'fluid jug',
        query: 'blue jug with a white label',
        rank: 2,
        style: null,
        accent: { color: ACCENTS.act, opacity: 1 },
      },
    ]);
    // A point has no look for the camera to find: nothing to light live.
    enter(plan.steps[1] as Step);
    expect(shown(tracking)).toEqual([]);
  });

  it("lights the action focus's item for the rest of the step, until it names another", () => {
    const { bus, tracking, start, enter } = setup();
    const answer = (stepId: string, actionId: string | null) =>
      bus.emit('focus.answered', {
        t: 2000,
        frameT: 1900,
        stepId,
        detections: [],
        action: null,
        actionId,
        model: 'er',
        latencyMs: 100,
      });
    start();
    enter(OPEN);
    answer('open', 'rag');
    expect(tracking.objects.map(({ id, rank, accent }) => [id, rank, accent.color])).toEqual([
      ['cap', 0, ACCENTS.act],
      ['rag', 1, ACCENTS.act],
      ['jug', null, ACCENTS.act],
    ]);
    tracking.update(600_000);
    expect(shown(tracking)).toEqual(['cap', 'rag']);
    // Nothing to touch this time, an answer about another step, an object it never declared:
    // the item stays.
    answer('open', null);
    answer('pour', 'jug');
    answer('open', 'kettle');
    expect(shown(tracking)).toEqual(['cap', 'rag']);
    answer('open', 'jug');
    expect(shown(tracking)).toEqual(['cap', 'jug']);
    // Already shown: lit as the step shows it.
    answer('open', 'cap');
    expect(shown(tracking)).toEqual(['cap']);
    enter(POUR);
    answer('open', 'rag');
    expect(shown(tracking)).toEqual(['jug', 'cap']);
  });

  it("follows an object in the action focus's words until the plan words it again", () => {
    const { bus, registry, tracking, start, enter, replan } = setup();
    start();
    enter(OPEN);
    tracking.refine('jug', '  Tall blue jug with a white label, right of the cap ');
    tracking.refine('cap', 'Round blue cap at the front left of the engine bay');
    tracking.refine('kettle', 'A kettle');
    expect(tracking.objects.map(({ id, phrase, query }) => [id, phrase, query])).toEqual([
      ['cap', 'blue washer cap', 'Round blue cap at the front left of the engine bay'],
      ['jug', 'fluid jug', 'Tall blue jug with a white label, right of the cap'],
      ['rag', 'rag', 'rag'],
    ]);
    // A new step shows the cap in its own words; the jug's words stay ER's while the plan's
    // for it are still the ones they stood in for.
    enter(DONE);
    expect(tracking.get('cap')?.query).toBe('washer cap');
    expect(tracking.get('jug')?.query).toBe('Tall blue jug with a white label, right of the cap');
    // A revision words the jug again: the plan's words win.
    const jug = procedure.objects.find((o) => o.id === 'jug');
    if (!jug) throw new Error('fixture');
    const written = { ...jug, tracking: { query: 'tall blue jug, cap on top', moves: true } };
    registry.update(written, 1100);
    replan({ ...procedure, objects: procedure.objects.map((o) => (o.id === 'jug' ? written : o)) });
    bus.emit('plan.changed', { t: 1100, rev: 2, op: 'revise', stepId: null });
    expect(tracking.get('jug')).toMatchObject({
      phrase: 'fluid jug',
      query: 'tall blue jug, cap on top',
    });
    // A lesson that ends takes its words with it.
    tracking.refine('rag', 'Folded red rag');
    bus.emit('procedure.aborted', { t: 2000, reason: 'new lesson' });
    tracking.refine('rag', 'Folded red rag again');
    start();
    expect(tracking.get('rag')?.query).toBe('rag');
  });

  it("keeps ER's words for a show item through later rebuilds, until the step words it again", () => {
    const { bus, tracking, start, enter, highlight } = setup();
    start();
    enter(OPEN);
    const words = 'Round blue cap at the front left of the engine bay';
    tracking.refine('cap', words);
    // Every rebuild offers the cap again in its finder's words, after its show item.
    bus.emit('focus.answered', {
      t: 2000,
      frameT: 1900,
      stepId: 'open',
      detections: [],
      action: null,
      actionId: 'rag',
      model: 'er',
      latencyMs: 100,
    });
    expect(tracking.get('cap')?.query).toBe(words);
    highlight('cap', 'attention', 2100);
    expect(tracking.get('cap')?.query).toBe(words);
    bus.emit('plan.changed', { t: 2200, rev: 1, op: 'edit', stepId: 'open' });
    tracking.update(10_000);
    expect(tracking.get('cap')?.query).toBe(words);
    // The next step shows the cap in new words: the plan's win, and stay after a rebuild.
    enter(POUR);
    expect(tracking.get('cap')?.query).toBe('The open reservoir neck');
    bus.emit('plan.changed', { t: 2300, rev: 2, op: 'edit', stepId: 'pour' });
    expect(tracking.get('cap')?.query).toBe('The open reservoir neck');
  });

  it('follows an object added to the plan at once', () => {
    const { bus, registry, tracking, start, enter, replan } = setup();
    start();
    enter(OPEN);
    const funnel = {
      id: 'funnel',
      label: 'funnel',
      kind: 'item' as const,
      radius: 0.03,
      hidden: false,
      placement: { method: 'detect' as const },
      tracking: { query: 'small white funnel on the fender', moves: true },
    };
    registry.add(funnel, 1000);
    replan({ ...procedure, objects: [...procedure.objects, funnel] });
    bus.emit('plan.changed', { t: 1000, rev: 1, op: 'material', stepId: null });
    expect(ids(tracking)).toEqual(['cap', 'jug', 'rag', 'funnel']);
    expect(tracking.get('funnel')).toMatchObject({
      phrase: 'funnel',
      query: 'small white funnel on the fender',
      rank: null,
    });
  });

  it('ignores step highlights and unknown objects', () => {
    const { tracking, start, enter, highlight } = setup();
    start();
    enter(OPEN);
    highlight('jug', 'target', 1000, 'auto');
    highlight('kettle', 'target', 1000);
    expect(shown(tracking)).toEqual(['cap']);
    expect(ids(tracking)).toEqual(['cap', 'jug', 'rag']);
  });

  it('drops a highlight when the focus moves, as the overlay does', () => {
    const { tracking, start, enter, highlight } = setup();
    start();
    enter(OPEN);
    highlight('rag', 'attention', 1000);
    enter(POUR);
    expect(ids(tracking)).toEqual(['jug', 'cap', 'rag']);
    expect(shown(tracking)).toEqual(['jug', 'cap']);
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
    // The rag was followed by its label from the start, so that stays its phrase: the track goes
    // on, and the revised step's words become its query.
    expect(tracking.objects.map(({ id, phrase, query }) => [id, phrase, query])).toEqual([
      ['rag', 'rag', 'Folded blue rag on the right'],
      ['cap', 'blue washer cap', 'The cap, now loose'],
      ['jug', 'fluid jug', 'blue jug with a white label'],
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
    // The show items, then the plan's other objects in its order, as far as there is room.
    const shownIds = many.slice(0, 4).map((o) => o.id);
    expect(ids(tracking)).toEqual([...shownIds, 'cap', 'jug', 'rag', 'part-4']);
    // A highlight takes a slot before the merely followed.
    highlight('part-9', 'attention');
    expect(ids(tracking)).toEqual([...shownIds, 'part-9', 'cap', 'jug', 'rag']);
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
    expect(tracking.objects.length).toBe(3);
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
