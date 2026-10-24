import type { ImagePayload } from '@clio/protocol';

// The laptop's camera for the planner bench. Frames are encoded the way the headset encodes them
// for the planner (PassthroughCamera.snapshots: 1024 px wide, JPEG quality 0.8, ~400 ms apart),
// so a scene here reaches the planner as a headset view of it would.

const PLAN_WIDTH = 1024;
const PLAN_QUALITY = 0.8;
const SNAPSHOT_GAP_MS = 400;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Webcam {
  private readonly canvas = document.createElement('canvas');

  private constructor(
    private readonly video: HTMLVideoElement,
    private readonly stream: MediaStream,
  ) {}

  /** Plays the camera (`deviceId`, or the default one) in `video`. Throws when it can't. */
  static async open(video: HTMLVideoElement, deviceId?: string): Promise<Webcam> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser has no camera access (open the page on localhost)');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
      audio: false,
    });
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    return new Webcam(video, stream);
  }

  /** Cameras, labeled once the page has camera permission. */
  static async cameras(): Promise<MediaDeviceInfo[]> {
    const devices = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
    return devices.filter((d) => d.kind === 'videoinput');
  }

  get deviceId(): string | undefined {
    return this.stream.getVideoTracks()[0]?.getSettings().deviceId;
  }

  get size(): string {
    return `${this.video.videoWidth}×${this.video.videoHeight}`;
  }

  /** `count` frames, the first at once and each next ~400 ms later. */
  async snapshots(count: number): Promise<ImagePayload[]> {
    const shots: ImagePayload[] = [];
    for (let i = 0; i < count; i++) {
      if (i > 0) await sleep(SNAPSHOT_GAP_MS);
      const data = this.encode();
      if (!data) break;
      shots.push({ mimeType: 'image/jpeg', data });
    }
    if (!shots.length) throw new Error('The camera has no picture yet');
    return shots;
  }

  close(): void {
    for (const track of this.stream.getTracks()) track.stop();
    this.video.srcObject = null;
  }

  private encode(): string | null {
    const { videoWidth: w, videoHeight: h } = this.video;
    if (this.video.readyState < 2 || !w || !h) return null;
    const scale = Math.min(1, PLAN_WIDTH / w);
    this.canvas.width = Math.round(w * scale);
    this.canvas.height = Math.round(h * scale);
    const g = this.canvas.getContext('2d');
    if (!g) return null;
    g.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    return this.canvas.toDataURL('image/jpeg', PLAN_QUALITY).split(',')[1] ?? null;
  }
}
