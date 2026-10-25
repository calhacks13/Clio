import { rgba as accentRgba, erColor, objectStyle } from './colors';
import type { DeskObject } from './desk-tracker';
import { type ErBox, erOpacity } from './er-boxes';
import {
  boxCenter,
  boxToPixels,
  objectFitOf,
  pictureRect,
  polygonToPixels,
  type Rect,
  type Size,
  toPixels,
} from './fit';
import { placeTag, tagText } from './tags';

// The canvas over the webcam picture: for each followed object its outline (a soft fill and glow
// in its role color when lit, a thin neutral line when only followed), its bounding box in the same
// color and a tag at the box's top-left corner; then Robotics-ER's boxes, dashed and fading, with
// the action item marked. The canvas covers the video element exactly and maps the frame onto it
// through the video's object-fit (fit.ts). The picture is not mirrored, so the boxes line up.

/** One action-focus answer still on the picture. */
export interface ErAnswerView {
  /** When it arrived (performance.now ms); its boxes fade from then. */
  t: number;
  boxes: readonly ErBox[];
}

const TAG_FONT = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
const TAG_PAD_X = 5;
const TAG_HEIGHT = 17;
const GLOW_BLUR = 16;

export class DeskOverlay {
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly video: HTMLVideoElement,
  ) {}

  draw(objects: readonly DeskObject[], er: readonly ErAnswerView[], now: number): void {
    const { canvas, video } = this;
    const g = canvas.getContext('2d');
    if (!g) return;
    const dpr = window.devicePixelRatio || 1;
    const size: Size = { width: canvas.clientWidth, height: canvas.clientHeight };
    const width = Math.round(size.width * dpr);
    const height = Math.round(size.height * dpr);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size.width, size.height);
    const rect = pictureRect(
      { width: video.videoWidth, height: video.videoHeight },
      size,
      objectFitOf(getComputedStyle(video).objectFit),
    );
    if (!rect) return;
    g.save();
    g.beginPath();
    g.rect(rect.x, rect.y, rect.width, rect.height);
    g.clip();
    const taken: Rect[] = [];
    // The lit objects last, so their glow and tags sit on top of the ones only followed.
    const ordered = [...objects.filter((o) => !o.lit), ...objects.filter((o) => o.lit)];
    for (const o of ordered) this.drawObject(g, o, rect);
    for (const o of [...ordered].reverse()) this.drawTag(g, o, rect, size, taken);
    const accents = new Map(objects.map((o) => [o.id, o.accent]));
    for (const answer of er) {
      const opacity = erOpacity(answer.t, now);
      if (opacity <= 0) continue;
      for (const box of answer.boxes) {
        this.drawEr(g, box, erColor(box.id ? (accents.get(box.id) ?? null) : null), opacity, rect);
      }
    }
    g.restore();
  }

  private drawObject(g: CanvasRenderingContext2D, o: DeskObject, rect: Rect): void {
    const d = o.detection;
    if (!d?.found) return;
    const style = objectStyle(o.lit, o.accent, d.state);
    g.setLineDash(style.dashed ? [5, 4] : []);
    if (d.outline && d.outline.length >= 3) {
      const points = polygonToPixels(d.outline, rect);
      g.beginPath();
      for (const [i, [x, y]] of points.entries()) {
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      if (style.fill) {
        g.fillStyle = style.fill;
        g.fill();
      }
      g.shadowColor = style.glow ?? 'transparent';
      g.shadowBlur = style.glow ? GLOW_BLUR : 0;
      g.strokeStyle = style.stroke;
      g.lineWidth = style.lineWidth;
      g.stroke();
      g.shadowBlur = 0;
      g.shadowColor = 'transparent';
    }
    if (d.box) {
      const b = boxToPixels(d.box, rect);
      g.strokeStyle = style.box;
      g.lineWidth = style.boxWidth;
      g.strokeRect(b.x, b.y, b.width, b.height);
    }
    g.setLineDash([]);
  }

  private drawTag(
    g: CanvasRenderingContext2D,
    o: DeskObject,
    rect: Rect,
    size: Size,
    taken: Rect[],
  ): void {
    const d = o.detection;
    if (!d?.found || !d.box) return;
    const style = objectStyle(o.lit, o.accent, d.state);
    const text = tagText({ label: o.label, state: d.state, source: d.source, score: d.score });
    g.font = TAG_FONT;
    const width = Math.ceil(g.measureText(text).width) + TAG_PAD_X * 2;
    const tag = placeTag(boxToPixels(d.box, rect), { width, height: TAG_HEIGHT }, size, taken);
    taken.push(tag);
    g.fillStyle = style.tag;
    g.beginPath();
    g.roundRect(tag.x, tag.y, tag.width, tag.height, 3);
    g.fill();
    g.fillStyle = style.tagText;
    g.textBaseline = 'middle';
    g.fillText(text, tag.x + TAG_PAD_X, tag.y + tag.height / 2 + 0.5);
  }

  private drawEr(
    g: CanvasRenderingContext2D,
    box: ErBox,
    color: number,
    opacity: number,
    rect: Rect,
  ): void {
    const b = boxToPixels(box.box, rect);
    g.setLineDash(box.action ? [9, 5] : [5, 5]);
    g.strokeStyle = accentRgba(color, opacity);
    g.lineWidth = box.action ? 2.5 : 1.5;
    g.strokeRect(b.x, b.y, b.width, b.height);
    g.setLineDash([]);
    // The ER tag sits under the box, clear of the tracker's tag above it.
    const text = `${box.action ? 'next: ' : 'ER '}${box.label}`;
    g.font = TAG_FONT;
    g.fillStyle = accentRgba(color, opacity);
    g.textBaseline = 'top';
    g.fillText(text, b.x + 2, b.y + b.height + 3);
    if (!box.action) return;
    const [x, y] = toPixels(box.point ?? boxCenter(box.box), rect);
    g.beginPath();
    g.arc(x, y, 6, 0, Math.PI * 2);
    g.fillStyle = accentRgba(color, 0.9 * opacity);
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = `rgba(4, 18, 26, ${opacity})`;
    g.stroke();
  }
}
