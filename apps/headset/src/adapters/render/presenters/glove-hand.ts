import { type HandSample, JOINT_STRIDE } from '@clio/protocol';
import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';

// A solid illustrative glove driven by the original clip. Filled palm and continuous finger
// surfaces, with rounded tips instead of visible bones or joint beads. Three draw calls per hand.
const FINGERS = [
  [1, 2, 3, 4],
  [6, 7, 8, 9],
  [11, 12, 13, 14],
  [16, 17, 18, 19],
  [21, 22, 23, 24],
];
const KNUCKLES = [6, 11, 16, 21];
const PALM_RINGS = 9;
const PALM_SIDES = 20;
const FINGER_RINGS = 20;
const FINGER_SIDES = 12;
const FINGER_BODY_RINGS = 16;

/** Reused topology for a closed loft, with a center vertex at either cap. */
function surfaceGeometry(rings: number, sides: number, count = 1): BufferGeometry {
  const geometry = new BufferGeometry();
  const stride = rings * sides + 2;
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(stride * count * 3), 3));
  const indices: number[] = [];
  for (let surface = 0; surface < count; surface++) {
    const offset = surface * stride;
    for (let row = 0; row < rings - 1; row++) {
      for (let side = 0; side < sides; side++) {
        const a = offset + row * sides + side;
        const b = offset + row * sides + ((side + 1) % sides);
        indices.push(a, a + sides, b, b, a + sides, b + sides);
      }
    }
    for (let side = 0; side < sides; side++) {
      const next = (side + 1) % sides;
      indices.push(offset + rings * sides, offset + side, offset + next);
      indices.push(
        offset + rings * sides + 1,
        offset + (rings - 1) * sides + next,
        offset + (rings - 1) * sides + side,
      );
    }
  }
  geometry.setIndex(indices);
  return geometry;
}

export class GloveHand {
  readonly object = new Group();
  private readonly skin = new MeshStandardMaterial({
    color: 0xf2f6fa,
    roughness: 0.78,
    emissive: 0x25333e,
    emissiveIntensity: 0.15,
  });
  private readonly accent = new MeshStandardMaterial({
    color: 0x24d4ed,
    emissive: 0x24d4ed,
    emissiveIntensity: 0.25,
    roughness: 0.65,
  });
  private readonly palm = new Mesh(surfaceGeometry(PALM_RINGS, PALM_SIDES), this.skin);
  private readonly fingers = new Mesh(surfaceGeometry(FINGER_RINGS, FINGER_SIDES, 5), this.skin);
  private readonly cuff = new Mesh(new CylinderGeometry(1, 1, 1, 24), this.accent);
  private readonly points = Array.from({ length: 25 }, () => new Vector3());
  private readonly curves = FINGERS.map(
    (chain) => new CatmullRomCurve3(chain.map((i) => this.points[i] as Vector3)),
  );
  private readonly rotation = new Quaternion();
  private readonly basis = new Matrix4();
  private readonly center = new Vector3();
  private readonly forward = new Vector3();
  private readonly across = new Vector3();
  private readonly normal = new Vector3();
  private readonly position = new Vector3();
  private readonly tangent = new Vector3();
  private readonly previousTangent = new Vector3();
  private readonly fingerAcross = new Vector3();
  private readonly fingerNormal = new Vector3();

  constructor() {
    for (const mesh of [this.palm, this.fingers, this.cuff]) mesh.frustumCulled = false;
    this.object.add(this.palm, this.fingers, this.cuff);
    this.object.visible = false;
  }

