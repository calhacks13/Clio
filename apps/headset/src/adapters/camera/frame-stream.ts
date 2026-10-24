// Camera frames for the tracker (tracker/TRACK.md), as fast as the Mac answers them. The tracker
// only ever tracks the newest frame it was sent, so one frame is out at a time: the next goes once
// the answer for the last one is back, or after RESULT_WAIT_MS if it never comes. To keep the
// tracker busy, the next frame is grabbed and encoded while the last one is still out (timed to be
// ready about when its answer is due) and goes the moment that answer arrives; one that has waited
// more than PREPARED_MAX_AGE_MS since is dropped for a fresh grab. The Quest runs hot (it has shut
// down for heat), so the stream stays light: frames shrunk (frameSize), encoded after the XR frame
// rather than inside it, never two at a time, at most MAX_FPS, and nothing at all while stopped
// (the XR session ended or the page is hidden).

export interface FrameImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  /** Capture time on the performance.now() clock. */
  t: number;
}

/** A JPEG as bytes for the tracker and as base64 for the server's image payload. */
export interface EncodedJpeg {
  bytes: Uint8Array;
  base64: string;
}

export interface StreamedFrame {
  seq: number;
  t: number;
  width: number;
  height: number;
  jpeg: EncodedJpeg;
}

export interface FrameStreamOptions {
  maxFps?: number;
  /** Send the next frame after this long even if the last one's result never arrived (ms). */
  resultWaitMs?: number;
  /** A frame encoded ahead is sent only if it was ready at most this long ago (ms). */
  preparedMaxAgeMs?: number;
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
}

export interface FrameStreamDeps {
  /** The camera's newest frame, or null when there is none yet. */
  grab(): FrameImage | null;
  /** Whether a frame would be accepted now (the tracker is connected); nothing is encoded before. */
  ready(): boolean;
  /** Send an encoded frame; false when it could not be sent. */
  send(frame: StreamedFrame): boolean;
  now(): number;
  /** JPEG-encode a frame at width x height (defaults to encodeJpeg). */
  encode?(image: FrameImage, width: number, height: number, quality: number): Promise<EncodedJpeg>;
  failed?(err: unknown): void;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
  options?: FrameStreamOptions;
}

export const MAX_FPS = 30;
export const RESULT_WAIT_MS = 500;
export const PREPARED_MAX_AGE_MS = 50;
/** Start encoding ahead this much before the frame is due (ms): about one XR frame at 72 Hz. */
const PREPARE_LEAD_MS = 15;
const QUALITY = 0.7;
/** The result rate is counted over this window (ms). */
const RATE_WINDOW_MS = 2000;

/** Frame widths the stream can be asked for (?frame=), all 4:3. */
export const FRAME_WIDTHS = [640, 512, 480, 320] as const;
/**
 * Measured on Quest Browser 154, toDataURL takes about 17 ms at 640x480, 12 ms at 480x360 and
 * 7 ms at 320x240, all on the main thread. 480 keeps a small object a few dozen pixels across
 * for YOLOE (which letterboxes to 640 anyway) at two thirds of 640's time and bytes.
 */
export const DEFAULT_FRAME_WIDTH = 480;

/** The stream's frame size for a ?frame= value: one of FRAME_WIDTHS wide, 4:3; else the default. */
export function frameSize(param: string | null): { maxWidth: number; maxHeight: number } {
  const asked = Number(param);
  const width = FRAME_WIDTHS.find((w) => w === asked) ?? DEFAULT_FRAME_WIDTH;
  return { maxWidth: width, maxHeight: (width * 3) / 4 };
}

/** The last few values of a measurement: their median and mean. */
export class RecentSamples {
  private readonly values: number[] = [];
  private median: number | null = null;

  constructor(private readonly size = 60) {}

  add(value: number): void {
    this.values.push(value);
    if (this.values.length > this.size) this.values.shift();
    this.median = null;
  }

  /** Null before the first value. */
  get p50(): number | null {
    if (this.median === null && this.values.length > 0) {
      const sorted = [...this.values].sort((a, b) => a - b);
      this.median = sorted[sorted.length >> 1] ?? null;
    }
    return this.median;
  }

  /** Null before the first value. */
  get mean(): number | null {
    if (this.values.length === 0) return null;
    return this.values.reduce((sum, v) => sum + v, 0) / this.values.length;
  }

  clear(): void {
    this.values.length = 0;
    this.median = null;
  }
}

export interface FrameStreamStats {
  /** Results received per second. */
  fps: number;
  /** Median time from sending a frame to its result (ms). */
  sendToAnswerMs: number | null;
  /** Median time to grab and encode a frame (ms). */
  encodeMs: number | null;
  /** Share of recent frames that were encoded while the one before was still out. */
  aheadShare: number | null;
}

interface Prepared {
  frame: Omit<StreamedFrame, 'seq'>;
  /** When it was encoded. */
  readyT: number;
  /** Grabbed while the frame before it was still out. */
  ahead: boolean;
}

