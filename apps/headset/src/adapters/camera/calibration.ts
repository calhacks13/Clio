import {
  type Pose,
  type Quat,
  quatConjugate,
  quatFromAxisAngle,
  quatMultiply,
  type Vec3,
} from '../../core/math';
import type { CameraModel } from '../../domain/world/camera-model';

// Passthrough camera calibration for Quest Browser.
//
// Quest Browser exposes experimental, unstandardized lens fields on MediaTrackSettings. Observed
// shapes (see docs/dev-setup.md for sources):
//   lensIntrinsicCalibration | lensCalibration: [fx, fy, cx, cy, skew] in pixels, for the native
//     1280x1280 sensor (a 1280x960 stream is a center crop: cy shifts by 160)
//   lensTranslation: {x, y, z} (or [x, y, z]) in meters, camera relative to the device center
//   lensRotation:    {x, y, z, w} (or array), Android Camera2 convention
// Converting to the WebXR viewer frame (Meta's own Unity conversion, re-derived for a right-handed
// frame): position = lensTranslation, orientation = lensRotation⁻¹ · Rx(180°).
//
// Without lens fields we fall back to the approximation Google's XR Blocks ships for Quest 3
// (fx = fy ≈ 800 px at 1280 wide, ~2 cm up and 2.5 cm forward of the eye, pitched ~15° down).
// Quest Browser 154 reports no lens fields at all, and facingMode 'environment' opens "camera 2",
// which is the RIGHT passthrough camera (covering the right of the visor darkens it), so the
// fallback sits ~3.2 cm right of the head center instead of on it; outlines landed left before.
// Always validate on your headset (log `track.getSettings()`); primary.html takes ?camX= etc.

const DEG = Math.PI / 180;
const R_X_180: Quat = quatFromAxisAngle([1, 0, 0], Math.PI);

export const DEFAULT_HEAD_FROM_CAMERA: Pose = {
  p: [0.032, 0.02, -0.025],
  q: quatFromAxisAngle([1, 0, 0], -15 * DEG),
};

export function defaultQuestCameraModel(width: number, height: number): CameraModel {
  const f = 800 * (width / 1280);
  return {
    intrinsics: { width, height, fx: f, fy: f, cx: width / 2, cy: height / 2 },
    headFromCamera: DEFAULT_HEAD_FROM_CAMERA,
  };
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Reads [n numbers] from an array or an {x, y, z, w} point. */
function numbers(v: unknown, n: 3 | 4): number[] | null {
  if (Array.isArray(v)) return v.length >= n && v.slice(0, n).every(finite) ? v.slice(0, n) : null;
  if (v && typeof v === 'object') {
    const p = v as Record<string, unknown>;
    const out = (n === 3 ? ['x', 'y', 'z'] : ['x', 'y', 'z', 'w']).map((k) => p[k]);
    return out.every(finite) ? (out as number[]) : null;
  }
  return null;
}

function lensPose(settings: Record<string, unknown>): Pose | null {
  const t = numbers(settings.lensTranslation, 3);
  const r = numbers(settings.lensRotation, 4);
  if (!t || !r) return null;
  const rotation: Quat = [r[0] ?? 0, r[1] ?? 0, r[2] ?? 0, r[3] ?? 1];
  const position: Vec3 = [t[0] ?? 0, t[1] ?? 0, t[2] ?? 0];
  return { p: position, q: quatMultiply(quatConjugate(rotation), R_X_180) };
}

/** A camera model from the browser's lens metadata, or null if it reports nothing usable. */
export function cameraModelFromSettings(
  settings: Record<string, unknown>,
  stream: { width: number; height: number },
): CameraModel | null {
  const raw = settings.lensIntrinsicCalibration ?? settings.lensCalibration;
  if (!Array.isArray(raw) || raw.length < 4 || !raw.slice(0, 4).every(finite)) return null;
  const [fx, fy, cx, sensorCy] = raw as [number, number, number, number];
  // Intrinsics for a square sensor applied to a shorter, center-cropped stream: shift cy.
  const squareSensor =
    Math.abs(sensorCy - stream.width / 2) < Math.abs(sensorCy - stream.height / 2);
  const cy = squareSensor ? sensorCy - (stream.width - stream.height) / 2 : sensorCy;
  return {
    intrinsics: { width: stream.width, height: stream.height, fx, fy, cx, cy },
    headFromCamera: lensPose(settings) ?? DEFAULT_HEAD_FROM_CAMERA,
  };
}
