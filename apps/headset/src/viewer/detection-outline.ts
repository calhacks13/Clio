import type { Pose7 } from '@clio/protocol';
import { defaultQuestCameraModel } from '../adapters/camera/calibration';
import { composePose, type Pose, type Vec3 } from '../core/math';
import type { CameraModel } from '../domain/world/camera-model';
import { billboard, boxPolygon, liftOutline, outlinePoint } from '../domain/world/outline';
import type { Detection } from './episode-data';

// An object finder's 2D outline drawn in 3D: lifted onto the plane through the detection's 3D
// position that faced the camera when the frame was captured. Episodes don't record the camera
// calibration, so this uses the default Quest 3 model at the stream size the headset asks for.

const RECORDED_CAMERA = defaultQuestCameraModel(1280, 960);

/** The outline (or box) as a closed loop in the workspace frame, or null if it can't be placed. */
export function detectionOutline(
  detection: Detection,
  head: Readonly<Pose7>,
  model: CameraModel = RECORDED_CAMERA,
): Vec3[] | null {
  const center = detection.position;
  if (!detection.found || !center) return null;
  const polygon = detection.outline ?? (detection.box ? boxPolygon(detection.box) : null);
  if (!polygon) return null;
  const worldFromHead: Pose = {
    p: [head[0], head[1], head[2]],
    q: [head[3], head[4], head[5], head[6]],
  };
  const points = liftOutline(polygon, model, worldFromHead, center);
  const plane = billboard(center, composePose(worldFromHead, model.headFromCamera).p);
  if (!points || !plane) return null;
  return points.map((p) => outlinePoint(plane, center, p));
}