export class FrameStream {
  private running = false;
  /** Bumped by every stop, so an encoding that finishes afterwards is dropped. */
  private generation = 0;
  /** An encoding queued or running; held until it really finishes, even across a stop and start. */
  private encoding = false;
  private seq = 0;
  private lastSentT = Number.NEGATIVE_INFINITY;
  private awaiting: { seq: number; sentT: number } | null = null;
  private prepared: Prepared | null = null;
  private last: { frame: StreamedFrame; sentT: number } | null = null;
  private timer: unknown = null;
  private readonly results: number[] = [];
  private readonly sendToAnswer = new RecentSamples();
  private readonly encodeMs = new RecentSamples();
  private readonly ahead = new RecentSamples();

  constructor(private readonly deps: FrameStreamDeps) {}

  get streaming(): boolean {
    return this.running;
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
    this.generation++;
    this.awaiting = null;
    this.prepared = null;
    this.last = null;
    this.results.length = 0;
    this.sendToAnswer.clear();
    this.encodeMs.clear();
    this.ahead.clear();
    if (this.timer !== null) (this.deps.clearTimeout ?? clearTimeout)(this.timer as number);
    this.timer = null;
  }

  /** The last frame sent, if it went out within maxAgeMs (ms). */
  latest(maxAgeMs: number): StreamedFrame | null {
    if (!this.last || this.deps.now() - this.last.sentT > maxAgeMs) return null;
    return this.last.frame;
  }

  /** Results received per second, over the last couple of seconds. */
  get fps(): number {
    this.forgetOldResults(this.deps.now());
    return this.results.length / (RATE_WINDOW_MS / 1000);
  }

  get stats(): FrameStreamStats {
    return {
      fps: this.fps,
      sendToAnswerMs: this.sendToAnswer.p50,
      encodeMs: this.encodeMs.p50,
      aheadShare: this.ahead.mean,
    };
  }

  /** The tracker answered frame `seq`: the next frame goes now if it is ready. */
  received(seq: number): void {
    const now = this.deps.now();
    this.results.push(now);
    this.forgetOldResults(now);
    if (!this.awaiting || seq < this.awaiting.seq) return;
    this.sendToAnswer.add(now - this.awaiting.sentT);
    this.awaiting = null;
    this.pump(false);
  }

  /** Per render frame: send the next frame when one is due, or encode it ahead. */
  tick(): void {
    this.pump(true);
  }

  /**
   * Send the prepared frame if the tracker is free and the rate cap allows, else see that the next
   * one is encoded in time. From an XR frame (`inFrame`) the encoding waits until the frame is
   * done, so it never delays a render.
   */
  private pump(inFrame: boolean): void {
    if (!this.running || !this.deps.ready()) return;
    const now = this.deps.now();
    if (this.prepared && now - this.prepared.readyT > this.preparedMaxAgeMs) this.prepared = null;
    const out = this.awaiting !== null && now - this.awaiting.sentT < this.resultWaitMs;
    const capT = this.lastSentT + 1000 / this.maxFps;
    const encodeMs = this.encodeMs.p50 ?? 0;
    if (!out) {
      if (now >= capT) {
        if (this.prepared) this.sendPrepared(now);
        else this.prepare(inFrame);
        return;
      }
      // Only the cap holds the next frame back: grab it just in time, on a timer, not a tick.
      const grabT = capT - encodeMs;
      if (now >= grabT) this.prepare(inFrame);
      this.wakeAt(this.prepared || this.encoding ? capT : grabT, now);
      return;
    }
    // Out: have the next frame ready about when the answer is due (the median so far), starting a
    // little early as ticks are up to an XR frame apart. When the cap comes later than that, its
    // time is known exactly: grab just in time for it, on a timer. An answer this late may be
    // long: encode once it comes.
    const answerT = (this.awaiting?.sentT ?? now) + (this.sendToAnswer.p50 ?? 0);
    if (now > answerT + this.preparedMaxAgeMs) return;
    const capGrabT = capT - encodeMs;
    const answerGrabT = answerT - encodeMs - PREPARE_LEAD_MS;
    if (now >= Math.max(capGrabT, answerGrabT)) this.prepare(inFrame);
    else if (capGrabT >= answerGrabT) this.wakeAt(capGrabT, now);
  }

  private sendPrepared(now: number): void {
    if (!this.prepared) return;
    const { frame: prepared, ahead } = this.prepared;
    this.prepared = null;
    const frame: StreamedFrame = { seq: this.seq + 1, ...prepared };
    if (!this.deps.send(frame)) return;
    this.ahead.add(ahead ? 1 : 0);
    this.seq = frame.seq;
    this.lastSentT = now;
    this.awaiting = { seq: frame.seq, sentT: now };
    this.last = { frame, sentT: now };
  }

