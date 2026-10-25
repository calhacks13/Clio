import { COACH_TOOL_NAMES, type CoachKind, type Procedure, parseProcedure } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ScriptedAgent } from '../../src/adapters/scripted/scripted-agent';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import type { Narration } from '../../src/domain/coach/agent';
import { Narrator, type NarratorOptions } from '../../src/domain/coach/narrator';
import type { LessonView } from '../../src/domain/coach/ports';
import { buildSystemInstruction } from '../../src/domain/coach/prompt';
import { CoachSession } from '../../src/domain/coach/session';
import {
  type AvailableToolHandlers,
  CoachToolbox,
  type ToolHandlers,
} from '../../src/domain/coach/toolbox';
import { type AppEvents, isRecordable, type LessonPhase } from '../../src/domain/events';
import { briefStep, type PlanView, recitePlan } from '../../src/domain/plan/recital';
import type { TemplateSummary } from '../../src/domain/session/templates';
import { FakeAgent } from '../support/fake-agent';

const procedure: Procedure = parseProcedure({
  schema: 'clio.procedure/1',
  id: 'ph',
  version: 1,
  title: 'pH test',
  summary: 'S',
  workspace: { size: [1, 1] },
  objects: [
    { id: 'cup_a', label: 'cup A', placement: { method: 'detect' } },
    { id: 'vinegar', label: 'vinegar bottle', placement: { method: 'detect' } },
  ],
  steps: [
    {
      id: 'acid',
      instruction: 'Add vinegar to cup A.',
      doneWhen: 'cup A has turned pink',
      targets: ['vinegar', 'cup_a'],
      success: { type: 'hand_near', object: 'cup_a' },
      coachNotes: 'Watch for cup B.',
    },
    {
      id: 'look',
      instruction: 'Check the color.',
      targets: ['cup_a'],
      success: { type: 'confirm', prompt: 'cup A is pink' },
    },
  ],
  coach: { persona: 'A patient chemistry teacher.', notes: 'Cup B is the base.' },
});

function planView(over: Partial<PlanView> = {}): PlanView {
  return {
    goal: 'Test an acid with cabbage indicator',
    title: 'pH test',
    rev: 1,
    focusId: 'acid',
    materials: [
      { id: 'cup_a', label: 'cup A' },
      { id: 'vinegar', label: 'vinegar bottle' },
    ],
    steps: [
      {
        id: 'acid',
        instruction: 'Add vinegar to cup A.',
        doneWhen: 'cup A has turned pink',
        status: 'todo',
        uses: ['vinegar bottle', 'cup A'],
        demo: true,
        coachNotes: 'Watch for cup B.',
      },
      { id: 'look', instruction: 'Check the color.', status: 'todo', uses: ['cup A'], demo: false },
    ],
    ...over,
  };
}

function lessonView(
  plan: () => PlanView | null = () => planView(),
  authority?: () => 'coach' | 'local',
): LessonView {
  return {
    procedure: () => procedure,
    label: (id: string) => procedure.objects.find((o) => o.id === id)?.label ?? id,
    plan,
    ...(authority ? { authority } : {}),
  };
}

function handlers(log: string[] = []): ToolHandlers {
  const ok = (name: string) => async (args: unknown) => {
    log.push(`${name} ${JSON.stringify(args)}`);
    return { ok: true as const, result: { done: name } };
  };
  return {
    start_lesson: ok('start_lesson'),
    end_lesson: ok('end_lesson'),
    revise_plan: ok('revise_plan'),
    add_step: ok('add_step'),
    update_step: ok('update_step'),
    complete_step: ok('complete_step'),
    add_material: ok('add_material'),
    highlight: ok('highlight'),
    show_demo: ok('show_demo'),
    flag_mistake: ok('flag_mistake'),
  };
}

type Bus = Emitter<AppEvents>;

function bus() {
  const b: Bus = new Emitter<AppEvents>();
  const seen: { type: string; payload: Record<string, unknown> }[] = [];
  b.onAny((type, payload) =>
    seen.push({ type: String(type), payload: payload as Record<string, unknown> }),
  );
  return { b, seen };
}

const entered = (b: Bus, stepId: string, instruction = 'x', t = 0) =>
  b.emit('step.entered', { t, stepId, index: 0, instruction, targets: [] });

const pinch = (b: Bus, t: number) =>
  b.emit('hand.pinch', {
    t,
    hand: 'right',
    phase: 'start',
    point: [0, 0, 0],
    nearest: { objectId: 'cup_a', distance: 0.02 },
  });

const toolCall = (b: Bus, callId: string, name = 'update_step') =>
  b.emit('coach.tool_call', { t: 0, callId, name, args: {} });
const toolResult = (b: Bus, callId: string, name = 'update_step') =>
  b.emit('coach.tool_result', { t: 0, callId, name, ok: true, result: {} });

/** Arrow, bullet and middle-dot symbols never reach the model. */
const SYMBOLS = /[→←↑↓➜⟶·•]/;

describe('CoachToolbox', () => {
  it('routes valid calls to the handler with defaults applied, and records both ends', async () => {
    const log: string[] = [];
    const { b, seen } = bus();
    const box = new CoachToolbox(handlers(log), b, new ManualClock(10));
    const result = await box.handle({ id: 'c1', name: 'highlight', args: { object_id: 'cup_a' } });
    expect(log).toEqual(['highlight {"object_id":"cup_a","style":"target"}']);
    expect(result).toMatchObject({ id: 'c1', name: 'highlight', ok: true });
    expect(seen.map((e) => e.type)).toEqual(['coach.tool_call', 'coach.tool_result']);
  });

  it('sends validation errors back to the model instead of calling the handler', async () => {
    const log: string[] = [];
    const { b, seen } = bus();
    const box = new CoachToolbox(handlers(log), b, new ManualClock(10));
    const result = await box.handle({ id: 'c2', name: 'complete_step', args: {} });
    expect(log).toEqual([]);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.result)).toMatch(/reason/);
    expect(seen.find((e) => e.type === 'coach.tool_result')?.payload).toMatchObject({ ok: false });
  });

  it('answers a tool this coach lacks (no closer look) with an error', async () => {
    const { b } = bus();
    const box = new CoachToolbox(handlers(), b, new ManualClock(10));
    const result = await box.handle({
      id: 'c3',
      name: 'look_closer',
      args: { question: 'Which?' },
    });
    expect(result).toEqual({
      id: 'c3',
      name: 'look_closer',
      ok: false,
      result: { error: 'look_closer is not available on this headset.' },
    });
  });
});

