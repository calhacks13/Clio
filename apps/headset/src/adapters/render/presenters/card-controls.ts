import {
  CircleGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Shape,
  ShapeGeometry,
  Vector3,
} from 'three';
import { makeText, setText } from '../text';

// The instruction card's controls. The voice strip is a row of rounded bars across the whole top
// of the card: it moves like a voice in guidance blue while Clio speaks, in yellow while the
// learner talks, and sends a slow green ripple from left to right while Clio thinks (works out an
// answer it owes, or plans a lesson). Quiet listening shows nothing. The close button is a solid
// red circle with a white cross at the top right. A first touch stretches the red to the left into
// a pill reading "End lesson" beside the same white cross for a few seconds, and a touch on that
// ends the lesson, so a hand reaching past the card never ends one by accident.

export type VoiceStripState = 'speaking' | 'hearing' | 'thinking' | null;

export const STRIP_H = 0.012;
const BAR_W = 0.0026;
const BAR_PITCH = 0.0052;
const MAX_BARS = 96;
const COLORS: Record<Exclude<VoiceStripState, null>, number> = {
  speaking: 0x1768d9,
  /** A deep golden yellow: a light one all but vanishes on the white card. */
  hearing: 0xe9a700,
  /** Green with 3.4:1 contrast on the white card. */
  thinking: 0x1a9e6e,
};
/** How quickly a bar follows its level: the strip grows in and shrinks away rather than popping. */
const BAR_EASE_MS = 70;
/** A voice: three rhythms (Hz) and how they shift from bar to bar (rad), so no two bars agree. */
const VOICES = {
  speaking: [
    { hz: 2.3, step: 0.61, weight: 0.55 },
    { hz: 3.7, step: -0.37, weight: 0.3 },
    { hz: 6.1, step: 1.13, weight: 0.15 },
  ],
  hearing: [
    { hz: 2.9, step: 0.47, weight: 0.55 },
    { hz: 4.4, step: -0.53, weight: 0.3 },
    { hz: 7.0, step: 0.9, weight: 0.15 },
  ],
} as const;
/** The shortest a bar gets, as a share of the strip: about twice as tall as it is wide. */
const FLOOR = 0.4;
/** Thinking: a ripple crossing the strip left to right, under once a second. */
const RIPPLE_HZ = 0.7;
const RIPPLE_WAVES = 1.2;

/** The voice strip, centered on its origin. Layout sets its width; each frame sets its state. */
export class VoiceStrip {
  readonly object = new Group();
  private readonly material = new MeshBasicMaterial({ color: COLORS.speaking });
  private readonly bodyGeometry = new PlaneGeometry(BAR_W, 1);
  private readonly capGeometry = new CircleGeometry(BAR_W / 2, 12);
  // Three draw calls for the whole strip: the bars' middles, and their top and bottom ends.
  private readonly bodies = new InstancedMesh(this.bodyGeometry, this.material, MAX_BARS);
  private readonly tops = new InstancedMesh(this.capGeometry, this.material, MAX_BARS);
  private readonly bottoms = new InstancedMesh(this.capGeometry, this.material, MAX_BARS);
  private readonly heights: number[] = new Array<number>(MAX_BARS).fill(0);
  private count = 0;
  private state: VoiceStripState = null;
  private readonly matrix = new Matrix4();
  private readonly at = new Vector3();
  private readonly size = new Vector3();
  private readonly turn = new Quaternion();

  constructor() {
    for (const mesh of [this.bodies, this.tops, this.bottoms]) {
      mesh.renderOrder = 3;
      mesh.count = 0;
      this.object.add(mesh);
    }
    this.object.visible = false;
  }

  /** What the strip shows now: null once it has shrunk away. */
  get showing(): VoiceStripState {
    return this.object.visible ? this.state : null;
  }

  /** Each bar's height now (m), left to right. */
  get levels(): readonly number[] {
    return this.heights.slice(0, this.count);
  }

  /** Spans `width` metres: as many bars as fit at the strip's pitch. */
  setWidth(width: number): void {
    const count = Math.max(1, Math.min(MAX_BARS, Math.floor((width - BAR_W) / BAR_PITCH) + 1));
    if (count === this.count) return;
    for (let i = this.count; i < count; i++) this.heights[i] = 0;
    this.count = count;
  }

