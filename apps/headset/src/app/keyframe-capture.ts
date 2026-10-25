import { keyframeMediaName, type PixelIntrinsics } from '@clio/protocol';
import { captureTime, type FrameImage, fit, RecentSamples } from '../adapters/camera/frame-stream';
import type { PassthroughCamera } from '../adapters/camera/passthrough-camera';
import type { Clock } from '../core/clock';
import { createLogger } from '../core/log';
import { composePose, type Pose, poseToTuple, type Vec3 } from '../core/math';
import type { AppBus } from '../domain/events';
import type { CameraIntrinsics } from '../domain/world/camera-model';
import { KeyframeSelector, type KeyframeVerdict } from '../domain/world/keyframes';
import type { PoseHistory } from '../domain/world/pose-history';
import type { Workspace } from '../domain/world/workspace';

// Camera stills for the object models (docs/room-scene.md): while the episode records, about ten
// times a second when a keyframe is due, the newest camera frame is paired with the head pose at
// its capture time and the camera model, and the KeyframeSelector decides. A kept frame is shrunk
// to at most 960 px wide and encoded as a JPEG off the XR frame (asynchronously, never two at a
// time); then the `scene.keyframe` event goes on the bus and the JPEG to the episode's media.
// Only with ?scan=1.

const log = createLogger('keyframes');
export const KEYFRAME_MAX_WIDTH = 960;
const QUALITY = 0.85;
/** While a keyframe is due, a camera frame is looked at this often (ms). */
const LOOK_EVERY_MS = 100;

/**
 * JPEG-encodes a frame at width x height. It must draw the frame before it first awaits, so the
 * picture is the one the pose was taken for.
 */
export type KeyframeEncoder = (
  image: FrameImage,
  width: number,
  height: number,
  quality: number,
) => Promise<Blob>;

export interface KeyframeCaptureDeps {
  bus: AppBus;
  clock: Clock;
  camera: Pick<PassthroughCamera, 'frame' | 'model'>;
  poses: PoseHistory;
  workspace: () => Workspace;
  /** Points of the work in W a keyframe should show one of (objects, the table's middle). */
  focus: () => readonly Vec3[];
  /** Uploads a keyframe's JPEG with the episode (EpisodeRecorder.attachMedia). */
  attach: (name: string, jpeg: Blob) => void;
  encode?: KeyframeEncoder;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  selector?: KeyframeSelector;
}

interface Shot {
  image: FrameImage;
  /** Capture time, performance.now ms. */
  t: number;
  /** Camera pose in W at t. */
  pose: Pose;
  width: number;
  height: number;
  intrinsics: PixelIntrinsics;
}

export interface KeyframeStats {
  kept: number;
  /** Why the frames looked at this episode were not kept, by verdict. */
  verdicts: Record<KeyframeVerdict, number>;
  /** Median encode time (ms), null before the first. */
  encodeMs: number | null;
  failures: number;
}

const noVerdicts = (): Record<KeyframeVerdict, number> => ({
  keep: 0,
  full: 0,
  soon: 0,
  moving: 0,
  away: 0,
  seen: 0,
});

export class KeyframeCapture {
  private readonly selector: KeyframeSelector;
  /** Bumped by every reset, so a look or an encode that finishes afterwards is dropped. */
  private generation = 0;
  /** A look queued or an encode running; held until it really finishes, even across a reset. */
  private busy = false;
  private lookedT = Number.NEGATIVE_INFINITY;
  private verdicts = noVerdicts();
  private failures = 0;
  private readonly encodeMs = new RecentSamples(40);

  constructor(private readonly deps: KeyframeCaptureDeps) {
    this.selector = deps.selector ?? new KeyframeSelector();
  }

  get stats(): KeyframeStats {
    return {
      kept: this.selector.count,
      verdicts: { ...this.verdicts },
      encodeMs: this.encodeMs.p50,
      failures: this.failures,
    };
  }

  /** Every XR frame while recording: looks at the camera after the frame when a keyframe is due. */
  update(t: number): void {
    if (this.busy || t - this.lookedT < LOOK_EVERY_MS || !this.selector.due(t)) return;
    this.lookedT = t;
    this.busy = true;
    const generation = this.generation;
    (this.deps.setTimeout ?? setTimeout)(() => void this.look(generation), 0);
  }