  /** Grab and encode the next frame, unless one is ready or being encoded. */
  private prepare(deferred: boolean): void {
    if (this.prepared || this.encoding) return;
    const generation = this.generation;
    this.encoding = true;
    if (!deferred) {
      void this.encode(generation);
      return;
    }
    (this.deps.setTimeout ?? setTimeout)(() => void this.encode(generation), 0);
  }

  private async encode(generation: number): Promise<void> {
    const image = generation === this.generation && this.running ? this.deps.grab() : null;
    if (!image) {
      this.encoding = false;
      return;
    }
    const grabT = this.deps.now();
    const ahead = this.awaiting !== null;
    const { width, height } = fit(image.width, image.height, this.maxWidth, this.maxHeight);
    let jpeg: EncodedJpeg;
    try {
      jpeg = await (this.deps.encode ?? encodeJpeg)(image, width, height, this.quality);
    } catch (err) {
      if (generation === this.generation) this.deps.failed?.(err);
      return;
    } finally {
      this.encoding = false;
    }
    if (generation !== this.generation) return;
    const readyT = this.deps.now();
    this.encodeMs.add(readyT - grabT);
    this.prepared = { frame: { t: image.t, width, height, jpeg }, readyT, ahead };
    this.pump(false);
  }

  /** Pump again at time t, when the rate cap holds the next frame back. */
  private wakeAt(t: number, now: number): void {
    if (this.timer !== null) return;
    this.timer = (this.deps.setTimeout ?? setTimeout)(
      () => {
        this.timer = null;
        this.pump(false);
      },
      Math.max(0, t - now),
    );
  }

  private forgetOldResults(now: number): void {
    while (this.results.length > 0 && now - (this.results[0] ?? now) > RATE_WINDOW_MS) {
      this.results.shift();
    }
  }

  private get maxFps(): number {
    return this.deps.options?.maxFps ?? MAX_FPS;
  }

  private get resultWaitMs(): number {
    return this.deps.options?.resultWaitMs ?? RESULT_WAIT_MS;
  }

  private get preparedMaxAgeMs(): number {
    return this.deps.options?.preparedMaxAgeMs ?? PREPARED_MAX_AGE_MS;
  }

  private get maxWidth(): number {
    return this.deps.options?.maxWidth ?? DEFAULT_FRAME_WIDTH;
  }

  private get maxHeight(): number {
    return this.deps.options?.maxHeight ?? (DEFAULT_FRAME_WIDTH * 3) / 4;
  }

  private get quality(): number {
    return this.deps.options?.quality ?? QUALITY;
  }
}

/** The largest size within maxWidth x maxHeight with the image's aspect, never upscaled. */
export function fit(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

let canvas: HTMLCanvasElement | OffscreenCanvas | null = null;

/**
 * Draws the frame shrunk onto a canvas and encodes it with the synchronous toDataURL. On Quest
 * Browser 154 every asynchronous encode (canvas.toBlob, OffscreenCanvas.convertToBlob) takes a
 * fixed ~4 s whatever the size, which held the tracker stream to one frame every 4 s; toDataURL
 * takes 7 to 17 ms (frameSize). Its base64 is kept for the server's image payload, and decoded
 * with Uint8Array.fromBase64 (0.1 to 0.3 ms on the Quest, against 2 to 5 ms for an atob loop).
 * Without a document (workers, tests) it falls back to convertToBlob.
 */
export async function encodeJpeg(
  image: FrameImage,
  width: number,
  height: number,
  quality: number,
): Promise<EncodedJpeg> {
  canvas ??=
    typeof document === 'undefined'
      ? new OffscreenCanvas(width, height)
      : document.createElement('canvas');
  // Setting a canvas's size clears and reallocates it, even to the same size.
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const g = canvas.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!g) throw new Error('No 2D canvas context');
  g.drawImage(image.source, 0, 0, width, height);
  if (!('toDataURL' in canvas)) {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { bytes, base64: bytesToBase64(bytes) };
  }
  const url = canvas.toDataURL('image/jpeg', quality);
  const base64 = url.slice(url.indexOf(',') + 1);
  return { bytes: base64ToBytes(base64), base64 };
}

type Base64Decoder = { fromBase64?(base64: string): Uint8Array };

export function base64ToBytes(base64: string): Uint8Array {
  const native = (Uint8Array as unknown as Base64Decoder).fromBase64;
  if (native) return native(base64);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Frames from a playing video, stamped with their capture time (requestVideoFrameCallback), or
 * with the time they were asked for where the browser doesn't report it.
 */
export function videoFrames(video: HTMLVideoElement): () => FrameImage | null {
  let frameT = 0;
  if ('requestVideoFrameCallback' in video) {
    const onFrame = (now: number, meta: VideoFrameCallbackMetadata) => {
      frameT = meta.captureTime ?? meta.expectedDisplayTime ?? now;
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }
  return () => {
    const { videoWidth: width, videoHeight: height } = video;
    if (video.readyState < 2 || !width || !height) return null;
    return { source: video, width, height, t: frameT || performance.now() };
  };
}