  update(state: VoiceStripState, tMs: number, dtMs: number, reducedMotion: boolean): void {
    if (state) {
      this.state = state;
      this.material.color.setHex(COLORS[state]);
    }
    const follow = reducedMotion ? 1 : 1 - Math.exp(-Math.max(0, dtMs) / BAR_EASE_MS);
    const left = (-(this.count - 1) * BAR_PITCH) / 2;
    let tallest = 0;
    for (let i = 0; i < this.count; i++) {
      const across = this.count > 1 ? i / (this.count - 1) : 0.5;
      const goal = state ? STRIP_H * level(state, i, across, tMs / 1000, reducedMotion) : 0;
      const height = (this.heights[i] ?? 0) + (goal - (this.heights[i] ?? 0)) * follow;
      this.heights[i] = height;
      tallest = Math.max(tallest, height);
      this.place(i, left + i * BAR_PITCH, height);
    }
    for (const mesh of [this.bodies, this.tops, this.bottoms]) {
      mesh.count = this.count;
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.object.visible = tallest > 0.0005;
  }

  /** A rounded bar `height` tall at `x`: a straight middle and two round ends. */
  private place(index: number, x: number, height: number): void {
    const straight = Math.max(1e-4, height - BAR_W);
    const end = Math.max(1e-4, Math.min(1, height / BAR_W));
    this.bodies.setMatrixAt(
      index,
      this.matrix.compose(this.at.set(x, 0, 0), this.turn, this.size.set(1, straight, 1)),
    );
    this.tops.setMatrixAt(
      index,
      this.matrix.compose(this.at.set(x, straight / 2, 0), this.turn, this.size.set(end, end, 1)),
    );
    this.bottoms.setMatrixAt(
      index,
      this.matrix.compose(this.at.set(x, -straight / 2, 0), this.turn, this.size.set(end, end, 1)),
    );
  }

  dispose(): void {
    for (const mesh of [this.bodies, this.tops, this.bottoms]) mesh.dispose();
    this.bodyGeometry.dispose();
    this.capGeometry.dispose();
    this.material.dispose();
  }
}

/**
 * A bar's height as a share of the strip's. Never shorter than FLOOR, so a bar always reads as a
 * bar and the strip never as a dotted line. A voice is tallest mid-strip and lower toward the
 * ends; thinking is one ripple travelling across. Reduced motion holds the shape still.
 */
function level(
  state: Exclude<VoiceStripState, null>,
  index: number,
  across: number,
  s: number,
  still: boolean,
): number {
  if (state === 'thinking') {
    if (still) return 0.55;
    const ripple = 0.5 + 0.5 * Math.sin(2 * Math.PI * (RIPPLE_HZ * s - RIPPLE_WAVES * across));
    return FLOOR + (1 - FLOOR) * ripple ** 3;
  }
  const envelope = 0.45 + 0.55 * Math.sin(Math.PI * across);
  if (still) return FLOOR + (1 - FLOOR) * envelope * 0.6;
  let wave = 0;
  for (const v of VOICES[state])
    wave += v.weight * Math.sin(2 * Math.PI * v.hz * s + index * v.step);
  return FLOOR + (1 - FLOOR) * envelope * (0.5 + 0.5 * wave);
}

export const CLOSE_D = 0.028;
/** The armed pill: "End lesson", then the cross where it was. */
export const ARMED_W = 0.112;
const EXIT_RED = 0xe5484d;
const CROSS = 0.011;
const CROSS_STROKE = 0.0022;
/** A first touch arms the button this long. */
const ARMED_MS = 3000;
/** A second touch must come this long after the first: one long touch is not two. */
const CONFIRM_AFTER_MS = 250;
/** Touches count within this far of the button's face (m). */
const TOUCH_MARGIN = 0.008;
const TOUCH_DEPTH = 0.03;

/**
 * The red close button, its origin at the circle's center; armed, its pill grows to the left. A
 * touch counts when a fingertip comes onto it, not while one rests there.
 */
export class CloseButton {
  readonly object = new Group();
  private readonly material = new MeshBasicMaterial({ color: EXIT_RED });
  private readonly circle = roundedRect(CLOSE_D, CLOSE_D, CLOSE_D / 2);
  private readonly pill = roundedRect(ARMED_W, CLOSE_D, CLOSE_D / 2);
  private readonly background = new Mesh(this.circle, this.material);
  private readonly crossMaterial = new MeshBasicMaterial({ color: 0xffffff });
  private readonly cross = new Group();
  private readonly label = makeText({
    size: 0.0125,
    color: 0xffffff,
    anchorX: 'center',
    anchorY: 'middle',
    bold: true,
  });
  private armedAt: number | null = null;
  private touching = false;
  private readonly local = new Vector3();

