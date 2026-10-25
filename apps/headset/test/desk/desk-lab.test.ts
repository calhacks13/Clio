import {
  ApiPaths,
  type FocusRequest,
  type FocusResponse,
  type HealthResponse,
  type PlanResponse,
  parseProcedure,
} from '@clio/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../../src/adapters/net/api-client';
import type { TrackerSocket } from '../../src/adapters/net/tracker-client';
import { ManualClock } from '../../src/core/clock';
import { DESK_DEFAULTS, type DeskConfig } from '../../src/desk/config';
import { DeskLab, type DeskLabCamera } from '../../src/desk/desk-lab';
import type { MicSource, VoiceOutput } from '../../src/domain/coach/ports';
import { FakeAgent } from '../support/fake-agent';

// The desk lab end to end against a stand-in server (the API client's fetch), a stand-in /track
// socket, a stand-in camera and a fake voice: the real lesson, coach session and action focus.

class FakeSocket implements TrackerSocket {
  readyState = 0;
  binaryType: BinaryType = 'blob';
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly sent: (string | ArrayBufferView)[] = [];

  send(data: string | ArrayBufferView<ArrayBuffer>): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  accept(): void {
    this.readyState = 1;
    this.receive({ type: 'ready', model: 'yoloe-26l-seg' });
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  get messages(): Record<string, unknown>[] {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as Record<string, unknown>);
  }
}

const procedure = parseProcedure({
  schema: 'clio.procedure/1',
  id: 'basil-plan',
  version: 1,
  origin: {
    kind: 'generated',
    goal: 'water the basil',
    model: 'planner',
    createdAt: '2026-10-24T04:00:00.000Z',
  },
  title: 'Water the basil',
  summary: 'S',
  workspace: { size: [0.8, 0.6] },
  objects: [
    { id: 'can', label: 'watering can', kind: 'tool', placement: { method: 'detect' } },
    { id: 'pot', label: 'basil pot', kind: 'container', placement: { method: 'detect' } },
  ],
  steps: [
    {
      id: 'pour',
      instruction: 'Pour water at the base of the basil.',
      doneWhen: 'The soil is dark and wet.',
      targets: ['can', 'pot'],
      show: [
        { object: 'can', phrase: 'green watering can', description: 'The green can on the left' },
        { object: 'pot', phrase: 'basil pot', description: 'The terracotta pot with basil' },
      ],
      success: { type: 'confirm' },
    },
    {
      id: 'wipe',
      instruction: 'Wipe up any spill.',
      targets: [],
      success: { type: 'confirm' },
    },
  ],
});

const health: HealthResponse = {
  ok: true,
  version: '0.1.0',
  coach: { configured: true, liveModel: 'gemini-live-test', relayPath: '/gemini' },
};

const focusAnswer = (request: FocusRequest): FocusResponse => ({
  detections: request.objects.map((o) => ({
    id: o.id,
    found: o.id === 'pot',
    box: o.id === 'pot' ? [0.5, 0.3, 0.8, 0.7] : null,
    point: o.id === 'pot' ? [0.65, 0.5] : null,
    confidence: o.id === 'pot' ? 0.9 : 0,
    description: o.id === 'pot' ? 'Terracotta pot with basil, front right' : null,
  })),
  action: {
    id: 'can',
    label: 'watering can',
    phrase: 'green watering can',
    description: 'Green watering can, left',
    found: true,
    box: [0.1, 0.4, 0.3, 0.8],
    point: [0.2, 0.6],
    confidence: 0.8,
  },
  model: 'gemini-robotics-er-2-preview',
  latencyMs: 1200,
});

