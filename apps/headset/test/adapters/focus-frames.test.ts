import { describe, expect, it, vi } from 'vitest';
import { CameraFocusFrames, FOCUS_FRAME_WIDTH } from '../../src/adapters/camera/focus-frames';
import { MAX_FRAME_AGE_MS } from '../../src/adapters/camera/frame-stream';

// The action focus's frames: one sharp view about 1024 px wide, stamped with its capture time.

const camera = (t: number | null) => ({
  capture: vi.fn(async () =>
    t === null ? null : { t, width: 1280, height: 960, jpegBase64: '/9j/4AAQ' },
  ),
});

describe('CameraFocusFrames', () => {
  it('grabs one view at the planner snapshots width, stamped when the camera captured it', async () => {
    const source = camera(9_970);
    const frames = new CameraFocusFrames(source, () => 10_000);
    await expect(frames.grab()).resolves.toEqual({
      image: { mimeType: 'image/jpeg', data: '/9j/4AAQ' },
      t: 9_970,
    });
    expect(source.capture).toHaveBeenCalledWith(FOCUS_FRAME_WIDTH);
    expect(FOCUS_FRAME_WIDTH).toBe(1024);
  });

  it('takes a stale frame clock as captured now, and has nothing before the video does', async () => {
    const stale = new CameraFocusFrames(camera(10_000 - MAX_FRAME_AGE_MS - 1), () => 10_000);
    await expect(stale.grab()).resolves.toMatchObject({ t: 10_000 });
    await expect(new CameraFocusFrames(camera(null), () => 0).grab()).resolves.toBeNull();
  });
});
