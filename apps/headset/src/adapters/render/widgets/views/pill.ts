import { formatClock, timerRemaining } from '../../../../domain/widgets/format';
import type { TimerWidget, Widget, WidgetKind } from '../../../../domain/widgets/types';
import { chipLayout, DONE_TEXT, PILL_BAR, pillLayout, type RingSpec } from '../layout';
import { NumberTween, progress, tween } from '../motion';
import type { TabularText } from '../tabular';
import type { TextFactory, TextHandle } from '../text-port';
import { MM, mixHex, tokenColor, WIDGET_THEME } from '../theme';
import type { UiQuad } from '../ui-quad';
import { Face } from './face';
import { barTarget } from './progress';
import { doneRing, runningRing, styleRing, sweepAt } from './timer';

// The collapsed forms. A pill (180 x 34) is what a card becomes when the column runs out of room:
// the same solid white surface (the caution's warm one) with the small shadow and no ring, one line
// of the widget's gist (a timer's ring and digits, a mini bar and count, a value). A chip (30 tall,
// as wide as its content) is a timer's pill beside the lesson object it is about.

const C = WIDGET_THEME.color;
const M = WIDGET_THEME.motion;

/** A timer's ring and digits running, then its mint ring and "Done" once it ends. */
class TimerGist {
  private doneAt: number | null = null;
  private sweepFrom = 0;
  private seconds = -1;

  constructor(
    private readonly ring: UiQuad,
    private readonly digits: TabularText,
    private readonly done: TextHandle,
  ) {
    done.setColor(C.mintText);
  }

  set(w: TimerWidget, prev: TimerWidget | null, ring: RingSpec, t: number): boolean {
    styleRing(this.ring, ring);
    this.seconds = -1;
    if (w.status === 'done' && this.doneAt === null) {
      this.doneAt = t;
      this.sweepFrom = prev ? sweepAt(prev, t) : 0;
      this.digits.set(formatClock(0));
      return prev !== null;
    }
    if (w.status === 'active') this.doneAt = null;
    return false;
  }

  frame(w: TimerWidget, t: number, opacity: number): void {
    this.ring.opacity(opacity);
    if (this.doneAt === null) {
      runningRing(this.ring, sweepAt(w, t));
      const remaining = timerRemaining(w, t);
      const seconds = Math.ceil(remaining / 1000);
      if (seconds !== this.seconds) {
        this.seconds = seconds;
        this.digits.set(formatClock(remaining));
      }
      this.digits.setOpacity(opacity);
      this.done.setOpacity(0);
      return;
    }
    doneRing(this.ring, t, this.doneAt, this.sweepFrom);
    const cross = progress(t, this.doneAt, M.crossFadeMs);
    this.digits.setOpacity(opacity * (1 - cross));
    this.done.setOpacity(opacity * cross);
  }
}

export class PillFace extends Face<Widget> {
  private readonly card: UiQuad;
  private readonly primary: TextHandle;
  private readonly secondary: TextHandle | null = null;
  private readonly ring: UiQuad | null = null;
  private readonly mark: UiQuad | null = null;
  private readonly gist: TimerGist | null = null;
  private readonly digits: TabularText | null = null;
  private readonly fill = new NumberTween(0);
  /** A progress pill drops its mini bar when a long amount needs the room. */
  private markShown = true;
  private doneAt: number | null = null;

  constructor(
    text: TextFactory,
    readonly kind: WidgetKind,
  ) {
    super(text);
    const pillH = WIDGET_THEME.size.pillHeight;
    this.height = pillH;
    this.card = this.quad(
      {
        mode: 'box',
        width: this.width,
        height: pillH,
        radius: pillH / 2,
        shadow: WIDGET_THEME.shadow.xs,
      },
      'card',
    ).fill(tokenColor(kind === 'caution' ? 'cautionSurface' : 'surface'));
    this.place(this.card, { x: 0, y: 0, w: this.width, h: pillH }, pillH / 2);
    this.primary = this.label(kind === 'caution' ? 'strong' : 'label');
    if (kind === 'timer') {
      this.ring = this.quad({ mode: 'ring', width: 22 * MM, height: 22 * MM });
      this.digits = this.tabular('pillValue', 5);
      this.secondary = this.label('status');
      this.gist = new TimerGist(this.ring, this.digits, this.secondary);
    } else if (kind === 'progress') {
      this.mark = this.quad({ mode: 'segments', width: PILL_BAR.w, height: PILL_BAR.h });
      this.mark
        .fill(tokenColor('sunken'))
        .accent(C.ink)
        .param(1, 0, 0, 3 * MM);
      this.secondary = this.label('status');
    } else if (kind === 'caution') {
      this.mark = this.quad({ mode: 'bang', width: 16 * MM, height: 16 * MM });
      this.mark.fill(C.citrus).accent(C.onInk);
    } else if (kind === 'value') {
      this.secondary = this.label('pillValue', { x: 'right' });
    } else {
      this.secondary = this.label('status', { x: 'right' });
    }
  }

