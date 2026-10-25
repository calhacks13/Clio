/// <reference path="../../src/adapters/render/troika.d.ts" />
import { parseProcedure } from '@clio/protocol';
import type { WebGLRenderer } from 'three';
import { Object3D } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/adapters/render/text', () => ({
  makeText: () =>
    Object.assign(new Object3D(), { text: '', fillOpacity: 1, sync() {}, dispose() {} }),
  setText: (t: { text: string }, value: string) => {
    t.text = value;
  },
}));

import { ApiClient } from '../../src/adapters/net/api-client';
import type { TrackerSocket } from '../../src/adapters/net/tracker-client';
import type { XrRuntime } from '../../src/adapters/xr/xr-session';
import { type ActionFocusWiring, ClioApp, createActionFocus } from '../../src/app/clio-app';
import { LiveTracker } from '../../src/app/live-tracker';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import type { AppEvents } from '../../src/domain/events';
import type { CameraModel } from '../../src/domain/world/camera-model';
import { ObjectRegistry } from '../../src/domain/world/object-registry';
import { PoseHistory } from '../../src/domain/world/pose-history';
import { Workspace } from '../../src/domain/world/workspace';

// The app's end of the XR session, against the real live tracker and a stand-in /track socket.

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

  /** The camera frames sent (binary). */
  get frames(): number {
    return this.sent.filter((d) => typeof d !== 'string').length;
  }

  /** The JSON messages sent. */
  get messages(): { type: string; [key: string]: unknown }[] {
    return this.sent.filter((d) => typeof d === 'string').map((d) => JSON.parse(d as string));
  }
}

const procedure = parseProcedure({
  schema: 'clio.procedure/1',
  id: 'washer',
  version: 1,
  title: 'Refill',
  summary: 'S',
  workspace: { size: [1, 1] },
  objects: [{ id: 'cap', label: 'washer cap', placement: { method: 'detect' } }],
  steps: [
    {
      id: 'open',
      instruction: 'Open the cap.',
      targets: ['cap'],
      show: [{ object: 'cap', phrase: 'blue washer cap', description: 'Round blue cap' }],
      success: { type: 'confirm' },
    },
  ],
});

const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

/** A live tracker following the step's cap, streaming to a tracker that answers every frame. */
async function streaming() {
  const bus = new Emitter<AppEvents>();
  const clock = new ManualClock(1000);
  const registry = new ObjectRegistry(bus);
  registry.load(procedure.objects, 0);
  const poses = new PoseHistory();
  poses.push(0, { p: [0, 1.25, 0], q: [0, 0, 0, 1] });
  const socket = new FakeSocket();
  const model: CameraModel = {
    intrinsics: { width: 1280, height: 960, fx: 800, fy: 800, cx: 640, cy: 480 },
    headFromCamera: { p: [0, 0, 0], q: [0, 0, 0, 1] },
  };
  const camera = {
    frame: () => ({ source: {} as CanvasImageSource, width: 1280, height: 960, t: 0 }),
    model: () => model,
  };
  const live = new LiveTracker({
    bus,
    clock,
    registry,
    poses,
    camera,
    surfaces: { cast: () => null },
    workspace: () => new Workspace({ p: [0, 0.72, -0.5], q: [0, 0, 0, 1] }),
    procedure: () => procedure,
    trackerPort: 8790,
    frameWidth: null,
    hideHeld: false,
    emulated: true,
    socket: () => socket,
  });
  const connected = live.connect();
  socket.accept();
  await connected;
  // As in the emulator: the session stays 'visible' until it ends.
  const session = {
    enabledFeatures: [],
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as XRSession;
  live.start(
    { session, space: {} as XRReferenceSpace, features: [] } as XrRuntime,
    {
      getContext: () => null,
      xr: { getBinding: () => null },
    } as unknown as WebGLRenderer,
  );
  bus.emit('procedure.started', {
    t: clock.now(),
    procedureId: 'washer',
    version: 1,
    stepCount: 1,
  });
  bus.emit('step.entered', {
    t: clock.now(),
    stepId: 'open',
    index: 0,
    instruction: 'Open the cap.',
    targets: ['cap'],
  });
  live.perceive({} as XRFrame, clock.now());
  await flush();
  /** The tracker answers the last frame sent, as it does every one. */
  const answer = async () => {
    clock.advance(40);
    socket.receive({ type: 'detections', seq: socket.frames, t: clock.now(), detections: [] });
    await flush();
  };
  return { bus, clock, live, socket, answer };
}

/** A server whose action focus finds the cap, sure of it, in sharper words. */
function focusServer() {
  const asked: { url: string; body: { objects: { id: string }[] } }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    asked.push({ url, body: JSON.parse(String(init?.body)) });
    const answer = {
      detections: [
        {
          id: 'cap',
          found: true,
          box: [0.4, 0.5, 0.5, 0.6],
          point: [0.45, 0.55],
          confidence: 0.9,
          description: 'Round blue plastic cap with a yellow ring, front left',
        },
      ],
      action: null,
      model: 'gemini-robotics-er-2-preview',
      latencyMs: 900,
    };
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof globalThis.fetch;
  return { api: new ApiClient('', fetch), asked };
}

describe('createActionFocus', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: () => {},
      removeEventListener: () => {},
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage() {} }),
        toDataURL: () => 'data:image/jpeg;base64,AAAA',
      }),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const wiring = async (extra: Partial<ActionFocusWiring> = {}) => {
    const { bus, clock, live, socket } = await streaming();
    const { api, asked } = focusServer();
    const view = {
      procedure: () => procedure,
      label: (id: string) => (id === 'cap' ? 'washer cap' : id),
      plan: () => null,
    };
    const camera = {
      capture: async () => ({ t: clock.now(), width: 1280, height: 960, jpegBase64: '/9j/4AAQ' }),
    };
    const w: ActionFocusWiring = {
      bus,
      clock,
      api,
      camera,
      live,
      lesson: { declareObject: () => null, view: () => view },
      wanted: true,
      gemini: true,
      ...extra,
    };
    return { w, bus, clock, live, socket, asked };
  };

  it('runs only with a camera, the live tracker and a Gemini key, unless turned off', async () => {
    const { w, live } = await wiring();
    expect(createActionFocus(w)).not.toBeNull();
    expect(createActionFocus({ ...w, wanted: false })).toBeNull();
    expect(createActionFocus({ ...w, gemini: false })).toBeNull();
    expect(createActionFocus({ ...w, camera: null })).toBeNull();
    expect(createActionFocus({ ...w, live: null })).toBeNull();
    live.stop();
  });

  it('asks Robotics-ER about the step, anchors the tracker with its box and tells jev its words', async () => {
    const { w, bus, clock, live, socket, asked } = await wiring();
    const focus = createActionFocus(w);
    const detach = focus?.attach();
    bus.emit('step.entered', {
      t: clock.now(),
      stepId: 'open',
      index: 0,
      instruction: 'Open the cap.',
      targets: ['cap'],
    });
    await focus?.tick(clock.now());
    expect(asked.map((a) => [a.url, a.body.objects.map((o) => o.id)])).toEqual([
      ['/api/vision/focus', ['cap']],
    ]);
    const words = 'Round blue plastic cap with a yellow ring, front left';
    expect(socket.messages.at(-1)).toEqual({
      type: 'anchor',
      id: 'cap',
      t: clock.now(),
      box: [0.4, 0.5, 0.5, 0.6],
      source: 'er',
      query: words,
    });
    // From now on jev is told ER's words for the cap; its phrase stays, so its track goes on.
    live.perceive({} as XRFrame, clock.now());
    expect(socket.messages.at(-1)).toEqual({
      type: 'objects',
      objects: [{ id: 'cap', phrase: 'blue washer cap', query: words }],
    });
    detach?.();
    live.stop();
  });

  it('leaves placing objects to jev when its boxes are turned off, and still tells jev its words', async () => {
    const { w, bus, clock, live, socket, asked } = await wiring({ anchors: false });
    const focus = createActionFocus(w);
    const detach = focus?.attach();
    bus.emit('step.entered', {
      t: clock.now(),
      stepId: 'open',
      index: 0,
      instruction: 'Open the cap.',
      targets: ['cap'],
    });
    await focus?.tick(clock.now());
    expect(asked).toHaveLength(1);
    expect(socket.messages.filter((m) => m.type === 'anchor')).toEqual([]);
    live.perceive({} as XRFrame, clock.now());
    expect(socket.messages.at(-1)).toEqual({
      type: 'objects',
      objects: [
        {
          id: 'cap',
          phrase: 'blue washer cap',
          query: 'Round blue plastic cap with a yellow ring, front left',
        },
      ],
    });
    detach?.();
    live.stop();
  });
});

