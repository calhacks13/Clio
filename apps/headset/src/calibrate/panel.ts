import {
  CanvasTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from 'three';

// The camera feed as a panel in front of the user, with the crosshair to aim at and one or two
// lines of text below it. Everything is drawn into one canvas (video, crosshair, text), uploaded
// as a texture at most ~30 times a second, so the page needs no text renderer. The panel follows
// the head lazily, slightly above the line of sight. In 'strip' mode (placing a mark, where the
// user needs the middle of the view) only the text strip shows, low in the view.

export interface PanelVideo {
  source: CanvasImageSource;
  width: number;
  height: number;
}

export interface PanelView {
  /** The camera feed, or null when there is none. */
  video: PanelVideo | null;
  /** The crosshair, normalized image position (0..1, y down). */
  crosshair: readonly [number, number] | null;
  /** Where the solved camera sees the fingertip and the marks, normalized; drawn as dots. */
  dots: (readonly [number, number])[];
  /** The whole panel, or the text strip only. */
  mode: 'feed' | 'strip';
  title: string;
  detail: string;
  /** Detail drawn as a warning (yellow). */
  warn: boolean;
  /** Right column: progress, and how far out to hold the hand. */
  progress: string;
  hint: string;
}

const COLORS = {
  bg: '#0b1016',
  noVideo: '#151c24',
  accent: '#4fe3ff',
  onAccent: '#04121a',
  text: '#f2f5f7',
  muted: '#9aa7b2',
  warn: '#ffd23f',
};

const CANVAS_W = 960;
const VIDEO_H = 720;
const STRIP_H = 150;
/** Panel width in the room (m), and where it sits from the eyes (head frame). */
const PANEL_W = 0.46;
const OFFSET = new Vector3(0, 0.07, -0.72);
const STRIP_OFFSET = new Vector3(0, -0.2, -0.6);
const FOLLOW_MS = 250;
const MIN_REDRAW_MS = 33;

export class CalibrationPanel {
  readonly object = new Group();
  private readonly canvas = document.createElement('canvas');
  private readonly g: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private lastDraw = Number.NEGATIVE_INFINITY;
  private placed = false;
  private readonly target = new Vector3();
  private readonly lookQ = new Quaternion();
  private readonly mesh: Mesh;
  private mode: PanelView['mode'] = 'feed';

  constructor() {
    this.canvas.width = CANVAS_W;
    this.canvas.height = VIDEO_H + STRIP_H;
    const g = this.canvas.getContext('2d');
    if (!g) throw new Error('2D canvas unavailable');
    this.g = g;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    const height = (PANEL_W * this.canvas.height) / this.canvas.width;
    this.mesh = new Mesh(
      new PlaneGeometry(PANEL_W, height),
      new MeshBasicMaterial({ map: this.texture, toneMapped: false }),
    );
    this.object.add(this.mesh);
    this.object.visible = false;
  }

  /** Follows the head (position and orientation as three.js values). */
  follow(head: Vector3, orientation: Quaternion, dt: number): void {
    this.target
      .copy(this.mode === 'strip' ? STRIP_OFFSET : OFFSET)
      .applyQuaternion(orientation)
      .add(head);
    if (!this.placed) {
      this.object.position.copy(this.target);
      this.object.quaternion.copy(orientation);
      this.placed = true;
    } else {
      const k = 1 - Math.exp(-dt / FOLLOW_MS);
      this.object.position.lerp(this.target, k);
      this.lookQ.copy(orientation);
      this.object.quaternion.slerp(this.lookQ, k);
    }
    this.object.visible = true;
  }

  hide(): void {
    this.object.visible = false;
    this.placed = false;
  }

  /** Shows the whole panel or the strip only (jumps to the new place). */
  private setMode(mode: PanelView['mode']): void {
    if (mode === this.mode) return;
    this.mode = mode;
    const share = mode === 'strip' ? STRIP_H / this.canvas.height : 1;
    // The canvas's bottom rows (the strip) are the texture's lowest v.
    this.texture.repeat.set(1, share);
    this.mesh.scale.set(1, share, 1);
    this.placed = false;
  }

  /** Redraws the canvas (throttled) for time `t` (ms). */
  draw(view: PanelView, t: number): void {
    this.setMode(view.mode);
    if (t - this.lastDraw < MIN_REDRAW_MS) return;
    this.lastDraw = t;
    const g = this.g;
    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, CANVAS_W, this.canvas.height);
    const area = this.drawVideo(view.video);
    if (view.crosshair) this.drawCrosshair(area, view.crosshair);
    for (const dot of view.dots) this.drawDot(area, dot);
    this.drawStrip(view);
    this.texture.needsUpdate = true;
  }

  /** The video, fitted into the top area; returns the rectangle the image occupies. */
  private drawVideo(video: PanelVideo | null): { x: number; y: number; w: number; h: number } {
    const g = this.g;
    const aspect = video ? video.width / video.height : 4 / 3;
    const w = Math.min(CANVAS_W, VIDEO_H * aspect);
    const h = w / aspect;
    const area = { x: (CANVAS_W - w) / 2, y: (VIDEO_H - h) / 2, w, h };
    if (video) {
      g.drawImage(video.source, area.x, area.y, area.w, area.h);
    } else {
      g.fillStyle = COLORS.noVideo;
      g.fillRect(area.x, area.y, area.w, area.h);
      g.fillStyle = COLORS.muted;
      g.font = '500 36px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('No camera', area.x + area.w / 2, area.y + area.h / 2);
    }
    return area;
  }

  private drawCrosshair(
    area: { x: number; y: number; w: number; h: number },
    uv: readonly [number, number],
  ): void {
    const g = this.g;
    const x = area.x + uv[0] * area.w;
    const y = area.y + uv[1] * area.h;
    const arm = 34;
    const gap = 9;
    const strokes = (width: number, color: string) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(x - arm, y);
      g.lineTo(x - gap, y);
      g.moveTo(x + gap, y);
      g.lineTo(x + arm, y);
      g.moveTo(x, y - arm);
      g.lineTo(x, y - gap);
      g.moveTo(x, y + gap);
      g.lineTo(x, y + arm);
      g.stroke();
    };
    // A dark edge keeps it readable over a bright scene.
    strokes(9, COLORS.onAccent);
    strokes(4, COLORS.accent);
    g.fillStyle = COLORS.accent;
    g.beginPath();
    g.arc(x, y, 3, 0, Math.PI * 2);
    g.fill();
  }

  private drawDot(
    area: { x: number; y: number; w: number; h: number },
    uv: readonly [number, number],
  ): void {
    const g = this.g;
    const x = area.x + uv[0] * area.w;
    const y = area.y + uv[1] * area.h;
    g.fillStyle = COLORS.onAccent;
    g.beginPath();
    g.arc(x, y, 12, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = COLORS.warn;
    g.beginPath();
    g.arc(x, y, 8, 0, Math.PI * 2);
    g.fill();
  }

  private drawStrip(view: PanelView): void {
    const g = this.g;
    const top = VIDEO_H;
    const pad = 32;
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.fillStyle = COLORS.text;
    g.font = '600 38px system-ui, sans-serif';
    g.fillText(view.title, pad, top + 62, CANVAS_W - 2 * pad - 200);
    g.fillStyle = view.warn ? COLORS.warn : COLORS.muted;
    g.font = '500 30px system-ui, sans-serif';
    g.fillText(view.detail, pad, top + 112, CANVAS_W - 2 * pad - 200);
    g.textAlign = 'right';
    g.fillStyle = COLORS.text;
    g.font = '600 38px system-ui, sans-serif';
    g.fillText(view.progress, CANVAS_W - pad, top + 62);
    g.fillStyle = COLORS.accent;
    g.font = '600 30px system-ui, sans-serif';
    g.fillText(view.hint, CANVAS_W - pad, top + 112);
  }
}
