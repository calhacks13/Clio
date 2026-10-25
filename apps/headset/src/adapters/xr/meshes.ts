import type { DetectedMesh } from '../../domain/world/room-scan';
import { poseFromMatrix } from './frame-sampler';

/**
 * Reads WebXR mesh detection (Quest's room scan: the room's global mesh and the furniture volumes)
 * into DetectedMeshes for the RoomScanRecorder. Each XRMesh keeps one key for the session,
 * numbered as first seen. The vertex and index arrays are the XRMesh's own, not copies: the
 * recorder copies them only into a snapshot. Needs the 'mesh-detection' feature: if reading the
 * meshes throws, the reader turns itself off.
 */
export class XrMeshReader {
  private readonly keys = new WeakMap<XRMesh, string>();
  private count = 0;
  private disabled = false;

  constructor(private readonly onDisabled: (error: unknown) => void = () => {}) {}

  read(frame: XRFrame, refSpace: XRReferenceSpace): DetectedMesh[] {
    if (this.disabled) return [];
    let meshes: XRMeshSet | undefined;
    try {
      meshes = frame.detectedMeshes;
    } catch (err) {
      this.disabled = true;
      this.onDisabled(err);
      return [];
    }
    const detected: DetectedMesh[] = [];
    for (const mesh of meshes ?? []) {
      // A mesh the runtime can't locate this frame is still in the room: the recorder waits for it.
      const pose = frame.getPose(mesh.meshSpace, refSpace);
      detected.push({
        key: this.keyOf(mesh),
        label: mesh.semanticLabel ?? null,
        pose: pose ? poseFromMatrix(pose.transform.matrix) : null,
        vertices: mesh.vertices,
        indices: mesh.indices,
        changedAt: mesh.lastChangedTime,
      });
    }
    return detected;
  }

  private keyOf(mesh: XRMesh): string {
    let key = this.keys.get(mesh);
    if (!key) {
      key = `mesh-${++this.count}`;
      this.keys.set(mesh, key);
    }
    return key;
  }
}
