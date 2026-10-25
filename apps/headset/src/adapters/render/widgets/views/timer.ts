import { formatClock, timerRemaining } from '../../../../domain/widgets/format';
import type { TimerWidget } from '../../../../domain/widgets/types';
import { type RingSpec, TIMER_CHECK, TIMES_UP_TEXT, timerCard } from '../layout';
import { lerp, progress, tween } from '../motion';
import type { TextFactory } from '../text-port';
import { MM, mixHex, tokenColor, WIDGET_THEME } from '../theme';
import type { UiQuad } from '../ui-quad';
import { Face } from './face';

// The timer card (180 x 74, or 91 with a two-line label): an ink arc on a sunken ring that
// retreats counter-clockwise from 12 o'clock as time runs out, with a citrus end-dot riding its
// end (the logo's live dot), the label, and the time left in tabular digits, never 0:00 while it
// runs. When it ends the ring fills mint, the dot fades, a mint check draws on and the digits
// cross-fade to "Time's up". No blinking.

const C = WIDGET_THEME.color;
const M = WIDGET_THEME.motion;
/** The end-dot's surface ring (m). */
const DOT_RING = 1.5 * MM;

/** A ring quad's parameters from its spec: centreline radius, stroke, end-dot radius. */
export function styleRing(quad: UiQuad, ring: RingSpec): void {
  const r = ring.outer / 2 - ring.stroke / 2;
  quad.resize(ring.outer, ring.outer);
  quad.setExtent(Math.max(0, ring.dot / 2 + DOT_RING - ring.stroke / 2));
  quad.param(r, ring.stroke, 1, ring.dot / 2);
  quad
    .fill(tokenColor('sunken'))
    .accent(C.ink)
    .param2(C.citrus)
    .stroke(tokenColor('surface'), 1, DOT_RING);
}

/** The running ring: sweep is the time left as a share of the duration. */
export function runningRing(quad: UiQuad, sweep: number): void {
  quad.paramAt(2, sweep);
}

/**
 * The ring after the timer ended at `doneAt`: the arc fills to a full mint ring, the end-dot fades.
 * `from` is the sweep it ended at.
 */
export function doneRing(quad: UiQuad, t: number, doneAt: number, from: number): void {
  const k = tween(t, doneAt, M.tweenMs);
  quad.paramAt(2, lerp(from, 1, k));
  quad.accent(mixHex(C.ink, C.mintStrong, k));
  const dot = 1 - progress(t, doneAt, M.dotFadeMs);
  quad.param2(C.citrus, dot).stroke(tokenColor('surface'), dot, DOT_RING);
}

/** The share of a timer's duration left at t (0 once done). */
export function sweepAt(w: TimerWidget, t: number): number {
  return w.durationMs > 0 ? timerRemaining(w, t) / w.durationMs : 0;
}

export class TimerCard extends Face<TimerWidget> {
  private readonly card = this.cardQuad(74 * MM);
  private readonly ring = this.quad({ mode: 'ring', width: 40 * MM, height: 40 * MM });
  private readonly check = this.quad(
    { mode: 'check', width: TIMER_CHECK, height: TIMER_CHECK, radius: TIMER_CHECK / 2 },
    'mark',
  );
  private readonly labelText = this.label('label');
  private readonly digits = this.tabular('display', 5);
  private readonly state = this.label('state');
  private doneAt: number | null = null;
  private sweepFrom = 0;
  private seconds = -1;

  constructor(text: TextFactory) {
    super(text);
    this.check
      .fill(0, 0)
      .stroke(0, 0, 0)
      .accent(C.mintStrong)
      .param(0, 3 * MM, TIMER_CHECK, 0);
    this.state.setColor(C.mintText);
  }

  set(w: TimerWidget, t: number): boolean {
    const prev = this.record;
    this.record = w;
    const layout = timerCard(w);
    this.height = layout.height;
    this.place(this.card, { x: 0, y: 0, w: this.width, h: layout.height });
    styleRing(this.ring, layout.ring);
    this.placeAt(this.ring, layout.ring.cx, layout.ring.cy);
    this.placeAt(this.check, layout.ring.cx, layout.ring.cy);
    this.placeText(this.labelText, layout.label);
    this.placeTabular(this.digits, layout.digits.x, layout.digits.y);
    this.placeText(this.state, layout.state, TIMES_UP_TEXT);
    this.seconds = -1;

    let pulse = prev !== null && w.updatedT !== prev.updatedT;
    if (w.status === 'done' && this.doneAt === null) {
      this.doneAt = t;
      this.sweepFrom = prev ? sweepAt(prev, t) : 0;
      // The clock fades out at 0:00, not at the last second it showed running.
      this.digits.set(formatClock(0));
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
    this.ring.opacity(opacity);
    this.labelText.setOpacity(opacity);
    if (this.doneAt === null) {
      runningRing(this.ring, sweepAt(w, t));
      const remaining = timerRemaining(w, t);
      const seconds = Math.ceil(remaining / 1000);
      if (seconds !== this.seconds) {
        this.seconds = seconds;
        this.digits.set(formatClock(remaining));
      }
      this.digits.setOpacity(opacity);
      this.state.setOpacity(0);
      this.check.opacity(0);
      return;
    }
    doneRing(this.ring, t, this.doneAt, this.sweepFrom);
    this.check.paramAt(0, tween(t, this.doneAt + M.checkDelayMs, M.checkDrawMs));
    this.check.opacity(opacity);
    const cross = progress(t, this.doneAt, M.crossFadeMs);
    this.digits.setOpacity(opacity * (1 - cross));
    this.state.setOpacity(opacity * cross);
  }
}
