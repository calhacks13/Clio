import { Group, type Vector3 } from 'three';
import type { Text } from 'troika-three-text';
import {
  installOcclusionDebug,
  type WindowFar,
  XrDepthOcclusion,
} from '../adapters/render/glow/depth-occlusion';
import { type ObjectGlowMode, ObjectHighlight } from '../adapters/render/object-highlight';
import { makeText, setText } from '../adapters/render/text';
import type { Placement } from './placement';

// The main object's light, drawn like the lesson's (adapters/render/presenters/outlines.ts): the
// object glows from within its silhouette, or corner brackets frame a box-only answer, on a plane
// through the object that turns toward the viewer every frame. Its name floats just above the
// glow's bright edge. Each new mask reshapes the light in place; a newly found object (a new name,
// or one back after being lost) fades in quickly with a brief flare; "nothing found" fades it out.
// Nothing is allocated per frame: the group turns with lookAt, whose basis (+z at the eye, x
// level) is the outline's billboard. The light and its name keep the room's depth order: hands
// hide them through their occluders (tracking/hand-occluders.ts), and real surfaces nearer than
// the object hide the light through the depth map (adapters/render/glow/depth-occlusion.ts).

const LABEL_SIZE = 0.024;
const LABEL_GAP = 0.01;
const FADE_IN_MS = 180;
const FADE_OUT_MS = 600;
/** An object back after fading below this is found again: it flares like a new one. */
const RELIGHT_BELOW = 0.35;

/** troika fades the text's outline separately from its fill (missing from troika.d.ts). */
type FadingText = Text & { outlineOpacity: number };

export class PrimaryOutlineView {
  readonly object = new Group();
  private readonly highlight = new ObjectHighlight();
  private readonly label: FadingText;
  private placed = false;
  private opacity = 0;
  private target = 0;
  private name: string | null = null;

  /**
   * `windowFar`: how this runtime's depth map encodes window depth ('infinite' for IWER, as for
   * the depth sampler in main.ts).
   */
  constructor({ windowFar = 'reported' }: { windowFar?: WindowFar } = {}) {
    const occlusion = new XrDepthOcclusion(windowFar);
    this.highlight.setOcclusion(occlusion);
    occlusion.probeTarget = this.highlight.probeTarget();
    installOcclusionDebug(occlusion);
    this.label = makeText({
      size: LABEL_SIZE,
      anchorX: 'center',
      anchorY: 'bottom',
      bold: true,
    }) as FadingText;
    this.label.renderOrder = 11;
    this.object.add(this.highlight, this.label);
    this.object.visible = false;
  }

  /**
   * Light up a found object, replacing whatever was drawn. The primary object is a whole object,
   * so by default its light spills around it.
   */
  show({ center, outline }: Placement, name: string, mode: ObjectGlowMode = 'object'): void {
    // A tracker that drops one frame must not make the light flare again.
    if (name !== this.name || this.opacity < RELIGHT_BELOW) this.highlight.ignite();
    this.name = name;
    this.object.position.set(...center);
    this.placed = true;
    this.highlight.setOutline(outline, mode);
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let top = Number.NEGATIVE_INFINITY;
    for (const [x, y] of outline.points) {
      if (x < left) left = x;
      if (x > right) right = x;
      if (y > top) top = y;
    }
    const gap = LABEL_GAP + (outline.shape === 'contour' ? this.highlight.reach : 0);
    this.label.position.set((left + right) / 2, top + gap, 0.001);
    setText(this.label, name);
    this.target = 1;
  }

  /** Nothing to outline now: fade the last outline out. */
  fade(): void {
    this.target = 0;
  }

  update(eye: Vector3, dt: number, _t: number): void {
    const step = dt / (this.target > this.opacity ? FADE_IN_MS : FADE_OUT_MS);
    this.opacity =
      this.target > this.opacity
        ? Math.min(this.target, this.opacity + step)
        : Math.max(this.target, this.opacity - step);
    this.object.visible = this.placed && this.opacity > 0;
    if (!this.object.visible) return;
    this.object.lookAt(eye);
    // Ease out: light comes up fast and settles, and dies away slowly.
    const shown = this.opacity * (2 - this.opacity);
    this.highlight.setOpacity(shown);
    this.label.fillOpacity = shown;
    this.label.outlineOpacity = shown;
  }

  /** Forget the outline (the session ended). */
  clear(): void {
    this.placed = false;
    this.opacity = 0;
    this.target = 0;
    this.name = null;
    this.object.visible = false;
  }
}
