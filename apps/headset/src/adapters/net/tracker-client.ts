import {
  NormalizedBoxSchema,
  NormalizedPointSchema,
  NormalizedPolygonSchema,
} from '@clio/protocol';
import { z } from 'zod';
import { createLogger } from '../../core/log';

// The live tracking stream (tracker/TRACK.md): camera frames go to the tracker on the Mac, which
// answers every one. A connection has two modes:
//   target   (the primary page) one target, boxed by Gemini and jev's answer about once a second;
//            each frame is answered with a mask.
//   objects  (the lesson) a set of objects in words; the tracker asks jev about them itself,
//            together, about once a second, YOLOE-26 and ByteTrack follow each one on every frame,
//            and each frame is answered with one detection per object, in the set's order.
// A connection is in target mode until it sends an `objects` message. The socket goes through the
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
  /** ByteTrack's id for the track; null from a tracker that omits it. */
  track: z.number().int().nullable().default(null),
});

// One frame answers for every object at once, so one object's odd geometry must not drop the
// others': coordinates are clamped into the image, and an outline of fewer than 3 points is none.
const unit = z.number().transform((v) => Math.min(1, Math.max(0, v)));
const UnitPoint = z.tuple([unit, unit]);
const UnitBox = z.tuple([unit, unit, unit, unit]);
const UnitOutline = z
  .array(UnitPoint)
  .transform((points) => (points.length >= 3 ? points : null))
  .nullable();

/** One object of the set in one frame (objects mode). */
const DetectionSchema = z.object({
  /** The lesson's object id, as sent. */
  id: z.string(),
  found: z.boolean(),
  /** tracking, coasting, lost or unknown (jev has not placed it yet). */
  state: z.string().nullable().default(null),
  box: UnitBox.nullable().default(null),
  outline: UnitOutline.default(null),
  point: UnitPoint.nullable().default(null),
  contact: UnitPoint.nullable().default(null),
  score: z.number().nullable().default(null),
  track: z.number().int().nullable().default(null),
});

const DetectionsSchema = z.object({
  type: z.literal('detections'),
  seq: z.number().int(),
  /** The frame's capture time, echoed back (performance.now() clock). */
  t: z.number(),
  model: z.string().nullable().default(null),
  ms: z.record(z.string(), z.number()).nullable().default(null),
  /** One per object in the set, in its order; empty while the set is. */
  detections: z.array(DetectionSchema),
});

const TrackerMessageSchema = z.discriminatedUnion('type', [
  ReadySchema,
  MaskSchema,
  DetectionsSchema,
]);

export type TrackerMask = z.output<typeof MaskSchema>;
export type TrackerDetection = z.output<typeof DetectionSchema>;
export type TrackerDetections = z.output<typeof DetectionsSchema>;
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

/** An object to follow, in words. */
export interface TrackedQuery {
  /** The lesson's object id: detections come back under it. */
  id: string;
  /** A short category noun phrase, jev's subject. A changed phrase starts the object's track over. */
  phrase: string;
  /** What tells it apart (context for jev); changing it does not restart the track. */
  query: string;
}

/**
 * Replaces the whole set (objects mode; the tracker follows at most 8). An empty set stops
 * tracking and every jev call.
 */
export type ObjectsMessage = { type: 'objects'; objects: readonly TrackedQuery[] };

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
  /** Each mask, as it arrives (target mode). */
  mask?(mask: TrackerMask): void;
  /** Each frame's detections, as they arrive (objects mode). */
  detections?(message: TrackerDetections): void;
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
  /** waitConnected() calls still waiting. */
  private readonly waiting = new Set<(connected: boolean) => void>();

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
    this.settleWaiting(false);
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

  /**
   * Resolves true once connected, false when the connection attempt under way fails first or `ms`
   * milliseconds pass. Call after open().
   */
  waitConnected(ms: number): Promise<boolean> {
    if (this.connected) return Promise.resolve(true);
    if (!this.wanted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (connected: boolean) => {
        this.waiting.delete(done);
        (this.deps.clearTimeout ?? clearTimeout)(timer as number);
        resolve(connected);
      };
      this.waiting.add(done);
      const timer = (this.deps.setTimeout ?? setTimeout)(() => done(false), ms);
    });
  }

  /** Send a target, a clear or an object set; false when not connected. */
  send(message: TargetMessage | ClearMessage | ObjectsMessage): boolean {
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
      this.settleWaiting(false);
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
        this.settleWaiting(true);
      }
      return;
    }
    if (!this.connected) return;
    if (message.type === 'mask') this.deps.mask?.(message);
    else this.deps.detections?.(message);
  }

  private settleWaiting(connected: boolean): void {
    for (const done of [...this.waiting]) done(connected);
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
