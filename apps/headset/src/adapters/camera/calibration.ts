import { type Pose, type Quat, quatFromAxisAngle, quatMultiply } from '../../core/math';
import type { CameraModel } from '../../domain/world/camera-model';

// Passthrough camera calibration for Quest Browser.
//
// Quest Browser exposes experimental lens fields on MediaTrackSettings (lensIntrinsicCalibration
// [fx, fy, cx, cy, skew], lensTranslation [m], lensRotation [x, y, z, w]); they are not standardized
// and may change between browser releases. When they are absent we fall back to the approximation
// Google's XR Blocks ships for Quest 3 (fx = fy ≈ 800 px at 1280 wide, camera ~2 cm above and
// 2.5 cm in front of the eye, pitched ~15° down). Log `track.getSettings()` on your headset and
// verify; docs/dev-setup.md explains how.

const DEG = Math.PI / 180;

export const DEFAULT_HEAD_FROM_CAMERA: Pose = {
  p: [0, 0.02, -0.025],
  q: quatFromAxisAngle([1, 0, 0], -15 * DEG),
};

export function defaultQuestCameraModel(width: number, height: number): CameraModel {
  const f = 800 * (width / 1280);
  return {
    intrinsics: { width, height, fx: f, fy: f, cx: width / 2, cy: height / 2 },
    headFromCamera: DEFAULT_HEAD_FROM_CAMERA,
  };
}

const isNumbers = (v: unknown, n: number): v is number[] =>
  Array.isArray(v) &&
  v.length >= n &&
  v.slice(0, n).every((x) => typeof x === 'number' && Number.isFinite(x));

/** Android's camera optical frame looks down +z with y down; WebXR cameras look down -z, y up. */
const OPTICAL_TO_WEBXR: Quat = quatFromAxisAngle([1, 0, 0], Math.PI);

function lensPose(settings: Record<string, unknown>): Pose | null {
  const t = settings.lensTranslation;
  const r = settings.lensRotation;
  if (!isNumbers(t, 3) || !isNumbers(r, 4)) return null;
  return {
    p: [t[0] ?? 0, t[1] ?? 0, t[2] ?? 0],
    q: quatMultiply([r[0] ?? 0, r[1] ?? 0, r[2] ?? 0, r[3] ?? 1], OPTICAL_TO_WEBXR),
  };
}

/** A camera model from the browser's lens metadata, or null if it reports nothing usable. */
export function cameraModelFromSettings(
  settings: Record<string, unknown>,
  stream: { width: number; height: number },
): CameraModel | null {
  const k = settings.lensIntrinsicCalibration;
  if (!isNumbers(k, 4)) return null;
  const [fx, fy, cx, cy] = k as [number, number, number, number];
  return {
    intrinsics: { width: stream.width, height: stream.height, fx, fy, cx, cy },
    headFromCamera: lensPose(settings) ?? DEFAULT_HEAD_FROM_CAMERA,
  };
}
