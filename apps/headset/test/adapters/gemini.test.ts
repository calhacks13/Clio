import { COACH_TOOL_NAMES } from '@clio/protocol';
import { Behavior, FunctionResponseScheduling, ThinkingLevel } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import { toGeminiTools } from '../../src/adapters/gemini/declarations';
import { GeminiLiveAgent } from '../../src/adapters/gemini/gemini-live-agent';
import { liveModelTraits } from '../../src/adapters/gemini/live-model';
import { interpretServerMessage, TranscriptAggregator } from '../../src/adapters/gemini/messages';

// A fake Live API: every connect() opens a recording session the test can close from the server
// side, the way a dropped socket or a goAway recycle would.
const live = vi.hoisted(() => {
  class FakeSession {
    content: unknown[] = [];
    toolResponses: unknown[] = [];
    media: unknown[] = [];
    closed = false;
    sendClientContent(params: unknown) {
      this.content.push(params);
    }
    sendToolResponse(params: unknown) {
      this.toolResponses.push(params);
    }
    sendRealtimeInput(params: unknown) {
      this.media.push(params);
    }
    close() {
      this.closed = true;
    }
  }
  interface Connection {
    config: { systemInstruction?: unknown; tools?: unknown };
    session: FakeSession;
    /** Close it from the server side. */
    drop: () => void;
    /** A message from the server. */
    send: (msg: unknown) => void;
  }
  return { FakeSession, connections: [] as Connection[] };
});

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  interface ConnectParams {
    config: { systemInstruction?: unknown };
    callbacks: {
      onclose?: (e: { code: number; reason: string }) => void;
      onmessage?: (msg: unknown) => void;
    };
  }
  class GoogleGenAI {
    readonly live = {
      connect: async ({ config, callbacks }: ConnectParams) => {
        const session = new live.FakeSession();
        live.connections.push({
          config,
          session,
          drop: () => callbacks.onclose?.({ code: 1006, reason: 'dropped' }),
          send: (msg) => callbacks.onmessage?.(msg),
        });
        return session;
      },
    };
  }
  return { ...actual, GoogleGenAI };
});

describe('Gemini tool declarations', () => {
  const [tools] = toGeminiTools(['start_lesson', 'highlight']);
  const decls = tools?.functionDeclarations ?? [];

  it('converts tool argument schemas to Gemini schema format', () => {
    const highlight = decls.find((d) => d.name === 'highlight');
    expect(highlight?.parameters).toMatchObject({
      type: 'OBJECT',
      required: ['object_id'],
      properties: {
        object_id: { type: 'STRING' },
        style: { type: 'STRING', enum: ['target', 'attention', 'warning'] },
      },
    });
  });

  it('declares the tools that answer at once blocking, and look_closer non-blocking', () => {
    const all = toGeminiTools(COACH_TOOL_NAMES)[0]?.functionDeclarations ?? [];
    expect(all.map((d) => d.name)).toEqual(COACH_TOOL_NAMES);
    for (const d of all) {
      expect(d.behavior, d.name).toBe(
        d.name === 'look_closer' ? Behavior.NON_BLOCKING : Behavior.BLOCKING,
      );
    }
  });

  it('leaves behavior out for a model that refuses it', () => {
    const all = toGeminiTools(COACH_TOOL_NAMES, { behavior: false })[0]?.functionDeclarations;
    expect(all?.map((d) => d.name)).toEqual(COACH_TOOL_NAMES);
    for (const d of all ?? []) expect(d, d.name).not.toHaveProperty('behavior');
  });
});

describe('liveModelTraits', () => {
  it('names a thinking level and drops behavior and scheduling for a thinking voice', () => {
    expect(liveModelTraits('gemini-3.8-live-extended-thinking')).toEqual({
      toolBehavior: false,
      responseScheduling: false,
      thinkingLevel: ThinkingLevel.LOW,
    });
  });

  it('keeps everything for the plain voice', () => {
    for (const model of ['gemini-3.8-live', 'gemini-3.1-flash-live-preview']) {
      expect(liveModelTraits(model), model).toEqual({
        toolBehavior: true,
        responseScheduling: true,
        thinkingLevel: null,
      });
    }
  });
});

