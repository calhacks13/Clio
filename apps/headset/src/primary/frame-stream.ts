// Camera frames for the tracker (tracker/TRACK.md), as fast as the Mac answers them:
// the next frame goes out once the result for the last one is back, or after RESULT_WAIT_MS if it
// never comes. The Quest runs hot (it has shut down for heat), so the stream stays light: frames
// shrunk to 640x480 and JPEG-encoded asynchronously off the render path, never more than one
// encoding at a time, at most MAX_FPS, and nothing at all while stopped (the XR session ended or
// the page is hidden).

export interface FrameImage {
  source: ImageBitmapSource;
  width: number;
  height: number;
  /** Capture time on the performance.now() clock. */
  t: number;
}

export interface StreamedFrame {
  seq: number;
  t: number;
  width: number;
  height: number;
  jpeg: Blob;
}

export interface FrameStreamOptions {
  maxFps?: number;
  /** Send the next frame after this long even if the last one's result never arrived (ms). */
  resultWaitMs?: number;
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
  encode?(image: FrameImage, width: number, height: number, quality: number): Promise<Blob>;
  failed?(err: unknown): void;
  options?: FrameStreamOptions;
}

export const MAX_FPS = 15;
export const RESULT_WAIT_MS = 500;
const MAX_WIDTH = 640;
const MAX_HEIGHT = 480;
const QUALITY = 0.7;
/** The result rate is counted over this window (ms). */
const RATE_WINDOW_MS = 2000;

export class FrameStream {
  private running = false;
  /** Bumped by every stop, so an encoding that finishes afterwards is dropped. */
  private generation = 0;
  private encoding = false;
  private seq = 0;
  private lastStartT = Number.NEGATIVE_INFINITY;
  private awaiting: { seq: number; sentT: number } | null = null;
  private last: { frame: StreamedFrame; sentT: number } | null = null;
  private readonly results: number[] = [];

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
    this.last = null;
    this.results.length = 0;
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

  /** The tracker answered frame `seq`: the next frame may go. */
  received(seq: number): void {
    const now = this.deps.now();
    this.results.push(now);
    this.forgetOldResults(now);
    if (this.awaiting && seq >= this.awaiting.seq) this.awaiting = null;
  }

  /** Per render frame: encode and send the next frame when one is due. */
  tick(): void {
    if (!this.running || this.encoding) return;
    const now = this.deps.now();
    if (now - this.lastStartT < 1000 / (this.options.maxFps ?? MAX_FPS)) return;
    if (
      this.awaiting &&
      now - this.awaiting.sentT < (this.options.resultWaitMs ?? RESULT_WAIT_MS)
    ) {
      return;
    }
    if (!this.deps.ready()) return;
    const image = this.deps.grab();
    if (!image) return;
    this.lastStartT = now;
    void this.encodeAndSend(image);
  }

  private async encodeAndSend(image: FrameImage): Promise<void> {
    const generation = this.generation;
    const { width, height } = fit(
      image.width,
      image.height,
      this.options.maxWidth ?? MAX_WIDTH,
      this.options.maxHeight ?? MAX_HEIGHT,
    );
    // Held until the encoding really finishes, even across a stop and start.
    this.encoding = true;
    let jpeg: Blob;
    try {
      jpeg = await (this.deps.encode ?? encodeJpeg)(
        image,
        width,
        height,
        this.options.quality ?? QUALITY,
      );
    } catch (err) {
      if (generation === this.generation) this.deps.failed?.(err);
      return;
    } finally {
      this.encoding = false;
    }
    if (generation !== this.generation) return;
    const frame: StreamedFrame = { seq: this.seq + 1, t: image.t, width, height, jpeg };
    if (!this.deps.send(frame)) return;
    this.seq = frame.seq;
    const sentT = this.deps.now();
    this.awaiting = { seq: frame.seq, sentT };
    this.last = { frame, sentT };
  }

  private forgetOldResults(now: number): void {
    while (this.results.length > 0 && now - (this.results[0] ?? now) > RATE_WINDOW_MS) {
      this.results.shift();
    }
  }

  private get options(): FrameStreamOptions {
    return this.deps.options ?? {};
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

let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;

/**
 * Shrinks the frame while decoding it (createImageBitmap), then lets the browser encode the JPEG
 * asynchronously (OffscreenCanvas.convertToBlob, else canvas.toBlob), so neither blocks a render.
 */
export async function encodeJpeg(
  image: FrameImage,
  width: number,
  height: number,
  quality: number,
): Promise<Blob> {
  const bitmap = await createImageBitmap(image.source, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: 'low',
  });
  try {
    canvas ??=
      typeof OffscreenCanvas === 'undefined'
        ? document.createElement('canvas')
        : new OffscreenCanvas(width, height);
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d') as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null;
    if (!g) throw new Error('No 2D canvas context');
    g.drawImage(bitmap, 0, 0);
    if ('convertToBlob' in canvas)
      return await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const element = canvas;
    return await new Promise((resolve, reject) =>
      element.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('JPEG encoding failed'))),
        'image/jpeg',
        quality,
      ),
    );
  } finally {
    bitmap.close();
  }
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

/** A JPEG blob as the base64 the server's image payload takes. */
export async function jpegBase64(jpeg: Blob): Promise<string> {
  const bytes = new Uint8Array(await jpeg.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
