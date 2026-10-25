import type { ProgressWidget } from '../../../../domain/widgets/types';
import { DONE_TEXT, progressCard } from '../layout';
import { NumberTween, progress, tween } from '../motion';
import type { TextFactory, TextHandle } from '../text-port';
import { MM, mixHex, tokenColor, WIDGET_THEME } from '../theme';
import type { UiQuad } from '../ui-quad';
import { Face } from './face';

// The progress card (180 x 62): the label and the count ("3 of 4", "120 of 250 mL") over a bar,
// or for a long amount the label, then the count beside a bar at least 40 mm long, or the count on
// a row of its own over a full-width bar (180 x 83). A whole-number total of at most 12 with no
// unit is a segmented bar like the site's step bar (ink pills, sunken empty ones with a hairline);
// anything else is a continuous ink fill on a sunken track. At the target the fill turns mint and
// the count becomes a mint dot and "Done".

const C = WIDGET_THEME.color;
const M = WIDGET_THEME.motion;
const LINE = WIDGET_THEME.line;
/** Gap between segments, and the continuous fill's least width (m). */
const SEGMENT_GAP = 3 * MM;
const MIN_FILL = 8 * MM;

/** A bar quad's look: segments (count, gap) or a continuous track (min fill). */
export function styleBar(quad: UiQuad, segments: number): void {
  quad.fill(tokenColor('sunken')).accent(C.ink);
  if (segments > 1) {
    quad.stroke(LINE.hairline.color, LINE.hairline.alpha, WIDGET_THEME.size.hairline);
    quad.param(segments, 0, SEGMENT_GAP, 0);
  } else {
    quad.stroke(0, 0, 0);
    quad.param(1, 0, 0, MIN_FILL);
  }
}

/** What the bar fills to: whole segments filled, or the share of the total. */
export function barTarget(w: Pick<ProgressWidget, 'value' | 'total'>, segments: number): number {
  return segments > 1
    ? Math.min(w.value, w.total)
    : w.total > 0
      ? Math.min(1, w.value / w.total)
      : 0;
}

export class ProgressCard extends Face<ProgressWidget> {
  private readonly card = this.cardQuad(62 * MM);
  private readonly bar = this.quad({ mode: 'segments', width: 148 * MM, height: 8 * MM });
  private readonly doneDot = this.quad({
    mode: 'box',
    width: 6 * MM,
    height: 6 * MM,
    radius: 3 * MM,
  });
  private readonly labelText = this.label('label');
  /** The count right-aligned beside the label or bar, or left-aligned on its own row. */
  private readonly counts = {
    right: this.label('status', { x: 'right' }),
    left: this.label('status'),
  } as const;
  private count: TextHandle = this.counts.right;
  private readonly doneText = this.label('status');
  private readonly fill = new NumberTween(0);
  private segments = 1;
  private doneAt: number | null = null;

  constructor(text: TextFactory) {
    super(text);
    this.doneDot.fill(C.mint);
    this.doneText.setColor(C.mintText);
  }

  set(w: ProgressWidget, t: number): boolean {
    const prev = this.record;
    this.record = w;
    const layout = progressCard(w);
    this.height = layout.height;
    this.place(this.card, { x: 0, y: 0, w: this.width, h: layout.height });
    this.place(this.bar, layout.bar, layout.bar.h / 2);
    this.place(this.doneDot, layout.done.dot, layout.done.dot.h / 2);
    this.placeText(this.labelText, layout.label);
    const left = layout.count.align === 'left';
    this.count = left ? this.counts.left : this.counts.right;
    this.placeText(this.count, layout.count);
    (left ? this.counts.right : this.counts.left).set('');
    this.placeText(this.doneText, layout.done.text, DONE_TEXT);

    const target = barTarget(w, layout.segments);
    if (prev === null || layout.segments !== this.segments) {
      this.segments = layout.segments;
      styleBar(this.bar, layout.segments);
      this.fill.snap(target);
    } else {
      this.fill.set(target, t, layout.segments > 1 ? M.segmentGrowMs : M.tweenMs);
    }

    let pulse = prev !== null && w.updatedT !== prev.updatedT;
    if (w.status === 'done' && this.doneAt === null) {
      this.doneAt = t;
      pulse = prev !== null;
    } else if (w.status === 'active') {
      this.doneAt = null;
    }
    return pulse;
  }

  frame(t: number, opacity: number): void {
    if (!this.record) return;
    this.card.opacity(opacity);
    this.labelText.setOpacity(opacity);
    this.bar.paramAt(1, this.fill.value(t));
    const done = this.doneAt === null ? 0 : tween(t, this.doneAt, M.tweenMs);
    this.bar.accent(mixHex(C.ink, C.mintStrong, done));
    this.bar.opacity(opacity);
    const cross = this.doneAt === null ? 0 : progress(t, this.doneAt, M.crossFadeMs);
    this.count.setOpacity(opacity * (1 - cross));
    this.doneDot.opacity(opacity * cross);
    this.doneText.setOpacity(opacity * cross);
  }
}
