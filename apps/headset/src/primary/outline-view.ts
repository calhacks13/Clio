import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  type Vector3,
} from 'three';
import type { Text } from 'troika-three-text';
import {
  cornerBrackets,
  mergeStrokes,
  type Stroke,
  strokePolyline,
} from '../adapters/render/stroke';
import { makeText, setText } from '../adapters/render/text';
import type { ObjectOutline } from '../domain/world/outline';
import type { Placement } from './placement';

// The main object's outline, drawn like the lesson's (adapters/render/presenters/outlines.ts): a
// contour laid just outside the object, or corner brackets around a box-only answer, on a plane
// through the object that turns toward the viewer every frame. Its name floats just above. A new
// answer replaces it at once; "nothing found" fades it out. Nothing is allocated per frame: the
// group turns with lookAt, whose basis (+z at the eye, x level) is the outline's billboard.

const COLOR = 0x4fe3ff;
const STROKE_M = 0.004;
const BRACKET_SHARE = 0.3;
const LABEL_SIZE = 0.024;
const LABEL_GAP = 0.012;
const FADE_IN_MS = 150;
const FADE_OUT_MS = 600;

/** troika fades the text's outline separately from its fill (missing from troika.d.ts). */
type FadingText = Text & { outlineOpacity: number };

export class PrimaryOutlineView {
  readonly object = new Group();
  private readonly mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  private readonly label: FadingText;
  private placed = false;
  private opacity = 0;
  private target = 0;

  constructor() {
    this.mesh = new Mesh(
      new BufferGeometry(),
      new MeshBasicMaterial({
        color: COLOR,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      }),
    );
    this.mesh.renderOrder = 10;
    this.label = makeText({
      size: LABEL_SIZE,
      anchorX: 'center',
      anchorY: 'bottom',
      bold: true,
    }) as FadingText;
    this.label.renderOrder = 11;
    this.object.add(this.mesh, this.label);
    this.object.visible = false;
  }

  /** Outline a newly found object, replacing whatever was drawn. */
  show({ center, outline }: Placement, name: string): void {
    this.object.position.set(...center);
    this.placed = true;
    this.mesh.geometry.dispose();
    this.mesh.geometry = toGeometry(strokeFor(outline));
    const xs = outline.points.map(([x]) => x);
    const top = Math.max(...outline.points.map(([, y]) => y));
    this.label.position.set((Math.min(...xs) + Math.max(...xs)) / 2, top + LABEL_GAP, 0.001);
    setText(this.label, name);
    this.target = 1;
  }

  /** Nothing to outline now: fade the last outline out. */
  fade(): void {
    this.target = 0;
  }

  update(eye: Vector3, dt: number, t: number): void {
    const step = dt / (this.target > this.opacity ? FADE_IN_MS : FADE_OUT_MS);
    this.opacity =
      this.target > this.opacity
        ? Math.min(this.target, this.opacity + step)
        : Math.max(this.target, this.opacity - step);
    this.object.visible = this.placed && this.opacity > 0;
    if (!this.object.visible) return;
    this.object.lookAt(eye);
    this.mesh.material.opacity = this.opacity * (0.8 + 0.15 * Math.sin(t / 250));
    this.label.fillOpacity = this.opacity;
    this.label.outlineOpacity = this.opacity;
  }

  /** Forget the outline (the session ended). */
  clear(): void {
    this.placed = false;
    this.opacity = 0;
    this.target = 0;
    this.object.visible = false;
  }
}

function strokeFor(outline: ObjectOutline): Stroke {
  if (outline.shape === 'contour') {
    return strokePolyline(outline.points, { width: STROKE_M, closed: true, outside: true });
  }
  return mergeStrokes(
    cornerBrackets(outline.points, BRACKET_SHARE).map((corner) =>
      strokePolyline(corner, { width: STROKE_M, closed: false }),
    ),
  );
}

function toGeometry({ positions, indices }: Stroke): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
}