describe('Narrator', () => {
  function setup(
    options: NarratorOptions = {},
    plan: () => PlanView | null = () => planView(),
    authority?: () => 'coach' | 'local',
  ) {
    const { b, seen } = bus();
    const out: Narration[] = [];
    const narrator = new Narrator(b, lessonView(plan, authority), (n) => out.push(n), {
      pinchThrottleMs: 2000,
      ...options,
    });
    narrator.attach();
    return { b, seen, out };
  }

  it('briefs the coach from the plan when a step takes focus, and asks it to speak', () => {
    const { b, out } = setup();
    entered(b, 'acid', 'Add vinegar to cup A.');
    expect(out).toEqual([
      {
        kind: 'step',
        text: `[app] ${briefStep(planView(), 'acid')} Tell them what to do in under 15 words.`,
        reply: true,
        data: { instruction: 'Add vinegar to cup A.', stepId: 'acid' },
      },
    ]);
    expect(out[0]?.text).toContain('Done when: cup A has turned pink.');
    expect(out[0]?.text).toContain('Watch for cup B.');
  });

  it('falls back to the instruction when there is no plan to brief from', () => {
    const { b, out } = setup({}, () => null);
    entered(b, 'acid', 'Add vinegar to cup A.');
    expect(out[0]).toMatchObject({ kind: 'step', reply: true });
    expect(out[0]?.text).toContain('Add vinegar to cup A.');
  });

  it('folds a completion into the next briefing, saying who completed it', () => {
    const cases = [
      ['coach', 'you completed it'],
      ['user', 'they pressed Done'],
      ['check', 'measured by the app'],
      ['skip', 'skipped'],
    ] as const;
    for (const [by, who] of cases) {
      const { b, out } = setup();
      b.emit('step.completed', { t: 5, stepId: 'acid', index: 0, by, forced: true, durationMs: 5 });
      entered(b, 'look');
      expect(out).toHaveLength(1);
      expect(out[0]?.text.startsWith(`[app] Done: acid (${who}). `)).toBe(true);
      expect(out[0]?.text).not.toMatch(/detected|not verified|advance_step/);
    }
  });

  it('leaves the briefing to the tool result while a tool call runs', () => {
    const { b, out } = setup();
    b.emit('step.completed', {
      t: 1,
      stepId: 'acid',
      index: 0,
      by: 'user',
      forced: false,
      durationMs: 1,
    });
    toolCall(b, 'c1');
    toolCall(b, 'c2');
    entered(b, 'look');
    toolResult(b, 'c1');
    entered(b, 'acid');
    expect(out).toEqual([]);
    toolResult(b, 'c2');
    entered(b, 'look');
    expect(out).toHaveLength(1);
    expect(out[0]?.text).not.toContain('Done:');
  });

  it('still briefs after a Done-button or check completion while a call without a briefing runs', () => {
    for (const name of ['show_demo', 'highlight', 'flag_mistake', 'start_lesson', 'revise_plan']) {
      for (const [by, who] of [
        ['user', 'they pressed Done'],
        ['check', 'measured by the app'],
      ] as const) {
        const { b, out } = setup();
        toolCall(b, 'c1', name);
        b.emit('step.completed', {
          t: 1,
          stepId: 'acid',
          index: 0,
          by,
          forced: false,
          durationMs: 1,
        });
        entered(b, 'look');
        expect(out.map((n) => n.kind)).toEqual(['step']);
        expect(out[0]?.text.startsWith(`[app] Done: acid (${who}). `)).toBe(true);
      }
    }
  });

  it('shares a new plan as context, and asks the coach to explain a revised one', () => {
    const { b, out } = setup();
    const recital = recitePlan(planView());
    b.emit('plan.ready', {
      t: 0,
      planId: 'p1',
      procedure,
      warnings: ['Dropped an unknown object.'],
      revision: false,
    });
    b.emit('plan.ready', { t: 1, planId: 'p1', procedure, warnings: [], revision: true });
    expect(out[0]).toMatchObject({ kind: 'plan', reply: false });
    expect(out[0]?.text.startsWith(`[app] Plan ready. ${recital}`)).toBe(true);
    expect(out[0]?.text).toContain('Caveats: Dropped an unknown object.');
    expect(out[1]).toMatchObject({ kind: 'plan_revised', reply: true });
    expect(out[1]?.text.startsWith(`[app] Plan revised. ${recital}`)).toBe(true);
    expect(
      out[1]?.text.endsWith('\nTell them in one sentence what changed, then what to do now.'),
    ).toBe(true);
    expect(out[1]?.text).not.toContain('Caveats');
  });

  it('says a first-stage plan is partly an outline, and shares its refinement quietly', () => {
    const { b, out } = setup();
    const recital = recitePlan(planView());
    b.emit('plan.ready', {
      t: 0,
      planId: 'p1',
      procedure,
      warnings: [],
      revision: false,
      stage: 'first',
    });
    b.emit('plan.ready', {
      t: 1,
      planId: 'p1-r1',
      procedure,
      warnings: ['Cup B is cracked.'],
      revision: true,
      stage: 'rest',
    });
    expect(out[0]).toMatchObject({ kind: 'plan', reply: false });
    expect(out[0]?.text).toBe(
      `[app] Plan ready. ${recital}\nThe steps after the first are an outline; the full plan follows as "Plan refined".`,
    );
    expect(out[1]).toMatchObject({ kind: 'plan_refined', reply: false });
    expect(out[1]?.text).toBe(
      `[app] Plan refined: the later steps are written in full now. ${recital}\nCaveats: Cup B is cracked.`,
    );
  });

  it('asks a Gemini coach to write the plan itself when planning fails', () => {
    const trusted = setup({ perception: 'trusted' });
    trusted.b.emit('plan.failed', { t: 0, goal: 'g', error: 'timed out', revision: false });
    expect(trusted.out[0]).toMatchObject({
      kind: 'plan_failed',
      reply: true,
      data: { error: 'timed out' },
    });
    expect(trusted.out[0]?.text).toContain(
      '[app] Planning failed (timed out). Write the plan yourself: call add_step once per step, in order, starting with the first thing to do, each with a done_when you will be able to see.',
    );

    const all = setup();
    all.b.emit('plan.failed', { t: 0, goal: 'g', error: 'timed out', revision: false });
    expect(all.out[0]).toMatchObject({ kind: 'plan_failed', reply: true });
    expect(all.out[0]?.text).toContain('Apologize briefly');
    expect(all.out[0]?.text).not.toContain('add_step');
  });

  it('keeps the plan when re-planning fails', () => {
    const { b, out } = setup({ perception: 'trusted' });
    b.emit('plan.failed', { t: 0, goal: 'g', error: 'HTTP 502', revision: true });
    expect(out).toEqual([
      {
        kind: 'revise_failed',
        text: '[app] Re-planning failed (HTTP 502). The plan is unchanged; adjust it with add_step or update_step.',
        reply: true,
        data: { error: 'HTTP 502' },
      },
    ]);
  });

  it('asks the coach to keep the learner company while planning is slow', () => {
    const { b, out } = setup();
    b.emit('plan.slow', { t: 0, goal: 'g', elapsedMs: 12_400 });
    expect(out).toEqual([
      {
        kind: 'plan_slow',
        text: '[app] Planning is taking longer than usual (12 s). Keep them company in one short sentence; the plan will arrive as an [app] message.',
        reply: true,
      },
    ]);
  });

  it('says nothing of a step that looks done: the lesson completes it, and the briefing says so', () => {
    const { b, out } = setup();
    b.emit('step.looks_done', { t: 0, stepId: 'acid', observation: 'cup A is pink', image: null });
    expect(out).toEqual([]);
  });

  it('marks what the app saw as urgent: a step it completed, something done wrong, a hazard', () => {
    const { b, out } = setup();
    const done = (by: 'check' | 'coach') =>
      b.emit('step.completed', {
        t: 0,
        stepId: 'acid',
        index: 0,
        by,
        forced: false,
        durationMs: 1,
      });
    done('check');
    entered(b, 'look', 'Check the color.');
    done('coach');
    entered(b, 'look', 'Check the color.');
    b.emit('step.looks_wrong', { t: 0, stepId: 'acid', wrong: 'w', observation: 'o', image: null });
    b.emit('step.hazard', { t: 0, stepId: 'acid', hazard: 'knife', image: null });
    b.emit('step.stuck', { t: 0, stepId: 'acid', elapsedMs: 15_000 });
    done('check');
    b.emit('procedure.completed', { t: 0, durationMs: 1 });
    expect(out.map((n) => `${n.kind}:${n.urgent === true}`)).toEqual([
      'step:true',
      'step:false',
      'looks_wrong:true',
      'hazard:true',
      'stuck:false',
      'complete:true',
    ]);
    expect(out[0]?.text.startsWith('[app] Done: acid (measured by the app).')).toBe(true);
  });

  it('tells the coach in words when the step watcher sees the learner do something else', () => {
    const { b, out } = setup({ perception: 'trusted' });
    b.emit('step.looks_wrong', {
      t: 0,
      stepId: 'acid',
      wrong: 'poured vinegar into cup B, not cup A',
      observation: 'cup B is turning pink',
      image: null,
    });
    expect(out).toEqual([
      {
        kind: 'looks_wrong',
        text: '[app] Step watcher: on "Add vinegar to cup A." they seem to have done something else: poured vinegar into cup B, not cup A (cup B is turning pink). If you see it too, tell them in a few words what to do instead; if not, carry on without mentioning it.',
        reply: true,
        data: { stepId: 'acid' },
        urgent: true,
      },
    ]);
  });

  it('says which criteria are not met, and what the watcher saw, when something went wrong', () => {
    const { b, out } = setup({ perception: 'trusted' });
    b.emit('step.looks_wrong', {
      t: 0,
      stepId: 'acid',
      wrong: 'poured vinegar into cup B, not cup A',
      observation: 'cup B is turning pink',
      image: null,
      criteria: [
        { text: "Cup A's liquid is pink.", met: 'no', seen: 'still purple.' },
        { text: 'Cup B is still purple.', met: 'no', seen: 'pink' },
        { text: 'Cup C is still purple.', met: 'yes', seen: 'purple' },
      ],
    });
    expect(out[0]?.text).toBe(
      '[app] Step watcher: on "Add vinegar to cup A." they seem to have done something else: poured vinegar into cup B, not cup A. Not met: Cup A\'s liquid is pink (saw: still purple); Cup B is still purple (saw: pink). If you see it too, tell them in a few words what to do instead; if not, carry on without mentioning it.',
    );
  });

  it('tells the coach in words about a hazard the step watcher sees, to warn the learner', () => {
    const { b, out } = setup({ perception: 'trusted' });
    b.emit('step.hazard', { t: 0, stepId: 'acid', hazard: 'kitchen knife by cup A', image: null });
    expect(out).toEqual([
      {
        kind: 'hazard',
        text: '[app] Step watcher: a possible hazard near their hands: kitchen knife by cup A. If you see it too, warn them in a few words; if not, carry on without mentioning it.',
        reply: true,
        data: { stepId: 'acid' },
        urgent: true,
      },
    ]);
  });

  it('offers a demonstration to a stuck learner only when the step has one', () => {
    let plan = planView();
    const { b, out } = setup({}, () => plan);
    b.emit('step.stuck', { t: 0, stepId: 'acid', elapsedMs: 15_000 });
    plan = planView({ focusId: 'look' });
    b.emit('step.stuck', { t: 1, stepId: 'look', elapsedMs: 20_000 });
    expect(out.map((n) => [n.kind, n.reply])).toEqual([
      ['stuck', true],
      ['stuck', true],
    ]);
    expect(out[0]?.text).toContain('15 s');
    expect(out[0]?.text).toContain('Offer help: call show_demo, then give one tip.');
    expect(out[1]?.text).toContain('20 s');
    expect(out[1]?.text).toContain('Offer one tip, or ask what is unclear.');
    expect(out[1]?.text).not.toContain('show_demo');
  });

  const ruleMistake = (b: Bus, source: 'rule' | 'coach' = 'rule') =>
    b.emit('mistake.detected', {
      t: 0,
      stepId: 'acid',
      kind: 'wrong_cup',
      message: 'Use cup A.',
      source,
    });

  it("reports rule mistakes and the end of the lesson, but not the coach's own", () => {
    const { b, out } = setup({ perception: 'trusted' }, undefined, () => 'coach');
    ruleMistake(b, 'rule');
    ruleMistake(b, 'coach');
    b.emit('procedure.completed', { t: 2, durationMs: 61_000 });
    expect(out.map((n) => n.kind)).toEqual(['mistake', 'complete']);
    expect(out[0]?.text).toContain('Use cup A.');
    expect(out[0]?.data).toEqual({ message: 'Use cup A.' });
    expect(out[1]?.text).toContain('61 s');
  });

  it('with trusted perception, reports rule mistakes only while the coach has authority', () => {
    let authority: 'coach' | 'local' = 'local';
    const trusted = setup({ perception: 'trusted' }, undefined, () => authority);
    ruleMistake(trusted.b);
    authority = 'coach';
    ruleMistake(trusted.b);
    expect(trusted.out.map((n) => n.kind)).toEqual(['mistake']);

    const unknown = setup({ perception: 'trusted' });
    ruleMistake(unknown.b);
    expect(unknown.out).toEqual([]);

    const all = setup({}, undefined, () => 'local');
    ruleMistake(all.b);
    expect(all.out.map((n) => n.kind)).toEqual(['mistake']);
  });

  it('with all perception, notes pinches (throttled), missing and pinched objects', () => {
    const { b, out } = setup();
    pinch(b, 0);
    pinch(b, 500);
    pinch(b, 2500);
    b.emit('object.missing', { t: 3, objectIds: ['vinegar'] });
    b.emit('object.registered', {
      t: 4,
      objectId: 'vinegar',
      position: [0, 0, 0],
      method: 'pinch',
    });
    b.emit('object.registered', {
      t: 5,
      objectId: 'cup_a',
      position: [0, 0, 0],
      method: 'detector',
    });
    expect(out.map((n) => [n.kind, n.reply])).toEqual([
      ['pinch', false],
      ['pinch', false],
      ['missing', true],
      ['registered', true],
    ]);
    expect(out[2]?.text).toContain('vinegar bottle');
    expect(out[3]?.text).toBe('[app] Registered the vinegar bottle where they pinched.');
  });

  it('with trusted perception, says nothing the tracker or the object finder produced', () => {
    const { b, out, seen } = setup({ perception: 'trusted' });
    pinch(b, 0);
    b.emit('object.missing', { t: 1, objectIds: ['vinegar'] });
    b.emit('object.registered', {
      t: 2,
      objectId: 'vinegar',
      position: [0, 0, 0],
      method: 'pinch',
    });
    expect(out).toEqual([]);
    expect(seen.filter((e) => e.type === 'coach.narration')).toEqual([]);
  });

  it('leaves recording to the session, which knows what reached the model', () => {
    const { b, seen, out } = setup();
    b.emit('step.stuck', { t: 3, stepId: 'acid', elapsedMs: 15000 });
    expect(out.map((n) => n.kind)).toEqual(['stuck']);
    expect(seen.filter((e) => e.type === 'coach.narration')).toEqual([]);
  });

  it('never sends arrow or bullet symbols to the model', () => {
    const { b, out } = setup();
    b.emit('plan.ready', { t: 0, planId: 'p', procedure, warnings: ['w'], revision: false });
    b.emit('plan.ready', { t: 0, planId: 'p', procedure, warnings: [], revision: true });
    b.emit('plan.failed', { t: 0, goal: 'g', error: 'e', revision: false });
    b.emit('plan.failed', { t: 0, goal: 'g', error: 'e', revision: true });
    b.emit('plan.slow', { t: 0, goal: 'g', elapsedMs: 12_000 });
    b.emit('step.completed', {
      t: 0,
      stepId: 'acid',
      index: 0,
      by: 'check',
      forced: false,
      durationMs: 1,
    });
    entered(b, 'look');
    b.emit('step.looks_done', { t: 0, stepId: 'look', observation: 'o', image: null });
    b.emit('step.stuck', { t: 0, stepId: 'acid', elapsedMs: 1 });
    b.emit('procedure.completed', { t: 0, durationMs: 1 });
    expect(out).toHaveLength(8);
    for (const n of out) expect(n.text).not.toMatch(SYMBOLS);
  });
});