describe('GeminiLiveAgent', () => {
  async function connected(model = 'gemini-live-test') {
    live.connections.length = 0;
    const agent = new GeminiLiveAgent({
      model,
      transport: 'relay',
      origin: 'http://laptop.test',
      connectTimeoutMs: 1000,
    });
    await agent.connect({ systemInstruction: 'plan rev 1', tools: ['highlight', 'complete_step'] });
    const back = () =>
      new Promise<void>((resolve) => {
        const off = agent.events.on('status', ({ state }) => {
          if (state !== 'ready') return;
          off();
          resolve();
        });
      });
    return { agent, back };
  }

  const connection = (i: number) => {
    const c = live.connections[i];
    if (!c) throw new Error(`no connection ${i}`);
    return c;
  };

  it('sends narrations as client turns, asking for a reply only when wanted', async () => {
    const { agent } = await connected();
    agent.narrate({ kind: 'plan', text: '[app] Plan ready.', reply: false });
    agent.narrate({ kind: 'step', text: '[app] Now acid.', reply: true });
    expect(connection(0).session.content).toEqual([
      { turns: [{ role: 'user', parts: [{ text: '[app] Plan ready.' }] }], turnComplete: false },
      { turns: [{ role: 'user', parts: [{ text: '[app] Now acid.' }] }], turnComplete: true },
    ]);
    await agent.close();
  });

  const calls = (...names: [id: string, name: string][]) => ({
    toolCall: { functionCalls: names.map(([id, name]) => ({ id, name, args: {} })) },
  });

  it('answers blocking calls without scheduling', async () => {
    const { agent } = await connected();
    connection(0).send(calls(['c1', 'complete_step'], ['c2', 'highlight']));
    agent.respond([
      { id: 'c1', name: 'complete_step', ok: true, result: { plan: 'Goal: g' } },
      { id: 'c2', name: 'highlight', ok: false, result: { error: 'Unknown object' } },
    ]);
    expect(connection(0).session.toolResponses).toEqual([
      {
        functionResponses: [
          { id: 'c1', name: 'complete_step', response: { output: { plan: 'Goal: g' } } },
          { id: 'c2', name: 'highlight', response: { error: { error: 'Unknown object' } } },
        ],
      },
    ]);
    await agent.close();
  });

  it('schedules a non-blocking answer for when the voice is idle', async () => {
    const { agent } = await connected();
    connection(0).send(calls(['c1', 'look_closer']));
    agent.respond([{ id: 'c1', name: 'look_closer', ok: true, result: { answer: 'Cup C.' } }]);
    expect(connection(0).session.toolResponses).toEqual([
      {
        functionResponses: [
          {
            id: 'c1',
            name: 'look_closer',
            response: { output: { answer: 'Cup C.' } },
            scheduling: FunctionResponseScheduling.WHEN_IDLE,
          },
        ],
      },
    ]);
    await agent.close();
  });

  it('asks a thinking voice for its thinking level, with no behavior or scheduling', async () => {
    const { agent } = await connected('gemini-3.8-live-extended-thinking');
    const config = connection(0).config as {
      thinkingConfig?: unknown;
      tools?: { functionDeclarations?: object[] }[];
    };
    expect(config.thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.LOW });
    for (const d of config.tools?.[0]?.functionDeclarations ?? []) {
      expect(d).not.toHaveProperty('behavior');
    }
    connection(0).send(calls(['c1', 'look_closer']));
    agent.respond([{ id: 'c1', name: 'look_closer', ok: true, result: { answer: 'Cup C.' } }]);
    expect(connection(0).session.toolResponses).toEqual([
      {
        functionResponses: [
          { id: 'c1', name: 'look_closer', response: { output: { answer: 'Cup C.' } } },
        ],
      },
    ]);
    await agent.close();
  });

  it('answers only calls the connection made and has not cancelled, once', async () => {
    const { agent, back } = await connected();
    connection(0).send(calls(['c1', 'highlight'], ['c2', 'look_closer'], ['c3', 'look_closer']));
    connection(0).send({ toolCallCancellation: { ids: ['c1'] } });
    agent.respond([{ id: 'c1', name: 'highlight', ok: true, result: {} }]);
    agent.respond([{ id: 'nope', name: 'highlight', ok: true, result: {} }]);
    agent.respond([{ id: 'c2', name: 'look_closer', ok: true, result: { answer: 'A' } }]);
    agent.respond([{ id: 'c2', name: 'look_closer', ok: true, result: { answer: 'A' } }]);
    const answered = (i: number) =>
      (connection(i).session.toolResponses as { functionResponses: { id: string }[] }[]).flatMap(
        (r) => r.functionResponses.map((f) => f.id),
      );
    expect(answered(0)).toEqual(['c2']);
    // c3 belongs to the connection that dropped; the next one never made it.
    const ready = back();
    connection(0).drop();
    await ready;
    agent.respond([{ id: 'c3', name: 'look_closer', ok: true, result: { answer: 'B' } }]);
    expect(answered(1)).toEqual([]);
    await agent.close();
  });

  it('queues narrations across a reconnect and sends them as one turn once back', async () => {
    const { agent, back } = await connected();
    const ready = back();
    connection(0).drop();
    agent.narrate({ kind: 'plan', text: '[app] A', reply: false });
    agent.narrate({ kind: 'step', text: '[app] B', reply: true });
    agent.respond([{ id: 'c1', name: 'highlight', ok: true, result: {} }]);
    agent.pushImage('jpeg');
    await ready;
    expect(connection(0).session.closed).toBe(true);
    expect(connection(0).session.content).toEqual([]);
    expect(connection(1).session.content).toEqual([
      { turns: [{ role: 'user', parts: [{ text: '[app] A [app] B' }] }], turnComplete: true },
    ]);
    // Answers and frames for the dead connection mean nothing to the next one.
    expect(connection(1).session.toolResponses).toEqual([]);
    expect(connection(1).session.media).toEqual([]);
    await agent.close();
  });

  it('sends what is narrated on ready in the same turn as what was missed', async () => {
    const { agent, back } = await connected();
    agent.events.on('status', ({ state }) => {
      if (state === 'ready') agent.narrate({ kind: 'reconnected', text: '[app] R', reply: false });
    });
    const ready = back();
    connection(0).drop();
    agent.narrate({ kind: 'step', text: '[app] B', reply: true });
    await ready;
    expect(connection(1).session.content).toEqual([
      { turns: [{ role: 'user', parts: [{ text: '[app] B [app] R' }] }], turnComplete: true },
    ]);
    agent.narrate({ kind: 'plan', text: '[app] C', reply: false });
    expect(connection(1).session.content).toHaveLength(2);

    // Let the first reconnect finish before dropping again.
    await new Promise((r) => setTimeout(r, 0));
    const quiet = back();
    connection(1).drop();
    await quiet;
    expect(connection(2).session.content).toEqual([
      { turns: [{ role: 'user', parts: [{ text: '[app] R' }] }], turnComplete: false },
    ]);
    await agent.close();
  });

  it('keeps only the newest 10 narrations while the connection is down', async () => {
    const { agent, back } = await connected();
    const ready = back();
    connection(0).drop();
    for (let i = 1; i <= 12; i++) agent.narrate({ kind: 'n', text: `[app] ${i}`, reply: false });
    await ready;
    const turns = connection(1).session.content as { turns: { parts: { text: string }[] }[] }[];
    expect(turns).toHaveLength(1);
    expect(turns[0]?.turns[0]?.parts[0]?.text).toBe(
      Array.from({ length: 10 }, (_, i) => `[app] ${i + 3}`).join(' '),
    );
    await agent.close();
  });

  it('starts the next connection from the updated instruction', async () => {
    const { agent, back } = await connected();
    agent.updateInstruction('plan rev 2');
    const ready = back();
    connection(0).drop();
    await ready;
    expect(connection(0).config.systemInstruction).toBe('plan rev 1');
    expect(connection(1).config.systemInstruction).toBe('plan rev 2');
    await agent.close();
  });

  it('drops narrations once closed', async () => {
    const { agent } = await connected();
    await agent.close();
    agent.narrate({ kind: 'step', text: '[app] late', reply: true });
    expect(connection(0).session.content).toEqual([]);
  });
});