  set(w: Widget, t: number): boolean {
    const prev = this.record;
    this.record = w;
    const layout = pillLayout(w);
    this.placeText(this.primary, layout.primary);
    if (this.secondary && layout.secondary) this.placeText(this.secondary, layout.secondary);
    else this.secondary?.set('');
    this.markShown = layout.mark !== null;
    if (this.mark && layout.mark) this.place(this.mark, layout.mark, layout.mark.h / 2);
    let pulse = prev !== null && w.updatedT !== prev.updatedT;
    if (
      w.kind === 'timer' &&
      this.gist &&
      this.ring &&
      this.digits &&
      layout.ring &&
      layout.digits
    ) {
      this.placeAt(this.ring, layout.ring.cx, layout.ring.cy);
      this.placeTabular(this.digits, layout.digits.x, layout.digits.y);
      if (this.secondary && layout.secondary)
        this.placeText(this.secondary, layout.secondary, DONE_TEXT);
      pulse = this.gist.set(w, prev?.kind === 'timer' ? prev : null, layout.ring, t) || pulse;
    }
    if (w.kind === 'progress') {
      const target = barTarget(w, 1);
      if (prev === null) this.fill.snap(target);
      else this.fill.set(target, t, M.tweenMs);
    }
    if (w.status === 'done' && this.doneAt === null) {
      this.doneAt = t;
      pulse = prev !== null;
    } else if (w.status === 'active') {
      this.doneAt = null;
    }
    return pulse;
  }

  frame(t: number, opacity: number): void {
    const w = this.record;
    if (!w) return;
    this.card.opacity(opacity);
    this.primary.setOpacity(opacity);
    if (w.kind === 'timer') {
      this.gist?.frame(w, t, opacity);
      return;
    }
    this.secondary?.setOpacity(opacity);
    if (!this.mark) return;
    if (w.kind === 'progress') {
      this.mark.paramAt(1, this.fill.value(t));
      const done = this.doneAt === null ? 0 : tween(t, this.doneAt, M.tweenMs);
      this.mark.accent(mixHex(C.ink, C.mintStrong, done));
      if (this.secondary) this.secondary.setColor(mixHex(C.ink, C.mintText, done));
    }
    this.mark.opacity(this.markShown ? opacity : 0);
  }
}

/** A timer's chip beside its object: ring, digits and label, 30 mm tall. */
export class TimerChip extends Face<TimerWidget> {
  private readonly card: UiQuad;
  private readonly ring: UiQuad;
  private readonly digits: TabularText;
  private readonly labelText: TextHandle;
  private readonly done: TextHandle;
  private readonly gist: TimerGist;

  constructor(text: TextFactory) {
    super(text);
    const h = WIDGET_THEME.size.chipHeight;
    this.height = h;
    this.card = this.quad(
      { mode: 'box', width: 100 * MM, height: h, radius: h / 2, shadow: WIDGET_THEME.shadow.xs },
      'card',
    ).fill(tokenColor('surface'));
    this.ring = this.quad({ mode: 'ring', width: 18 * MM, height: 18 * MM });
    this.digits = this.tabular('pillValue', 5, 14 * MM);
    this.labelText = this.label('label');
    this.done = this.label('status');
    this.gist = new TimerGist(this.ring, this.digits, this.done);
  }

  set(w: TimerWidget, t: number): boolean {
    const prev = this.record;
    this.record = w;
    const layout = chipLayout(w);
    this.width = layout.width;
    this.place(this.card, { x: 0, y: 0, w: layout.width, h: layout.height }, layout.height / 2);
    this.placeAt(this.ring, layout.ring.cx, layout.ring.cy);
    this.placeTabular(this.digits, layout.digits.x, layout.digits.y);
    this.placeText(this.labelText, layout.label);
    this.placeText(this.done, layout.done, DONE_TEXT);
    return this.gist.set(w, prev, layout.ring, t);
  }

  frame(t: number, opacity: number): void {
    const w = this.record;
    if (!w) return;
    this.card.opacity(opacity);
    this.labelText.setOpacity(opacity);
    this.gist.frame(w, t, opacity);
  }
}
