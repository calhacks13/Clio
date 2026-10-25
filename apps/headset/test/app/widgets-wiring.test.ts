import { COACH_TOOL_NAMES, isWidgetTool, parseProcedure, WIDGET_TOOL_NAMES } from '@clio/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coachHandlers, coachWidgets } from '../../src/app/clio-app';
import { installWidgetDebug, SAMPLE_ARGS } from '../../src/app/widget-debug';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import type { Narration } from '../../src/domain/coach/agent';
import { Narrator } from '../../src/domain/coach/narrator';
import type { LessonView } from '../../src/domain/coach/ports';
import { CoachSession } from '../../src/domain/coach/session';
import {
  type CoachOwnToolHandlers,
  CoachToolbox,
  type ToolHandlers,
} from '../../src/domain/coach/toolbox';
import type { AppEvents } from '../../src/domain/events';
import type { PlanView } from '../../src/domain/plan/recital';
import { WidgetBoard } from '../../src/domain/widgets/board';
import type { WidgetAnnotation } from '../../src/domain/widgets/types';
import { FakeAgent } from '../support/fake-agent';

// How the app puts the coach's widgets together (clio-app.ts): the board's tools merged into the
// coach's toolbox, its narrations through the narrator, the session told what is on screen or,
// with ?widgets=0, given no widget tools at all; and window.__widgets, the debug hook that shows
// them without a conversation and never as the coach.

const procedure = parseProcedure({
  schema: 'clio.procedure/1',
  id: 'washer',
  version: 1,
  title: 'Refill',
  summary: 'S',
  workspace: { size: [1, 1] },
  objects: [{ id: 'bottle', label: 'washer fluid bottle', placement: { method: 'detect' } }],
  steps: [{ id: 'open', instruction: 'Open the cap.', success: { type: 'confirm' } }],
});

const plan: PlanView = {
  goal: 'Refill the washer fluid',
  title: 'Refill',
  rev: 1,
  focusId: 'open',
  materials: [{ id: 'bottle', label: 'washer fluid bottle' }],
  steps: [{ id: 'open', instruction: 'Open the cap.', status: 'todo', uses: [], demo: false }],
};

const view: LessonView = {
  procedure: () => procedure,
  label: (id) => id,
  plan: () => plan,
};

/** A board on a bus that remembers everything emitted on it. */
function board() {
  const bus = new Emitter<AppEvents>();
  const clock = new ManualClock(1000);
  const seen: { type: string; payload: Record<string, unknown> }[] = [];
  bus.onAny((type, payload) =>
    seen.push({ type: String(type), payload: payload as Record<string, unknown> }),
  );
  const widgets = new WidgetBoard({ bus, clock, view });
  widgets.attach();
  const annotations = () =>
    seen
      .filter((e) => e.type === 'annotation' && e.payload.label === 'widget.updated')
      .map((e) => e.payload.data as WidgetAnnotation);
  return { bus, clock, seen, widgets, annotations };
}

const ok = async () => ({ ok: true as const, result: {} });

const lessonTools = (): ToolHandlers => ({
  start_lesson: ok,
  revise_plan: ok,
  add_step: ok,
  update_step: ok,
  complete_step: ok,
  add_material: ok,
  highlight: ok,
  show_demo: ok,
  flag_mistake: ok,
});

const ownTools = (): CoachOwnToolHandlers => ({ look_closer: ok });

const voice = { play: () => {}, say: () => {}, stop: () => {} };

/** The toolbox and narrator as the app builds them, on one bus with the board. */
function wired() {
  const parts = board();
  const { bus, clock, widgets } = parts;
  const toolbox = new CoachToolbox(coachHandlers(lessonTools(), ownTools(), widgets), bus, clock);
  const heard: Narration[] = [];
  new Narrator(bus, view, (n) => heard.push(n), {
    perception: 'trusted',
    waiting: () => widgets.waiting(),
  }).attach();
  return { ...parts, toolbox, heard };
}