describe('Gemini Live server messages', () => {
  it('extracts audio, transcripts and turn signals from server content', () => {
    const events = interpretServerMessage({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AQA=' } }] },
        inputTranscription: { text: 'how do I' },
        outputTranscription: { text: 'First,' },
        interrupted: true,
        turnComplete: true,
      },
    });
    expect(events).toEqual([
      { kind: 'audio', data: 'AQA=', sampleRate: 24000 },
      { kind: 'transcript', role: 'user', text: 'how do I' },
      { kind: 'transcript', role: 'coach', text: 'First,' },
      { kind: 'interrupted' },
      { kind: 'turnComplete' },
    ]);
  });

  it('extracts tool calls, cancellations, go-away notices and resumption handles', () => {
    expect(
      interpretServerMessage({
        toolCall: { functionCalls: [{ id: 'f1', name: 'highlight', args: { object_id: 'cap' } }] },
        toolCallCancellation: { ids: ['f0'] },
        goAway: { timeLeft: '10s' },
        sessionResumptionUpdate: { newHandle: 'h2', resumable: true },
      }),
    ).toEqual([
      { kind: 'toolCalls', calls: [{ id: 'f1', name: 'highlight', args: { object_id: 'cap' } }] },
      { kind: 'toolCancel', ids: ['f0'] },
      { kind: 'goAway', timeLeft: '10s' },
      { kind: 'resumption', handle: 'h2' },
    ]);
  });

  it('ignores a resumption update that is not resumable', () => {
    expect(
      interpretServerMessage({ sessionResumptionUpdate: { newHandle: 'h3', resumable: false } }),
    ).toEqual([]);
  });
});

describe('TranscriptAggregator', () => {
  it('builds partial transcripts per role and finalizes them at the end of a turn', () => {
    const agg = new TranscriptAggregator();
    expect(agg.add('coach', 'Add ')).toEqual({ role: 'coach', text: 'Add ', final: false });
    expect(agg.add('coach', 'vinegar.')).toEqual({
      role: 'coach',
      text: 'Add vinegar.',
      final: false,
    });
    agg.add('user', 'ok');
    expect(agg.complete()).toEqual([
      { role: 'user', text: 'ok', final: true },
      { role: 'coach', text: 'Add vinegar.', final: true },
    ]);
    expect(agg.complete()).toEqual([]);
  });
});
