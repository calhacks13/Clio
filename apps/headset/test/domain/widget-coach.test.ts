import {
  COACH_TOOL_NAMES,
  type CoachToolName,
  isWidgetTool,
  type Procedure,
  parseProcedure,
} from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import type { Narration } from '../../src/domain/coach/agent';
import { Narrator, type NarratorOptions } from '../../src/domain/coach/narrator';
import type { LessonView } from '../../src/domain/coach/ports';
import { buildSystemInstruction } from '../../src/domain/coach/prompt';
import { CoachSession } from '../../src/domain/coach/session';
import { CoachToolbox, type ToolHandlers } from '../../src/domain/coach/toolbox';
import type { AppEvents } from '../../src/domain/events';
import { type PlanView, recitePlan } from '../../src/domain/plan/recital';
import { WidgetBoard } from '../../src/domain/widgets/board';
import { FakeAgent } from '../support/fake-agent';

// What the coach hears about the learner's widgets: the narrations of a timer running out and of
// touched answers and ticks, a stuck nudge held while a timer runs, and what is on screen in
// cancel notices and the reconnect recap. The prompt describes the widget tools only when it has
// them.

/** Arrow, bullet and middle-dot symbols never reach the model (as in coach.test.ts). */
const SYMBOLS = /[→←↑↓➜⟶·•]/;

const procedure: Procedure = parseProcedure({
  schema: 'clio.procedure/1',
  id: 'ph',
  version: 1,
  title: 'pH test',
  summary: 'S',
  workspace: { size: [1, 1] },
  objects: [{ id: 'cup_a', label: 'cup A', placement: { method: 'detect' } }],
  steps: [
    { id: 'acid', instruction: 'Add vinegar to cup A.', success: { type: 'elapsed', ms: 10 } },
  ],
});

const plan: PlanView = {
  goal: 'Test an acid',
  title: 'pH test',
  rev: 1,
  focusId: 'acid',
  materials: [{ id: 'cup_a', label: 'cup A' }],
  steps: [
    { id: 'acid', instruction: 'Add vinegar to cup A.', status: 'todo', uses: [], demo: false },
  ],
};

const view = (current: PlanView | null = plan): LessonView => ({
  procedure: () => procedure,
  label: (id) => id,
  plan: () => current,
});

function narrator(options: NarratorOptions = {}, lesson: LessonView = view()) {
  const bus = new Emitter<AppEvents>();
  const out: Narration[] = [];
  const n = new Narrator(bus, lesson, (narration) => out.push(narration), options);
  n.attach();
  return { bus, out, tick: (t: number) => n.tick(t) };
}

const STUCK = '[app] They have been on this step for 120 s. Offer one tip, or ask what is unclear.';

