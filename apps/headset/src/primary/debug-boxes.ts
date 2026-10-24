import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  type Quaternion,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { length, madd, sub, type Vec3 } from '../core/math';
import { base64ToBytes, type StreamedFrame } from './frame-stream';
import type { ObjectMask, Placement } from './placement';
import type { TargetMessage, TrackerMask } from './tracker-client';

// ?debug=boxes: where jev's box and the tracker's mask really are. A picture-in-picture panel,
// lazily head-locked in the lower left of the view, shows the newest streamed camera frame the
// tracker answered (redrawn at most REDRAW_HZ times a second), with jev's box from the latest
// answer in yellow and the tracker's mask box and outline in cyan, both in that frame's normalized
// coordinates. Jev measured its box on the look's frame: the footer shows how much older that
// frame is than the one on the panel (ms; 0 when it is the same frame, negative when newer). In
// the room, jev's box is drawn as a thin yellow frame, placed like the outline (placement.ts),
// so it shows where jev thinks the object (or part) is. The raw values are on
// window.__primaryDebug (main.ts). ?debug= takes a comma list, or repeats: ?debug=1,boxes.

type Box = readonly [number, number, number, number];
type Uv = readonly [number, number];

const REDRAW_HZ = 5;
/** Sent frames kept, so a mask is drawn on its own frame (it comes back a frame or two later). */
const KEPT_FRAMES = 12;

const PICTURE_W = 640;
const PICTURE_H = 480;
const FOOTER_H = 92;
/** Panel width in the room (m); its height follows the canvas. */
const PANEL_W = 0.26;
/** Head frame (m): left, a little below the line of sight, ahead. Clear of the ?debug=1 HUD. */
const PANEL_OFFSET: Vec3 = [-0.3, -0.07, -0.8];
const FOLLOW_MS = 120;
/** The yellow frame's width as an angle seen from the camera (rad): about 0.25 degrees. */
const FRAME_RIBBON_RAD = 0.0045;

const PANEL = '#0b1016';
const JEV = '#ffd60a';
const TRACK = '#22d3ee';
const ON_COLOR = '#04121a';
const VALUE = '#e8eef3';
const LABEL = '#9aa7b2';
const EMPTY = '—';

/** What shows with no ?debug= at all: the HUD and the boxes. */
export const DEFAULT_DEBUG = ['1', 'boxes'] as const;

/**
 * The ?debug= flags: a comma list or repeated, e.g. ?debug=1,boxes or ?debug=1&debug=boxes.
 * Without the parameter, DEFAULT_DEBUG; ?debug=0 (or off) shows nothing.
 */
export function debugFlags(params: URLSearchParams): Set<string> {
  if (!params.has('debug')) return new Set(DEFAULT_DEBUG);
  const flags = new Set(
    params
      .getAll('debug')
      .flatMap((v) => v.split(','))
      .map((v) => v.trim())
      .filter(Boolean),
  );
  flags.delete('0');
  flags.delete('off');
  return flags;
}

/** jev's box as a mask for placeOutline: its 4 corners as the outline. */
export function boxMask(box: Box): ObjectMask {
  const [x0, y0, x1, y1] = box;
  return {
    point: null,
    box,
    outline: [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
  };
}

/** A normalized box in pixels on a w x h picture: x, y, width, height. */
export function boxRect(box: Box, w: number, h: number): [number, number, number, number] {
  const [x0, y0, x1, y1] = box;
  return [x0 * w, y0 * h, (x1 - x0) * w, (y1 - y0) * h];
}

/**
 * A thin frame along a closed polygon in the room: each corner and the same corner moved toward
 * the polygon's middle by `width`, two triangles per edge.
 */
export function frameRibbon(
  points: readonly Readonly<Vec3>[],
  width: number,
): { positions: Float32Array; index: number[] } {
  const n = points.length;
  let c: Vec3 = [0, 0, 0];
  for (const p of points) c = madd(c, p, 1 / n);
  const positions = new Float32Array(n * 6);
  points.forEach((p, i) => {
    const d = sub(c, p);
    const len = length(d) || 1;
    positions.set(p, i * 6);
    positions.set(madd(p, d, Math.min(width * Math.SQRT2, len * 0.5) / len), i * 6 + 3);
  });
  const index: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [po, pi, qo, qi] = [2 * i, 2 * i + 1, 2 * j, 2 * j + 1];
    index.push(po, qo, qi, po, qi, pi);
  }
  return { positions, index };
}

