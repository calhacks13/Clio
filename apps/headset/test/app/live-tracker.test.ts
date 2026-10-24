/// <reference path="../../src/adapters/render/troika.d.ts" />
import { parseProcedure, type Step } from '@clio/protocol';
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

import type { TrackerSocket } from '../../src/adapters/net/tracker-client';
import type { XrRuntime } from '../../src/adapters/xr/xr-session';
import { LiveTracker } from '../../src/app/live-tracker';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import { quatFromAxisAngle } from '../../src/core/math';
import type { AppEvents } from '../../src/domain/events';
import type { CameraModel } from '../../src/domain/world/camera-model';
import { ObjectRegistry } from '../../src/domain/world/object-registry';
import { PoseHistory } from '../../src/domain/world/pose-history';
import { Workspace } from '../../src/domain/world/workspace';

// The lesson's live tracking end to end against a stand-in /track socket: what it sends the
// tracker as the lesson moves, and where the tracker's answers go.

class FakeSocket implements TrackerSocket {
  readyState = 0;
  binaryType: BinaryType = 'blob';
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly sent: (string | ArrayBufferView)[] = [];

  constructor(readonly url: string) {}

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

  drop(): void {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }

  /** The JSON messages sent (frames are binary). */
  get messages(): unknown[] {
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
  objects: [
    { id: 'cap', label: 'washer cap', placement: { method: 'detect' } },
    { id: 'jug', label: 'fluid jug', placement: { method: 'detect' } },
  ],
  steps: [
    {
      id: 'open',
      instruction: 'Open the cap.',
      targets: ['cap'],
      show: [
        { object: 'cap', phrase: 'blue washer cap', description: 'Round blue cap, front left' },
      ],
      success: { type: 'confirm' },
    },
    { id: 'done', instruction: 'Say done.', success: { type: 'confirm' } },
  ],
});
const [OPEN, DONE] = procedure.steps as [Step, Step];

