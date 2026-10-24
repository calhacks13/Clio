import { describe, expect, it } from 'vitest';
import {
  frameMessage,
  parseTrackerMessage,
  TrackerClient,
  type TrackerMask,
  type TrackerSocket,
  trackerUrl,
} from '../../src/primary/tracker-client';

class FakeSocket implements TrackerSocket {
  readyState = 0;
  binaryType: BinaryType = 'blob';
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly sent: (string | ArrayBufferView)[] = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string | ArrayBufferView<ArrayBuffer>): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  /** The tracker accepts the connection and says it is ready. */
  accept(model = 'yoloe-26l-seg'): void {
    this.readyState = 1;
    this.receive({ type: 'ready', model });
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
}

const mask = {
  type: 'mask',
  seq: 41,
  t: 123456.7,
  found: true,
  name: 'silver metal caliper',
  outline: [
    [0.41, 0.52],
    [0.47, 0.5],
    [0.49, 0.58],
  ],
  box: [0.31, 0.42, 0.58, 0.77],
  point: [0.45, 0.6],
  contact: [0.44, 0.76],
  score: 0.93,
  ms: { segment: 38, total: 46 },
  model: 'yoloe-26l-seg',
};

function setup() {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const masks: TrackerMask[] = [];
  const connections: boolean[] = [];
  const client = new TrackerClient({
    url: 'ws://localhost:5173/track',
    mask: (m) => masks.push(m),
    connection: (open) => connections.push(open),
    socket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    clearTimeout: () => {},
  });
  /** Run the latest scheduled reconnect. */
  const retry = () => timers.at(-1)?.fn();
  return { client, sockets, timers, masks, connections, retry };
}

describe('parseTrackerMessage', () => {
  it('reads ready and mask messages', () => {
    expect(parseTrackerMessage('{"type":"ready","model":"yoloe-26l-seg"}')).toEqual({
      type: 'ready',
      model: 'yoloe-26l-seg',
    });
    expect(parseTrackerMessage(JSON.stringify(mask))).toMatchObject({
      seq: 41,
      found: true,
      outline: mask.outline,
      contact: [0.44, 0.76],
    });
  });

  it('reads a lost object, with its geometry null or left out', () => {
    expect(
      parseTrackerMessage('{"type":"mask","seq":3,"t":10,"found":false,"outline":null}'),
    ).toMatchObject({ seq: 3, found: false, outline: null, box: null, point: null, name: null });
  });

  it('ignores anything else', () => {
    expect(parseTrackerMessage('not json')).toBeNull();
    expect(parseTrackerMessage('{"type":"hello"}')).toBeNull();
    expect(parseTrackerMessage('{"type":"mask","seq":"x"}')).toBeNull();
    expect(parseTrackerMessage(new ArrayBuffer(4))).toBeNull();
  });
});

describe('frameMessage', () => {
  it('is a big-endian header length, the JSON header, then the JPEG, in one buffer', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
    const header = { seq: 41, t: 123456.7, width: 640, height: 480 };
    const bytes = frameMessage(header, jpeg);
    const length = new DataView(bytes.buffer).getUint32(0, false);
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
    expect(json).toEqual({ type: 'frame', ...header });
    expect([...bytes.subarray(4 + length)]).toEqual([0xff, 0xd8, 0xff]);
  });
});

describe('trackerUrl', () => {
  it('uses the page origin, secure when the page is', () => {
    expect(trackerUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/track',
    );
    expect(trackerUrl({ protocol: 'https:', host: '192.168.1.5:5173' })).toBe(
      'wss://192.168.1.5:5173/track',
    );
  });
});

describe('TrackerClient', () => {
  it('is connected once the tracker says it is ready, and passes masks on', () => {
    const { client, sockets, masks, connections } = setup();
    client.open();
    expect(sockets[0]?.url).toBe('ws://localhost:5173/track');
    expect(client.connected).toBe(false);
    sockets[0]?.accept();
    expect(client.connected).toBe(true);
    expect(client.model).toBe('yoloe-26l-seg');
    expect(connections).toEqual([true]);
    sockets[0]?.receive(mask);
    expect(masks.map((m) => m.seq)).toEqual([41]);
  });

  it('sends frames and targets only while connected', () => {
    const { client, sockets } = setup();
    const header = { seq: 1, t: 0, width: 640, height: 480 };
    expect(client.sendFrame(header, new Uint8Array([0xff, 0xd8]))).toBe(false);
    client.open();
    expect(client.send({ type: 'clear' })).toBe(false);
    sockets[0]?.accept();
    expect(client.sendFrame(header, new Uint8Array([0xff, 0xd8]))).toBe(true);
    const target = { type: 'target', seq: 1, box: [0.1, 0.2, 0.3, 0.4], name: 'cup' } as const;
    expect(client.send(target)).toBe(true);
    expect(sockets[0]?.sent[0]).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(String(sockets[0]?.sent[1]))).toEqual(target);
  });

  it('reconnects with a growing wait, back to short once connected again', () => {
    const { client, sockets, timers, connections, retry } = setup();
    client.open();
    sockets[0]?.accept();
    sockets[0]?.drop();
    expect(client.connected).toBe(false);
    expect(connections).toEqual([true, false]);
    expect(timers.map((t) => t.ms)).toEqual([500]);

    retry();
    sockets[1]?.drop();
    retry();
    sockets[2]?.drop();
    expect(timers.map((t) => t.ms)).toEqual([500, 1000, 2000]);

    retry();
    sockets[3]?.accept();
    expect(connections).toEqual([true, false, true]);
    sockets[3]?.drop();
    expect(timers.at(-1)?.ms).toBe(500);
  });

  it('waits at most 8 s between attempts', () => {
    const { client, sockets, timers, retry } = setup();
    client.open();
    for (let i = 0; i < 8; i++) {
      sockets.at(-1)?.drop();
      retry();
    }
    expect(Math.max(...timers.map((t) => t.ms))).toBe(8000);
  });

  it('stops reconnecting once closed', () => {
    const { client, sockets, timers, connections } = setup();
    client.open();
    sockets[0]?.accept();
    client.close();
    expect(sockets[0]?.closed).toBe(true);
    expect(connections).toEqual([true, false]);
    expect(timers).toEqual([]);
    expect(client.connected).toBe(false);
  });
});