export interface DebugAnswer {
  name: string | null;
  /** Null when nothing was found. */
  box: Box | null;
  /** The streamed frame it was measured on; null when the frame was captured just for it. */
  seq: number | null;
  /** That frame's capture time. */
  t: number;
}

export interface DebugMask {
  seq: number;
  t: number;
  box: Box | null;
  state: string | null;
  score: number | null;
  outline: readonly Uv[] | null;
}

interface KeptFrame {
  seq: number | null;
  t: number;
  bytes: Uint8Array;
}

/** What the panel is drawn from: the frame shown and the boxes on it. */
export interface PanelView {
  frame: KeptFrame | null;
  answer: DebugAnswer | null;
  mask: DebugMask | null;
  /** How much older jev's frame is than the one shown (ms); null without both. */
  answerAgeMs: number | null;
}

type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type DebugCanvas = HTMLCanvasElement | OffscreenCanvas;

export interface DebugBoxesDeps {
  /** Defaults to a new <canvas>. */
  canvas?: DebugCanvas;
  /** JPEG bytes to something drawable (defaults to createImageBitmap). */
  decode?(bytes: Uint8Array): Promise<CanvasImageSource & { close?(): void }>;
}

/**
 * Drawn over everything, the glow included: the glow is in three's transparent pass, so these
 * are too (fully opaque), and come after it by renderOrder.
 */
const ON_TOP = { transparent: true, opacity: 1, depthTest: false, depthWrite: false } as const;

const position = new Vector3();
const offset = new Vector3();

export class DebugBoxes {
  /** The picture-in-picture panel (head-locked: add to the scene, update every XR frame). */
  readonly panel = new Group();
  /** jev's box in the room. */
  readonly box: Mesh<BufferGeometry, MeshBasicMaterial>;
  private readonly canvas: DebugCanvas;
  private readonly texture: CanvasTexture<DebugCanvas>;
  private readonly frames: KeptFrame[] = [];
  private lookImage: KeptFrame | null = null;
  private latestAnswer: DebugAnswer | null = null;
  private latestMask: DebugMask | null = null;
  private lastTarget: (TargetMessage & { part?: boolean }) | null = null;
  private shown: PanelView | null = null;
  private dirty = false;
  private drawing = false;
  private lastDrawT = Number.NEGATIVE_INFINITY;
  private decoded: { frame: KeptFrame; image: CanvasImageSource & { close?(): void } } | null =
    null;
  private placed = false;
  /** jev's box in the room (world space), as last placed. */
  private corners: Vec3[] | null = null;

  constructor(private readonly deps: DebugBoxesDeps = {}) {
    this.canvas = deps.canvas ?? document.createElement('canvas');
    this.canvas.width = PICTURE_W;
    this.canvas.height = PICTURE_H + FOOTER_H;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    const height = (PANEL_W * this.canvas.height) / this.canvas.width;
    const picture = new Mesh(
      new PlaneGeometry(PANEL_W, height),
      new MeshBasicMaterial({ map: this.texture, ...ON_TOP }),
    );
    picture.renderOrder = 30;
    this.panel.add(picture);
    this.panel.visible = false;
    this.box = new Mesh(
      new BufferGeometry(),
      new MeshBasicMaterial({ color: JEV, side: DoubleSide, ...ON_TOP }),
    );
    this.box.renderOrder = 29;
    this.box.frustumCulled = false;
    this.box.visible = false;
  }

  /** A frame sent to the tracker. */
  frameSent(frame: Pick<StreamedFrame, 'seq' | 't' | 'jpeg'>): void {
    this.frames.push({ seq: frame.seq, t: frame.t, bytes: frame.jpeg.bytes });
    if (this.frames.length > KEPT_FRAMES) this.frames.shift();
    this.dirty = true;
  }