describe('CoachSession', () => {
  interface SetupOptions {
    kind?: CoachKind;
    plan?: () => PlanView | null;
    phase?: () => LessonPhase;
    templates?: readonly TemplateSummary[];
    tools?: Partial<AvailableToolHandlers>;
  }

  async function setup({
    kind = 'gemini',
    plan = () => planView(),
    phase,
    templates,
    tools,
  }: SetupOptions = {}) {
    const { b, seen } = bus();
    const agent = new FakeAgent(kind);
    const played: string[] = [];
    const clock = new ManualClock(0);
    const frames: string[] = [];
    let micHandler: ((pcm: Int16Array) => void) | null = null;
    /** Whether the speaker still has audio to play. */
    const speaker = { playing: false };
    const session = new CoachSession({
      agent,
      toolbox: new CoachToolbox({ ...handlers(), ...tools }, b, clock),
      bus: b,
      clock,
      view: { ...lessonView(plan), ...(phase ? { phase } : {}) },
      voice: {
        play: (pcm) => played.push(`pcm:${pcm.length}`),
        say: (text) => played.push(`say:${text}`),
        stop: () => played.push('stop'),
        playing: () => speaker.playing,
      },
      mic: {
        start: async (onChunk) => {
          micHandler = onChunk;
        },
        stop: () => {},
      },
      camera: { snapshot: async () => `frame${frames.push('x')}` },
      persona: 'A fallback persona.',
      ...(templates ? { templates } : {}),
    });
    await session.start();
    return { agent, b, seen, played, session, clock, speaker, mic: () => micHandler };
  }

  const settle = () => new Promise((r) => setTimeout(r, 0));
  const speak = (agent: FakeAgent) =>
    agent.events.emit('audio', { pcm: new Int16Array(480), sampleRate: 24000 });
  type Seen = { type: string; payload: Record<string, unknown> }[];
  const narrated = (seen: Seen) =>
    seen.filter((e) => e.type === 'coach.narration').map((e) => String(e.payload.text));
  /** What the recording says reached the model, and which briefings never did. */
  const recorded = (seen: Seen) =>
    seen
      .filter(
        (e) =>
          e.type === 'coach.narration' ||
          (e.type === 'annotation' && e.payload.label === 'coach.narration_dropped'),
      )
      .map((e) => e.payload);
  const stuck = (b: Bus, t: number, elapsedMs = 15_000) =>
    b.emit('step.stuck', { t, stepId: 'acid', elapsedMs });
  /** Every coach.voice the session published, oldest first. */
  const voices = (seen: Seen) =>
    seen.filter((e) => e.type === 'coach.voice').map((e) => e.payload.voice);

  describe('the conversation, for the status mark', () => {
    it('is quiet once started, and never recorded', async () => {
      const { seen } = await setup();
      expect(voices(seen)).toEqual(['quiet']);
      expect(isRecordable('coach.voice')).toBe(false);
    });

    it('speaks from the first audio until the speaker has played the turn out', async () => {
      const { agent, seen, session, clock, speaker } = await setup();
      speaker.playing = true;
      speak(agent);
      speak(agent);
      // Generation runs ahead of playback: the turn is over, the audio isn't.
      agent.events.emit('turnComplete', {});
      session.tick(clock.advance(2000));
      expect(voices(seen)).toEqual(['quiet', 'speaking']);
      speaker.playing = false;
      session.tick(clock.advance(16));
      expect(voices(seen)).toEqual(['quiet', 'speaking', 'quiet']);
    });

    it('keeps speaking through a gap in the audio while the turn goes on', async () => {
      const { agent, seen, session, clock } = await setup();
      speak(agent);
      session.tick(clock.advance(500));
      expect(voices(seen)).toEqual(['quiet', 'speaking']);
      agent.events.emit('turnComplete', {});
      expect(voices(seen)).toEqual(['quiet', 'speaking', 'quiet']);
    });

    it('stops speaking at once on a barge-in or a dropped connection', async () => {
      const { agent, seen, speaker } = await setup();
      speaker.playing = true;
      speak(agent);
      agent.events.emit('interrupted', {});
      expect(voices(seen)).toEqual(['quiet', 'speaking', 'quiet']);
      speak(agent);
      agent.events.emit('status', { state: 'reconnecting' });
      agent.events.emit('status', { state: 'ready' });
      expect(voices(seen)).toEqual(['quiet', 'speaking', 'quiet', 'speaking', 'quiet']);
    });

    it('hears the learner while their words arrive, until they have been quiet for 1.2 s', async () => {
      const { agent, seen, session, clock } = await setup();
      agent.events.emit('transcript', { role: 'user', text: 'Which', final: false });
      session.tick(clock.advance(1000));
      agent.events.emit('transcript', { role: 'user', text: 'Which cup', final: false });
      agent.events.emit('transcript', { role: 'coach', text: 'Cup', final: false });
      session.tick(clock.advance(1100));
      expect(voices(seen)).toEqual(['quiet', 'hearing']);
      session.tick(clock.advance(100));
      expect(voices(seen)).toEqual(['quiet', 'hearing', 'quiet']);
      agent.events.emit('transcript', { role: 'user', text: 'Which cup?', final: true });
      expect(voices(seen)).toEqual(['quiet', 'hearing', 'quiet']);
    });

    it('says Clio is speaking over the learner until the model gives way', async () => {
      const { agent, seen } = await setup();
      speak(agent);
      agent.events.emit('transcript', { role: 'user', text: 'Wait', final: false });
      expect(voices(seen)).toEqual(['quiet', 'speaking']);
      agent.events.emit('interrupted', {});
      expect(voices(seen)).toEqual(['quiet', 'speaking', 'hearing']);
    });

    it('speaks a text-to-speech line for as long as the speaker says it', async () => {
      const { agent, seen, session, clock, speaker } = await setup({ kind: 'scripted' });
      speaker.playing = true;
      agent.events.emit('say', { text: 'Hi' });
      session.tick(clock.advance(800));
      expect(voices(seen)).toEqual(['quiet', 'speaking']);
      speaker.playing = false;
      session.tick(clock.advance(16));
      expect(voices(seen)).toEqual(['quiet', 'speaking', 'quiet']);
    });

    it('turns off when the session stops, and stays off without a microphone', async () => {
      const { seen, session } = await setup();
      await session.stop();
      expect(voices(seen)).toEqual(['quiet', 'off']);

      const { b, seen: scripted } = bus();
      const clock = new ManualClock(0);
      const deaf = new CoachSession({
        agent: new ScriptedAgent(),
        toolbox: new CoachToolbox(handlers(), b, clock),
        bus: b,
        clock,
        view: lessonView(),
        voice: { play: () => {}, say: () => {}, stop: () => {}, playing: () => true },
      });
      await deaf.start();
      b.emit('plan.ready', { t: 0, planId: 'p', procedure, warnings: [], revision: false });
      entered(b, 'acid', 'Add vinegar to cup A.');
      deaf.tick(clock.advance(100));
      await deaf.stop();
      expect(voices(scripted)).toEqual([]);
    });
  });

  it('connects with every coach tool but the widgets (no board) and an instruction that holds the plan', async () => {
    const templates = [{ id: 'ph-indicator', title: 'pH indicator', summary: 'Acids and bases.' }];
    const { agent, mic } = await setup({ templates });
    expect(agent.setup?.tools).toEqual([
      'start_lesson',
      'end_lesson',
      'revise_plan',
      'add_step',
      'update_step',
      'complete_step',
      'add_material',
      'highlight',
      'show_demo',
      'flag_mistake',
      'look_closer',
    ]);
    expect(agent.setup?.systemInstruction).toBe(
      buildSystemInstruction({
        persona: 'A patient chemistry teacher.',
        lessonNotes: 'Cup B is the base.',
        templates,
        plan: planView(),
        widgets: false,
      }),
    );
    expect(agent.setup?.systemInstruction).toContain(recitePlan(planView()));
    mic()?.(new Int16Array(320));
    expect(agent.audio).toHaveLength(1);
  });

  it('answers tool calls through the agent', async () => {
    const { agent } = await setup();
    agent.events.emit('toolCalls', { calls: [{ id: 'c1', name: 'show_demo', args: {} }] });
    await settle();
    expect(agent.responses).toMatchObject([{ id: 'c1', name: 'show_demo', ok: true }]);
  });

  it('plays coach speech and cuts it off when the user interrupts', async () => {
    const { agent, played } = await setup();
    speak(agent);
    agent.events.emit('say', { text: 'Hi' });
    agent.events.emit('interrupted', {});
    expect(played).toEqual(['pcm:480', 'say:Hi', 'stop']);
  });

  it('records final transcripts, and shows partial ones only as captions', async () => {
    const { agent, seen } = await setup();
    agent.events.emit('transcript', { role: 'coach', text: 'Add vin', final: false });
    agent.events.emit('transcript', { role: 'coach', text: 'Add vinegar.', final: true });
    expect(seen.filter((e) => e.type === 'transcript').map((e) => e.payload.text)).toEqual([
      'Add vinegar.',
    ]);
    expect(seen.filter((e) => e.type === 'coach.caption')).toHaveLength(2);
  });

  it('sends one camera frame every 4 s, whatever the step', async () => {
    const { agent, b, session, clock } = await setup();
    entered(b, 'look', 'Check the color.', clock.now());
    while (clock.now() < 8000) {
      session.tick(clock.advance(100));
      await settle();
    }
    expect(agent.images).toEqual(['frame1', 'frame2']);
  });

  it('tells a Gemini coach nothing from the tracker, and a scripted coach everything', async () => {
    const gemini = await setup();
    pinch(gemini.b, 0);
    expect(gemini.agent.narrations).toEqual([]);
    const scripted = await setup({ kind: 'scripted' });
    pinch(scripted.b, 0);
    expect(scripted.agent.narrations.map((n) => n.kind)).toEqual(['pinch']);
  });

  it('refreshes the system instruction once the plan has settled for 1.5 s', async () => {
    let plan = planView();
    const { agent, b, session, clock } = await setup({ plan: () => plan });
    plan = planView({
      rev: 2,
      focusId: 'look',
      steps: planView().steps.map((s) => (s.id === 'acid' ? { ...s, status: 'done' } : s)),
    });
    b.emit('plan.changed', { t: clock.now(), rev: 2, op: 'complete', stepId: 'acid' });
    session.tick(clock.advance(1000));
    b.emit('plan.changed', { t: clock.now(), rev: 2, op: 'focus', stepId: 'look' });
    session.tick(clock.advance(1000));
    expect(agent.instructions).toEqual([]);
    session.tick(clock.advance(500));
    expect(agent.instructions).toHaveLength(1);
    expect(agent.instructions[0]).toContain(recitePlan(plan));
    expect(agent.instructions[0]).toContain('Lesson plan (snapshot');
    session.tick(clock.advance(5000));
    expect(agent.instructions).toHaveLength(1);

    b.emit('plan.ready', { t: clock.now(), planId: 'p', procedure, warnings: [], revision: true });
    session.tick(clock.advance(1500));
    expect(agent.instructions).toHaveLength(2);
  });

  it('holds narrations while the coach speaks and sends them merged after its turn', async () => {
    const { agent, b, seen, session, clock } = await setup();
    speak(agent);
    b.emit('plan.ready', { t: clock.now(), planId: 'p', procedure, warnings: [], revision: false });
    b.emit('plan.slow', { t: clock.now(), goal: 'g', elapsedMs: 12_000 });
    session.tick(clock.advance(100));
    agent.events.emit('turnComplete', {});
    expect(agent.narrations).toEqual([]);
    session.tick(clock.advance(100));
    expect(agent.narrations).toEqual([
      { kind: 'plan_slow', text: narrated(seen).join(' '), reply: true },
    ]);
    expect(narrated(seen)).toHaveLength(2);
  });

  it('sends held narrations once the oldest is 6 s old, even mid-speech', async () => {
    const { agent, b, session, clock } = await setup();
    speak(agent);
    b.emit('step.stuck', { t: clock.now(), stepId: 'acid', elapsedMs: 15_000 });
    session.tick(clock.advance(3000));
    speak(agent);
    session.tick(clock.advance(2900));
    expect(agent.narrations).toEqual([]);
    session.tick(clock.advance(100));
    expect(agent.narrations.map((n) => n.kind)).toEqual(['stuck']);
  });

  it('drops a held briefing for a step that has lost focus since', async () => {
    let plan = planView();
    const { agent, b, session, clock } = await setup({ plan: () => plan });
    speak(agent);
    entered(b, 'acid', 'Add vinegar to cup A.');
    plan = planView({ focusId: 'look' });
    entered(b, 'look', 'Check the color.');
    agent.events.emit('turnComplete', {});
    session.tick(clock.advance(100));
    expect(agent.narrations).toHaveLength(1);
    expect(agent.narrations[0]).toMatchObject({
      kind: 'step',
      reply: true,
      data: { stepId: 'look' },
    });
    expect(agent.narrations[0]?.text).not.toContain('Now acid');

    // The coach moved the focus itself: its tool result carries the briefing.
    speak(agent);
    plan = planView();
    b.emit('plan.slow', { t: clock.now(), goal: 'g', elapsedMs: 12_000 });
    entered(b, 'acid', 'Add vinegar to cup A.');
    plan = planView({ focusId: 'look' });
    agent.events.emit('turnComplete', {});
    session.tick(clock.advance(100));
    expect(agent.narrations.slice(1).map((n) => n.kind)).toEqual(['plan_slow']);
    expect(agent.narrations[1]?.text).not.toContain('Now acid');
  });

  it('waits until the learner has been quiet for 1.2 s', async () => {
    const { agent, b, session, clock } = await setup();
    b.emit('step.stuck', { t: clock.now(), stepId: 'acid', elapsedMs: 15_000 });
    await settle();
    expect(agent.narrations).toHaveLength(1);
    agent.events.emit('transcript', { role: 'user', text: 'wait, which', final: false });
    b.emit('step.stuck', { t: clock.now(), stepId: 'acid', elapsedMs: 30_000 });
    session.tick(clock.advance(1100));
    expect(agent.narrations).toHaveLength(1);
    session.tick(clock.advance(100));
    expect(agent.narrations).toHaveLength(2);
  });

  it('sends what the app saw while the learner is still talking, but not over the coach', async () => {
    const { agent, b, session, clock } = await setup({ plan: () => planView({ focusId: 'look' }) });
    agent.events.emit('transcript', { role: 'user', text: 'I did it', final: false });
    b.emit('step.completed', {
      t: clock.now(),
      stepId: 'acid',
      index: 0,
      by: 'check',
      forced: false,
      durationMs: 5,
    });
    entered(b, 'look', 'Check the color.', clock.now());
    await settle();
    expect(agent.narrations.map((n) => n.kind)).toEqual(['step']);
    speak(agent);
    b.emit('step.hazard', { t: clock.now(), stepId: 'look', hazard: 'knife', image: null });
    session.tick(clock.advance(100));
    expect(agent.narrations).toHaveLength(1);
    agent.events.emit('turnComplete', {});
    session.tick(clock.advance(100));
    expect(agent.narrations.map((n) => n.kind)).toEqual(['step', 'hazard']);
  });

  it('gives other coaches every narration at once, even while they speak', async () => {
    const { agent, b, clock } = await setup({ kind: 'scripted' });
    speak(agent);
    b.emit('step.stuck', { t: clock.now(), stepId: 'acid', elapsedMs: 15_000 });
    expect(agent.narrations.map((n) => n.kind)).toEqual(['stuck']);
  });

  it('sends what one burst of events produces as one message', async () => {
    const { agent, b, seen, clock } = await setup();
    b.emit('plan.ready', { t: clock.now(), planId: 'p', procedure, warnings: [], revision: false });
    entered(b, 'acid', 'Add vinegar to cup A.');
    expect(agent.narrations).toEqual([]);
    await settle();
    expect(agent.narrations).toEqual([
      {
        kind: 'step',
        text: narrated(seen).join(' '),
        reply: true,
        data: { instruction: 'Add vinegar to cup A.', stepId: 'acid' },
      },
    ]);
    expect(narrated(seen)).toHaveLength(2);
    expect(narrated(seen)[0]?.startsWith('[app] Plan ready.')).toBe(true);
  });

  it('lets a revised plan stand in for the briefing that came with it, and puts it first', async () => {
    let plan = planView();
    const { agent, b, seen, clock } = await setup({ plan: () => plan });
    b.emit('step.stuck', { t: clock.now(), stepId: 'acid', elapsedMs: 15_000 });
    plan = planView({ rev: 2, focusId: 'look' });
    entered(b, 'look', 'Check the color.');
    b.emit('plan.ready', { t: clock.now(), planId: 'p', procedure, warnings: [], revision: true });
    await settle();
    expect(agent.narrations).toHaveLength(1);
    expect(agent.narrations[0]).toMatchObject({ kind: 'stuck', reply: true });
    const text = agent.narrations[0]?.text ?? '';
    expect(text.startsWith(`[app] Plan revised. ${recitePlan(plan)}`)).toBe(true);
    expect(text).toContain('[app] They have been on this step for 15 s.');
    expect(text).not.toContain('Tell them what to do in under 15 words.');
    expect(recorded(seen).map((p) => p.kind ?? p.label)).toEqual([
      'coach.narration_dropped',
      'plan_revised',
      'stuck',
    ]);
    expect(recorded(seen)[0]).toEqual({
      t: 0,
      label: 'coach.narration_dropped',
      data: { kind: 'step', stepId: 'look' },
    });
  });

  it("holds what a tool call sets off until the model has the call's answer and ends its turn", async () => {
    let completeLesson = () => {};
    const { agent, b, session, clock } = await setup({
      tools: {
        complete_step: () => {
          completeLesson();
          return { ok: true, result: { done: 'acid' } };
        },
      },
    });
    completeLesson = () => b.emit('procedure.completed', { t: clock.now(), durationMs: 61_000 });
    agent.events.emit('toolCalls', {
      calls: [
        {
          id: 'c1',
          name: 'complete_step',
          args: { step_id: 'acid', reason: 'pink', evidence: 'seen' },
        },
      ],
    });
    await settle();
    session.tick(clock.advance(100));
    expect(agent.log).toEqual(['respond:c1']);
    agent.events.emit('turnComplete', {});
    session.tick(clock.advance(100));
    expect(agent.log).toEqual(['respond:c1', 'narrate:complete']);

    // A barge-in ends the turn too.
    agent.events.emit('toolCalls', { calls: [{ id: 'c2', name: 'show_demo', args: {} }] });
    stuck(b, clock.now());
    await settle();
    expect(agent.log.slice(2)).toEqual(['respond:c2']);
    agent.events.emit('interrupted', {});
    session.tick(clock.advance(100));
    expect(agent.log.slice(2)).toEqual(['respond:c2', 'narrate:stuck']);
  });

  it('holds narrations while the connection is down, and sends them with the recap on return', async () => {
    let plan = planView();
    const { agent, b, seen, session, clock } = await setup({ plan: () => plan });
    agent.events.emit('status', { state: 'reconnecting' });
    stuck(b, clock.now());
    entered(b, 'acid', 'Add vinegar to cup A.');
    plan = planView({ focusId: 'look' });
    entered(b, 'look', 'Check the color.');
    await settle();
    // The 6 s limit only applies while there is a connection to send on.
    session.tick(clock.advance(7000));
    expect(agent.narrations).toEqual([]);
    expect(recorded(seen)).toEqual([]);

    agent.events.emit('status', { state: 'ready' });
    await settle();
    const recap = `[app] Reconnected. ${recitePlan(plan)}`;
    expect(agent.narrations).toHaveLength(1);
    expect(agent.narrations[0]).toMatchObject({ kind: 'reconnected', reply: true });
    const text = agent.narrations[0]?.text ?? '';
    expect(text.startsWith('[app] They have been on this step for 15 s.')).toBe(true);
    expect(text).toContain(briefStep(plan, 'look'));
    expect(text).not.toContain('Now acid');
    expect(text.endsWith(recap)).toBe(true);
    expect(recorded(seen)).toEqual([
      { t: 7000, label: 'coach.narration_dropped', data: { kind: 'step', stepId: 'acid' } },
      { t: 7000, kind: 'stuck', text: expect.stringContaining('15 s') },
      { t: 7000, kind: 'step', text: expect.stringContaining('Now look') },
      { t: 7000, kind: 'reconnected', text: recap },
    ]);
  });

  it('starts the 6 s limit again once the connection is back', async () => {
    const { agent, b, session, clock } = await setup();
    agent.events.emit('status', { state: 'reconnecting' });
    stuck(b, clock.now());
    session.tick(clock.advance(7000));
    agent.events.emit('transcript', { role: 'user', text: 'hello?', final: false });
    agent.events.emit('status', { state: 'ready' });
    await settle();
    session.tick(clock.advance(1000));
    expect(agent.narrations).toEqual([]);
    session.tick(clock.advance(300));
    expect(agent.narrations.map((n) => n.kind)).toEqual(['reconnected']);
  });

  it('drops what it holds once the connection is gone for good', async () => {
    for (const state of ['error', 'closed'] as const) {
      const { agent, b, seen, session, clock } = await setup();
      agent.events.emit('status', { state: 'reconnecting' });
      stuck(b, clock.now());
      agent.events.emit('status', { state });
      stuck(b, clock.now(), 30_000);
      agent.events.emit('status', { state: 'ready' });
      await settle();
      session.tick(clock.advance(7000));
      expect(agent.narrations).toEqual([]);
      expect(recorded(seen)).toEqual([]);
    }
  });

  it('records each narration when it reaches the model, and each briefing it drops', async () => {
    let plan = planView();
    const { agent, b, seen, session, clock } = await setup({ plan: () => plan });
    speak(agent);
    entered(b, 'acid', 'Add vinegar to cup A.');
    plan = planView({ focusId: 'look' });
    stuck(b, clock.now());
    session.tick(clock.advance(500));
    expect(recorded(seen)).toEqual([]);
    agent.events.emit('turnComplete', {});
    session.tick(clock.advance(100));
    expect(recorded(seen)).toEqual([
      { t: 600, label: 'coach.narration_dropped', data: { kind: 'step', stepId: 'acid' } },
      { t: 600, kind: 'stuck', text: agent.narrations[0]?.text },
    ]);

    const scripted = await setup({ kind: 'scripted' });
    scripted.clock.advance(250);
    speak(scripted.agent);
    stuck(scripted.b, 0);
    expect(recorded(scripted.seen)).toEqual([
      { t: 250, kind: 'stuck', text: scripted.agent.narrations[0]?.text },
    ]);
  });

  describe('with no lesson running', () => {
    const nudge =
      '[app] No lesson is running, so what they just said starts one: call start_lesson now with a goal made from it, done with their hands, and say in one short sentence what you are starting. If they only greeted or thanked you, ask in a few words what they want to do instead.';
    /** The learner asks something, and the coach answers in words. */
    const answered = (agent: FakeAgent) => {
      agent.events.emit('transcript', { role: 'user', text: 'How does a French', final: false });
      speak(agent);
      agent.events.emit('transcript', {
        role: 'user',
        text: 'How does a French press work?',
        final: true,
      });
      agent.events.emit('turnComplete', {});
    };

    it('tells a coach that answered in words and went quiet to start a lesson, once', async () => {
      for (const phase of ['idle', 'done'] as const) {
        const { agent, seen, session, clock } = await setup({
          plan: () => null,
          phase: () => phase,
        });
        answered(agent);
        session.tick(clock.advance(5999));
        await settle();
        expect(agent.narrations).toEqual([]);
        session.tick(clock.advance(1));
        await settle();
        expect(agent.narrations).toEqual([{ kind: 'start_nudge', text: nudge, reply: true }]);
        expect(narrated(seen)).toEqual([nudge]);
        session.tick(clock.advance(20_000));
        await settle();
        expect(agent.narrations).toHaveLength(1);
      }
    });

    it('waits while either of them is still talking', async () => {
      const { agent, session, clock } = await setup({ plan: () => null, phase: () => 'idle' });
      answered(agent);
      session.tick(clock.advance(4000));
      speak(agent);
      agent.events.emit('turnComplete', {});
      session.tick(clock.advance(4000));
      agent.events.emit('transcript', { role: 'user', text: 'I mean', final: false });
      session.tick(clock.advance(5999));
      await settle();
      expect(agent.narrations).toEqual([]);
      session.tick(clock.advance(1));
      await settle();
      expect(agent.narrations.map((n) => n.kind)).toEqual(['start_nudge']);
    });

    it('counts a typed learner turn', async () => {
      const { agent, b, session, clock } = await setup({ plan: () => null, phase: () => 'idle' });
      b.emit('transcript', {
        t: clock.now(),
        role: 'user',
        text: 'Why is my plant drooping?',
        final: true,
      });
      session.tick(clock.advance(6000));
      await settle();
      expect(agent.narrations.map((n) => n.kind)).toEqual(['start_nudge']);
    });

    it('leaves a coach alone that starts or ends a lesson, even late, and a running lesson', async () => {
      const calls = [
        { id: 'c1', name: 'start_lesson', args: { goal: 'brew coffee' } },
        { id: 'c1', name: 'end_lesson', args: { reason: 'not what they want' } },
      ];
      for (const call of calls) {
        const { agent, session, clock } = await setup({ plan: () => null, phase: () => 'idle' });
        answered(agent);
        session.tick(clock.advance(3000));
        agent.events.emit('toolCalls', { calls: [call] });
        agent.events.emit('turnComplete', {});
        session.tick(clock.advance(30_000));
        await settle();
        expect(agent.narrations).toEqual([]);
      }

      for (const phase of ['planning', 'locating', 'lesson'] as const) {
        const { agent, session, clock } = await setup({ phase: () => phase });
        answered(agent);
        session.tick(clock.advance(30_000));
        await settle();
        expect(agent.narrations).toEqual([]);
      }

      // A lesson that starts some other way meanwhile.
      let phase: LessonPhase = 'idle';
      const started = await setup({ plan: () => null, phase: () => phase });
      answered(started.agent);
      phase = 'planning';
      started.session.tick(started.clock.advance(3000));
      phase = 'done';
      started.session.tick(started.clock.advance(30_000));
      await settle();
      expect(started.agent.narrations).toEqual([]);
    });

    it('stays out of it until the learner speaks, and without a lesson phase or a Gemini coach', async () => {
      const quiet = await setup({ plan: () => null, phase: () => 'idle' });
      quiet.session.welcome(null);
      speak(quiet.agent);
      quiet.agent.events.emit('turnComplete', {});
      quiet.session.tick(quiet.clock.advance(30_000));
      await settle();
      expect(quiet.agent.narrations.map((n) => n.kind)).toEqual(['welcome']);

      const unknown = await setup({ plan: () => null });
      answered(unknown.agent);
      unknown.session.tick(unknown.clock.advance(30_000));
      await settle();
      expect(unknown.agent.narrations).toEqual([]);

      const scripted = await setup({ kind: 'scripted', plan: () => null, phase: () => 'idle' });
      answered(scripted.agent);
      scripted.session.tick(scripted.clock.advance(30_000));
      await settle();
      expect(scripted.agent.narrations).toEqual([]);
    });
  });

  it('speaks first: asks what they want to do, or greets them while their goal is planned', async () => {
    const idle = await setup({ plan: () => null });
    idle.session.welcome(null);
    await settle();
    expect(idle.agent.narrations).toEqual([
      {
        kind: 'welcome',
        text: '[app] They just put the headset on and no lesson is running. Greet them in one short sentence and ask what they want to do.',
        reply: true,
      },
    ]);
    expect(narrated(idle.seen)).toEqual([idle.agent.narrations[0]?.text]);

    const planning = await setup({ plan: () => null });
    planning.session.welcome('refill the washer fluid');
    await settle();
    expect(planning.agent.narrations).toEqual([
      {
        kind: 'welcome',
        text: '[app] They just put the headset on to: refill the washer fluid. The app has already started that lesson, and its plan arrives as an [app] message. Greet them in one short sentence; give no steps yet and call no tool.',
        reply: true,
      },
    ]);
  });

  it('recaps the plan after a reconnect, but not on the first connection', async () => {
    const { agent, seen } = await setup();
    expect(agent.narrations).toEqual([]);
    speak(agent);
    agent.events.emit('status', { state: 'reconnecting' });
    agent.events.emit('status', { state: 'ready' });
    await settle();
    const recap = `[app] Reconnected. ${recitePlan(planView())}`;
    expect(agent.narrations).toEqual([{ kind: 'reconnected', text: recap, reply: false }]);
    expect(narrated(seen)).toEqual([recap]);

    const idle = await setup({ plan: () => null });
    idle.agent.events.emit('status', { state: 'reconnecting' });
    idle.agent.events.emit('status', { state: 'ready' });
    await settle();
    expect(idle.agent.narrations.map((n) => n.text)).toEqual([
      '[app] Reconnected. No lesson is running.',
    ]);
  });

  it('pushes the current plan into the next connection as soon as it starts reconnecting', async () => {
    const { agent, b, clock } = await setup();
    b.emit('plan.changed', { t: clock.now(), rev: 2, op: 'edit', stepId: 'acid' });
    agent.events.emit('status', { state: 'reconnecting' });
    expect(agent.instructions).toHaveLength(1);
  });

  it('rebuilds the instruction on every reconnect attempt, even with no plan change', async () => {
    let plan: PlanView | null = planView();
    const { agent } = await setup({ plan: () => plan });
    agent.events.emit('status', { state: 'reconnecting' });
    plan = null;
    agent.events.emit('status', { state: 'reconnecting' });
    expect(agent.instructions).toHaveLength(2);
    expect(agent.instructions[0]).toContain('Lesson plan (snapshot');
    expect(agent.instructions[1]).not.toContain('Lesson plan (snapshot');
  });

  it('rebuilds the instruction once a lesson starts, fails or ends', async () => {
    let plan: PlanView | null = planView();
    const { agent, b, session, clock } = await setup({ plan: () => plan });
    plan = null;
    b.emit('lesson.phase', { t: clock.now(), phase: 'failed', detail: 'Planning failed' });
    session.tick(clock.advance(1400));
    expect(agent.instructions).toEqual([]);
    session.tick(clock.advance(100));
    expect(agent.instructions).toHaveLength(1);
    expect(agent.instructions[0]).not.toContain('Lesson plan (snapshot');

    plan = planView();
    b.emit('lesson.phase', { t: clock.now(), phase: 'lesson' });
    session.tick(clock.advance(1500));
    expect(agent.instructions).toHaveLength(2);
    expect(agent.instructions[1]).toContain(recitePlan(planView()));
  });

  it('tells the coach when a cancelled call had already changed the plan', async () => {
    const { agent, seen } = await setup();
    agent.events.emit('toolCalls', {
      calls: [
        {
          id: 'c1',
          name: 'complete_step',
          args: { step_id: 'acid', reason: 'pink', evidence: 'seen' },
        },
        { id: 'c2', name: 'highlight', args: { object_id: 'cup_a' } },
        { id: 'c3', name: 'complete_step', args: { reason: 'pink', evidence: 'seen' } },
      ],
    });
    await settle();
    agent.events.emit('interrupted', {});
    agent.events.emit('cancelledTools', { ids: ['c1', 'c2', 'c3', 'c9'] });
    await settle();
    expect(seen.filter((e) => e.type === 'annotation').map((e) => e.payload)).toEqual([
      { t: 0, label: 'coach.tool_cancelled', data: { callId: 'c1', name: 'complete_step' } },
      { t: 0, label: 'coach.tool_cancelled', data: { callId: 'c3', name: 'complete_step' } },
    ]);
    expect(agent.narrations).toEqual([
      {
        kind: 'cancelled',
        text: `[app] Your complete_step call was already applied. ${recitePlan(planView())}`,
        reply: false,
      },
    ]);
  });

  it('says nothing was applied when every cancelled plan call failed', async () => {
    const { agent, seen } = await setup({
      tools: { add_step: () => ({ ok: false, error: 'Wait for the new plan.' }) },
    });
    agent.events.emit('toolCalls', {
      calls: [
        { id: 'c1', name: 'add_step', args: { text: 'Stir.', done_when: 'it is mixed' } },
        { id: 'c2', name: 'complete_step', args: { reason: 'pink', evidence: 'seen' } },
      ],
    });
    await settle();
    agent.events.emit('interrupted', {});
    agent.events.emit('cancelledTools', { ids: ['c1', 'c2'] });
    await settle();
    expect(
      seen
        .filter((e) => e.type === 'annotation')
        .map((e) => (e.payload.data as { callId: string }).callId),
    ).toEqual(['c1', 'c2']);
    expect(agent.narrations).toEqual([]);
  });

  it('tells the coach once a cancelled call that was still running succeeds', async () => {
    let finish: (outcome: { ok: true; result: unknown }) => void = () => {};
    const { agent, seen } = await setup({
      tools: { add_material: () => new Promise((resolve) => (finish = resolve)) },
    });
    agent.events.emit('toolCalls', {
      calls: [{ id: 'c1', name: 'add_material', args: { label: 'funnel' } }],
    });
    await settle();
    agent.events.emit('interrupted', {});
    agent.events.emit('cancelledTools', { ids: ['c1'] });
    expect(seen.filter((e) => e.type === 'annotation')).toHaveLength(1);
    expect(agent.narrations).toEqual([]);
    finish({ ok: true, result: {} });
    await settle();
    expect(agent.narrations.map((n) => n.text)).toEqual([
      `[app] Your add_material call was already applied. ${recitePlan(planView())}`,
    ]);
  });

  it('tells the coach of a cancelled highlight only when it added a material', async () => {
    let finish: (outcome: { ok: true; result: unknown }) => void = () => {};
    const { agent, seen } = await setup({
      tools: {
        highlight: ({ object_id }) =>
          object_id === 'red_button'
            ? new Promise((resolve) => (finish = resolve))
            : { ok: true, result: { shown: true } },
      },
    });
    agent.events.emit('toolCalls', {
      calls: [
        { id: 'c1', name: 'highlight', args: { object_id: 'cup_a' } },
        { id: 'c2', name: 'highlight', args: { object_id: 'red_button', look_for: 'red button' } },
        { id: 'c3', name: 'end_lesson', args: { reason: 'not what they want' } },
      ],
    });
    await settle();
    agent.events.emit('interrupted', {});
    agent.events.emit('cancelledTools', { ids: ['c1', 'c2', 'c3'] });
    await settle();
    const cancelled = () =>
      seen
        .filter((e) => e.type === 'annotation')
        .map((e) => (e.payload.data as { callId: string }).callId);
    // A plain highlight changed nothing; the one still running may have.
    expect(cancelled()).toEqual(['c3']);
    finish({ ok: true, result: { shown: false, material_id: 'red_button', added: true } });
    await settle();
    expect(cancelled()).toEqual(['c3', 'c2']);
    expect(agent.narrations.map((n) => n.text)).toEqual([
      `[app] Your end_lesson call was already applied. ${recitePlan(planView())}`,
      `[app] Your highlight call was already applied. ${recitePlan(planView())}`,
    ]);
  });

  describe('a non-blocking call (look_closer)', () => {
    const answer = { answer: 'Cup C is the empty one.', highlighted: ['cup C'] };
    async function looking() {
      let finish: (outcome: { ok: true; result: unknown }) => void = () => {};
      const ctx = await setup({
        tools: { look_closer: () => new Promise((resolve) => (finish = resolve)) },
      });
      ctx.agent.events.emit('toolCalls', {
        calls: [{ id: 'c1', name: 'look_closer', args: { question: 'Which cup is empty?' } }],
      });
      await settle();
      return { ...ctx, finish: (result: unknown = answer) => finish({ ok: true, result }) };
    }

    it('lets the conversation go on and answers the call when the smart model has', async () => {
      const { agent, b, clock, finish } = await looking();
      // The voice says its filler and ends its turn; narrations flow while the look runs.
      speak(agent);
      agent.events.emit('turnComplete', {});
      stuck(b, clock.now());
      await settle();
      expect(agent.narrations.map((n) => n.kind)).toEqual(['stuck']);
      expect(agent.responses).toEqual([]);
      finish();
      await settle();
      expect(agent.responses).toEqual([
        { id: 'c1', name: 'look_closer', ok: true, result: answer },
      ]);
    });

    it('tells a new connection the answer as a narration, since it never made the call', async () => {
      const { agent, finish } = await looking();
      agent.events.emit('status', { state: 'reconnecting' });
      agent.events.emit('status', { state: 'ready' });
      finish();
      await settle();
      expect(agent.responses).toEqual([]);
      expect(agent.narrations.at(-1)).toEqual({
        kind: 'late_answer',
        text: `[app] Your look_closer call answered: ${JSON.stringify(answer)}`,
        reply: true,
      });
    });

    it('tells a cancelled look as a narration, not as an applied plan change', async () => {
      const { agent, seen, finish } = await looking();
      agent.events.emit('interrupted', {});
      agent.events.emit('cancelledTools', { ids: ['c1'] });
      finish({ error: 'x' });
      await settle();
      expect(seen.filter((e) => e.type === 'annotation')).toEqual([]);
      expect(agent.responses).toEqual([]);
      expect(agent.narrations.map((n) => n.text)).toEqual([
        '[app] Your look_closer call answered: {"error":"x"}',
      ]);
    });
  });

  it('shows the coach the frame the step watcher judged by, before what it says of it', async () => {
    const { agent, b, clock } = await setup();
    const order: string[] = [];
    const push = agent.pushImage.bind(agent);
    const narrate = agent.narrate.bind(agent);
    agent.pushImage = (jpeg) => {
      order.push(`image:${jpeg}`);
      push(jpeg);
    };
    agent.narrate = (n) => {
      order.push(`narration:${n.kind}`);
      narrate(n);
    };
    b.emit('step.looks_done', { t: clock.now(), stepId: 'acid', observation: 'pink', image: 'j1' });
    await settle();
    b.emit('step.looks_done', { t: clock.now(), stepId: 'acid', observation: 'pink', image: null });
    await settle();
    b.emit('step.looks_wrong', {
      t: clock.now(),
      stepId: 'acid',
      wrong: 'used cup B',
      observation: 'B is pink',
      image: 'j2',
    });
    await settle();
    // A done says nothing itself: the lesson completes the step and the briefing follows.
    expect(order).toEqual(['image:j1', 'image:j2', 'narration:looks_wrong']);
  });
});

