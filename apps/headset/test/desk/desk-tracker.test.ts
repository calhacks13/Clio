import { parseProcedure } from '@clio/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { TrackerSocket } from '../../src/adapters/net/tracker-client';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import { DeskTracker } from '../../src/desk/desk-tracker';
import type { AppEvents } from '../../src/domain/events';
import { ACCENTS } from '../../src/domain/overlay/accents';
import { ObjectRegistry } from '../../src/domain/world/object-registry';

// The desk's live tracking against a stand-in /track socket: what it tells the tracker as the
// lesson moves, what it keeps for the picture and what the registry hears.

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

  drop(): void {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }

  /** The object sets sent, as ids. */
  get sets(): string[][] {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as { type: string; objects?: { id: string }[] })
      .filter((m) => m.type === 'objects')
      .map((m) => (m.objects ?? []).map((o) => o.id));
  }
}

const procedure = parseProcedure({
  schema: 'clio.procedure/1',
  id: 'basil',
  version: 1,
  title: 'Basil',
  summary: 'S',
  workspace: { size: [1, 1] },
  objects: [
    { id: 'can', label: 'watering can', kind: 'tool', placement: { method: 'detect' } },
    { id: 'pot', label: 'basil pot', kind: 'container', placement: { method: 'detect' } },
    { id: 'cloth', label: 'cloth', placement: { method: 'detect' } },
  ],
  steps: [
    {
      id: 'pour',
      instruction: 'Pour water at the base of the basil.',
      targets: ['can', 'pot'],
      show: [
        { object: 'can', phrase: 'green watering can', description: 'The green can on the left' },
        { object: 'pot', phrase: 'basil pot', description: 'The terracotta pot with basil' },
      ],
      success: { type: 'confirm' },
    },
  ],
});

const detection = (over: Record<string, unknown>) => ({
  found: true,
  state: 'tracking',
  box: [0.1, 0.5, 0.3, 0.9],
  outline: [
    [0.1, 0.5],
    [0.3, 0.5],
    [0.3, 0.9],
  ],
  point: [0.2, 0.7],
  contact: [0.2, 0.9],
  score: 0.9,
  track: 1,
  ...over,
});

let tracker: DeskTracker | null = null;
afterEach(() => tracker?.dispose());

