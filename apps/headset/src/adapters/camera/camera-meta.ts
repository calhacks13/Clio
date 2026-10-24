import type { CameraModelRecord } from '@clio/protocol';
import { poseToTuple } from '../../core/math';
import type { CameraModel } from '../../domain/world/camera-model';
import { cameraModelFromSettings, defaultQuestCameraModel } from './calibration';
import {
  type CalibrationBase,
  type CameraOffsetOverride,
  loadStoredCalibration,
  type StoredCalibration,
  storedCalibrationFits,
} from './stored-calibration';

// What an episode's meta records about the passthrough camera (meta.camera): the model the 2D
// answers were lifted with and where it came from, so they can be lifted again after the episode.
// Image coordinates in episodes are normalized, so the intrinsics' own size is the one recorded.

export type CameraModelSource = CameraModelRecord['source'];

/**
 * Where a camera model came from, in the order the pages apply them: `override` when ?camX= and
 * the like moved it, `calibrated` when calibrate.html's stored calibration fits the base model,
 * otherwise the base itself: `lens-metadata` when the browser reported lens intrinsics, `default`
 * for the Quest 3 guess. `base` is the model before any stored calibration or override.
 */
export function cameraModelSource(
  base: CameraModel,
  kind: CalibrationBase,
  stored: StoredCalibration | null,
  override: CameraOffsetOverride = [null, null, null],
): CameraModelSource {
  if (override.some((v) => v !== null)) return 'override';
  if (stored && storedCalibrationFits(base, kind, stored)) return 'calibrated';
  return kind === 'lens' ? 'lens-metadata' : 'default';
}

/** meta.camera for `model`, the one actually used (any calibration applied). */
export function cameraRecord(model: CameraModel, source: CameraModelSource): CameraModelRecord {
  return {
    intrinsics: { ...model.intrinsics },
    headFromCamera: poseToTuple(model.headFromCamera),
    source,
  };
}

/**
 * meta.camera for a PassthroughCamera opened with the stored calibration (the lesson). Its base
 * model is rebuilt from the camera's settings at the model's size, the way the camera built it.
 */
export function passthroughCameraRecord(
  camera: { readonly settings: Record<string, unknown>; model(): CameraModel },
  stored: StoredCalibration | null = loadStoredCalibration(),
): CameraModelRecord {
  const model = camera.model();
  const { width, height } = model.intrinsics;
  const lens = cameraModelFromSettings(camera.settings, { width, height });
  const base = lens ?? defaultQuestCameraModel(width, height);
  return cameraRecord(model, cameraModelSource(base, lens ? 'lens' : 'default', stored));
}
