import type { ChecklistWidget } from '../../../../domain/widgets/types';
import { type ChecklistRowLayout, checklistCard, DONE_TEXT } from '../layout';
import { ColorTween, NumberTween, progress, tween } from '../motion';
import type { TextFactory, TextHandle } from '../text-port';
import { MM, tokenColor, WIDGET_THEME } from '../theme';
import type { UiQuad } from '../ui-quad';
import { Face, type TouchLook, type TouchRect } from './face';

// The checklist card: a title and "1 of 3", then up to five rows, each a circle and its text with
// hairline dividers between. A done item is an ink disc with a white check, as on the site, and
// its text turns muted. A fingertip over a row rings its circle in ink and lays a soft sunken tile
// under the row; a press fills the circle at once (optimistic) before the board confirms it.

const C = WIDGET_THEME.color;
const M = WIDGET_THEME.motion;
const LINE = WIDGET_THEME.line;
const MAX_ITEMS = 5;
const CHECK_W = 10 * MM;
const CHECK_STROKE = 2.4 * MM;

export class ChecklistCard extends Face<ChecklistWidget> {
  private readonly card = this.cardQuad(100 * MM);
  private readonly tile = this.quad(
    { mode: 'box', width: 168 * MM, height: 32 * MM, radius: WIDGET_THEME.size.tileRadius },
    'under',
  );
  private readonly dividers: UiQuad[] = [];
  private readonly circles: UiQuad[] = [];
  private readonly rowTexts: TextHandle[] = [];
  private readonly title = this.label('title');
  private readonly count = this.label('label', { x: 'right' });
  private readonly doneText = this.label('status', { x: 'right' });
  private rows: ChecklistRowLayout[] = [];
  private readonly shown: boolean[] = [];
  private readonly discAt = new Float64Array(MAX_ITEMS);
  private readonly checkAt = new Float64Array(MAX_ITEMS);
  /** An optimistic press: -1 none, 0 shows it undone, 1 done; and when it was pressed. */
  private readonly optimistic = new Int8Array(MAX_ITEMS).fill(-1);
  private readonly pressedAt = new Float64Array(MAX_ITEMS).fill(Number.NEGATIVE_INFINITY);
  private readonly textColor: ColorTween[] = [];
  private readonly ringColor: ColorTween[] = [];
  private readonly tileAlpha = new NumberTween(0);
  private hovered = -1;
  /** The row the hover tile sits on (it stays there while it fades out). */
  private tileRow = -1;
  private dividerCount = 0;
  private doneAt: number | null = null;
  private touches: TouchRect[] = [];

  constructor(text: TextFactory) {
    super(text);
    this.tile.fill(tokenColor('sunkenSoft'));
    for (let i = 0; i < MAX_ITEMS - 1; i++) {
      this.dividers.push(
        this.quad({ mode: 'box', width: 120 * MM, height: 1 * MM }).fill(
          LINE.hairline.color,
          LINE.hairline.alpha,
        ),
      );
    }
    for (let i = 0; i < MAX_ITEMS; i++) {
      this.circles.push(
        this.quad({ mode: 'check', width: 18 * MM, height: 18 * MM, radius: 9 * MM })
          .fill(C.ink)
          .accent(C.onInk)
          .param(0, CHECK_STROKE, CHECK_W, 0),
      );
      this.rowTexts.push(this.label('body'));
      this.shown.push(false);
      this.textColor.push(new ColorTween(C.ink));
      this.ringColor.push(new ColorTween(C.inkFaint));
    }
    this.doneText.setColor(C.mintText);
  }

  set(w: ChecklistWidget, t: number): boolean {
    const prev = this.record;
    this.record = w;
    const layout = checklistCard(w);
    this.height = layout.height;
    this.rows = layout.rows;
    this.place(this.card, { x: 0, y: 0, w: this.width, h: layout.height });
    this.placeText(this.title, layout.title);
    this.placeText(this.count, layout.count);
    this.placeText(this.doneText, layout.done, DONE_TEXT);
    this.touches = [];
    for (let i = 0; i < MAX_ITEMS; i++) {
      const row = layout.rows[i];
      const circle = this.circles[i] as UiQuad;
      const text = this.rowTexts[i] as TextHandle;
      const divider = this.dividers[i - 1];
      circle.mesh.visible = row !== undefined;
      text.object.visible = row !== undefined;
      this.optimistic[i] = -1;
      if (!row) {
        text.set('');
        continue;
      }
      this.touches.push({ index: i, rect: row.row });
      this.place(circle, row.circle, row.circle.w / 2);
      this.placeText(text, row.text);
      if (divider) this.place(divider, layout.dividers[i - 1] ?? row.row);
      const done = w.items[i]?.done ?? false;
      if (prev === null) {
        // Already done when it appears: no tick motion.
        this.shown[i] = done;
        this.discAt[i] = Number.NEGATIVE_INFINITY;
        this.checkAt[i] = Number.NEGATIVE_INFINITY;
        this.textColor[i]?.snap(done ? C.inkMuted : C.ink);
      }
    }
    this.dividerCount = layout.dividers.length;
    for (let i = 0; i < this.dividers.length; i++) {
      (this.dividers[i] as UiQuad).mesh.visible = i < this.dividerCount;
    }
    if (this.hovered >= layout.rows.length) this.hovered = -1;
    if (this.tileRow >= layout.rows.length) this.tileRow = -1;

    const pressed = prev !== null && this.recentlyPressed(t);
    let pulse = prev !== null && w.updatedT !== prev.updatedT && !pressed;
    if (w.status === 'done' && this.doneAt === null) {
      this.doneAt = t;
      pulse = prev !== null;
    } else if (w.status === 'active') {
      this.doneAt = null;
    }
    return pulse;
  }

