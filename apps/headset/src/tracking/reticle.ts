import { DoubleSide, Mesh, MeshBasicMaterial, RingGeometry } from 'three';

// Where you look meets a real surface: a viewer-space hit-test source, and a flat ring on the
// first hit. Without the 'hit-test' feature the source is never created and the ring stays hidden.

export class SurfaceReticle {
  readonly object = new Mesh(
    // A hit pose's +y is the surface normal, so the ring lies in its x/z plane.
    new RingGeometry(0.035, 0.045, 48).rotateX(-Math.PI / 2),
    new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide }),
  );
  private source: XRHitTestSource | null = null;
  private session: XRSession | null = null;

  constructor() {
    this.object.matrixAutoUpdate = false;
    this.object.visible = false;
  }

  async start(session: XRSession): Promise<void> {
    this.session = session;
    try {
      const viewer = await session.requestReferenceSpace('viewer');
      const source = (await session.requestHitTestSource?.({ space: viewer })) ?? null;
      // The session may have ended while the source was being created.
      if (this.session === session) this.source = source;
      else source?.cancel();
    } catch {
      this.source = null;
    }
  }

  update(frame: XRFrame, space: XRReferenceSpace): void {
    const hit = this.source ? frame.getHitTestResults(this.source)[0] : undefined;
    const pose = hit?.getPose(space);
    this.object.visible = Boolean(pose);
    if (!pose) return;
    this.object.matrix.fromArray(pose.transform.matrix);
    this.object.matrixWorldNeedsUpdate = true;
  }

  stop(): void {
    this.session = null;
    try {
      this.source?.cancel();
    } catch {
      // Already cancelled along with its session.
    }
    this.source = null;
    this.object.visible = false;
  }
}
