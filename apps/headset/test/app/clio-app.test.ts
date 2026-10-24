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

import type { TrackerSocket } from '../../src/adapters/net/tracker-client';
import type { XrRuntime } from '../../src/adapters/xr/xr-session';
import { ClioApp } from '../../src/app/clio-app';
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
