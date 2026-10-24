import { CameraModelSchema } from '@clio/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultQuestCameraModel } from '../../src/adapters/camera/calibration';
import {
  cameraModelSource,
  cameraRecord,
  passthroughCameraRecord,
} from '../../src/adapters/camera/camera-meta';
import { PassthroughCamera } from '../../src/adapters/camera/passthrough-camera';
import { STORAGE_KEY, type StoredCalibration } from '../../src/adapters/camera/stored-calibration';

const SAVED: StoredCalibration = {
  base: 'default',
  width: 1280,
  height: 960,
  baseFx: 800,
  headFromCamera: { p: [0.035, 0.018, -0.03], q: [-0.13, 0.01, 0.002, 0.9914] },
  fx: 848,
  fy: 848,
  missMm: 5.2,
  heldOutDeg: 0.6,
  errorDeg: 0.6,
  inliers: 14,
  samples: 15,
  savedAt: 1_790_000_000_000,
};
const LENS_SETTINGS = {
  lensIntrinsicCalibration: [870, 870, 640, 640, 0],
  lensTranslation: [0.03, 0.01, -0.02],
  lensRotation: [0, 0, 0, 1],
};

/** A PassthroughCamera opened the way the lesson opens it, on a fake 1280x960 stream. */
async function lessonCamera(settings: Record<string, unknown>, saved: StoredCalibration | null) {
  const items = new Map(saved ? [[STORAGE_KEY, JSON.stringify(saved)]] : []);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: () => {},
    removeItem: () => {},
  });
  const video = { readyState: 4, videoWidth: 1280, videoHeight: 960, play: async () => {} };
  vi.stubGlobal('document', { createElement: (tag: string) => (tag === 'video' ? video : {}) });
  const stream = {
    getVideoTracks: () => [{ getSettings: () => ({ width: 1280, height: 960, ...settings }) }],
    getTracks: () => [],
  };
  vi.stubGlobal('navigator', {
    userAgent: 'test',
    mediaDevices: { getUserMedia: async () => stream },
  });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const camera = await PassthroughCamera.open({ storedCalibration: true });
  if (!camera) throw new Error('camera did not open');
  return camera;
}

describe('meta.camera', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('records the model in use and where it came from, for the lesson camera', async () => {
    for (const [settings, saved, source] of [
      [{}, null, 'default'],
      [{}, SAVED, 'calibrated'],
      [LENS_SETTINGS, null, 'lens-metadata'],
      // A calibration solved against the default guess does not fit the lens model.
      [LENS_SETTINGS, SAVED, 'lens-metadata'],
    ] as const) {
      const camera = await lessonCamera(settings, saved);
      const record = passthroughCameraRecord(camera);
      const model = camera.model();
      expect(record.source).toBe(source);
      expect(record.intrinsics).toEqual(model.intrinsics);
      expect(record.headFromCamera).toEqual([...model.headFromCamera.p, ...model.headFromCamera.q]);
      expect(CameraModelSchema.safeParse(record).success).toBe(true);
    }
  });

  it('names an override first, then a fitting stored calibration, then the base', () => {
    const base = defaultQuestCameraModel(1280, 960);
    expect(cameraModelSource(base, 'default', SAVED, [0.03, null, null])).toBe('override');
    expect(cameraModelSource(base, 'default', SAVED)).toBe('calibrated');
    expect(cameraModelSource(base, 'lens', SAVED)).toBe('lens-metadata');
    expect(cameraModelSource(base, 'default', null)).toBe('default');
  });

  it('copies the intrinsics and turns the head pose into a Pose7', () => {
    const model = defaultQuestCameraModel(640, 480);
    const record = cameraRecord(model, 'default');
    expect(record).toEqual({
      intrinsics: { width: 640, height: 480, fx: 400, fy: 400, cx: 320, cy: 240 },
      headFromCamera: [...model.headFromCamera.p, ...model.headFromCamera.q],
      source: 'default',
    });
    expect(record.intrinsics).not.toBe(model.intrinsics);
  });
});
