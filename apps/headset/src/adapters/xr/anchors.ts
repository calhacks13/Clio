import { createLogger } from '../../core/log';
import type { Pose } from '../../core/math';
import { poseFromMatrix } from './frame-sampler';

const log = createLogger('anchor');
const STORAGE_KEY = 'clio.workspaceAnchor';

/**
 * Keeps the workspace pinned to the physical table with a WebXR anchor (re-localized by the
 * headset as tracking improves), persisted across sessions where the browser supports it.
 * Without anchor support the workspace simply stays in local-floor space.
 */
export class WorkspaceAnchor {
  private anchor: XRAnchor | null = null;

  get active(): boolean {
    return this.anchor !== null;
  }

  async create(frame: XRFrame, space: XRReferenceSpace, pose: Pose): Promise<boolean> {
    if (!frame.createAnchor) return false;
    try {
      const { p, q } = pose;
      const transform = new XRRigidTransform(
        { x: p[0], y: p[1], z: p[2] },
        { x: q[0], y: q[1], z: q[2], w: q[3] },
      );
      this.anchor = await frame.createAnchor(transform, space);
      const handle = await this.anchor.requestPersistentHandle?.();
      if (handle) localStorage.setItem(STORAGE_KEY, handle);
      return true;
    } catch (err) {
      log.warn(`anchor creation failed: ${String(err)}`);
      return false;
    }
  }

  /** Try to restore the workspace anchor saved by a previous session. */
  async restore(session: XRSession): Promise<boolean> {
    const handle = localStorage.getItem(STORAGE_KEY);
    if (!handle || !session.restorePersistentAnchor) return false;
    try {
      this.anchor = await session.restorePersistentAnchor(handle);
      return true;
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      return false;
    }
  }

  /** The anchor's current pose, or null if it isn't being tracked this frame. */
  pose(frame: XRFrame, space: XRReferenceSpace): Pose | null {
    if (!this.anchor) return null;
    const p = frame.getPose(this.anchor.anchorSpace, space);
    if (!p) return null;
    return poseFromMatrix(p.transform.matrix);
  }

  forget(): void {
    this.anchor?.delete();
    this.anchor = null;
    localStorage.removeItem(STORAGE_KEY);
  }
}