function setup() {
  const bus = new Emitter<AppEvents>();
  const clock = new ManualClock(1000);
  const registry = new ObjectRegistry(bus);
  const sockets: FakeSocket[] = [];
  let current: typeof procedure | null = null;
  tracker = new DeskTracker({
    bus,
    clock,
    registry,
    procedure: () => current,
    camera: { frame: () => null },
    url: 'ws://localhost/track',
    frameWidth: 640,
    size: [1, 1],
    socket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const begin = () => {
    current = procedure;
    registry.load(procedure.objects, clock.now());
    bus.emit('procedure.started', {
      t: clock.now(),
      procedureId: 'basil',
      version: 1,
      stepCount: 1,
    });
    bus.emit('step.entered', {
      t: clock.now(),
      stepId: 'pour',
      index: 0,
      instruction: 'Pour.',
      targets: ['can', 'pot'],
    });
  };
  return { bus, clock, registry, sockets, tracker, begin };
}

describe('DeskTracker', () => {
  it('follows every declared object, the step show items first and lit', () => {
    const { sockets, tracker, begin, clock } = setup();
    tracker.open();
    sockets[0]?.accept();
    tracker.perceive(clock.now());
    expect(sockets[0]?.sets).toEqual([[]]);
    begin();
    tracker.perceive(clock.now());
    expect(sockets[0]?.sets.at(-1)).toEqual(['can', 'pot', 'cloth']);
    const objects = tracker.objects();
    expect(objects.map((o) => [o.id, o.label, o.lit, o.rank])).toEqual([
      ['can', 'watering can', true, 0],
      ['pot', 'basil pot', true, 1],
      ['cloth', 'cloth', false, null],
    ]);
    expect(objects[0]?.accent.color).toBe(ACCENTS.act);
    expect(objects[1]?.accent.color).toBe(ACCENTS.destination);
    // Unchanged: not sent again.
    tracker.perceive(clock.now());
    expect(sockets[0]?.sets).toHaveLength(2);
  });

  it('keeps each object newest answer and tells the registry where it stands in', () => {
    const { sockets, tracker, begin, clock, registry } = setup();
    begin();
    tracker.open();
    sockets[0]?.accept();
    tracker.perceive(clock.now());
    sockets[0]?.receive({
      type: 'detections',
      seq: 1,
      t: 1100,
      model: 'yoloe-26l-seg',
      ms: { total: 31 },
      detections: [
        detection({ id: 'can' }),
        detection({
          id: 'pot',
          found: false,
          state: 'unknown',
          box: null,
          outline: null,
          point: null,
          contact: null,
          score: null,
          track: null,
        }),
        detection({ id: 'stranger' }),
      ],
    });
    const can = tracker.objects().find((o) => o.id === 'can');
    expect(can?.detection).toMatchObject({ found: true, state: 'tracking', score: 0.9 });
    expect(tracker.objects().find((o) => o.id === 'pot')?.detection?.found).toBe(false);
    expect(registry.get('can')).toMatchObject({
      position: [0.2, 0, -0.09999999999999998],
      source: 'detector',
      measured: false,
      t: 1100,
    });
    expect(registry.get('pot')).toBeUndefined();

    // A fifth of a second apart at most: the next answer is drawn but not told.
    sockets[0]?.receive({
      type: 'detections',
      seq: 2,
      t: 1150,
      detections: [detection({ id: 'can', contact: [0.9, 0.9] })],
    });
    expect(tracker.objects().find((o) => o.id === 'can')?.detection?.contact).toEqual([0.9, 0.9]);
    expect(registry.get('can')?.t).toBe(1100);
    sockets[0]?.receive({
      type: 'detections',
      seq: 3,
      t: 1400,
      detections: [detection({ id: 'can', contact: [0.9, 0.9] })],
    });
    expect(registry.get('can')).toMatchObject({
      t: 1400,
      position: [0.9, 0, -0.09999999999999998],
    });

    // Lost: the registry hears it, and keeps where it was last seen.
    sockets[0]?.receive({
      type: 'detections',
      seq: 4,
      t: 1500,
      detections: [
        detection({
          id: 'can',
          found: false,
          state: 'lost',
          box: null,
          outline: null,
          point: null,
          contact: null,
          score: null,
        }),
      ],
    });
    expect(registry.get('can')?.lostAt).toBe(1500);

    const stats = tracker.stats();
    expect(stats).toMatchObject({
      connected: true,
      model: 'yoloe-26l-seg',
      followed: 3,
      lit: 2,
      found: 0,
    });
  });

  it('forgets the answers when the connection drops, and sends the set again on the next', () => {
    const { sockets, tracker, begin, clock } = setup();
    begin();
    tracker.open();
    sockets[0]?.accept();
    tracker.perceive(clock.now());
    sockets[0]?.receive({
      type: 'detections',
      seq: 1,
      t: 1100,
      detections: [detection({ id: 'can' })],
    });
    expect(tracker.stats().found).toBe(1);
    sockets[0]?.drop();
    expect(tracker.objects().every((o) => o.detection === null)).toBe(true);
    expect(tracker.live).toBe(false);
  });

  it("sends Robotics-ER's boxes as anchors, after the set they belong to, and reads who placed each", () => {
    const { sockets, tracker, begin, clock } = setup();
    tracker.open();
    sockets[0]?.accept();
    tracker.perceive(clock.now());
    begin();
    // No tick since the lesson started: the anchor brings the new set along first.
    tracker.anchor({
      id: 'pot',
      box: [0.4, 0.2, 0.7, 0.6],
      t: 990,
      query: 'terracotta pot, front',
    });
    const messages = (sockets[0]?.sent ?? [])
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as Record<string, unknown>);
    expect(messages.map((m) => m.type)).toEqual(['objects', 'objects', 'anchor']);
    expect(messages[2]).toEqual({
      type: 'anchor',
      id: 'pot',
      t: 990,
      box: [0.4, 0.2, 0.7, 0.6],
      source: 'er',
      query: 'terracotta pot, front',
    });
    sockets[0]?.receive({
      type: 'detections',
      seq: 1,
      t: 1100,
      detections: [detection({ id: 'can', source: 'jev' }), detection({ id: 'pot', source: 'er' })],
    });
    expect(tracker.objects().map((o) => o.detection?.source ?? null)).toEqual(['jev', 'er', null]);
    expect(tracker.stats().sources).toEqual({ jev: 1, er: 1, none: 0 });
  });
});
