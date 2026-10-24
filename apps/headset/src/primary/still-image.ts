import { defaultQuestCameraModel } from '../adapters/camera/calibration';
import type { CameraModel } from '../domain/world/camera-model';
import type { CameraFrame, CameraFrameSource } from '../domain/world/grounding';
import type { FrameImage } from './frame-stream';

// A photo in place of the passthrough camera (?image=/demo/<file>.jpg), so the whole loop runs in
// a desktop browser. Every capture is the same JPEG, and every streamed frame the same picture,
// stamped with the time it was asked for and read with the Quest 3 default camera model.

const MAX_WIDTH = 960;
const QUALITY = 0.8;

export class StillImageCamera implements CameraFrameSource {
  private readonly calibration: CameraModel;

  private constructor(
    readonly image: HTMLImageElement,
    private readonly jpegBase64: string,
  ) {
    this.calibration = defaultQuestCameraModel(image.naturalWidth, image.naturalHeight);
  }

  static async load(url: string): Promise<StillImageCamera> {
    const image = new Image();
    image.src = url;
    await image.decode();
    // Encoded once, the way the passthrough camera encodes its frames.
    const scale = Math.min(1, MAX_WIDTH / image.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
    const jpeg = canvas.toDataURL('image/jpeg', QUALITY).split(',')[1];
    if (!jpeg) throw new Error(`Could not encode ${url}`);
    return new StillImageCamera(image, jpeg);
  }

  model(): CameraModel {
    return this.calibration;
  }

  /** The photo as the tracker's next frame. */
  grab(): FrameImage {
    const { image } = this;
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      t: performance.now(),
    };
  }

  async capture(): Promise<CameraFrame> {
    return {
      t: performance.now(),
      width: this.image.naturalWidth,
      height: this.image.naturalHeight,
      jpegBase64: this.jpegBase64,
    };
  }
}
