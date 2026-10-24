import { type Procedure, parseProcedure } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import type { Narration } from '../../src/domain/coach/agent';
import { Narrator } from '../../src/domain/coach/narrator';
import { buildSystemInstruction } from '../../src/domain/coach/prompt';
import { CoachSession } from '../../src/domain/coach/session';
import { CoachToolbox, type ToolHandlers } from '../../src/domain/coach/toolbox';
import type { AppEvents } from '../../src/domain/events';
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
      targets: ['vinegar', 'cup_a'],
      show: [
        { object: 'vinegar', phrase: 'white vinegar bottle', description: 'Clear bottle, red cap' },
        { object: 'cup_a', phrase: 'cup labeled A', description: 'Clear cup with an A on it' },
      ],
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
});

function handlers(log: string[] = []): ToolHandlers {
  const ok = (name: string) => async (args: unknown) => {
    log.push(`${name} ${JSON.stringify(args)}`);
    return { ok: true as const, result: { done: name } };
  };
  return {
    start_lesson: ok('start_lesson'),
    revise_plan: ok('revise_plan'),
    highlight: ok('highlight'),
    show_demo: ok('show_demo'),
    advance_step: ok('advance_step'),
    flag_mistake: ok('flag_mistake'),
  };
}

const view = {
  procedure: () => procedure,
  label: (id: string) => procedure.objects.find((o) => o.id === id)?.label ?? id,
};

function bus() {
  const b = new Emitter<AppEvents>();
  const seen: { type: string; payload: Record<string, unknown> }[] = [];
  b.onAny((type, payload) =>
    seen.push({ type: String(type), payload: payload as Record<string, unknown> }),
  );
  return { b, seen };
}

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
    const result = await box.handle({ id: 'c2', name: 'advance_step', args: {} });
    expect(log).toEqual([]);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.result)).toMatch(/reason/);
    expect(seen.find((e) => e.type === 'coach.tool_result')?.payload).toMatchObject({ ok: false });
  });
});

