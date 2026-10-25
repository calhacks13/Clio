import {
  CylinderGeometry,
  InstancedMesh,
  Matrix4,
  NoBlending,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  Vector4,
} from 'three';
import { ON_TOP_ORDER } from '../on-top';
import { onTopGroup } from './layering';

// The index finger's last two bones as a hole punch, so a white widget never paints over the real
// finger poking it. Widgets draw on top of everything (layering.ts), so a depth-only occluder like
// the hands' (hand-occluders.ts) can no longer hide them; instead these capsules draw after the
// widgets and write a colour of (0, 0, 0, 0) with no blending and no depth test. In immersive-ar
// the compositor shows passthrough wherever the framebuffer's alpha is 0, so the real finger shows
// through the hole. Only the part of the finger in front of the column's plane punches (behind it
// the widget is nearer, and drawn), and a hand's capsules show only while its fingertip is near a
// touch target (dock.ts). In the desktop preview the hole shows the page behind the canvas.

/** Capsule radius (m). */
export const FINGERTIP_RADIUS = 0.009;
/** A hand's capsules show while its fingertip is this close to a touch target (m). */
export const FINGERTIP_NEAR = 0.15;
/** The punch's group order: after the widgets and the step card (ON_TOP_ORDER). */
export const HOLE_PUNCH_ORDER = ON_TOP_ORDER + 1;

const VERTEX = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 p = vec4(position, 1.0);
  #ifdef USE_INSTANCING
  p = instanceMatrix * p;
  #endif
  vec4 world = modelMatrix * p;
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAGMENT = /* glsl */ `
uniform vec4 uPlane;
varying vec3 vWorld;
void main() {
  if (dot(uPlane.xyz, vWorld) + uPlane.w < 0.0) discard;
  gl_FragColor = vec4(0.0);
}
`;

const UP = new Vector3(0, 1, 0);
const m = new Matrix4();
const dir = new Vector3();
const scale = new Vector3();
const q = new Quaternion();

export class FingertipOccluder {
  readonly object = onTopGroup();
  /** The column's plane in world space (normal toward the eye, offset); only its front punches. */
  private readonly plane = new Vector4(0, 0, 1, 0);
  readonly material = new ShaderMaterial({
    uniforms: { uPlane: { value: this.plane } },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    blending: NoBlending,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  /** Per hand: intermediate, distal and tip joints. */
  private readonly joints: InstancedMesh;
  /** Per hand: intermediate to distal, distal to tip. */
  private readonly bones: InstancedMesh;
  private readonly sphere = new SphereGeometry(1, 10, 8);
  private readonly rod: CylinderGeometry;
  private readonly shown = [false, false];

  constructor() {
    // Transparent, so it is in the pass the widgets are in; its group order puts it after them.
    this.object.renderOrder = HOLE_PUNCH_ORDER;
    this.rod = new CylinderGeometry(1, 1, 1, 10, 1, true);
    this.rod.translate(0, 0.5, 0);
    this.joints = new InstancedMesh(this.sphere, this.material, 6);
    this.bones = new InstancedMesh(this.rod, this.material, 4);
    for (const mesh of [this.joints, this.bones]) mesh.frustumCulled = false;
    this.object.add(this.joints, this.bones);
    this.shown[0] = true;
    this.shown[1] = true;
    this.hide(0);
    this.hide(1);
  }

  /** The plane through `point` facing `normal` (unit, world space): the column's surface. */
  setPlane(normal: Vector3, point: Vector3): void {
    this.plane.set(normal.x, normal.y, normal.z, -normal.dot(point));
  }

  /**
   * Lays hand `slot` (0 left, 1 right) along its index intermediate, distal and tip joints (in the
   * occluder's parent frame).
   */
  place(slot: 0 | 1, intermediate: Vector3, distal: Vector3, tip: Vector3): void {
    const r = FINGERTIP_RADIUS;
    m.makeScale(r, r, r).setPosition(intermediate);
    this.joints.setMatrixAt(slot * 3, m);
    m.makeScale(r, r, r).setPosition(distal);
    this.joints.setMatrixAt(slot * 3 + 1, m);
    m.makeScale(r, r, r).setPosition(tip);
    this.joints.setMatrixAt(slot * 3 + 2, m);
    this.bone(slot * 2, intermediate, distal);
    this.bone(slot * 2 + 1, distal, tip);
    this.joints.instanceMatrix.needsUpdate = true;
    this.bones.instanceMatrix.needsUpdate = true;
    this.shown[slot] = true;
    this.object.visible = true;
  }

  /** Hides hand `slot` (its instances shrink to nothing); with both hidden it draws nothing. */
  hide(slot: 0 | 1): void {
    if (!this.shown[slot]) return;
    this.shown[slot] = false;
    this.object.visible = this.shown[0] === true || this.shown[1] === true;
    m.makeScale(0, 0, 0);
    for (let i = 0; i < 3; i++) this.joints.setMatrixAt(slot * 3 + i, m);
    for (let i = 0; i < 2; i++) this.bones.setMatrixAt(slot * 2 + i, m);
    this.joints.instanceMatrix.needsUpdate = true;
    this.bones.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.joints.dispose();
    this.bones.dispose();
    this.sphere.dispose();
    this.rod.dispose();
    this.material.dispose();
  }

  private bone(i: number, from: Vector3, to: Vector3): void {
    dir.subVectors(to, from);
    const length = dir.length();
    q.setFromUnitVectors(UP, length > 1e-6 ? dir.divideScalar(length) : UP);
    m.compose(from, q, scale.set(FINGERTIP_RADIUS, length, FINGERTIP_RADIUS));
    this.bones.setMatrixAt(i, m);
  }
}
