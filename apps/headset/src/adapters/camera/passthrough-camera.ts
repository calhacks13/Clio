import type { ImagePayload } from '@clio/protocol';
import { createLogger } from '../../core/log';
import type { CoachFrameSource } from '../../domain/coach/ports';
import type { PlanImageSource } from '../../domain/session/lesson-controller';
import type { CameraModel } from '../../domain/world/camera-model';
import type { CameraFrame, CameraFrameSource } from '../../domain/world/grounding';
import { cameraModelFromSettings, defaultQuestCameraModel } from './calibration';
import { applyStoredCalibration, loadStoredCalibration } from './stored-calibration';

// Quest Browser exposes the headset's front RGB cameras through getUserMedia (Browser 40.1+). We
// ask for the environment-facing camera explicitly: the "facing front" device is the avatar selfie
// camera, which can wedge the media stack until reboot. Open the camera BEFORE entering XR: a
// permission prompt during an immersive session ends the session.
//
// Known issue (Sept 2026, Browser ~150): the headset-camera permission prompt may never appear;
// grant it over adb (docs/dev-setup.md). On desktop any webcam works, which is handy for testing
// grounding with the emulator.
//
// open({ storedCalibration: true }) puts calibrate.html's saved camera pose on the model when it
// was made for the same model (the default guess, or the same lens metadata; stored-calibration.ts).
// calibrate.html itself opens the camera without it.

const log = createLogger('camera');
const isQuest = () => /OculusBrowser|Quest/.test(navigator.userAgent);
/** Time between the frames of one snapshots() call, so they don't all show the same instant. */
const SNAPSHOT_GAP_MS = 400;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class PassthroughCamera implements CameraFrameSource, CoachFrameSource, PlanImageSource {
  private readonly canvas = document.createElement('canvas');
  private lastFrameT = 0;
  private readonly calibration: CameraModel;

  private constructor(
    private readonly video: HTMLVideoElement,
    private readonly stream: MediaStream,
    private readonly reported: Record<string, unknown>,
    storedCalibration: boolean,
  ) {
    const width = video.videoWidth || Number(reported.width) || 1280;
    const height = video.videoHeight || Number(reported.height) || 960;
    const fromBrowser = cameraModelFromSettings(reported, { width, height });
    const model = fromBrowser ?? defaultQuestCameraModel(width, height);
    const stored = storedCalibration ? loadStoredCalibration() : null;
    this.calibration = applyStoredCalibration(model, fromBrowser ? 'lens' : 'default', stored);
    log.info(
      `${width}x${height}, calibration from ${fromBrowser ? 'browser lens metadata' : 'Quest 3 defaults'}${this.calibration === model ? '' : ', with the stored calibration'}`,
    );
    const track = (now: number, meta: VideoFrameCallbackMetadata) => {
      this.lastFrameT = meta.captureTime ?? meta.expectedDisplayTime ?? now;
      video.requestVideoFrameCallback(track);
    };
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(track);
  }

  static async open(
    options: { storedCalibration?: boolean } = {},
  ): Promise<PassthroughCamera | null> {
    if (!navigator.mediaDevices?.getUserMedia) return null;
    const size = { width: { ideal: 1280 }, height: { ideal: 960 } };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: isQuest() ? { facingMode: { exact: 'environment' }, ...size } : size,
      });
    } catch (err) {
      log.warn(
        `camera unavailable (${String(err)}). On Quest, grant the headset camera permission (see docs/dev-setup.md).`,
      );
      return null;
    }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    const track = stream.getVideoTracks()[0];
    const settings = (track?.getSettings() ?? {}) as Record<string, unknown>;
    log.info(`camera settings: ${JSON.stringify(settings)}`);
    return new PassthroughCamera(video, stream, settings, options.storedCalibration ?? false);
  }

  /** Raw MediaTrackSettings, including Quest's experimental lens fields when present. */
  get settings(): Record<string, unknown> {
    return this.reported;
  }

  model(): CameraModel {
    return this.calibration;
  }

  async capture(maxWidth = 960): Promise<CameraFrame | null> {
    const jpeg = this.encode(maxWidth, 0.8);
    return jpeg
      ? {
          t: this.lastFrameT || performance.now(),
          width: this.video.videoWidth,
          height: this.video.videoHeight,
          jpegBase64: jpeg,
        }
      : null;
  }

  async snapshot(): Promise<string | null> {
    return this.encode(640, 0.7);
  }

  /**
   * Up to `max` sharp frames for the planner and the step watcher, the first at once and each next
   * about 400 ms later. Stops early when the video isn't ready, so it may return fewer.
   */
  async snapshots(max: number): Promise<ImagePayload[]> {
    const shots: ImagePayload[] = [];
    for (let i = 0; i < max; i++) {
      if (i > 0) await sleep(SNAPSHOT_GAP_MS);
      const jpeg = this.encode(1024, 0.8);
      if (!jpeg) break;
      shots.push({ mimeType: 'image/jpeg', data: jpeg });
    }
    return shots;
  }

  close(): void {
    for (const t of this.stream.getTracks()) t.stop();
  }

  private encode(maxWidth: number, quality: number): string | null {
    const { videoWidth: w, videoHeight: h } = this.video;
    if (this.video.readyState < 2 || !w || !h) return null;
    const scale = Math.min(1, maxWidth / w);
    this.canvas.width = Math.round(w * scale);
    this.canvas.height = Math.round(h * scale);
    const g = this.canvas.getContext('2d');
    if (!g) return null;
    g.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    return this.canvas.toDataURL('image/jpeg', quality).split(',')[1] ?? null;
  }
}
