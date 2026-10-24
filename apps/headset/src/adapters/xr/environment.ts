import type { DetectedPlane } from '../../domain/world/environment';
import { poseFromMatrix } from './frame-sampler';

/**
 * Reads WebXR plane detection (horizontal and vertical planes) into DetectedPlanes for the
 * EnvironmentRecorder. Each XRPlane keeps one key for the session, numbered as first seen. Needs
 * the 'plane-detection' feature: if reading the planes throws, the reader turns itself off.
 */
export class XrPlaneReader {
  private readonly keys = new WeakMap<XRPlane, string>();
  private count = 0;
  private disabled = false;

  constructor(private readonly onDisabled: (error: unknown) => void = () => {}) {}

  read(frame: XRFrame, refSpace: XRReferenceSpace): DetectedPlane[] {
    if (this.disabled) return [];
    let planes: XRPlaneSet | undefined;
    try {
      planes = frame.detectedPlanes;
    } catch (err) {
      this.disabled = true;
      this.onDisabled(err);
      return [];
    }
    const detected: DetectedPlane[] = [];
    for (const plane of planes ?? []) {
      const { orientation } = plane;
      // A plane without a known orientation would make the whole snapshot invalid.
      if (orientation !== 'horizontal' && orientation !== 'vertical') continue;
      const pose = frame.getPose(plane.planeSpace, refSpace);
      if (!pose) continue;
      detected.push({
        key: this.keyOf(plane),
        orientation,
        label: plane.semanticLabel ?? null,
        pose: poseFromMatrix(pose.transform.matrix),
        polygon: plane.polygon.map((p) => [p.x, p.z] as const),
        changedAt: plane.lastChangedTime,
      });
    }
    return detected;
  }

  private keyOf(plane: XRPlane): string {
    let key = this.keys.get(plane);
    if (!key) {
      key = `plane-${++this.count}`;
      this.keys.set(plane, key);
    }
    return key;
  }
}
