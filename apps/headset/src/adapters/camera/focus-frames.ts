import type { FocusFrames } from '../../domain/session/action-focus';
import { captureTime } from './frame-stream';
import type { PassthroughCamera } from './passthrough-camera';

// The action focus's frames (domain/session/action-focus.ts): one sharp view for Robotics-ER 2,
// encoded like the planner's snapshots (about 1024 px wide), stamped with when the camera captured
// it on the performance.now() clock, so its boxes can be placed with the head pose of that moment
// and the tracker can match them to the frame it was streamed.

/** The width the action focus is sent (FocusRequestSchema: about 1024 px). */
export const FOCUS_FRAME_WIDTH = 1024;

export class CameraFocusFrames implements FocusFrames {
  constructor(
    private readonly camera: Pick<PassthroughCamera, 'capture'>,
    /** performance.now ms. */
    private readonly now: () => number,
  ) {}

  async grab(): Promise<{ image: { mimeType: 'image/jpeg'; data: string }; t: number } | null> {
    const frame = await this.camera.capture(FOCUS_FRAME_WIDTH);
    if (!frame) return null;
    return {
      image: { mimeType: 'image/jpeg', data: frame.jpegBase64 },
      // A stale frame clock (it may stop in an immersive session) reads as captured now.
      t: captureTime(frame.t, this.now()),
    };
  }
}