describe('ScriptedAgent in a session', () => {
  it('speaks briefings and failures, and ignores what only a model would read', async () => {
    const { b } = bus();
    const clock = new ManualClock(0);
    const said: string[] = [];
    const session = new CoachSession({
      agent: new ScriptedAgent(),
      toolbox: new CoachToolbox(handlers(), b, clock),
      bus: b,
      clock,
      view: lessonView(),
      voice: { play: () => {}, say: (text) => said.push(text), stop: () => {} },
    });
    await session.start();
    b.emit('plan.ready', { t: 0, planId: 'p', procedure, warnings: [], revision: false });
    b.emit('plan.slow', { t: 0, goal: 'g', elapsedMs: 12_000 });
    entered(b, 'acid', 'Add vinegar to cup A.');
    b.emit('step.looks_done', { t: 0, stepId: 'acid', observation: 'pink', image: null });
    b.emit('plan.failed', { t: 0, goal: 'g', error: 'e', revision: false });
    expect(said).toEqual(['Add vinegar to cup A.', "Sorry, I couldn't plan that lesson."]);
    await session.stop();
  });

  it('briefs the next step after Done while its demonstration is still loading', async () => {
    const { b } = bus();
    const clock = new ManualClock(0);
    const said: string[] = [];
    const session = new CoachSession({
      agent: new ScriptedAgent(),
      toolbox: new CoachToolbox(
        { ...handlers(), show_demo: () => new Promise(() => {}) },
        b,
        clock,
      ),
      bus: b,
      clock,
      view: lessonView(),
      voice: { play: () => {}, say: (text) => said.push(text), stop: () => {} },
    });
    await session.start();
    b.emit('step.stuck', { t: 0, stepId: 'acid', elapsedMs: 15_000 });
    b.emit('step.completed', {
      t: 1,
      stepId: 'acid',
      index: 0,
      by: 'user',
      forced: false,
      durationMs: 1,
    });
    entered(b, 'look', 'Check the color.');
    expect(said).toEqual(['Watch this.', 'Check the color.']);
    await session.stop();
  });
});

