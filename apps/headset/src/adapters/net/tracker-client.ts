import {
  NormalizedBoxSchema,
  NormalizedPointSchema,
  NormalizedPolygonSchema,
} from '@clio/protocol';
import { z } from 'zod';
import { createLogger } from '../../core/log';

// The live tracking stream (tracker/TRACK.md): camera frames go to the tracker on the
// Mac, which segments the current target on every one and answers each with a mask; Gemini and
// jev's answer, about once a second, tell it what the target is. The socket goes through the
// page's own origin (Vite proxies /track to the tracker), and reconnects with backoff while open.

const log = createLogger('tracker');

export const TRACK_PATH = '/track';
const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 8000;

const ReadySchema = z.object({ type: z.literal('ready'), model: z.string() });

const MaskSchema = z.object({
  type: z.literal('mask'),
  seq: z.number().int(),
  /** The frame's capture time, echoed back (performance.now() clock). */
  t: z.number(),
  found: z.boolean(),
  name: z.string().nullable().default(null),
  outline: NormalizedPolygonSchema.nullable().default(null),
  box: NormalizedBoxSchema.nullable().default(null),
  point: NormalizedPointSchema.nullable().default(null),
  /** Middle of the mask's lowest edge, where the object most likely rests on a surface. */
  contact: NormalizedPointSchema.nullable().default(null),
  score: z.number().nullable().default(null),
  /** tracking, coasting, lost, unknown or idle (TRACK.md); null from a tracker that omits it. */
  state: z.string().nullable().default(null),
  ms: z.object({ segment: z.number(), total: z.number() }).partial().nullable().default(null),
  model: z.string().nullable().default(null),
});

const TrackerMessageSchema = z.discriminatedUnion('type', [ReadySchema, MaskSchema]);

export type TrackerMask = z.output<typeof MaskSchema>;
export type TrackerMessage = z.output<typeof TrackerMessageSchema>;

/** The header of a binary frame message; the JPEG bytes follow it. */
export interface FrameHeader {
  seq: number;
  /** Capture time on the performance.now() clock. */
  t: number;
  width: number;
  height: number;
}

export type TargetMessage = {
  type: 'target';
  /** The streamed frame the box was measured on. */
  seq: number;
  box: readonly [number, number, number, number];
  name: string;
  /** ?focus=part: the box is one part of the main object (a label, a button), not all of it. */
  part?: boolean;
};
export type ClearMessage = { type: 'clear' };

/** A message from the tracker, or null for anything this page doesn't understand. */
export function parseTrackerMessage(data: unknown): TrackerMessage | null {
  if (typeof data !== 'string') return null;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = TrackerMessageSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

const encoder = new TextEncoder();

/**
 * A frame message: 4-byte big-endian header length, the JSON header, then the JPEG. One buffer,
 * not a Blob: a WebSocket sends a buffer at once, but reads a Blob back asynchronously first.
 */
export function frameMessage(header: FrameHeader, jpeg: Uint8Array): Uint8Array<ArrayBuffer> {
  const json = encoder.encode(JSON.stringify({ type: 'frame', ...header }));
  const message = new Uint8Array(4 + json.byteLength + jpeg.byteLength);
  new DataView(message.buffer).setUint32(0, json.byteLength, false);
  message.set(json, 4);
  message.set(jpeg, 4 + json.byteLength);
  return message;
}

/** ws(s)://<host>/track on the page's own origin. */
export function trackerUrl(location: Pick<Location, 'protocol' | 'host'>): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${TRACK_PATH}`;
}

/** The parts of WebSocket the client uses, so tests can stand in for it. */
export interface TrackerSocket {
  readonly readyState: number;
  binaryType: BinaryType;
  onclose: ((event: CloseEvent) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  send(data: string | ArrayBufferView<ArrayBuffer>): void;
  close(): void;
}

export interface TrackerClientDeps {
  url: string;
  /** Each mask, as it arrives. */
  mask(mask: TrackerMask): void;
  /** The connection opened (the tracker starts without a target) or closed. */
  connection?(open: boolean): void;
  socket?(url: string): TrackerSocket;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
}

const OPEN = 1;

export class TrackerClient {
  private ws: TrackerSocket | null = null;
  private wanted = false;
  private retryMs = FIRST_RETRY_MS;
  private retry: unknown = null;
  private readyModel: string | null = null;

  constructor(private deps: TrackerClientDeps) {}

  /** Open, once the tracker said it is ready. */
  get connected(): boolean {
    return this.ws?.readyState === OPEN && this.readyModel !== null;
  }

  /** The segmentation model the tracker reported, once connected. */
  get model(): string | null {
    return this.readyModel;
  }

  /** Switch to another tracker: drops the current connection and connects to `url` if open. */
  setUrl(url: string): void {
    if (url === this.deps.url) return;
    const reopen = this.wanted;
    this.close();
    this.deps.url = url;
    if (reopen) this.open();
  }

  /** Connect, and keep reconnecting until close(). */
  open(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.retryMs = FIRST_RETRY_MS;
    this.connect();
  }

  close(): void {
    this.wanted = false;
    if (this.retry !== null) (this.deps.clearTimeout ?? clearTimeout)(this.retry as number);
    this.retry = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
      this.dropped();
    }
  }

  /** Send a frame; false when not connected (nothing was sent). */
  sendFrame(header: FrameHeader, jpeg: Uint8Array): boolean {
    if (!this.connected || !this.ws) return false;
    this.ws.send(frameMessage(header, jpeg));
    return true;
  }

  /** Send a target or clear; false when not connected. */
  send(message: TargetMessage | ClearMessage): boolean {
    if (!this.connected || !this.ws) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  private connect(): void {
    this.retry = null;
    let ws: TrackerSocket;
    try {
      ws = (this.deps.socket ?? ((url) => new WebSocket(url)))(this.deps.url);
    } catch (err) {
      log.warn(`could not open ${this.deps.url}: ${String(err)}`);
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (event) => this.message(event.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.dropped();
      this.scheduleRetry();
    };
  }

  private message(data: unknown): void {
    const message = parseTrackerMessage(data);
    if (!message) return;
    if (message.type === 'ready') {
      const first = this.readyModel === null;
      this.readyModel = message.model;
      this.retryMs = FIRST_RETRY_MS;
      if (first) {
        log.info(`connected (${message.model})`);
        this.deps.connection?.(true);
      }
      return;
    }
    if (this.connected) this.deps.mask(message);
  }

  private dropped(): void {
    if (this.readyModel === null) return;
    this.readyModel = null;
    this.deps.connection?.(false);
  }

  private scheduleRetry(): void {
    if (!this.wanted) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(MAX_RETRY_MS, this.retryMs * 2);
    this.retry = (this.deps.setTimeout ?? setTimeout)(() => this.connect(), wait);
  }
}