const DEG = Math.PI / 180;
const model: CameraModel = {
  intrinsics: { width: 1280, height: 960, fx: 800, fy: 800, cx: 640, cy: 480 },
  headFromCamera: { p: [0.032, -0.02, -0.06], q: quatFromAxisAngle([1, 0, 0], -15 * DEG) },
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** A frame with no hands in it, for the presenters' stage. */
const xrFrame = { session: { inputSources: [] } } as unknown as XRFrame;
const frame = {} as XRFrame;

function setup() {
  const bus = new Emitter<AppEvents>();
  const clock = new ManualClock(1000);
  const registry = new ObjectRegistry(bus);
  registry.load(procedure.objects, 0);
  const poses = new PoseHistory();
  poses.push(0, { p: [0, 1.25, 0], q: quatFromAxisAngle([1, 0, 0], -20 * DEG) });
  const sockets: FakeSocket[] = [];
  const camera = { frame: vi.fn(() => null), model: () => model };
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
    emulated: false,
    socket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  const start = () =>
    bus.emit('procedure.started', {
      t: clock.now(),
      procedureId: procedure.id,
      version: 1,
      stepCount: procedure.steps.length,
    });
  const enter = (step: Step) =>
    bus.emit('step.entered', {
      t: clock.now(),
      stepId: step.id,
      index: procedure.steps.indexOf(step),
      instruction: step.instruction,
      targets: step.targets,
    });
  return { bus, clock, registry, sockets, camera, live, start, enter };
}

const session = (visibilityState: XRVisibilityState = 'visible') =>
  ({
    enabledFeatures: [],
    visibilityState,
    addEventListener: () => {},
    removeEventListener: () => {},
  }) as unknown as XRSession;

const renderer = {
  getContext: () => null,
  xr: { getBinding: () => null },
} as unknown as WebGLRenderer;

describe('LiveTracker', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: () => {},
      removeEventListener: () => {},
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('connects before the session, saying whether the tracker answered', async () => {
    const { live, sockets } = setup();
    const connected = live.connect();
    expect(sockets[0]?.url).toBe('ws://localhost:8790/track');
    sockets[0]?.accept();
    await expect(connected).resolves.toBe(true);
    expect(live.live).toBe(true);
    live.stop();
    expect(live.live).toBe(false);
  });

  it("tells the tracker the lesson's objects, once per change, and again on a new connection", async () => {
    const { live, sockets, start, enter, bus } = setup();
    const connected = live.connect();
    sockets[0]?.accept();
    await connected;
    start();
    enter(OPEN);
    live.perceive(frame, 1000);
    live.perceive(frame, 1016);
    // The step's show item in its words, then the plan's other objects in the finder's words.
    const set = {
      type: 'objects',
      objects: [
        { id: 'cap', phrase: 'blue washer cap', query: 'Round blue cap, front left' },
        { id: 'jug', phrase: 'fluid jug', query: 'fluid jug' },
      ],
    };
    expect(sockets[0]?.messages).toEqual([set]);

    // The tracker restarts: the new connection hears the set again.
    vi.useFakeTimers();
    sockets[0]?.drop();
    expect(live.live).toBe(false);
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    sockets[1]?.accept();
    live.perceive(frame, 1032);
    expect(sockets[1]?.messages).toEqual([set]);

    // A step that shows nothing still follows every object, so the recording covers it.
    enter(DONE);
    live.perceive(frame, 1048);
    expect(sockets[1]?.messages.at(-1)).toEqual({
      type: 'objects',
      objects: [
        { id: 'cap', phrase: 'blue washer cap', query: 'washer cap' },
        { id: 'jug', phrase: 'fluid jug', query: 'fluid jug' },
      ],
    });

    // The end of the lesson stops tracking and every jev call.
    bus.emit('procedure.completed', { t: 1060, durationMs: 1060 });
    live.perceive(frame, 1064);
    expect(sockets[1]?.messages.at(-1)).toEqual({ type: 'objects', objects: [] });
    live.stop();
  });

  it('lights only what the step shows; the rest is followed for the recording', async () => {
    const { live, sockets, start, enter, registry, bus } = setup();
    const observed: string[] = [];
    bus.on('objects.observed', ({ observation }) => observed.push(observation.objectId));
    const connected = live.connect();
    sockets[0]?.accept();
    await connected;
    start();
    enter(OPEN);
    live.perceive(frame, 1000);
    const seen = (id: string, x: number) => ({
      id,
      found: true,
      state: 'tracking',
      box: [x - 0.05, 0.55, x + 0.05, 0.7],
      outline: [
        [x - 0.05, 0.7],
        [x + 0.05, 0.7],
        [x, 0.55],
      ],
      point: [x, 0.64],
      contact: [x, 0.7],
      score: 0.9,
      track: 1,
    });
    sockets[0]?.receive({
      type: 'detections',
      seq: 1,
      t: 990,
      model: 'yoloe-26l-seg',
      detections: [seen('cap', 0.5), seen('jug', 0.3)],
    });
    live.perceive(frame, 1016);
    await flush();
    live.prepare(xrFrame, {} as XRReferenceSpace);
    expect(live.lit('cap')).toBe(true);
    expect(live.lit('jug')).toBe(false);
    // Unlit, the jug is still placed and recorded like the cap.
    expect(registry.get('jug')).toMatchObject({ source: 'detector', confidence: 0.9 });
    expect(observed.sort()).toEqual(['cap', 'jug']);
    live.stop();
  });

  it("puts the tracker's answers in the registry as the camera's untrusted detector", async () => {
    const { live, sockets, start, enter, registry, bus } = setup();
    const observed: unknown[] = [];
    bus.on('objects.observed', ({ observation }) => observed.push(observation));
    const connected = live.connect();
    sockets[0]?.accept();
    await connected;
    start();
    enter(OPEN);
    live.perceive(frame, 1000);
    sockets[0]?.receive({
      type: 'detections',
      seq: 1,
      t: 990,
      model: 'yoloe-26l-seg',
      detections: [
        {
          id: 'cap',
          found: true,
          state: 'tracking',
          box: [0.45, 0.55, 0.55, 0.7],
          outline: [
            [0.45, 0.7],
            [0.55, 0.7],
            [0.5, 0.55],
          ],
          point: [0.5, 0.64],
          contact: [0.5, 0.7],
          score: 0.9,
          track: 3,
        },
      ],
    });
    live.perceive(frame, 1016);
    await flush();
    expect(registry.get('cap')).toMatchObject({ source: 'detector', confidence: 0.9, t: 990 });
    expect(observed).toEqual([
      expect.objectContaining({
        objectId: 'cap',
        role: 'tracker',
        status: 'measured',
        trackId: '3',
      }),
    ]);
    live.stop();
  });

  it('streams frames only while the session is shown and something is followed', async () => {
    const shown = setup();
    const connected = shown.live.connect();
    shown.sockets[0]?.accept();
    await connected;
    shown.live.start(
      { session: session(), space: {} as XRReferenceSpace, features: [] } as XrRuntime,
      renderer,
    );
    shown.live.perceive(frame, 1000);
    await flush();
    // Nothing followed yet: no frame is grabbed.
    expect(shown.camera.frame).not.toHaveBeenCalled();
    shown.start();
    shown.enter(OPEN);
    shown.live.perceive(frame, 1016);
    await flush();
    expect(shown.camera.frame).toHaveBeenCalled();
    shown.live.stop();

    const covered = setup();
    const ready = covered.live.connect();
    covered.sockets[0]?.accept();
    await ready;
    covered.live.start(
      {
        session: session('visible-blurred'),
        space: {} as XRReferenceSpace,
        features: [],
      } as XrRuntime,
      renderer,
    );
    covered.start();
    covered.enter(OPEN);
    covered.live.perceive(frame, 1000);
    await flush();
    expect(covered.camera.frame).not.toHaveBeenCalled();
    covered.live.stop();
  });
});
