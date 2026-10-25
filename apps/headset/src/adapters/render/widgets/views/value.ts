import type { ValueWidget } from '../../../../domain/widgets/types';
import { valueCard } from '../layout';
import { progress } from '../motion';
import { MM, WIDGET_THEME } from '../theme';
import { Face } from './face';

// The value card (180 x 74 at one line): a muted label over one figure in Inter Tight. The figure
// steps down from 22 mm to 20 and 18 before it wraps, and is never cut. No signal colour; a new
// value cross-fades from the old one with one pulse.

const M = WIDGET_THEME.motion;

export class ValueCard extends Face<ValueWidget> {
  private readonly card = this.cardQuad(74 * MM);
  private readonly labelText = this.label('label');
  /** Two figures, so a new value cross-fades from the old. */
  private readonly figures = [this.label('figure'), this.label('figure')] as const;
  private current: 0 | 1 = 0;
  private changedAt = Number.NEGATIVE_INFINITY;

  set(w: ValueWidget, t: number): boolean {
    const prev = this.record;
    this.record = w;
    const layout = valueCard(w);
    this.height = layout.height;
    this.place(this.card, { x: 0, y: 0, w: this.width, h: layout.height });
    this.placeText(this.labelText, layout.label);
    const changed = prev !== null && prev.value !== w.value;
    if (changed) {
      this.current = this.current === 0 ? 1 : 0;
      this.changedAt = t;
    }
    this.placeText(this.figures[this.current], layout.value);
    return prev !== null && (changed || w.updatedT !== prev.updatedT);
  }

  frame(t: number, opacity: number): void {
    if (!this.record) return;
    this.card.opacity(opacity);
    this.labelText.setOpacity(opacity);
    const k = progress(t, this.changedAt, M.crossFadeMs);
    this.figures[this.current].setOpacity(opacity * k);
    this.figures[this.current === 0 ? 1 : 0].setOpacity(opacity * (1 - k));
  }
}
