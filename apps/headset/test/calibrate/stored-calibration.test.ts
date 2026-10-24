import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEAD_FROM_CAMERA,
  defaultQuestCameraModel,
} from '../../src/adapters/camera/calibration';
import {
  applyStoredCalibration,
  calibrationBase,
  cameraOffsetFromParams,
  clearStoredCalibration,
  loadStoredCalibration,
  STORAGE_KEY,
  type StoredCalibration,
  saveStoredCalibration,
} from '../../src/adapters/camera/stored-calibration';
import type { Quat } from '../../src/core/math';

class MemoryStore {
  readonly items = new Map<string, string>();
  getItem(k: string): string | null {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.items.set(k, v);
  }
  removeItem(k: string): void {
    this.items.delete(k);
  }
}

const TURNED: Quat = [-0.13, 0.01, 0.002, 0.9914];
const SAVED: StoredCalibration = {
  base: 'default',
  width: 1280,
  height: 960,
  baseFx: 800,
  headFromCamera: { p: [0.035, 0.018, -0.03], q: TURNED },
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

describe('stored camera calibration', () => {
  it('round-trips through storage and clears', () => {
    const store = new MemoryStore();
    expect(loadStoredCalibration(store)).toBeNull();
    expect(saveStoredCalibration(SAVED, store)).toBe(true);
    const loaded = loadStoredCalibration(store);
    expect(loaded?.base).toBe('default');
    expect(loaded?.fx).toBe(848);
    expect(Math.hypot(...(loaded?.headFromCamera.q ?? [0, 0, 0, 0]))).toBeCloseTo(1, 9);
    clearStoredCalibration(store);
    expect(loadStoredCalibration(store)).toBeNull();
    expect(saveStoredCalibration(SAVED, null)).toBe(false);
  });

  it('ignores malformed or implausible values', () => {
    const store = new MemoryStore();
    store.setItem(STORAGE_KEY, '{not json');
    expect(loadStoredCalibration(store)).toBeNull();
    const bad = [
      { ...SAVED, headFromCamera: { p: [0.5, 0, 0], q: [0, 0, 0, 1] } },
      { ...SAVED, base: 'guess' },
      { ...SAVED, baseFx: undefined },
      { ...SAVED, fx: 1200 },
    ];
    for (const value of bad) {
      store.setItem(STORAGE_KEY, JSON.stringify(value));
      expect(loadStoredCalibration(store)).toBeNull();
    }
  });

  it('tells a lens-calibrated camera from the default guess', () => {
    expect(calibrationBase({ width: 1280, height: 960 })).toBe('default');
    expect(calibrationBase(LENS_SETTINGS)).toBe('lens');
  });

  it('applies the stored pose and focal length to the model it was solved against', () => {
    const model = defaultQuestCameraModel(1280, 960);
    expect(applyStoredCalibration(model, 'default', null)).toBe(model);
    const tuned = applyStoredCalibration(model, 'default', SAVED);
    expect(tuned.headFromCamera.p).toEqual([0.035, 0.018, -0.03]);
    expect(tuned.headFromCamera.q).toEqual(TURNED);
    expect(tuned.intrinsics.fx).toBe(848);
    expect(tuned.intrinsics.cx).toBe(640);
    // The same camera streamed at half size: the focal length scales with it.
    const half = applyStoredCalibration(defaultQuestCameraModel(640, 480), 'default', SAVED);
    expect(half.intrinsics.fx).toBe(424);
    expect(half.headFromCamera.p).toEqual([0.035, 0.018, -0.03]);
  });

  it('leaves a model it was not solved against alone: lens metadata wins', () => {
    const model = defaultQuestCameraModel(1280, 960);
    expect(applyStoredCalibration(model, 'lens', SAVED)).toBe(model);
    const otherFocal = { ...model, intrinsics: { ...model.intrinsics, fx: 870, fy: 870 } };
    expect(applyStoredCalibration(otherFocal, 'default', SAVED)).toBe(otherFocal);
    const otherShape = defaultQuestCameraModel(1280, 720);
    expect(applyStoredCalibration(otherShape, 'default', SAVED)).toBe(otherShape);
  });

  it('lets URL overrides win per axis', () => {
    const model = defaultQuestCameraModel(1280, 960);
    const override = cameraOffsetFromParams(new URLSearchParams('camX=0.04&camZ=nope'));
    expect(override).toEqual([0.04, null, null]);
    expect(applyStoredCalibration(model, 'default', SAVED, override).headFromCamera.p).toEqual([
      0.04, 0.018, -0.03,
    ]);
    expect(applyStoredCalibration(model, 'lens', SAVED, override).headFromCamera.p).toEqual([
      0.04,
      DEFAULT_HEAD_FROM_CAMERA.p[1],
      DEFAULT_HEAD_FROM_CAMERA.p[2],
    ]);
  });
});
