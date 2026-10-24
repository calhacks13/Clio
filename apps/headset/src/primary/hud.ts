import {
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

// ?debug=1: the last object named, how many frames a second the tracker answers, how long a frame
// takes from capture to the tracker's answer and to its outline being drawn (medians), and how
// long the last look (Gemini and jev) took, on a small panel that trails the head a meter ahead
// and a little below the line of sight (like the tracking page's panel).

const WIDTH = 0.64;
const HEIGHT = 0.095;
const CORNER = 0.016;
const NAME_SHARE = 0.36;
const STATS = 4;
const DISTANCE = 1;
const DROP = 0.28;
const FOLLOW_MS = 350;
const PANEL = 0x0b1016;
const VALUE = 0xe8eef3;
const LABEL = 0x9aa7b2;
const EMPTY = '—';

function roundedRect(w: number, h: number, r: number): Shape {
  const x = -w / 2;
  const y = -h / 2;
  const shape = new Shape();
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + h - r);
  shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  shape.lineTo(x + r, y + h);
  shape.quadraticCurveTo(x, y + h, x, y + h - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  return shape;
}

const target = new Vector3();
const heading = new Vector3();

export class PrimaryHud {
  readonly object = new Group();
  private readonly name: Text;
  private readonly rate: Text;
  private readonly answer: Text;
  private readonly drawn: Text;
  private readonly cycle: Text;
  private readonly forward = new Vector3(0, 0, -1);
  private placed = false;

  constructor() {
    const panel = new Mesh(
      new ShapeGeometry(roundedRect(WIDTH, HEIGHT, CORNER), 6),
      new MeshBasicMaterial({ color: PANEL }),
    );
    this.object.add(panel);
    const nameWidth = WIDTH * NAME_SHARE;
    const statWidth = (WIDTH - nameWidth) / STATS;
    const stat = (i: number) => -WIDTH / 2 + nameWidth + statWidth * (i + 0.5);
    this.name = this.cell('Object', -WIDTH / 2 + nameWidth / 2, nameWidth);
    this.rate = this.cell('Track', stat(0), statWidth);
    this.answer = this.cell('Answer', stat(1), statWidth);
    this.drawn = this.cell('Drawn', stat(2), statWidth);
    this.cycle = this.cell('Look', stat(3), statWidth);
    this.object.visible = false;
  }

  /** The last answer: the object named (null for none) and the look's duration. */
  show(name: string | null, cycleMs: number): void {
    setText(this.name, name ?? 'None');
    setText(this.cycle, `${(cycleMs / 1000).toFixed(1)} s`);
  }

  /** Tracker results per second, and capture to answer and to drawn outline (ms, medians). */
  showStats(fps: number, answerMs: number | null, drawnMs: number | null): void {
    setText(this.rate, `${Math.round(fps)}/s`);
    setText(this.answer, answerMs === null ? EMPTY : `${Math.round(answerMs)} ms`);
    setText(this.drawn, drawnMs === null ? EMPTY : `${Math.round(drawnMs)} ms`);
  }

  update(head: Vector3, orientation: Quaternion, dt: number): void {
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

  /** A bold value over a small caption, centered at x. */
  private cell(caption: string, x: number, width: number): Text {
    const value = makeText({
      size: 0.024,
      color: VALUE,
      maxWidth: width - 0.02,
      anchorX: 'center',
      anchorY: 'bottom',
      bold: true,
    });
    value.position.set(x, -0.002, 0.001);
    setText(value, EMPTY);
    const label = makeText({ size: 0.013, color: LABEL, anchorX: 'center', anchorY: 'top' });
    label.position.set(x, -0.01, 0.001);
    setText(label, caption);
    this.object.add(value, label);
    return value;
  }

  hide(): void {
    this.object.visible = false;
    this.placed = false;
    setText(this.name, EMPTY);
    setText(this.rate, EMPTY);
    setText(this.answer, EMPTY);
    setText(this.drawn, EMPTY);
    setText(this.cycle, EMPTY);
  }
}