describe('system prompt', () => {
  it('explains every tool, the [app] messages and how the coach keeps the plan', () => {
    const prompt = buildSystemInstruction({});
    for (const tool of COACH_TOOL_NAMES) expect(prompt).toContain(tool);
    expect(prompt).toContain('[app]');
    expect(prompt).toContain('not observations');
    expect(prompt).toContain('one camera frame every 4 seconds');
    expect(prompt).toContain('evidence "seen"');
    expect(prompt).toContain('evidence "heard"');
    expect(prompt).toContain('Call complete_step with the step_id from the plan');
    expect(prompt).toMatch(
      /"heard" whenever you know from their words rather than\s+your own eyes/,
    );
    expect(prompt).toContain('Never read step ids aloud.');
    expect(prompt).not.toMatch(/Trust them|per second|advance_step/);
    expect(prompt).not.toMatch(SYMBOLS);
  });

  it('starts a lesson from whatever it hears with none running, questions included', () => {
    const prompt = buildSystemInstruction({});
    expect(prompt).toMatch(
      /While no lesson is running \(none yet, or the last one is over\),\s+whatever the learner says or shows starts one, questions included: infer the goal and call\s+start_lesson in that same turn/,
    );
    expect(prompt).toMatch(/A question becomes a lesson on its answer, done with their\s+hands/);
    expect(prompt).toMatch(
      /Don't answer it in words, don't call look_closer\s+instead and don't interview them: the lesson answers it/,
    );
    expect(prompt).toMatch(/When they name nothing to do,\s+start a curated lesson below or one/);
    expect(prompt).toMatch(/Only a bare greeting, "yes" or\s+"um" gets one short question back/);
    // A closer look is for questions during a lesson; with none running a question starts one.
    expect(prompt).toMatch(
      /During a\s+lesson, whenever the learner asks whether something is safe/,
    );
  });

  it('takes "no" at once and lights what to touch', () => {
    const prompt = buildSystemInstruction({});
    expect(prompt).toMatch(/"that's not what I want", "stop" or "wrong\s+thing", stop right there/);
    expect(prompt).toMatch(/a new\s+goal is a new start_lesson, which replaces the running lesson/);
    expect(prompt).toMatch(
      /Every time\s+you ask them to touch, move or operate something, or they ask you to show them a thing, call\s+highlight on it \(style "target"\) in that same turn, before you say it/,
    );
    expect(prompt).toMatch(/If it is not in the\s+plan, give look_for/);
    // Anything can be lit: an answer that it is not lit yet is never a reason to say it cannot be.
    expect(prompt).toMatch(/so never say you\s+cannot highlight something/);
    expect(prompt).toMatch(/When highlight answers shown\s+false, it lights up by itself/);
    expect(prompt).toMatch(
      /If they did not say what they want, call end_lesson and\s+ask in a few words/,
    );
    expect(prompt).toContain('very brief: under 15 words per turn');
  });

  it('adds the persona, lesson notes, curated lessons and the plan snapshot, plan last', () => {
    const plan = planView();
    const prompt = buildSystemInstruction({
      persona: 'A patient chemistry teacher.',
      lessonNotes: 'Cup B is the base.',
      templates: [
        { id: 'ph-indicator', title: 'pH indicator', summary: 'Test acids and bases.' },
        { id: 'shirt-fold', title: 'Fold a shirt', summary: 'Fold a T-shirt in two moves.' },
      ],
      plan,
    });
    expect(prompt).toContain('Persona for this lesson: A patient chemistry teacher.');
    expect(prompt).toContain('Lesson notes: Cup B is the base.');
    expect(prompt).toContain(
      'Curated lessons you can start from:\n- ph-indicator: pH indicator. Test acids and bases.\n- shirt-fold: Fold a shirt. Fold a T-shirt in two moves.',
    );
    expect(
      prompt.endsWith(
        `Lesson plan (snapshot from when this connection started; newer [app] messages and tool results win):\n${recitePlan(plan)}`,
      ),
    ).toBe(true);
    expect(prompt).not.toMatch(SYMBOLS);
  });

  it('leaves out what it is not given', () => {
    const prompt = buildSystemInstruction({ templates: [], plan: null });
    expect(prompt).not.toMatch(/Persona for|Lesson notes|Curated lessons you can|Lesson plan \(/);
  });
});
