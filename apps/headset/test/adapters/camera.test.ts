import { describe, expect, it } from 'vitest';
import {
  cameraModelFromSettings,
  defaultQuestCameraModel,
} from '../../src/adapters/camera/calibration';

describe('camera calibration', () => {
  it('falls back to approximate Quest 3 intrinsics scaled to the stream', () => {
    const m = defaultQuestCameraModel(640, 480);
    expect(m.intrinsics).toEqual({ width: 640, height: 480, fx: 400, fy: 400, cx: 320, cy: 240 });
  });

  it('uses the browser-reported lens intrinsics when present', () => {
    const m = cameraModelFromSettings(
      { width: 1280, height: 960, lensIntrinsicCalibration: [866, 866, 642.1, 480.8, 0] },
      { width: 1280, height: 960 },
    );
    expect(m?.intrinsics).toEqual({
      width: 1280,
      height: 960,
      fx: 866,
      fy: 866,
      cx: 642.1,
      cy: 480.8,
    });
  });

  it('returns null when the browser reports nothing usable', () => {
    expect(
      cameraModelFromSettings({ width: 1280, height: 960 }, { width: 1280, height: 960 }),
    ).toBeNull();
    expect(
      cameraModelFromSettings({ lensIntrinsicCalibration: ['x'] }, { width: 1280, height: 960 }),
    ).toBeNull();
  });
});