  update(hand: HandSample | null): void {
    this.object.visible = hand !== null;
    if (!hand) return;
    for (let i = 0; i < this.points.length; i++)
      this.points[i]?.fromArray(hand.joints, i * JOINT_STRIDE);
    const point = (i: number) => this.points[i] as Vector3;
    const wrist = point(0);
    this.center.set(0, 0, 0);
    for (const i of KNUCKLES) this.center.add(point(i));
    this.center.multiplyScalar(0.25);
    this.forward.subVectors(this.center, wrist);
    const length = this.forward.length();
    if (length < 0.015) {
      this.object.visible = false;
      return;
    }
    this.forward.divideScalar(length);
    this.across.subVectors(point(6), point(21)).normalize();
    this.normal.crossVectors(this.across, this.forward).normalize();
    if (this.normal.lengthSq() < 0.5) {
      this.object.visible = false;
      return;
    }
    this.across.crossVectors(this.forward, this.normal).normalize();
    const size = Math.max(0.6, Math.min(1.5, length / 0.08));
    const width = point(6).distanceTo(point(21)) * 0.5 + 0.009 * size;
    const positions = this.palm.geometry.getAttribute('position') as BufferAttribute;
    for (let row = 0; row < PALM_RINGS; row++) {
      const u = row / (PALM_RINGS - 1);
      const halfWidth = 0.021 * size * (1 - u) + width * u;
      const thickness = size * (0.013 - 0.004 * u);
      this.center.copy(wrist).addScaledVector(this.forward, length * u);
      for (let side = 0; side < PALM_SIDES; side++) {
        const angle = (side / PALM_SIDES) * Math.PI * 2;
        this.position
          .copy(this.center)
          .addScaledVector(this.across, Math.cos(angle) * halfWidth)
          .addScaledVector(this.normal, Math.sin(angle) * thickness);
        positions.setXYZ(
          row * PALM_SIDES + side,
          this.position.x,
          this.position.y,
          this.position.z,
        );
      }
    }
    positions.setXYZ(PALM_RINGS * PALM_SIDES, wrist.x, wrist.y, wrist.z);
    positions.setXYZ(PALM_RINGS * PALM_SIDES + 1, this.center.x, this.center.y, this.center.z);
    positions.needsUpdate = true;
    this.palm.geometry.computeVertexNormals();
    this.updateFingers(size);
    this.cuff.position.copy(wrist).addScaledVector(this.forward, -0.004 * size);
    // The cuff's circular cross-section is flattened to the same proportions as the palm.
    this.cuff.quaternion.setFromRotationMatrix(
      this.basis.makeBasis(this.across, this.forward, this.normal),
    );
    this.cuff.scale.set(0.022 * size, 0.012 * size, 0.014 * size);
  }

  private updateFingers(size: number): void {
    const positions = this.fingers.geometry.getAttribute('position') as BufferAttribute;
    const stride = FINGER_RINGS * FINGER_SIDES + 2;
    for (let finger = 0; finger < this.curves.length; finger++) {
      const curve = this.curves[finger];
      if (!curve) continue;
      const offset = finger * stride;
      for (let row = 0; row < FINGER_RINGS; row++) {
        const u = Math.min(1, row / (FINGER_BODY_RINGS - 1));
        curve.getPoint(u, this.center);
        curve.getTangent(u, this.tangent).normalize();
        if (row === 0) {
          this.fingerAcross
            .copy(this.across)
            .addScaledVector(this.tangent, -this.across.dot(this.tangent));
          if (this.fingerAcross.lengthSq() < 1e-6) {
            this.fingerAcross
              .copy(this.normal)
              .addScaledVector(this.tangent, -this.normal.dot(this.tangent));
          }
          this.fingerAcross.normalize();
        } else {
          this.rotation.setFromUnitVectors(this.previousTangent, this.tangent);
          this.fingerAcross.applyQuaternion(this.rotation).normalize();
        }
        this.previousTangent.copy(this.tangent);
        this.fingerNormal.crossVectors(this.fingerAcross, this.tangent).normalize();
        let radius = size * (finger === 4 ? 0.0085 - 0.002 * u : 0.01 - 0.0025 * u);
        // A hemispherical fingertip continues the same surface; no cap rings or joint beads.
        if (row >= FINGER_BODY_RINGS) {
          const angle =
            (((row - FINGER_BODY_RINGS + 1) / (FINGER_RINGS - FINGER_BODY_RINGS + 1)) * Math.PI) /
            2;
          this.center.addScaledVector(this.tangent, Math.sin(angle) * radius);
          radius *= Math.cos(angle);
        }
        for (let side = 0; side < FINGER_SIDES; side++) {
          const angle = (side / FINGER_SIDES) * Math.PI * 2;
          this.position
            .copy(this.center)
            .addScaledVector(this.fingerAcross, Math.cos(angle) * radius)
            .addScaledVector(this.fingerNormal, Math.sin(angle) * radius);
          positions.setXYZ(
            offset + row * FINGER_SIDES + side,
            this.position.x,
            this.position.y,
            this.position.z,
          );
        }
      }
      curve.getPoint(0, this.center);
      positions.setXYZ(
        offset + FINGER_RINGS * FINGER_SIDES,
        this.center.x,
        this.center.y,
        this.center.z,
      );
      curve
        .getPoint(1, this.center)
        .addScaledVector(this.tangent, size * (finger === 4 ? 0.0065 : 0.0075));
      positions.setXYZ(
        offset + FINGER_RINGS * FINGER_SIDES + 1,
        this.center.x,
        this.center.y,
        this.center.z,
      );
    }
    positions.needsUpdate = true;
    this.fingers.geometry.computeVertexNormals();
  }

  dispose(): void {
    for (const mesh of [this.palm, this.fingers, this.cuff]) mesh.geometry.dispose();
    this.skin.dispose();
    this.accent.dispose();
  }
}