  constructor() {
    const stroke = new PlaneGeometry(CROSS, CROSS_STROKE);
    for (const angle of [Math.PI / 4, -Math.PI / 4]) {
      const line = new Mesh(stroke, this.crossMaterial);
      line.rotation.z = angle;
      line.renderOrder = 4;
      this.cross.add(line);
    }
    this.cross.position.z = 0.001;
    setText(this.label, 'End lesson');
    this.label.outlineWidth = 0;
    // Between the pill's left end and the cross, which stays put.
    this.label.position.set(-ARMED_W / 2, 0, 0.001);
    this.label.renderOrder = 4;
    this.label.visible = false;
    this.background.renderOrder = 3;
    this.object.add(this.background, this.cross, this.label);
  }

  /** Armed: the next touch ends the lesson. */
  get armed(): boolean {
    return this.armedAt !== null;
  }

  /** Width it takes now, from its right edge. */
  get width(): number {
    return this.armed ? ARMED_W : CLOSE_D;
  }

  /**
   * One frame. `tips` are fingertips in world space; `covered` says one is on something drawn over
   * the card. True when this frame's touch ends the lesson.
   */
  update(t: number, tips: readonly Vector3[], covered: (tip: Vector3) => boolean): boolean {
    if (this.armedAt !== null && t - this.armedAt > ARMED_MS) this.disarm();
    const touching = tips.some((tip) => this.under(tip) && !covered(tip));
    const pressed = touching && !this.touching;
    this.touching = touching;
    if (!pressed) return false;
    if (this.armedAt === null) {
      this.arm(t);
      return false;
    }
    if (t - this.armedAt < CONFIRM_AFTER_MS) return false;
    this.disarm();
    return true;
  }

  /** Back to the plain cross, as when the card shows something new. */
  disarm(): void {
    this.armedAt = null;
    this.background.geometry = this.circle;
    this.background.position.x = 0;
    this.label.visible = false;
  }

  private arm(t: number): void {
    this.armedAt = t;
    this.background.geometry = this.pill;
    this.background.position.x = -(ARMED_W - CLOSE_D) / 2;
    this.label.visible = true;
  }

  /** A fingertip on the button's face, as wide as it is now. */
  private under(tip: Vector3): boolean {
    this.object.updateWorldMatrix(true, false);
    const p = this.object.worldToLocal(this.local.copy(tip));
    const half = this.width / 2;
    const center = -(this.width - CLOSE_D) / 2;
    return (
      Math.abs(p.x - center) <= half + TOUCH_MARGIN &&
      Math.abs(p.y) <= CLOSE_D / 2 + TOUCH_MARGIN &&
      Math.abs(p.z) <= TOUCH_DEPTH
    );
  }

  dispose(): void {
    this.circle.dispose();
    this.pill.dispose();
    this.material.dispose();
    (this.cross.children[0] as Mesh).geometry.dispose();
    this.crossMaterial.dispose();
    this.label.dispose();
  }
}

/** Centered planar surface with a measured radius, including pill buttons. */
export function roundedRect(width: number, height: number, radius: number): ShapeGeometry {
  const x = -width / 2;
  const y = -height / 2;
  const r = Math.min(radius, width / 2, height / 2);
  const shape = new Shape();
  shape.moveTo(x + r, y);
  shape.lineTo(x + width - r, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + r);
  shape.lineTo(x + width, y + height - r);
  shape.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  shape.lineTo(x + r, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  return new ShapeGeometry(shape, 10);
}