  /** A look's own capture (no tracker): shown while no streamed frame is. */
  lookFrame(t: number, jpegBase64: string): void {
    this.lookImage = { seq: null, t, bytes: base64ToBytes(jpegBase64) };
    this.dirty = true;
  }

  answer(answer: DebugAnswer): void {
    this.latestAnswer = answer;
    this.dirty = true;
  }

  mask(mask: TrackerMask): void {
    this.latestMask = {
      seq: mask.seq,
      t: mask.t,
      box: mask.box,
      state: mask.state ?? (mask.found ? null : 'lost'),
      score: mask.score,
      outline: mask.outline,
    };
    this.dirty = true;
  }

  target(message: TargetMessage & { part?: boolean }): void {
    this.lastTarget = message;
  }

  /** jev's box placed in the room, seen from `eye` (world space), or null to hide it. */
  place(placement: Placement | null, eye: Readonly<Vec3> = [0, 0, 0]): void {
    this.corners = placement && placement.points.length >= 3 ? placement.points : null;
    if (!placement || !this.corners) {
      this.box.visible = false;
      return;
    }
    const width = FRAME_RIBBON_RAD * length(sub(placement.center, eye));
    const { positions, index } = frameRibbon(this.corners, width);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setIndex(index);
    this.box.geometry.dispose();
    this.box.geometry = geometry;
    this.box.visible = true;
  }

  /** The frame to show and the boxes on it: the newest mask's own frame when it is still kept. */
  view(): PanelView {
    const mask = this.latestMask;
    const own = mask && this.frames.find((f) => f.seq === mask.seq);
    const frame = own ?? this.frames.at(-1) ?? this.lookImage;
    const answer = this.latestAnswer;
    let answerAgeMs: number | null = null;
    if (frame && answer) {
      answerAgeMs = answer.seq !== null && answer.seq === frame.seq ? 0 : frame.t - answer.t;
    }
    return { frame, answer, mask: mask && own ? mask : null, answerAgeMs };
  }

  /** Raw values for window.__primaryDebug. */
  snapshot() {
    const a = this.latestAnswer;
    const m = this.latestMask;
    return {
      answer: a && { name: a.name, box: a.box, seq: a.seq, t: a.t, world: this.corners },
      mask: m && {
        seq: m.seq,
        t: m.t,
        box: m.box,
        state: m.state,
        score: m.score,
        outlinePoints: m.outline?.length ?? 0,
        outline: m.outline,
      },
      target: this.lastTarget,
      panel: this.shown && {
        frameSeq: this.shown.frame?.seq ?? null,
        answerAgeMs: this.shown.answerAgeMs,
      },
    };
  }

  /** Per XR frame: follow the head; redraw the panel at most REDRAW_HZ times a second. */
  update(head: Vector3, orientation: Quaternion, dt: number, now: number): void {
    offset.set(...PANEL_OFFSET).applyQuaternion(orientation);
    position.copy(head).add(offset);
    if (this.placed) {
      const k = 1 - Math.exp(-dt / FOLLOW_MS);
      this.panel.position.lerp(position, k);
      this.panel.quaternion.slerp(orientation, k);
    } else {
      this.panel.position.copy(position);
      this.panel.quaternion.copy(orientation);
      this.placed = true;
    }
    this.panel.visible = true;
    if (!this.dirty || this.drawing || now - this.lastDrawT < 1000 / REDRAW_HZ) return;
    this.dirty = false;
    this.lastDrawT = now;
    void this.redraw(this.view());
  }

  hide(): void {
    this.panel.visible = false;
    this.box.visible = false;
    this.placed = false;
    this.frames.length = 0;
    this.lookImage = null;
    this.latestAnswer = null;
    this.latestMask = null;
    this.lastTarget = null;
    this.corners = null;
    this.shown = null;
    this.dirty = false;
    this.decoded?.image.close?.();
    this.decoded = null;
  }