describe('Narrator', () => {
  function setup() {
    const { b, seen } = bus();
    const out: Narration[] = [];
    const narrator = new Narrator(b, view, (n) => out.push(n), { pinchThrottleMs: 2000 });
    narrator.attach();
    return { b, seen, out };
  }

  it('briefs the coach when a step starts and asks it to speak', () => {
    const { b, out } = setup();
    b.emit('step.entered', {
      t: 0,
      stepId: 'acid',
      index: 0,
      instruction: 'Add vinegar to cup A.',
      targets: ['vinegar', 'cup_a'],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.reply).toBe(true);
    expect(out[0]?.text).toContain('Step 1/2');
    expect(out[0]?.text).toContain('Add vinegar to cup A.');
    expect(out[0]?.text).toContain('vinegar bottle, cup A');
    expect(out[0]?.text).toContain('Watch for cup B.');
  });

  it('tells the coach what is outlined for the learner, so it can refer to it', () => {
    const { b, out } = setup();
    const enter = (index: number, stepId: string) =>
      b.emit('step.entered', { t: 0, stepId, index, instruction: 'x', targets: [] });
    enter(0, 'acid');
    expect(out[0]?.text).toContain(
      'Outlined in AR: white vinegar bottle, then cup labeled A (once the camera finds them).',
    );
    enter(1, 'look');
    expect(out[1]?.text).not.toContain('Outlined');
  });

  it('folds a detected completion into the next step briefing', () => {
    const { b, out } = setup();
    b.emit('step.completed', {
      t: 5,
      stepId: 'acid',
      index: 0,
      by: 'check',
      forced: false,
      durationMs: 5,
    });
    b.emit('step.entered', {
      t: 5,
      stepId: 'look',
      index: 1,
      instruction: 'Check the color.',
      targets: ['cup_a'],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toMatch(/Step 1 done/);
    expect(out[0]?.text).toMatch(/advance_step/);
  });

  it('keeps pinch chatter to one note per throttle window, without asking for a reply', () => {
    const { b, out } = setup();
    const pinch = (t: number) =>
      b.emit('hand.pinch', {
        t,
        hand: 'right',
        phase: 'start',
        point: [0, 0, 0],
        nearest: { objectId: 'cup_a', distance: 0.02 },
      });
    pinch(0);
    pinch(500);
    pinch(2500);
    expect(out.map((n) => [n.kind, n.reply])).toEqual([
      ['pinch', false],
      ['pinch', false],
    ]);
  });

  it('asks for help with missing objects and when the learner is stuck', () => {
    const { b, out } = setup();
    b.emit('object.missing', { t: 0, objectIds: ['vinegar'] });
    b.emit('step.stuck', { t: 1, stepId: 'acid', elapsedMs: 15000 });
    expect(out[0]?.text).toContain('vinegar bottle');
    expect(out[1]?.text).toContain('show_demo');
  });

  it('records every narration as model input on the bus', () => {
    const { b, seen } = setup();
    b.emit('step.stuck', { t: 3, stepId: 'acid', elapsedMs: 15000 });
    expect(seen.filter((e) => e.type === 'coach.narration').map((e) => e.payload.kind)).toEqual([
      'stuck',
    ]);
  });
});

describe('CoachSession', () => {
  async function setup() {
    const { b, seen } = bus();
    const agent = new FakeAgent();
    const played: string[] = [];
    const clock = new ManualClock(0);
    const frames: string[] = [];
    let micHandler: ((pcm: Int16Array) => void) | null = null;
    const session = new CoachSession({
      agent,
      toolbox: new CoachToolbox(handlers(), b, clock),
      bus: b,
      clock,
      view,
      voice: {
        play: (pcm) => played.push(`pcm:${pcm.length}`),
        say: (text) => played.push(`say:${text}`),
        stop: () => played.push('stop'),
      },
      mic: {
        start: async (onChunk) => {
          micHandler = onChunk;
        },
        stop: () => {},
      },
      camera: { snapshot: async () => `frame${frames.push('x')}` },
    });
    await session.start();
    return { agent, b, seen, played, session, clock, mic: () => micHandler };
  }

  it('connects with the system prompt and every coach tool, and streams the mic', async () => {
    const { agent, mic } = await setup();
    expect(agent.setup?.tools).toEqual([
      'start_lesson',
      'revise_plan',
      'highlight',
      'show_demo',
      'advance_step',
      'flag_mistake',
    ]);
    mic()?.(new Int16Array(320));
    expect(agent.audio).toHaveLength(1);
  });

  it('answers tool calls through the agent', async () => {
    const { agent } = await setup();
    agent.events.emit('toolCalls', { calls: [{ id: 'c1', name: 'show_demo', args: {} }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(agent.responses).toMatchObject([{ id: 'c1', name: 'show_demo', ok: true }]);
  });

  it('plays coach speech and cuts it off when the user interrupts', async () => {
    const { agent, played } = await setup();
    agent.events.emit('audio', { pcm: new Int16Array(480), sampleRate: 24000 });
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

  it('sends camera frames faster while a step waits on a visual confirmation', async () => {
    const { agent, b, session, clock } = await setup();
    const run = async (untilMs: number) => {
      while (clock.now() < untilMs) {
        session.tick(clock.advance(100));
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    b.emit('step.entered', {
      t: clock.now(),
      stepId: 'acid',
      index: 0,
      instruction: 'x',
      targets: [],
    });
    await run(4000);
    const periodic = agent.images.length;
    b.emit('step.entered', {
      t: clock.now(),
      stepId: 'look',
      index: 1,
      instruction: 'x',
      targets: [],
    });
    await run(8000);
    expect(periodic).toBe(1);
    expect(agent.images.length - periodic).toBe(4);
  });
});

describe('system prompt', () => {
  it('explains every tool and that [app] messages are sensor facts', () => {
    const prompt = buildSystemInstruction({});
    for (const tool of [
      'start_lesson',
      'revise_plan',
      'highlight',
      'show_demo',
      'advance_step',
      'flag_mistake',
    ]) {
      expect(prompt).toContain(tool);
    }
    expect(prompt).toContain('[app]');
    expect(prompt).toContain('outlines the real objects each step is about');
  });
});

describe('Narrator registration feedback', () => {
  it('lets the coach acknowledge an object registered by pinch', () => {
    const { b } = bus();
    const out: Narration[] = [];
    new Narrator(b, view, (n) => out.push(n)).attach();
    b.emit('object.registered', {
      t: 0,
      objectId: 'vinegar',
      position: [0, 0, 0],
      method: 'pinch',
    });
    b.emit('object.registered', {
      t: 1,
      objectId: 'cup_a',
      position: [0, 0, 0],
      method: 'detector',
    });
    expect(out.map((n) => n.text)).toEqual([
      '[app] Registered the vinegar bottle where they pinched.',
    ]);
  });
});
