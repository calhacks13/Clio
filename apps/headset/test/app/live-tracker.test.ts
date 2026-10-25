/// <reference path="../../src/adapters/render/troika.d.ts" />
import { type Procedure, parseProcedure, type Step } from '@clio/protocol';
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
import type { PresentContext } from '../../src/adapters/render/presenter';
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
/** The plan once the lesson has declared the sponge (the action focus's item, say). */
const withSponge = parseProcedure({
  ...procedure,
  objects: [
    ...procedure.objects,
    { id: 'sponge', label: 'yellow sponge', placement: { method: 'detect' } },
  ],
});

const DEG = Math.PI / 180;
const model: CameraModel = {
  intrinsics: { width: 1280, height: 960, fx: 800, fy: 800, cx: 640, cy: 480 },
  headFromCamera: { p: [0.032, -0.02, -0.06], q: quatFromAxisAngle([1, 0, 0], -15 * DEG) },
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** A frame with no hands in it, for the presenters' stage. */
const xrFrame = { session: { inputSources: [] } } as unknown as XRFrame;
const frame = {} as XRFrame;

function setup({
  debug = false,
  plan = () => procedure,
}: {
  debug?: boolean;
  plan?: () => Procedure;
} = {}) {
  const bus = new Emitter<AppEvents>();
  const clock = new ManualClock(1000);
  const registry = new ObjectRegistry(bus);
  registry.load(withSponge.objects, 0);
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
    procedure: plan,
    trackerPort: 8790,
    frameWidth: null,
    hideHeld: false,
    emulated: false,
    debug,
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

/** One object seen by the tracker at image x, as jev placed it. */
const seen = (id: string, x: number, source: 'jev' | 'er' | null = 'jev') => ({
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
  source,
});

/** The names and debug lines on the boxes drawn now. */
function tags(live: LiveTracker): { name: string; detail: string | null }[] {
  const presenter = live.boxPresenter;
  presenter.update({
    t: 0,
    dt: 1000,
    head: { p: [0, 1.25, 0], q: [0, 0, 0, 1] },
  } as PresentContext);
  return presenter.object.children.map((box) => {
    const [, name, detail] = (box.children[1]?.children ?? []) as (Object3D & { text: string })[];
    return { name: name?.text ?? '', detail: detail?.visible ? detail.text : null };
  });
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

  it('starts on a session without depth sensing, whose depthUsage throws', () => {
    // The tracker did not answer in time, so the session never asked for depth sensing: the spec
    // has depthUsage throw then, and start() runs before the app's first frame.
    const { live } = setup();
    const refusing = Object.defineProperty(session(), 'depthUsage', {
      get() {
        throw new DOMException('Depth sensing is not enabled', 'InvalidStateError');
      },
    });
    expect(() =>
      live.start(
        { session: refusing, space: {} as XRReferenceSpace, features: [] } as XrRuntime,
        renderer,
      ),
    ).not.toThrow();
    live.stop();
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
    // A card must also avoid the real jug even though this step does not light it.
    expect(live.panelMasks).toHaveLength(2);
    expect(live.panelMasks.every((mask) => mask.outline.points.length > 0)).toBe(true);
    // Unlit, the jug is still placed and recorded like the cap.
    expect(registry.get('jug')).toMatchObject({ source: 'detector', confidence: 0.9 });
    expect(observed.sort()).toEqual(['cap', 'jug']);
    enter(DONE);
    live.prepare(xrFrame, {} as XRReferenceSpace);
    expect(live.lit('cap')).toBe(false);
    expect(live.panelMasks).toHaveLength(2);
    live.stop();
    expect(live.panelMasks).toEqual([]);
  });

  it('boxes what is lit, its name on the box; with ?debug=1 every followed object, saying more', async () => {
    for (const debug of [false, true]) {
      const { live, sockets, start, enter } = setup({ debug });
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
        detections: [seen('cap', 0.5, 'er'), seen('jug', 0.3)],
      });
      live.perceive(frame, 1016);
      await flush();
      live.prepare(xrFrame, {} as XRReferenceSpace);
      // The cap's glow has no name of its own: its box's tag carries it.
      const glow = live.presenter.object.children;
      live.presenter.update({
        t: 0,
        dt: 16,
        head: { p: [0, 1.25, 0], q: [0, 0, 0, 1] },
      } as PresentContext);
      expect(glow).toHaveLength(1);
      expect(glow[0]?.children.find((c) => 'text' in c)?.visible).toBe(false);
      if (debug) {
        expect(tags(live)).toEqual([
          { name: 'washer cap', detail: 'tracking · er · 0.90' },
          { name: 'fluid jug', detail: 'tracking · jev · 0.90' },
        ]);
      } else {
        expect(tags(live)).toEqual([{ name: 'washer cap', detail: null }]);
      }
      live.stop();
    }
  });

  it("hands Robotics-ER's boxes to the tracker as anchors, only for the set it follows", async () => {
    const { live, sockets, start, enter } = setup();
    const anchor = {
      id: 'cap',
      box: [0.4, 0.5, 0.5, 0.6] as [number, number, number, number],
      t: 980,
      query: 'Round blue plastic cap with a yellow ring',
    };
    // No tracker yet: dropped.
    live.anchor(anchor);
    const connected = live.connect();
    sockets[0]?.accept();
    await connected;
    // Connected, but the set is not sent yet (still target mode): dropped.
    live.anchor(anchor);
    expect(sockets[0]?.messages).toEqual([]);
    start();
    enter(OPEN);
    live.perceive(frame, 1000);
    live.anchor(anchor);
    // Not in the set: dropped.
    live.anchor({ ...anchor, id: 'sponge' });
    const { query: _words, ...bare } = anchor;
    live.anchor(bare);
    expect(sockets[0]?.messages.slice(1)).toEqual([
      { type: 'anchor', ...anchor, source: 'er' },
      { type: 'anchor', ...bare, source: 'er' },
    ]);
    // A new connection is in target mode until the set is sent again.
    vi.useFakeTimers();
    sockets[0]?.drop();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    sockets[1]?.accept();
    live.anchor(anchor);
    expect(sockets[1]?.messages).toEqual([]);
    live.perceive(frame, 1016);
    live.anchor(anchor);
    expect(sockets[1]?.messages.at(-1)).toEqual({ type: 'anchor', ...anchor, source: 'er' });
    live.stop();
  });

  it('holds an anchor for an object the set lacks until the set has it, for a moment', async () => {
    let plan = procedure;
    const { live, sockets, start, enter, bus, clock } = setup({ plan: () => plan });
    const connected = live.connect();
    sockets[0]?.accept();
    await connected;
    start();
    enter(OPEN);
    live.perceive(frame, 1000);
    const anchor = { id: 'sponge', box: [0.6, 0.6, 0.7, 0.7] as [number, number, number, number] };
    live.anchor({ ...anchor, t: 990 });
    // The lesson declares the sponge: the next set has it, then its anchor follows.
    plan = withSponge;
    bus.emit('plan.changed', { t: 1001, rev: 2, op: 'add', stepId: null });
    live.perceive(frame, 1016);
    const sent = sockets[0]?.messages ?? [];
    expect(sent.slice(-2)).toEqual([
      expect.objectContaining({ type: 'objects' }),
      { type: 'anchor', ...anchor, t: 990, source: 'er' },
    ]);
    // One for an object that never joins goes after a while, unsent.
    live.anchor({ ...anchor, id: 'kettle', t: 1020 });
    clock.advance(2500);
    live.perceive(frame, 1040);
    live.perceive(frame, 1056);
    expect(sockets[0]?.messages.some((m) => (m as { id?: string }).id === 'kettle')).toBe(false);
    live.stop();
  });

  it("draws Robotics-ER's boxes dashed for a moment with ?debug=1, where ER saw them", async () => {
    for (const debug of [false, true]) {
      const { live, sockets, start, enter, bus, clock } = setup({ debug });
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
        detections: [seen('cap', 0.5)],
      });
      live.perceive(frame, 1016);
      await flush();
      live.prepare(xrFrame, {} as XRReferenceSpace);
      bus.emit('focus.answered', {
        t: clock.now(),
        frameT: 980,
        stepId: OPEN.id,
        detections: [
          {
            id: 'cap',
            found: true,
            box: [0.45, 0.55, 0.55, 0.7],
            point: [0.5, 0.62],
            confidence: 0.86,
            description: 'Round blue cap',
          },
          { id: 'jug', found: false, box: null, point: null, confidence: 0.1, description: null },
        ],
        action: {
          id: null,
          label: 'red reset button',
          phrase: 'red button',
          description: 'A round red button on the left',
          found: true,
          box: [0.2, 0.6, 0.25, 0.66],
          point: [0.22, 0.63],
          confidence: 0.7,
        },
        actionId: null,
        model: 'gemini-robotics-er-2-preview',
        latencyMs: 1200,
      });
      live.prepare(xrFrame, {} as XRReferenceSpace);
      const names = () => tags(live).map((tag) => tag.name);
      if (!debug) {
        expect(names()).toEqual(['washer cap']);
        live.stop();
        continue;
      }
      expect(tags(live)).toEqual([
        { name: 'washer cap', detail: 'tracking · jev · 0.90' },
        { name: 'washer cap', detail: 'ER 0.86' },
        { name: 'red reset button', detail: 'ER 0.70 · next' },
      ]);
      // ER's box for the cap is at the cap's distance, around where the tracker has it.
      const [own, er] = live.boxPresenter.object.children;
      expect(er?.position.toArray()).toEqual(own?.position.toArray());
      clock.advance(1600);
      live.prepare(xrFrame, {} as XRReferenceSpace);
      live.boxPresenter.update({
        t: 0,
        dt: 1000,
        head: { p: [0, 1.25, 0], q: [0, 0, 0, 1] },
      } as PresentContext);
      expect(names()).toEqual(['washer cap']);
      live.stop();
    }
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
