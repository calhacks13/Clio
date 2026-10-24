import type { Pose, Quat, Vec3 } from '../../core/math';
import type { CameraModel } from '../../domain/world/camera-model';
import { cameraModelFromSettings } from './calibration';

// The passthrough camera's pose and focal length as measured by calibrate.html, kept in this
// origin's localStorage so the pages that place things from camera pixels (primary.html, the
// lesson app) can use it. Quest Browser reports no lens calibration, so without this the camera is
// a guess (calibration.ts).
//
// A record holds what it was solved against: the base model ('default' guess or the browser's
// 'lens' metadata), the stream size and that base's focal length. It is applied only to a live
// model with the same base and focal length; anything else (lens metadata appearing in a later
// browser, a different stream) leaves the live model alone, so real lens metadata wins over a
// calibration of the guess. Consumers opt in (primary.html applies it itself, the lesson app opens
// PassthroughCamera with storedCalibration): calibrate.html must start from the raw model, or each
// run would build on the last one's errors.
//
// localStorage is per origin: a calibration saved over USB (http://localhost:5173) is not seen over
// Wi-Fi (https://<laptop>:5173), and the reverse.

export const STORAGE_KEY = 'clio.camera-calibration.v2';

/** Which camera model a calibration started from. */
export type CalibrationBase = 'default' | 'lens';

export interface StoredCalibration {
  base: CalibrationBase;
  /** The stream the samples were taken from, and the base model's focal length (px at width). */
  width: number;
  height: number;
  baseFx: number;
  /** Camera pose in the head (XR viewer) frame. */
  headFromCamera: Pose;
  /** Solved focal lengths (px at width). */
  fx: number;
  fy: number;
  /** Predicted miss 1 m out (mm), far samples held out (deg), samples' RMS error (deg). */
  missMm: number;
  heldOutDeg: number;
  errorDeg: number;
  /** Samples kept, and taken. */
  inliers: number;
  samples: number;
  /** ms since the epoch. */
  savedAt: number;
}

/** The base of a live camera: 'lens' when the browser reports lens intrinsics. */
export function calibrationBase(settings: Record<string, unknown>): CalibrationBase {
  return cameraModelFromSettings(settings, { width: 1280, height: 960 }) ? 'lens' : 'default';
}

/** What getItem/setItem/removeItem need; window.localStorage by default. */
type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Storage disabled (private mode, blocked site data).
    return null;
  }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const tuple = (v: unknown, n: number): v is number[] =>
  Array.isArray(v) && v.length === n && v.every(finite);

/** The camera can't be more than this far from the head center (m). */
const MAX_OFFSET = 0.15;
/** A solved focal length can't be further than this from the base's (share). */
const MAX_FOCAL_CHANGE = 0.3;

/** A stored value if it is well formed and plausible, else null. */
export function parseStoredCalibration(raw: unknown): StoredCalibration | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.base !== 'default' && r.base !== 'lens') return null;
  const pose = r.headFromCamera as { p?: unknown; q?: unknown } | undefined;
  if (!pose || !tuple(pose.p, 3) || !tuple(pose.q, 4)) return null;
  const p = pose.p as Vec3;
  const q = pose.q as Quat;
  if (Math.hypot(...p) > MAX_OFFSET) return null;
  const norm = Math.hypot(...q);
  if (Math.abs(norm - 1) > 1e-3) return null;
  const numbers = [
    'width',
    'height',
    'baseFx',
    'fx',
    'fy',
    'missMm',
    'heldOutDeg',
    'errorDeg',
    'inliers',
    'samples',
    'savedAt',
  ];
  if (!numbers.every((k) => finite(r[k]))) return null;
  const [width, height, baseFx, fx, fy] = [r.width, r.height, r.baseFx, r.fx, r.fy] as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (!(width > 0 && height > 0 && baseFx > 0 && fx > 0 && fy > 0)) return null;
  if (Math.abs(fx / baseFx - 1) > MAX_FOCAL_CHANGE) return null;
  return {
    base: r.base,
    width,
    height,
    baseFx,
    headFromCamera: {
      p: [...p],
      q: Math.abs(norm - 1) < 1e-9 ? [...q] : (q.map((v) => v / norm) as Quat),
    },
    fx,
    fy,
    missMm: r.missMm as number,
    heldOutDeg: r.heldOutDeg as number,
    errorDeg: r.errorDeg as number,
    inliers: r.inliers as number,
    samples: r.samples as number,
    savedAt: r.savedAt as number,
  };
}

/** The saved calibration, or null if there is none (or it can't be read). */
export function loadStoredCalibration(
  store: KeyValueStore | null = defaultStore(),
): StoredCalibration | null {
  try {
    const text = store?.getItem(STORAGE_KEY);
    return text ? parseStoredCalibration(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

/** Saves `calibration`; false if storage is unavailable. */
export function saveStoredCalibration(
  calibration: StoredCalibration,
  store: KeyValueStore | null = defaultStore(),
): boolean {
  try {
    if (!store) return false;
    store.setItem(STORAGE_KEY, JSON.stringify(calibration));
    return true;
  } catch {
    return false;
  }
}

export function clearStoredCalibration(store: KeyValueStore | null = defaultStore()): void {
  try {
    store?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * Whether `stored` was solved against the same model as the live `model`: the same base, the same
 * image shape, and the base focal length (scaled to the live width) within 1%.
 */
export function storedCalibrationFits(
  model: CameraModel,
  base: CalibrationBase,
  stored: StoredCalibration,
): boolean {
  const k = model.intrinsics;
  if (stored.base !== base) return false;
  if (Math.abs(k.width / k.height - stored.width / stored.height) > 1e-3) return false;
  const expectedFx = (stored.baseFx * k.width) / stored.width;
  return Math.abs(k.fx / expectedFx - 1) <= 0.01;
}

/** Per-axis position overrides (m, head frame); null keeps the axis. */
export type CameraOffsetOverride = readonly [number | null, number | null, number | null];

/** ?camX=, ?camY=, ?camZ= as overrides (the same parameters primary.html reads). */
export function cameraOffsetFromParams(params: URLSearchParams): CameraOffsetOverride {
  const read = (k: string) => {
    const v = Number.parseFloat(params.get(k) ?? '');
    return Number.isFinite(v) ? v : null;
  };
  return [read('camX'), read('camY'), read('camZ')];
}

/**
 * `model` with the stored camera pose and focal length when the record fits it
 * (storedCalibrationFits), then any URL overrides on top (they win, per axis). A record that
 * doesn't fit is ignored.
 */
export function applyStoredCalibration(
  model: CameraModel,
  base: CalibrationBase,
  stored: StoredCalibration | null,
  override: CameraOffsetOverride = [null, null, null],
): CameraModel {
  const use = stored && storedCalibrationFits(model, base, stored) ? stored : null;
  const [x, y, z] = override;
  if (!use && x === null && y === null && z === null) return model;
  const scale = use ? model.intrinsics.width / use.width : 1;
  const intrinsics = use
    ? { ...model.intrinsics, fx: use.fx * scale, fy: use.fy * scale }
    : model.intrinsics;
  const pose = use ? use.headFromCamera : model.headFromCamera;
  return {
    ...model,
    intrinsics,
    headFromCamera: {
      p: [x ?? pose.p[0], y ?? pose.p[1], z ?? pose.p[2]],
      q: [...pose.q],
    },
  };
}
