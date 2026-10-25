import type { ImagePayload } from '@clio/protocol';
import { captureTime, type FrameImage } from '../adapters/camera/frame-stream';
import { Webcam } from '../bench/webcam';
import { createLogger } from '../core/log';
import type { CoachFrameSource } from '../domain/coach/ports';
import type { PlanImageSource } from '../domain/session/lesson-controller';
import type { CameraModel } from '../domain/world/camera-model';
import type { CameraFrame, CameraFrameSource } from '../domain/world/grounding';

// The laptop's camera standing in for the headset's passthrough camera, in every role the headset
// gives it: the tracker's stream (frame()), the voice's small frame every few seconds (snapshot()),
// the planner's and the step watcher's sharp frames (snapshots()), the finder's and the closer
// look's frame (capture()) and Robotics-ER's frame (grab()). It plays in the page's own <video>, so
// what is drawn over the picture is what the models were sent. Opening and picking a camera are
// the planner bench's (bench/webcam.ts). It has no lens model: the desk places nothing in 3D.

const log = createLogger('desk-camera');

/** The voice's frames: like the headset's (PassthroughCamera.snapshot). */
const VOICE_WIDTH = 640;
const VOICE_QUALITY = 0.7;
/** One-shot finder frames: like the headset's (PassthroughCamera.capture). */
const CAPTURE_WIDTH = 960;
const CAPTURE_QUALITY = 0.8;
/** Robotics-ER's frame (the focus contract asks for about 1024 px). */
const FOCUS_WIDTH = 1024;
const FOCUS_QUALITY = 0.8;

export class DeskCamera implements CameraFrameSource, CoachFrameSource, PlanImageSource {
  private webcam: Webcam | null = null;
  private readonly canvas = document.createElement('canvas');
  /** Capture time of the newest video frame (performance.now ms), 0 before the first. */
  private lastFrameT = 0;

  constructor(readonly video: HTMLVideoElement) {
    const track = (now: number, meta: VideoFrameCallbackMetadata) => {
      this.lastFrameT = meta.captureTime ?? meta.expectedDisplayTime ?? now;
      video.requestVideoFrameCallback(track);
    };
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(track);
  }

  /** The cameras the browser sees, labeled once the page may use one. */
  static cameras(): Promise<MediaDeviceInfo[]> {
    return Webcam.cameras();
  }

  /** Plays `deviceId` (or the default camera) in the video. Throws when it can't. */
  async open(deviceId?: string): Promise<void> {
    this.close();
    this.webcam = await Webcam.open(this.video, deviceId);
    this.lastFrameT = 0;
    log.info(`camera ${this.webcam.size}`);
  }

  get opened(): boolean {
    return this.webcam !== null;
  }

  get deviceId(): string | undefined {
    return this.webcam?.deviceId;
  }

  get size(): string {
    return this.webcam?.size ?? '';
  }

  close(): void {
    this.webcam?.close();
    this.webcam = null;
  }

  model(): CameraModel | null {
    return null;
  }

  /** The newest video frame, unencoded, stamped with its capture time; null before one. */
  frame(): FrameImage | null {
    const { videoWidth: width, videoHeight: height } = this.video;
    if (!this.webcam || this.video.readyState < 2 || !width || !height) return null;
    const now = performance.now();
    return { source: this.video, width, height, t: captureTime(this.lastFrameT || now, now) };
  }

  async capture(maxWidth = CAPTURE_WIDTH): Promise<CameraFrame | null> {
    const frame = this.frame();
    const jpeg = frame && this.encode(maxWidth, CAPTURE_QUALITY);
    return frame && jpeg
      ? { t: frame.t, width: frame.width, height: frame.height, jpegBase64: jpeg }
      : null;
  }

  async snapshot(): Promise<string | null> {
    return this.encode(VOICE_WIDTH, VOICE_QUALITY);
  }

  /** Up to `max` sharp frames about 400 ms apart, as the headset sends the planner; [] without. */
  async snapshots(max: number): Promise<ImagePayload[]> {
    if (!this.webcam || max <= 0) return [];
    return this.webcam.snapshots(max).catch(() => []);
  }

  /** One sharp frame for Robotics-ER and when it was captured (performance.now ms). */
  async grab(): Promise<{ image: ImagePayload; t: number } | null> {
    const frame = this.frame();
    const data = frame && this.encode(FOCUS_WIDTH, FOCUS_QUALITY);
    return frame && data ? { image: { mimeType: 'image/jpeg', data }, t: frame.t } : null;
  }

  private encode(maxWidth: number, quality: number): string | null {
    const { videoWidth: w, videoHeight: h } = this.video;
    if (!this.webcam || this.video.readyState < 2 || !w || !h) return null;
    const scale = Math.min(1, maxWidth / w);
    this.canvas.width = Math.round(w * scale);
    this.canvas.height = Math.round(h * scale);
    const g = this.canvas.getContext('2d');
    if (!g) return null;
    g.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    return this.canvas.toDataURL('image/jpeg', quality).split(',')[1] ?? null;
  }
}
