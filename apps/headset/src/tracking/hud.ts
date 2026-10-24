import { HAND_JOINTS } from '@clio/protocol';
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
import { panelPlace } from '../adapters/render/in-view';
import { drawOnTop } from '../adapters/render/on-top';
import { makeText, setText } from '../adapters/render/text';
import { HAND_COLORS } from './palette';

// A small panel of live counts, a meter ahead of the head and a little below the line of sight.
// It trails the head (exponential follow on the horizontal heading, rising to stay in view when
// looking down: in-view.ts) so it stays readable without sitting in the way. The numbers refresh
// a few times a second: troika re-lays out on each change.

export interface TrackingStats {
  fps: number;
  left: boolean;
  right: boolean;
  surfaces: number;
  meshes: number;
}

const LABELS = ['FPS', 'Left', 'Right', 'Surfaces', 'Meshes'] as const;
const WIDTH = 0.4;
const HEIGHT = 0.095;
const CORNER = 0.016;
const DISTANCE = 1;
const DROP = 0.28;
const FOLLOW_MS = 350;
const REFRESH_MS = 250;
const PANEL = 0x0b1016;
const VALUE = 0xe8eef3;
const LABEL = 0x9aa7b2;
const OFF = 0x5b6773;

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

export class TrackingHud {
  readonly object = new Group();
  private readonly values: Text[] = [];
  /** The last heading followed (unit [x, z] on the floor). */
  private heading: [number, number] = [0, -1];
  private placed = false;
  private nextRefresh = 0;

  constructor() {
    const panel = new Mesh(
      new ShapeGeometry(roundedRect(WIDTH, HEIGHT, CORNER), 6),
      new MeshBasicMaterial({ color: PANEL }),
    );
    this.object.add(panel);
    const cell = WIDTH / LABELS.length;
    LABELS.forEach((name, i) => {
      const x = -WIDTH / 2 + cell * (i + 0.5);
      const value = makeText({
        size: 0.028,
        color: VALUE,
        anchorX: 'center',
        anchorY: 'bottom',
        bold: true,
      });
      value.position.set(x, -0.002, 0.001);
      const label = makeText({ size: 0.013, color: LABEL, anchorX: 'center', anchorY: 'top' });
      label.position.set(x, -0.01, 0.001);
      setText(label, name);
      this.values.push(value);
      this.object.add(value, label);
    });
    // Over the room and the hands (on-top.ts): the panel, then its text.
    for (const child of this.object.children) child.renderOrder = child === panel ? 0 : 1;
    drawOnTop(this.object);
    this.object.visible = false;
  }

  update(
    head: Vector3,
    orientation: Quaternion,
    dt: number,
    t: number,
    stats: TrackingStats,
  ): void {
    this.object.visible = true;
    const place = panelPlace(
      {
        p: [head.x, head.y, head.z],
        q: [orientation.x, orientation.y, orientation.z, orientation.w],
      },
      DISTANCE,
      DROP,
      this.heading,
    );
    this.heading = place.heading;
    target.set(...place.point);
    if (this.placed) this.object.position.lerp(target, 1 - Math.exp(-dt / FOLLOW_MS));
    else this.object.position.copy(target);
    this.placed = true;
    this.object.lookAt(head);

    if (t < this.nextRefresh) return;
    this.nextRefresh = t + REFRESH_MS;
    const [fps, left, right, surfaces, meshes] = this.values;
    if (fps) setText(fps, String(Math.round(stats.fps)));
    if (left) this.showHand(left, stats.left, HAND_COLORS.left);
    if (right) this.showHand(right, stats.right, HAND_COLORS.right);
    if (surfaces) setText(surfaces, String(stats.surfaces));
    if (meshes) setText(meshes, String(stats.meshes));
  }

  hide(): void {
    this.object.visible = false;
    this.placed = false;
    this.nextRefresh = 0;
  }

  private showHand(text: Text, tracked: boolean, color: number): void {
    text.color = tracked ? color : OFF;
    // A tracked hand reports all of its joints.
    setText(text, String(tracked ? HAND_JOINTS.length : 0));
  }
}
