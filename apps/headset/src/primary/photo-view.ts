import { Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, Texture } from 'three';
import {
  composePose,
  dot,
  type Pose,
  rotateVec,
  sub,
  transformPoint,
  type Vec3,
} from '../core/math';
import type { CameraModel } from '../domain/world/camera-model';

// ?image= only: the photo itself, hung across the camera's view at the object's depth (just
// behind the outline), so on the desktop the outline can be checked against the object in it.

const BEHIND_M = 0.01;

export class PhotoView {
  readonly object: Mesh<PlaneGeometry, MeshBasicMaterial>;

  constructor(image: HTMLImageElement) {
    const texture = new Texture(image);
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
    this.object = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ map: texture }));
    this.object.visible = false;
  }

  /** Fill the camera's view (from where the head was) at the depth of `center`. */
  place(center: Readonly<Vec3>, model: CameraModel, head: Pose): void {
    const camera = composePose(head, model.headFromCamera);
    const depth = dot(sub(center, camera.p), rotateVec(camera.q, [0, 0, -1])) + BEHIND_M;
    if (depth <= 0) return;
    const { width, height, fx, fy, cx, cy } = model.intrinsics;
    const middle: Vec3 = [
      ((width / 2 - cx) / fx) * depth,
      ((cy - height / 2) / fy) * depth,
      -depth,
    ];
    this.object.position.set(...transformPoint(camera, middle));
    this.object.quaternion.set(...camera.q);
    this.object.scale.set((width / fx) * depth, (height / fy) * depth, 1);
    this.object.visible = true;
  }

  hide(): void {
    this.object.visible = false;
  }
}