describe('Narrator: widgets', () => {
  it('tells a trusted coach when a timer runs out, and asks it to say so', () => {
    const { bus, out } = narrator({ perception: 'trusted' });
    bus.emit('widget.timer_done', {
      t: 1,
      widgetId: 'timer',
      label: 'Glue sets',
      duration: '2:00',
    });
    expect(out).toEqual([
      {
        kind: 'timer_done',
        text: '[app] Timer "Glue sets" is up (2:00). Tell them in a few words, then carry on.',
        reply: true,
        data: { widgetId: 'timer', label: 'Glue sets' },
      },
    ]);
  });

  it('passes on an answer they touched, and stays silent about one they said', () => {
    const { bus, out } = narrator({ perception: 'trusted' });
    const chosen = { t: 1, widgetId: 'choices', question: 'Which screwdriver do you have?' };
    bus.emit('widget.chosen', { ...chosen, option: 'Flat', via: 'voice' });
    expect(out).toEqual([]);
    bus.emit('widget.chosen', { ...chosen, option: 'Phillips', via: 'touch' });
    expect(out).toEqual([
      {
        kind: 'choice',
        text: '[app] They touched "Phillips" for your question "Which screwdriver do you have?". Reply as if they had said it.',
        reply: true,
        data: { widgetId: 'choices', option: 'Phillips' },
      },
    ]);
  });

  it('notes a tick or an untick as context, and asks it to speak once everything is ticked', () => {
    const { bus, out } = narrator();
    const ticked = { t: 1, widgetId: 'checklist', title: 'Gather', total: 3 };
    bus.emit('widget.ticked', { ...ticked, item: 'funnel', done: true, doneCount: 2 });
    bus.emit('widget.ticked', { ...ticked, item: 'funnel', done: false, doneCount: 1 });
    bus.emit('widget.ticked', { ...ticked, item: 'rag', done: true, doneCount: 3 });
    expect(out).toEqual([
      {
        kind: 'checklist',
        text: '[app] They ticked "funnel" on "Gather" (2 of 3).',
        reply: false,
        data: { widgetId: 'checklist', item: 'funnel' },
      },
      {
        kind: 'checklist',
        text: '[app] They unticked "funnel" on "Gather" (1 of 3).',
        reply: false,
        data: { widgetId: 'checklist', item: 'funnel' },
      },
      {
        kind: 'checklist',
        text: '[app] They ticked everything on "Gather". Acknowledge it in a few words and go on.',
        reply: true,
        data: { widgetId: 'checklist', title: 'Gather' },
      },
    ]);
    for (const n of out) expect(n.text).not.toMatch(SYMBOLS);
  });

  it('gives the stuck nudge at once while no timer runs', () => {
    const { bus, out } = narrator({ waiting: () => false });
    bus.emit('step.stuck', { t: 120_000, stepId: 'acid', elapsedMs: 120_000 });
    expect(out).toEqual([{ kind: 'stuck', text: STUCK, reply: true }]);
  });

  it('holds the stuck nudge while a timer runs, and gives it once 20 s after the last ends', () => {
    let waiting = true;
    const { bus, out, tick } = narrator({ waiting: () => waiting });
    bus.emit('step.stuck', { t: 60_000, stepId: 'acid', elapsedMs: 60_000 });
    tick(90_000);
    expect(out).toEqual([]);
    waiting = false;
    tick(100_000);
    tick(119_999);
    expect(out).toEqual([]);
    // The same words, with the time they have really been on the step.
    tick(120_000);
    expect(out).toEqual([{ kind: 'stuck', text: STUCK, reply: true }]);
    tick(200_000);
    expect(out).toHaveLength(1);
  });

  it('waits again for a timer that starts before the held nudge goes out', () => {
    let waiting = true;
    const { bus, out, tick } = narrator({ waiting: () => waiting });
    bus.emit('step.stuck', { t: 0, stepId: 'acid', elapsedMs: 30_000 });
    waiting = false;
    tick(10_000);
    tick(25_000);
    waiting = true;
    tick(26_000);
    waiting = false;
    tick(70_000);
    tick(89_999);
    expect(out).toEqual([]);
    tick(90_000);
    expect(out).toEqual([{ kind: 'stuck', text: STUCK, reply: true }]);
  });

  it('drops a held nudge when the step changes or the lesson ends, not for a revision', () => {
    const ends: ((bus: Emitter<AppEvents>) => void)[] = [
      (b) =>
        b.emit('step.entered', { t: 1, stepId: 'acid', index: 0, instruction: 'x', targets: [] }),
      (b) => b.emit('procedure.completed', { t: 1, durationMs: 1000 }),
      (b) => b.emit('procedure.aborted', { t: 1, reason: 'user' }),
      (b) => b.emit('plan.requested', { t: 1, goal: 'Fold a shirt', revision: false }),
    ];
    for (const end of ends) {
      let waiting = true;
      const { bus, out, tick } = narrator({ waiting: () => waiting });
      bus.emit('step.stuck', { t: 0, stepId: 'acid', elapsedMs: 120_000 });
      end(bus);
      waiting = false;
      tick(1000);
      tick(100_000);
      expect(out.filter((n) => n.kind === 'stuck')).toEqual([]);
    }

    let waiting = true;
    const { bus, out, tick } = narrator({ waiting: () => waiting });
    bus.emit('step.stuck', { t: 0, stepId: 'acid', elapsedMs: 100_000 });
    bus.emit('plan.requested', { t: 1, goal: 'Test an acid', revision: true });
    waiting = false;
    tick(0);
    tick(20_000);
    expect(out.map((n) => n.kind)).toEqual(['stuck']);
  });

  it('drops a held nudge whose step is no longer the focus when it is due', () => {
    let waiting = true;
    let focusId: string | null = 'acid';
    const lesson: LessonView = { ...view(), plan: () => ({ ...plan, focusId }) };
    const { bus, out, tick } = narrator({ waiting: () => waiting }, lesson);
    bus.emit('step.stuck', { t: 0, stepId: 'acid', elapsedMs: 120_000 });
    waiting = false;
    tick(0);
    focusId = null;
    tick(20_000);
    focusId = 'acid';
    tick(40_000);
    expect(out).toEqual([]);
  });

  it('words what the board reports, with the board on the same bus', () => {
    const bus = new Emitter<AppEvents>();
    const clock = new ManualClock(0);
    const out: Narration[] = [];
    const board = new WidgetBoard({ bus, clock, view: view() });
    board.attach();
    new Narrator(bus, view(), (n) => out.push(n), { perception: 'trusted' }).attach();
    const tools = board.handlers();
    tools.show_timer({ seconds: 30, label: 'Tea' }, { callId: 'c1' });
    tools.show_choices(
      { question: 'Which screwdriver do you have?', options: ['Phillips', 'Flat'] },
      { callId: 'c2' },
    );
    board.touch({ type: 'choose', widgetId: 'choices', index: 1, hand: 'right' });
    board.tick(30_000);
    expect(out.map((n) => n.text)).toEqual([
      '[app] They touched "Flat" for your question "Which screwdriver do you have?". Reply as if they had said it.',
      '[app] Timer "Tea" is up (0:30). Tell them in a few words, then carry on.',
    ]);
  });
});