/** A stand-in server behind the API client: what each path answers, and what it was asked. */
function server() {
  const calls: { path: string; body: unknown }[] = [];
  const routes: Record<string, (body: unknown) => unknown> = {
    [`GET ${ApiPaths.procedures}`]: () => ({ procedures: [] }),
    [`POST ${ApiPaths.plans}`]: (): PlanResponse => ({
      planId: 'plan-1',
      procedure,
      warnings: [],
    }),
    [`POST ${ApiPaths.visionLocate}`]: () => ({
      model: 'jev',
      latencyMs: 400,
      detections: [
        { id: 'can', found: true, point: [0.2, 0.6], box: null, outline: null, confidence: 0.9 },
        { id: 'pot', found: false, point: null, box: null, outline: null, confidence: 0 },
      ],
    }),
    [`POST ${ApiPaths.visionFocus}`]: (body) => focusAnswer(body as FocusRequest),
  };
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    const route = routes[`${init?.method ?? 'GET'} ${path}`];
    const json = route
      ? route(body)
      : { error: { code: 'unavailable', message: `no ${path} here` } };
    return new Response(JSON.stringify(json), {
      status: route ? 200 : 503,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { api: new ApiClient('', fetchImpl as typeof fetch), calls };
}

const image = { mimeType: 'image/jpeg' as const, data: 'AAAA' };

function camera(clock: ManualClock): DeskLabCamera {
  return {
    frame: () => null,
    model: () => null,
    capture: async () => ({ t: clock.now(), width: 640, height: 480, jpegBase64: 'AAAA' }),
    snapshot: async () => 'AAAA',
    snapshots: async (max) => Array.from({ length: max }, () => image),
    grab: async () => ({ image, t: clock.now() }),
  };
}

const speaker: VoiceOutput = { play() {}, say() {}, stop() {} };

let lab: DeskLab | null = null;
afterEach(async () => {
  await lab?.stop();
  lab?.tracker.dispose();
});

function setup(config: Partial<DeskConfig> = {}, withHealth: HealthResponse | null = health) {
  const clock = new ManualClock(10_000);
  const { api, calls } = server();
  const agents: FakeAgent[] = [];
  const sockets: FakeSocket[] = [];
  const mic: { muted: Int16Array[]; feed: (pcm: Int16Array) => void } = {
    muted: [],
    feed: () => {},
  };
  const micSource: MicSource = {
    start: async (onChunk) => {
      mic.feed = onChunk;
    },
    stop: () => {},
  };
  lab = new DeskLab({
    config: { ...DESK_DEFAULTS, ...config },
    api,
    health: withHealth,
    camera: camera(clock),
    speaker,
    version: 'test',
    trackerUrl: 'ws://localhost/track',
    clock,
    agent: (gemini) => {
      const agent = new FakeAgent(gemini ? 'gemini' : 'scripted');
      agents.push(agent);
      return agent;
    },
    mic: () => micSource,
    socket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const events: { type: string; payload: unknown }[] = [];
  lab.bus.onAny((type, payload) => events.push({ type: String(type), payload }));
  return { lab, clock, calls, agents, sockets, mic, events };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

describe('DeskLab', () => {
  it('runs a lesson from a goal: planned on webcam frames, followed by the tracker, Robotics-ER anchoring it', async () => {
    const { lab, clock, calls, agents, sockets, events } = setup();
    await lab.start();
    expect(lab.coachKind).toBe('gemini');
    expect(agents[0]?.setup?.tools).toContain('highlight');
    sockets[0]?.accept();

    expect(lab.startLesson('water the basil')).toMatchObject({ ok: true });
    await lab.lesson.settled();
    const planned = calls.find((c) => c.path === ApiPaths.plans);
    expect(planned?.body).toMatchObject({ goal: 'water the basil', stage: 'first' });
    expect((planned?.body as { images?: unknown[] } | undefined)?.images?.length).toBeGreaterThan(
      0,
    );
    expect(lab.plan()?.focusId).toBe('pour');
    // The step's start: the finder's one-shot look stands the can in on the workspace.
    expect(lab.registry.get('can')).toMatchObject({ source: 'detector', measured: false });

    lab.tick(clock.advance(30));
    const sets = sockets[0]?.messages.filter((m) => m.type === 'objects') ?? [];
    const followed = (sets.at(-1)?.objects ?? []) as { id: string }[];
    expect(followed.map((o) => o.id)).toEqual(['can', 'pot']);
    expect(lab.tracker.objects().map((o) => [o.id, o.lit])).toEqual([
      ['can', true],
      ['pot', true],
    ]);

    // The action focus looked as the step was entered: ER's sure boxes anchor the tracker, with
    // its words for each object, which jev is told from then on.
    await settle();
    const focus = calls.find((c) => c.path === ApiPaths.visionFocus)?.body as FocusRequest;
    expect(focus.step.instruction).toBe('Pour water at the base of the basil.');
    expect(focus.objects.map((o) => o.id)).toEqual(['can', 'pot']);
    const anchors = sockets[0]?.messages.filter((m) => m.type === 'anchor') ?? [];
    expect(anchors).toEqual([
      expect.objectContaining({
        id: 'pot',
        box: [0.5, 0.3, 0.8, 0.7],
        source: 'er',
        query: 'Terracotta pot with basil, front right',
      }),
      expect.objectContaining({ id: 'can', box: [0.1, 0.4, 0.3, 0.8], source: 'er' }),
    ]);
    expect(events.some((e) => e.type === 'focus.answered')).toBe(true);

    // The tracker's answers are drawn and stand the pot in, so a highlight on it shows.
    sockets[0]?.receive({
      type: 'detections',
      seq: 1,
      t: clock.now(),
      detections: [
        {
          id: 'pot',
          found: true,
          state: 'tracking',
          box: [0.5, 0.3, 0.8, 0.7],
          point: [0.65, 0.5],
          score: 0.9,
          source: 'er',
        },
      ],
    });
    expect(lab.tracker.objects().find((o) => o.id === 'pot')?.detection?.source).toBe('er');
    agents[0]?.events.emit('toolCalls', {
      calls: [{ id: 'h1', name: 'highlight', args: { object_id: 'pot' } }],
    });
    await settle();
    expect(agents[0]?.responses.find((r) => r.id === 'h1')).toMatchObject({
      ok: true,
      result: { shown: true },
    });

    // Done confirms the focused step.
    expect(lab.done()).toMatchObject({ ok: true });
    expect(lab.plan()?.focusId).toBe('wipe');
  });

  it('sends a typed turn to the voice as the learner, and mutes the mic with silence', async () => {
    const { lab, agents, events, mic } = setup();
    await lab.start();
    const caption = (): unknown => events.findLast((e) => e.type === 'coach.caption')?.payload;
    let typedWhileAnnounced = false;
    lab.bus.on('coach.caption', () => {
      typedWhileAnnounced = lab.typing;
    });
    expect(lab.say('  I want to water my basil ')).toBe(true);
    expect(agents[0]?.narrations.at(-1)).toEqual({
      kind: 'learner_text',
      text: 'I want to water my basil',
      reply: true,
    });
    expect(caption()).toMatchObject({
      role: 'user',
      text: 'I want to water my basil',
      final: true,
    });
    expect(typedWhileAnnounced).toBe(true);
    expect(lab.typing).toBe(false);
    expect(lab.say('   ')).toBe(false);

    mic.feed(new Int16Array([3, 3]));
    lab.setMuted(true);
    mic.feed(new Int16Array([3, 3]));
    expect(agents[0]?.audio.map((pcm) => [...pcm])).toEqual([
      [3, 3],
      [0, 0],
    ]);
  });

  it('falls back to the scripted coach without a Gemini key, which cannot be typed to', async () => {
    const { lab, agents } = setup({}, { ...health, coach: { ...health.coach, configured: false } });
    await lab.start();
    expect(lab.coachKind).toBe('scripted');
    expect(lab.say('hello')).toBe(false);
    await lab.setCoach('scripted');
    expect(agents.map((a) => a.kind)).toEqual(['scripted', 'scripted']);
    expect(agents[0]?.closed).toBe(true);
  });

  it('switches coaches while running, and stops everything it started', async () => {
    const { lab, agents, sockets, events } = setup({ goal: 'water the basil' });
    await lab.start();
    await lab.lesson.settled();
    expect(lab.plan()?.goal).toBe('water the basil');
    await lab.setCoach('scripted');
    expect(lab.coachKind).toBe('scripted');
    await lab.setCoach('gemini');
    expect(agents.map((a) => a.kind)).toEqual(['gemini', 'scripted', 'gemini']);
    await lab.stop();
    expect(lab.running).toBe(false);
    expect(lab.coachKind).toBeNull();
    expect(agents.every((a) => a.closed)).toBe(true);
    expect(sockets[0]?.readyState).toBe(3);
    expect(events.some((e) => e.type === 'procedure.aborted')).toBe(true);
  });

  it('asks Robotics-ER nothing with ?focus=0', async () => {
    const { lab, clock, calls, sockets } = setup({ focus: false });
    expect(lab.focus).toBeNull();
    await lab.start();
    sockets[0]?.accept();
    lab.startLesson('water the basil');
    await lab.lesson.settled();
    lab.tick(clock.advance(30));
    await settle();
    expect(calls.some((c) => c.path === ApiPaths.visionFocus)).toBe(false);
  });
});