describe('the coach and the widgets, as the app wires them', () => {
  it('records a show_timer call around the change it made, and the board shows the timer', async () => {
    const { seen, widgets, toolbox } = wired();
    const args = { seconds: 120, label: 'Glue sets', object_id: 'bottle' };
    const answer = await toolbox.handle({ id: 'c1', name: 'show_timer', args });
    expect(answer).toMatchObject({
      id: 'c1',
      ok: true,
      result: { widget_id: 'timer', ends_in: '2:00', on_screen: 'timer "Glue sets" 2:00 left' },
    });
    expect(seen.map((e) => e.type)).toEqual(['coach.tool_call', 'annotation', 'coach.tool_result']);
    expect(seen[0]?.payload).toMatchObject({ callId: 'c1', name: 'show_timer', args });
    expect(seen[1]?.payload).toMatchObject({
      label: 'widget.updated',
      data: { op: 'show', id: 'timer', by: 'coach', callId: 'c1' },
    });
    expect(seen[2]?.payload).toMatchObject({ callId: 'c1', name: 'show_timer', ok: true });
    expect(widgets.snapshot().widgets).toEqual([
      expect.objectContaining({ kind: 'timer', label: 'Glue sets', objectId: 'bottle' }),
    ]);
  });

  it('tells the coach a timer ran out on the frame it did, after recording it', async () => {
    const { clock, seen, widgets, toolbox, heard } = wired();
    await toolbox.handle({ id: 'c1', name: 'show_timer', args: { seconds: 30, label: 'Tea' } });
    const start = clock.now();
    widgets.tick(start + 29_000);
    expect(heard).toEqual([]);
    expect(widgets.waiting()).toBe(true);

    // A late frame: the timer still ends at its exact time.
    widgets.tick(start + 30_400);
    expect(heard).toEqual([
      {
        kind: 'timer_done',
        text: '[app] Timer "Tea" is up (0:30). Tell them in a few words, then carry on.',
        reply: true,
        data: { widgetId: 'timer', label: 'Tea' },
      },
    ]);
    expect(widgets.waiting()).toBe(false);
    const done = seen.findIndex(
      (e) => e.type === 'annotation' && (e.payload.data as WidgetAnnotation).op === 'done',
    );
    expect(seen[done]?.payload).toMatchObject({
      t: start + 30_400,
      label: 'widget.updated',
      data: { op: 'done', id: 'timer', by: 'app', widget: { status: 'done', remainingMs: 0 } },
    });
    expect(seen.findIndex((e) => e.type === 'widget.timer_done')).toBeGreaterThan(done);
    expect(widgets.snapshot().widgets[0]).toMatchObject({ doneT: start + 30_000 });
  });

  it('passes an answer touched on the dock to the coach', async () => {
    const { widgets, toolbox, heard, annotations } = wired();
    await toolbox.handle({
      id: 'c1',
      name: 'show_choices',
      args: { question: 'Which screwdriver do you have?', options: ['Phillips', 'Flat'] },
    });
    // What the dock's onIntent does in the app.
    widgets.touch({ type: 'choose', widgetId: 'choices', index: 0, hand: 'right' });
    expect(heard).toEqual([
      {
        kind: 'choice',
        text: '[app] They touched "Phillips" for your question "Which screwdriver do you have?". Reply as if they had said it.',
        reply: true,
        data: { widgetId: 'choices', option: 'Phillips' },
      },
    ]);
    expect(annotations().at(-1)).toMatchObject({ op: 'choose', by: 'learner', hand: 'right' });
  });

  it('gives a session with the board every coach tool, item 7 and what is on screen', async () => {
    const { bus, clock, widgets, toolbox } = wired();
    expect(coachWidgets(widgets)).toEqual({ widgets });
    const agent = new FakeAgent('gemini');
    const session = new CoachSession({
      agent,
      toolbox,
      bus,
      clock,
      view,
      voice,
      ...coachWidgets(widgets),
    });
    await session.start();
    expect(agent.setup?.tools).toEqual(COACH_TOOL_NAMES);
    expect(agent.setup?.systemInstruction).toContain('7. Beside the step card');

    agent.events.emit('toolCalls', {
      calls: [{ id: 'c1', name: 'show_value', args: { label: 'Torque', value: '25 N m' } }],
    });
    agent.events.emit('interrupted', {});
    agent.events.emit('cancelledTools', { ids: ['c1'] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agent.narrations.map((n) => n.text)).toEqual([
      '[app] Your show_value call was already applied. On screen: value "Torque" 25 N m.',
    ]);
  });

  it('with ?widgets=0 declares no widget tool, leaves item 7 out and refuses a stale call', async () => {
    const bus = new Emitter<AppEvents>();
    const clock = new ManualClock(0);
    const agent = new FakeAgent('gemini');
    const toolbox = new CoachToolbox(coachHandlers(lessonTools(), ownTools(), null), bus, clock);
    const session = new CoachSession({
      agent,
      toolbox,
      bus,
      clock,
      view,
      voice,
      ...coachWidgets(null),
    });
    await session.start();
    const tools = agent.setup?.tools ?? [];
    expect(tools).toEqual(COACH_TOOL_NAMES.filter((n) => !isWidgetTool(n)));
    for (const name of WIDGET_TOOL_NAMES) expect(tools).not.toContain(name);
    expect(tools).toContain('look_closer');
    const prompt = agent.setup?.systemInstruction ?? '';
    expect(prompt).not.toContain('7. Beside the step card');
    expect(prompt).not.toMatch(/show_timer|clear_widget/);

    // A model still holding an old declaration gets the toolbox's usual answer.
    const stale = await toolbox.handle({
      id: 'c2',
      name: 'show_timer',
      args: { seconds: 60, label: 'Tea' },
    });
    expect(stale).toMatchObject({
      ok: false,
      result: { error: 'show_timer is not available on this headset.' },
    });
  });
});

describe('window.__widgets', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is set in a browser and shows each kind with its sample arguments, never as the coach', () => {
    const win: { __widgets?: unknown } = {};
    vi.stubGlobal('window', win);
    const { seen, widgets, annotations } = board();
    const debug = installWidgetDebug(widgets);
    expect(win.__widgets).toBe(debug);

    const shown = debug.show('timer');
    expect(shown).toMatchObject({ ok: true, result: { widget_id: 'timer', ends_in: '2:00' } });
    expect(debug.list()).toEqual(widgets.snapshot().widgets);
    expect(debug.list().map((w) => w.kind)).toEqual(['timer']);
    expect(annotations()).toEqual([
      expect.objectContaining({ op: 'show', id: 'timer', by: 'debug' }),
    ]);
    expect(annotations()[0]).not.toHaveProperty('callId');
    // Nothing reads as a call the coach made.
    expect(seen.some((e) => e.type.startsWith('coach.'))).toBe(false);
  });

  it('works without a window (Node), and validates arguments as the coach tool does', () => {
    const { widgets } = board();
    const debug = installWidgetDebug(widgets);
    expect(debug.show('value', { label: 'Torque', value: '25.0 newton metres' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('Invalid arguments for show_value'),
    });
    expect(debug.show('progress', { label: 'Screws out', value: 3, total: 4 })).toMatchObject({
      ok: true,
      result: { progress: '3 of 4' },
    });
    expect(debug.list()).toHaveLength(1);
  });

  it('touches a choice or a checklist item as the learner, and ignores other widgets', () => {
    const { seen, widgets, annotations } = board();
    const debug = installWidgetDebug(widgets);
    debug.show('choices');
    debug.show('checklist');
    debug.show('value');

    debug.touch('choices', 1);
    debug.touch('checklist', 2, 'left');
    debug.touch('value', 0);
    debug.touch('caution', 0);

    expect(annotations().slice(3)).toEqual([
      expect.objectContaining({
        op: 'choose',
        by: 'learner',
        item: 1,
        hand: 'right',
        via: 'touch',
      }),
      expect.objectContaining({ op: 'tick', by: 'learner', item: 2, hand: 'left', via: 'touch' }),
    ]);
    expect(seen.find((e) => e.type === 'widget.chosen')?.payload).toMatchObject({
      option: 'Flat',
      via: 'touch',
    });
    expect(seen.find((e) => e.type === 'widget.ticked')?.payload).toMatchObject({
      item: 'Washer fluid',
      done: true,
    });
  });

  it('clears everything by default, or one widget by its id, kind or label', () => {
    const { widgets } = board();
    const debug = installWidgetDebug(widgets);
    debug.show('timer');
    debug.show('value');
    debug.show('caution');
    expect(debug.clear('Torque')).toMatchObject({ ok: true, result: { cleared: ['value'] } });
    expect(debug.clear()).toMatchObject({ ok: true, result: { cleared: ['timer', 'caution'] } });
    expect(debug.list()).toEqual([]);
    expect(debug.clear()).toMatchObject({
      ok: true,
      result: { cleared: [], on_screen: 'nothing' },
    });
  });

  it('demos the kinds asked for, in order, within the board caps', () => {
    const { widgets } = board();
    const debug = installWidgetDebug(widgets);
    debug.demo(['value', 'timer']);
    expect(debug.list().map((w) => w.id)).toEqual(['value', 'timer']);

    debug.clear();
    // Every kind: three fit, and each new one replaces the oldest that can go.
    debug.demo();
    expect(debug.list().map((w) => w.id)).toEqual(['timer', 'choices', 'caution']);
  });

  it('has sample arguments the coach tools accept for every kind', () => {
    const { widgets } = board();
    const debug = installWidgetDebug(widgets);
    for (const kind of Object.keys(SAMPLE_ARGS) as (keyof typeof SAMPLE_ARGS)[]) {
      expect(debug.show(kind).ok).toBe(true);
      debug.clear();
    }
  });
});
