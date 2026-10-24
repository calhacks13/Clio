import {
  AxesHelper,
  BufferGeometry,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import type { PresentContext, Presenter } from '../presenter';

/** Workspace outline and axes (debug), and the first calibration corner (world frame). */
export class WorkspacePresenter implements Presenter {
  readonly object = new Group();
  private readonly outline: Line;
  private readonly axes = new AxesHelper(0.08);
  private size: [number, number] = [0, 0];

  constructor() {
    this.outline = new Line(
      new BufferGeometry(),
      new LineBasicMaterial({ color: 0x4fe3ff, transparent: true, opacity: 0.5 }),
    );
    this.object.add(this.outline, this.axes);
  }

  update(ctx: PresentContext): void {
    const size = ctx.procedure?.workspace.size ?? [0.6, 0.4];
    if (size[0] !== this.size[0] || size[1] !== this.size[1]) {
      this.size = [size[0], size[1]];
      const [w, d] = size;
      this.outline.geometry.setFromPoints([
        new Vector3(0, 0, 0),
        new Vector3(w, 0, 0),
        new Vector3(w, 0, -d),
        new Vector3(0, 0, -d),
        new Vector3(0, 0, 0),
      ]);
    }
    this.object.visible = ctx.debug;
  }
}

/** Marks the first pinched corner during calibration (world frame). */
export class CalibrationMarkerPresenter implements Presenter {
  readonly object = new Mesh(
    new SphereGeometry(0.012, 16, 12),
    new MeshBasicMaterial({ color: 0xffd23f }),
  );

  update(ctx: PresentContext): void {
    const corner = ctx.calibration?.firstCorner ?? null;
    this.object.visible = corner !== null;
    if (corner) this.object.position.set(...corner);
  }
}