  private async redraw(view: PanelView): Promise<void> {
    this.drawing = true;
    try {
      let image: CanvasImageSource | null = null;
      if (view.frame) {
        if (this.decoded?.frame !== view.frame) {
          const decoded = await this.decode(view.frame.bytes);
          this.decoded?.image.close?.();
          this.decoded = { frame: view.frame, image: decoded };
        }
        image = this.decoded?.image ?? null;
      }
      const g = this.canvas.getContext('2d') as Canvas2D | null;
      if (!g) return;
      drawPanel(g, image, view);
      this.shown = view;
      this.texture.needsUpdate = true;
    } catch {
      // A frame that won't decode is skipped; the next redraw tries the newest.
    } finally {
      this.drawing = false;
    }
  }

  private decode(bytes: Uint8Array): Promise<CanvasImageSource & { close?(): void }> {
    if (this.deps.decode) return this.deps.decode(bytes);
    return createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/jpeg' }));
  }
}

/** A short label on a solid fill, at x, above `y` (or below it when there is no room above). */
function tag(g: Canvas2D, text: string, color: string, x: number, y: number, below: boolean): void {
  g.font = '600 22px system-ui, sans-serif';
  const w = Math.min(PICTURE_W - 4, g.measureText(text).width + 14);
  const h = 30;
  const left = Math.max(2, Math.min(x, PICTURE_W - w - 2));
  const top = below ? Math.min(y + 2, PICTURE_H - h) : Math.max(0, y - h - 2);
  g.fillStyle = color;
  g.fillRect(left, top, w, h);
  g.fillStyle = ON_COLOR;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.fillText(text, left + 7, top + h / 2, w - 14);
}

/** The panel: the frame, the tracker's outline and box, jev's box, and a footer of values. */
export function drawPanel(g: Canvas2D, image: CanvasImageSource | null, view: PanelView): void {
  g.fillStyle = PANEL;
  g.fillRect(0, 0, PICTURE_W, PICTURE_H + FOOTER_H);
  if (image) g.drawImage(image, 0, 0, PICTURE_W, PICTURE_H);
  const { mask, answer } = view;
  if (mask?.outline && mask.outline.length > 2) {
    g.strokeStyle = TRACK;
    g.lineWidth = 1.5;
    g.beginPath();
    mask.outline.forEach(([x, y], i) => {
      if (i === 0) g.moveTo(x * PICTURE_W, y * PICTURE_H);
      else g.lineTo(x * PICTURE_W, y * PICTURE_H);
    });
    g.closePath();
    g.stroke();
  }
  if (mask?.box) {
    const [x, y, w, h] = boxRect(mask.box, PICTURE_W, PICTURE_H);
    g.strokeStyle = TRACK;
    g.lineWidth = 3;
    g.strokeRect(x, y, w, h);
    if (mask.state) tag(g, mask.state, TRACK, x, y + h, true);
  }
  if (answer?.box) {
    const [x, y, w, h] = boxRect(answer.box, PICTURE_W, PICTURE_H);
    g.strokeStyle = JEV;
    g.lineWidth = 3;
    g.strokeRect(x, y, w, h);
    if (answer.name) tag(g, answer.name, JEV, x, y, y < 34);
  }
  // Footer: value over caption, in four cells.
  const cells: [string, string, string][] = [
    [answer ? (answer.name ?? 'None') : EMPTY, 'jev', answer?.box ? JEV : VALUE],
    [view.answerAgeMs === null ? EMPTY : String(Math.round(view.answerAgeMs)), 'age ms', VALUE],
    [mask?.state ?? EMPTY, 'track', mask?.box ? TRACK : VALUE],
    [mask?.score == null ? EMPTY : mask.score.toFixed(2), 'score', VALUE],
  ];
  const widths = [0.46, 0.18, 0.2, 0.16];
  let x = 0;
  cells.forEach(([value, caption, color], i) => {
    const w = (widths[i] ?? 0.25) * PICTURE_W;
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillStyle = color;
    g.font = '600 26px system-ui, sans-serif';
    g.fillText(value, x + 14, PICTURE_H + 44, w - 20);
    g.fillStyle = LABEL;
    g.font = '400 18px system-ui, sans-serif';
    g.fillText(caption, x + 14, PICTURE_H + 74, w - 20);
    x += w;
  });
}