describe('ClioApp', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: () => {},
      removeEventListener: () => {},
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage() {} }),
        toDataURL: () => 'data:image/jpeg;base64,AAAA',
      }),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has the coach speak first, greeting them while a typed goal is planned', async () => {
    const kickoff = async (o: { procedure: object | null; goal: string | null }) => {
      const calls: string[] = [];
      const app = {
        o,
        startCoach: async () => {
          calls.push('coach');
        },
        coach: { welcome: (goal: string | null) => calls.push(`welcome ${goal}`) },
        lesson: {
          run: async () => {
            calls.push('run');
          },
          startLesson: (goal: string) => calls.push(`plan ${goal}`),
        },
      };
      const proto = ClioApp.prototype as unknown as { kickoff(this: unknown): Promise<void> };
      await proto.kickoff.call(app);
      return calls;
    };
    expect(await kickoff({ procedure: null, goal: null })).toEqual(['coach', 'welcome null']);
    expect(await kickoff({ procedure: null, goal: 'refill the washer' })).toEqual([
      'coach',
      'welcome refill the washer',
      'plan refill the washer',
    ]);
    // A saved lesson briefs its first step at once.
    expect(await kickoff({ procedure: {}, goal: null })).toEqual(['coach', 'run']);
  });

  it('stops streaming to the tracker as the session ends, not once the lesson has settled', async () => {
    const { bus, clock, live, socket, answer } = await streaming();
    await answer();
    expect(socket.frames).toBeGreaterThan(0);

    // The lesson's recording cannot finish (the server is down and its upload retries).
    const lesson = {
      stop: vi.fn(() => {
        bus.emit('procedure.aborted', { t: clock.now(), reason: 'session ended' });
        return new Promise<void>(() => {});
      }),
    };
    const scene = { stop: vi.fn() };
    const app = { lesson, live, coach: null, scene } as unknown as ClioApp;
    void ClioApp.prototype.shutdown.call(app, 'session ended');
    expect(lesson.stop).toHaveBeenCalledWith('session ended');
    expect(live.live).toBe(false);

    // No answer brings the stream back, nor a frame that still reached perceive().
    const sent = socket.frames;
    for (let i = 0; i < 5; i++) await answer();
    live.perceive({} as XRFrame, clock.now());
    await flush();
    expect(socket.frames).toBe(sent);
  });
});