  /** A new episode (or the end of one): its count starts over and late results are dropped. */
  reset(): void {
    const { kept, verdicts, encodeMs, failures } = this.stats;
    if (kept > 0 || failures > 0) {
      const skipped = (['seen', 'moving', 'away'] as const).map((v) => `${verdicts[v]} ${v}`);
      const encode = encodeMs === null ? '' : `, encode ${Math.round(encodeMs)} ms median`;
      log.info(`${kept} kept (${skipped.join(', ')})${encode}, ${failures} failed`);
    }
    this.generation++;
    this.selector.reset();
    this.lookedT = Number.NEGATIVE_INFINITY;
    this.verdicts = noVerdicts();
    this.failures = 0;
  }

  private async look(generation: number): Promise<void> {
    try {
      const shot = generation === this.generation ? this.choose() : null;
      if (!shot) return;
      const { clock } = this.deps;
      const started = clock.now();
      const encode = this.deps.encode ?? encodeJpegBlob;
      const jpeg = await encode(shot.image, shot.width, shot.height, QUALITY);
      this.encodeMs.add(clock.now() - started);
      if (generation === this.generation) this.store(shot, jpeg);
    } catch (err) {
      if (generation !== this.generation) return;
      if (this.failures++ === 0) log.warn(`keyframe not stored (${String(err)})`);
    } finally {
      this.busy = false;
    }
  }

  /** The newest camera frame with its pose, if the selector keeps it. */
  private choose(): Shot | null {
    const { camera, clock, poses } = this.deps;
    const image = camera.frame();
    if (!image) return null;
    const t = captureTime(image.t, clock.now());
    const head = poses.at(t);
    if (!head) return null;
    const model = camera.model();
    const pose = this.deps.workspace().toWorkspacePose(composePose(head, model.headFromCamera));
    const verdict = this.selector.judge({
      pose,
      t,
      motion: poses.motion(t),
      intrinsics: model.intrinsics,
      focus: this.deps.focus(),
    });
    this.verdicts[verdict]++;
    if (verdict !== 'keep') return null;
    const { width, height } = fit(
      image.width,
      image.height,
      KEYFRAME_MAX_WIDTH,
      KEYFRAME_MAX_WIDTH,
    );
    return { image, t, pose, width, height, intrinsics: scaled(model.intrinsics, width, height) };
  }

  private store(shot: Shot, jpeg: Blob): void {
    this.selector.keep(shot.pose, shot.t);
    const media = keyframeMediaName(this.selector.count);
    this.deps.bus.emit('scene.keyframe', {
      t: this.deps.clock.now(),
      media,
      capturedT: shot.t,
      pose: poseToTuple(shot.pose),
      width: shot.width,
      height: shot.height,
      intrinsics: shot.intrinsics,
    });
    this.deps.attach(media, jpeg);
  }
}

/** The camera's intrinsics for an image of width x height (the same view, scaled). */
export function scaled(k: CameraIntrinsics, width: number, height: number): PixelIntrinsics {
  const sx = width / k.width;
  const sy = height / k.height;
  return { fx: k.fx * sx, fy: k.fy * sy, cx: k.cx * sx, cy: k.cy * sy };
}

let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;

/**
 * Draws the frame shrunk onto a canvas at once and encodes it asynchronously, so the XR frame
 * never waits for it (unlike the tracker stream's toDataURL, frame-stream.ts: there a slow encode
 * would hold the stream back; here one keyframe every few seconds is plenty).
 */
async function encodeJpegBlob(
  image: FrameImage,
  width: number,
  height: number,
  quality: number,
): Promise<Blob> {
  canvas ??=
    typeof OffscreenCanvas === 'undefined'
      ? document.createElement('canvas')
      : new OffscreenCanvas(width, height);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const g = canvas.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!g) throw new Error('No 2D canvas context');
  g.drawImage(image.source, 0, 0, width, height);
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/jpeg', quality });
  const target = canvas;
  return new Promise((resolve, reject) =>
    target.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('JPEG encoding failed'))),
      'image/jpeg',
      quality,
    ),
  );
}
