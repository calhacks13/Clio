import {
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  type Quaternion,
  Shape,
  ShapeGeometry,
  Vector3,
} from 'three';
import type { Text } from 'troika-three-text';
import { makeText, setText } from '../adapters/render/text';

// The readout: one row per number, a meter ahead and a little below the line of sight, trailing
// the head's heading so it stays readable without covering what is being measured. It never
// depth-tests, so a hand held out in front of it (to read the Fingertip row) can't hide it.

export interface Row {
  label: string;
  /** Marker color shown beside the label, for rows that have a marker in the scene. */
  swatch?: number;
}

const WIDTH = 0.36;
const ROW_H = 0.036;
const PAD = 0.018;
const CORNER = 0.014;
const DISTANCE = 0.9;
const DROP = 0.3;
const FOLLOW_MS = 350;
const PANEL = 0x0b1016;
const VALUE = 0xe8eef3;
const LABEL = 0x9aa7b2;
/** Drawn after the scene, in this order, with no depth test. */
const ORDER = 20;

const flat = (color: number) =>
  new MeshBasicMaterial({ color, depthTest: false, depthWrite: false });

/** Text that draws over the panel regardless of depth. */
function overlayText(options: Parameters<typeof makeText>[0]): Text {
  const text = makeText(options);
  text.material = new MeshBasicMaterial({
    side: DoubleSide,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  text.renderOrder = ORDER + 2;
  return text;
}

function roundedRect(w: number, h: number, r: number): Shape {
  const x = -w / 2;
  const y = -h / 2;
  const s = new Shape();
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

const target = new Vector3();
const heading = new Vector3();

export class Readout {
  readonly object = new Group();
  private readonly values: Text[] = [];
  private readonly forward = new Vector3(0, 0, -1);
  private placed = false;

  constructor(rows: readonly Row[]) {
    const height = rows.length * ROW_H + 2 * PAD;
    const panel = new Mesh(new ShapeGeometry(roundedRect(WIDTH, height, CORNER), 6), flat(PANEL));
    panel.renderOrder = ORDER;
    this.object.add(panel);
    rows.forEach((row, i) => {
      const y = height / 2 - PAD - ROW_H * (i + 0.5);
      const left = -WIDTH / 2 + PAD;
      if (row.swatch !== undefined) {
        const swatch = new Mesh(
          new ShapeGeometry(roundedRect(0.012, 0.012, 0.003), 2),
          flat(row.swatch),
        );
        swatch.renderOrder = ORDER + 1;
        swatch.position.set(left + 0.006, y, 0.001);
        this.object.add(swatch);
      }
      const label = overlayText({ size: 0.017, color: LABEL, anchorX: 'left', anchorY: 'middle' });
      label.position.set(left + 0.022, y, 0.001);
      setText(label, row.label);
      const value = overlayText({
        size: 0.02,
        color: VALUE,
        anchorX: 'right',
        anchorY: 'middle',
        bold: true,
      });
      value.position.set(WIDTH / 2 - PAD, y, 0.001);
      this.values.push(value);
      this.object.add(label, value);
    });
    this.object.visible = false;
  }

  /** Follow the head; `dt` in ms. */
  follow(head: Vector3, orientation: Quaternion, dt: number): void {
    this.object.visible = true;
    // Looking straight up or down has no heading; keep the last one.
    heading.set(0, 0, -1).applyQuaternion(orientation).setY(0);
    if (heading.lengthSq() > 1e-4) this.forward.copy(heading).normalize();
    target.copy(head).addScaledVector(this.forward, DISTANCE);
    target.y = head.y - DROP;
    if (this.placed) this.object.position.lerp(target, 1 - Math.exp(-dt / FOLLOW_MS));
    else this.object.position.copy(target);
    this.placed = true;
    this.object.lookAt(head);
  }

  set(row: number, value: string): void {
    const text = this.values[row];
    if (text) setText(text, value);
  }

  hide(): void {
    this.object.visible = false;
    this.placed = false;
  }
}