describe('CoachSession: widgets', () => {
  function lessonTools(): ToolHandlers {
    const ok = async () => ({ ok: true as const, result: {} });
    return {
      start_lesson: ok,
      end_lesson: ok,
      revise_plan: ok,
      add_step: ok,
      update_step: ok,
      complete_step: ok,
      add_material: ok,
      highlight: ok,
      show_demo: ok,
      flag_mistake: ok,
    };
  }

  async function setup({
    kind = 'gemini',
    widgets = true,
    tools,
    lesson,
  }: {
    kind?: 'gemini' | 'scripted';
    widgets?: boolean;
    tools?: readonly CoachToolName[];
    lesson?: Partial<ToolHandlers>;
  } = {}) {
    const bus = new Emitter<AppEvents>();
    const seen: { type: string; payload: Record<string, unknown> }[] = [];
    bus.onAny((type, payload) =>
      seen.push({ type: String(type), payload: payload as Record<string, unknown> }),
    );
    const clock = new ManualClock(0);
    const agent = new FakeAgent(kind);
    const board = new WidgetBoard({ bus, clock, view: view() });
    board.attach();
    const session = new CoachSession({
      agent,
      toolbox: new CoachToolbox(
        { ...lessonTools(), ...lesson, ...(widgets ? board.handlers() : {}) },
        bus,
        clock,
      ),
      bus,
      clock,
      view: view(),
      voice: { play: () => {}, say: () => {}, stop: () => {} },
      ...(widgets ? { widgets: board } : {}),
      ...(tools ? { tools } : {}),
    });
    await session.start();
    return { agent, bus, board, clock, seen, session };
  }

  const settle = () => new Promise((r) => setTimeout(r, 0));

  async function cancel(agent: FakeAgent, calls: { id: string; name: string; args: object }[]) {
    agent.events.emit('toolCalls', {
      calls: calls.map((c) => ({ ...c, args: c.args as Record<string, unknown> })),
    });
    await settle();
    agent.events.emit('interrupted', {});
    agent.events.emit('cancelledTools', { ids: calls.map((c) => c.id) });
    await settle();
  }

  const GLUE = { seconds: 120, label: 'Glue sets' };

  it('tells the coach a cancelled widget call stuck, with what is on screen and no recital', async () => {
    const { agent, seen, board } = await setup();
    await cancel(agent, [{ id: 'c1', name: 'show_timer', args: GLUE }]);
    expect(board.snapshot().widgets).toHaveLength(1);
    expect(agent.narrations).toEqual([
      {
        kind: 'cancelled',
        text: '[app] Your show_timer call was already applied. On screen: timer "Glue sets" 2:00 left.',
        reply: false,
      },
    ]);
    expect(
      seen.filter((e) => e.payload.label === 'coach.tool_cancelled').map((e) => e.payload.data),
    ).toEqual([{ callId: 'c1', name: 'show_timer' }]);
  });

  it('reports a widget call still running when it was cancelled, once it succeeds', async () => {
    const { agent, seen } = await setup();
    const labels = () =>
      seen.filter((e) => e.payload.label === 'coach.tool_cancelled').map((e) => e.payload.data);
    agent.events.emit('toolCalls', {
      calls: [{ id: 'c1', name: 'show_value', args: { label: 'Torque', value: '25 N m' } }],
    });
    agent.events.emit('interrupted', {});
    agent.events.emit('cancelledTools', { ids: ['c1'] });
    // Recorded at once, as a plan call is: its change sticks whatever it answers.
    expect(labels()).toEqual([{ callId: 'c1', name: 'show_value' }]);
    await settle();
    expect(labels()).toHaveLength(1);
    expect(agent.narrations.map((n) => n.text)).toEqual([
      '[app] Your show_value call was already applied. On screen: value "Torque" 25 N m.',
    ]);
  });

  it('recites the plan for a cancelled highlight that added a material, beside a widget call', async () => {
    const { agent } = await setup({
      lesson: {
        highlight: async ({ object_id }) => ({
          ok: true,
          result:
            object_id === 'funnel'
              ? { shown: false, material_id: 'funnel', added: true }
              : { shown: true },
        }),
      },
    });
    await cancel(agent, [
      { id: 'c1', name: 'highlight', args: { object_id: 'funnel', look_for: 'white funnel' } },
      { id: 'c2', name: 'show_timer', args: GLUE },
    ]);
    // A plain highlight changed nothing: only what is on screen.
    await cancel(agent, [
      { id: 'c3', name: 'highlight', args: { object_id: 'acid' } },
      { id: 'c4', name: 'show_value', args: { label: 'Torque', value: '25 N m' } },
    ]);
    expect(agent.narrations.map((n) => n.text)).toEqual([
      `[app] Your highlight, show_timer calls were already applied. ${recitePlan(plan)} On screen: timer "Glue sets" 2:00 left.`,
      '[app] Your show_value call was already applied. On screen: timer "Glue sets" 2:00 left; value "Torque" 25 N m.',
    ]);
  });

  it('keeps the notice for a cancelled plan call exactly as it was, widgets or not', async () => {
    const { agent, board } = await setup();
    board.handlers().show_timer(GLUE, { callId: 'c0' });
    await cancel(agent, [
      {
        id: 'c1',
        name: 'complete_step',
        args: { step_id: 'acid', reason: 'pink', evidence: 'seen' },
      },
    ]);
    expect(agent.narrations).toEqual([
      {
        kind: 'cancelled',
        text: `[app] Your complete_step call was already applied. ${recitePlan(plan)}`,
        reply: false,
      },
    ]);
  });

  it('gives the recital and what is on screen when both kinds were cancelled', async () => {
    const { agent } = await setup();
    await cancel(agent, [
      {
        id: 'c1',
        name: 'complete_step',
        args: { step_id: 'acid', reason: 'pink', evidence: 'seen' },
      },
      { id: 'c2', name: 'show_timer', args: GLUE },
    ]);
    expect(agent.narrations.map((n) => n.text)).toEqual([
      `[app] Your complete_step, show_timer calls were already applied. ${recitePlan(plan)} On screen: timer "Glue sets" 2:00 left.`,
    ]);
  });

  it('says nothing about a widget call that failed', async () => {
    const { agent } = await setup();
    await cancel(agent, [{ id: 'c1', name: 'clear_widget', args: { widget_id: 'paint' } }]);
    expect(agent.narrations).toEqual([]);
  });

  it('adds what is on screen to the reconnect recap, only while something shows', async () => {
    const { agent, board, clock } = await setup();
    agent.events.emit('status', { state: 'reconnecting' });
    agent.events.emit('status', { state: 'ready' });
    await settle();
    expect(agent.narrations.map((n) => n.text)).toEqual([`[app] Reconnected. ${recitePlan(plan)}`]);

    board.handlers().show_timer(GLUE, { callId: 'c1' });
    clock.advance(8000);
    agent.events.emit('status', { state: 'reconnecting' });
    agent.events.emit('status', { state: 'ready' });
    await settle();
    expect(agent.narrations.at(-1)?.text).toBe(
      `[app] Reconnected. ${recitePlan(plan)} On screen: timer "Glue sets" 1:52 left.`,
    );
    expect(agent.narrations.at(-1)?.text).not.toMatch(SYMBOLS);
  });

  it('holds the stuck nudge while a widget timer runs, and gives it 20 s after it ends', async () => {
    const { agent, bus, board, clock, session } = await setup({ kind: 'scripted' });
    board.handlers().show_timer({ seconds: 30, label: 'Tea' }, { callId: 'c1' });
    bus.emit('step.stuck', { t: 0, stepId: 'acid', elapsedMs: 15_000 });
    session.tick(clock.advance(10_000));
    expect(agent.narrations).toEqual([]);
    // The frame's decide step: the board, then the session.
    board.tick(clock.advance(20_000));
    session.tick(clock.now());
    session.tick(clock.advance(19_999));
    expect(agent.narrations.map((n) => n.kind)).toEqual(['timer_done']);
    session.tick(clock.advance(1));
    expect(agent.narrations.map((n) => n.text)).toEqual([
      '[app] Timer "Tea" is up (0:30). Tell them in a few words, then carry on.',
      '[app] They have been on this step for 65 s. Offer one tip, or ask what is unclear.',
    ]);
  });

  it('counts a timer the coach cleared as the end of the wait', async () => {
    const { agent, bus, board, clock, session } = await setup({ kind: 'scripted' });
    board.handlers().show_timer(GLUE, { callId: 'c1' });
    bus.emit('step.stuck', { t: 0, stepId: 'acid', elapsedMs: 15_000 });
    clock.advance(5000);
    board.handlers().clear_widget({ widget_id: 'timer' }, { callId: 'c2' });
    session.tick(clock.now());
    session.tick(clock.advance(19_999));
    expect(agent.narrations).toEqual([]);
    session.tick(clock.advance(1));
    expect(agent.narrations.map((n) => n.kind)).toEqual(['stuck']);
  });

  it('declares the widget tools and describes them, unless it is given tools without them', async () => {
    const all = await setup();
    expect(all.agent.setup?.tools).toEqual(COACH_TOOL_NAMES);
    expect(all.agent.setup?.systemInstruction).toBe(buildSystemInstruction({ plan }));
    expect(all.agent.setup?.systemInstruction).toContain('8. Beside the step card');

    const tools = COACH_TOOL_NAMES.filter((n) => !isWidgetTool(n));
    const none = await setup({ widgets: false, tools });
    expect(none.agent.setup?.tools).toEqual(tools);
    const prompt = none.agent.setup?.systemInstruction ?? '';
    expect(prompt).toBe(buildSystemInstruction({ plan, widgets: false }));
    expect(prompt).not.toContain('8. Beside the step card');
    expect(prompt).not.toMatch(/show_timer|clear_widget|widget/);

    // A rebuilt instruction keeps to the same tools.
    none.agent.events.emit('status', { state: 'reconnecting' });
    expect(none.agent.instructions.at(-1)).toBe(prompt);
  });
});

describe('system prompt: widgets', () => {
  it('puts item 8 before the style paragraph, and the plan still last', () => {
    const prompt = buildSystemInstruction({ plan });
    const item = prompt.indexOf('8. Beside the step card');
    expect(item).toBeGreaterThan(prompt.indexOf('7. Take "no" at once'));
    expect(item).toBeLessThan(prompt.indexOf('Style:'));
    expect(prompt).toContain('widget ids aloud.\n\nStyle:');
    expect(
      prompt.endsWith(
        `Lesson plan (snapshot from when this connection started; newer [app] messages and tool results win):\n${recitePlan(plan)}`,
      ),
    ).toBe(true);
    expect(prompt).not.toMatch(SYMBOLS);
  });

  it('leaves item 8 out without widgets, and nothing else changes', () => {
    const off = buildSystemInstruction({ plan, widgets: false });
    const on = buildSystemInstruction({ plan });
    expect(off).not.toContain('8. Beside the step card');
    expect(off).toContain('call end_lesson and\n   ask in a few words.\n\nStyle:');
    expect(on.replace(/8\. Beside the step card[\s\S]*?widget ids aloud\.\n/, '')).toBe(off);
  });
});