  override touchRects(): readonly TouchRect[] {
    return this.touches;
  }

  override setTouch(index: number, look: TouchLook, t: number): void {
    const w = this.record;
    const row = this.rows[index];
    if (!w || !row) return;
    if (look === 'pressed') {
      this.optimistic[index] = w.items[index]?.done ? 0 : 1;
      this.pressedAt[index] = t;
      return;
    }
    const ring = this.ringColor[index] as ColorTween;
    if (look === 'hover') {
      if (this.hovered !== index) {
        if (this.hovered >= 0) this.ringColor[this.hovered]?.set(C.inkFaint, t, M.hoverMs);
        this.hovered = index;
        this.tileRow = index;
        this.place(this.tile, row.tile, WIDGET_THEME.size.tileRadius);
      }
      ring.set(C.ink, t, M.hoverMs);
      this.tileAlpha.set(1, t, M.hoverMs);
    } else if (this.hovered === index) {
      this.hovered = -1;
      ring.set(C.inkFaint, t, M.hoverMs);
      this.tileAlpha.set(0, t, M.hoverMs);
    }
  }

  frame(t: number, opacity: number): void {
    const w = this.record;
    if (!w) return;
    this.card.opacity(opacity);
    this.title.setOpacity(opacity);
    this.tile.opacity(opacity * this.tileAlpha.value(t));

    // The dividers either side of a hovered row give way to its tile.
    const tile = this.tileAlpha.value(t);
    for (let i = 0; i < this.dividerCount; i++) {
      const beside = this.tileRow >= 0 && (i === this.tileRow - 1 || i === this.tileRow);
      (this.dividers[i] as UiQuad).opacity(beside ? opacity * (1 - tile) : opacity);
    }
    const n = Math.min(this.rows.length, MAX_ITEMS);
    for (let i = 0; i < n; i++) {
      if (this.optimistic[i] !== -1 && t - (this.pressedAt[i] ?? t) > M.pressHoldMs) {
        this.optimistic[i] = -1;
      }
      const optimistic = this.optimistic[i] ?? -1;
      const done = optimistic === -1 ? (w.items[i]?.done ?? false) : optimistic === 1;
      if (done !== this.shown[i]) {
        this.shown[i] = done;
        // A press fills the disc at once; a tick from the coach grows it.
        this.discAt[i] = optimistic === 1 ? t - M.tickDiscMs : t;
        this.checkAt[i] = t + M.checkDelayMs;
        this.textColor[i]?.set(done ? C.inkMuted : C.ink, t, M.othersFadeMs);
      }
      const circle = this.circles[i] as UiQuad;
      circle.stroke(this.ringColor[i]?.value(t) ?? C.inkFaint, 1, WIDGET_THEME.size.ring);
      if (done) {
        circle.paramAt(3, tween(t, this.discAt[i] ?? 0, M.tickDiscMs));
        circle.paramAt(0, tween(t, this.checkAt[i] ?? 0, M.checkDrawMs));
      } else {
        circle.paramAt(3, 0);
        circle.paramAt(0, 0);
      }
      circle.opacity(opacity);
      const text = this.rowTexts[i] as TextHandle;
      text.setColor(this.textColor[i]?.value(t) ?? C.ink);
      text.setOpacity(opacity);
    }
    const cross = this.doneAt === null ? 0 : progress(t, this.doneAt, M.crossFadeMs);
    this.count.setOpacity(opacity * (1 - cross));
    this.doneText.setOpacity(opacity * cross);
  }

  private recentlyPressed(t: number): boolean {
    for (let i = 0; i < MAX_ITEMS; i++) {
      if (t - (this.pressedAt[i] ?? Number.NEGATIVE_INFINITY) < M.pressHoldMs) return true;
    }
    return false;
  }
}
