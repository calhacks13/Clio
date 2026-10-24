import { describe, expect, it } from 'vitest';
import {
  cameraModelFromSettings,
  defaultQuestCameraModel,
} from '../../src/adapters/camera/calibration';
import { pixelRay } from '../../src/domain/world/camera-model';

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

describe('camera calibration: Quest Browser lens-field shapes', () => {
  const R_X_180 = { x: 1, y: 0, z: 0, w: 0 };

  it('reads point-shaped lens fields and shifts sensor intrinsics to a center-cropped stream', () => {
    // Intrinsics for the 1280x1280 sensor (cy ≈ 640) but a 1280x960 stream: cy becomes 480.
    const m = cameraModelFromSettings(
      {
        lensIntrinsicCalibration: [866, 866, 640, 640, 0],
        lensTranslation: { x: 0.03, y: 0.01, z: -0.05 },
        lensRotation: R_X_180,
      },
      { width: 1280, height: 960 },
    );
    expect(m?.intrinsics.cy).toBe(480);
    expect(m?.headFromCamera.p).toEqual([0.03, 0.01, -0.05]);
  });

  it('turns a world-facing lens rotation into forward-looking rays', () => {
    const m = cameraModelFromSettings(
      {
        lensCalibration: [800, 800, 640, 480, 0],
        lensTranslation: [0, 0, 0],
        lensRotation: R_X_180,
      },
      { width: 1280, height: 960 },
    );
    if (!m) throw new Error('no model');
    const ray = pixelRay(m, [0.5, 0.5], { p: [0, 0, 0], q: [0, 0, 0, 1] });
    expect(ray.direction[2]).toBeCloseTo(-1);
  });
});
