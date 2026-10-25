import type { CautionWidget } from '../../../../domain/widgets/types';
import { cautionCard } from '../layout';
import type { TextFactory } from '../text-port';
import { MM, WIDGET_THEME } from '../theme';
import { Face } from './face';

// The caution card: a lasting hazard the coach has already said out loud, in one short sentence
// beside a citrus "!" disc, inside a full 2 mm citrus ring (never a coloured left border). It is
// static; it stays until the coach clears it or the lesson ends.

const C = WIDGET_THEME.color;

export class CautionCard extends Face<CautionWidget> {
  private readonly card = this.cardQuad(48 * MM);
  private readonly disc = this.quad({ mode: 'bang', width: 20 * MM, height: 20 * MM });
  private readonly body = this.label('strong');

  constructor(text: TextFactory) {
    super(text);
    this.card.stroke(C.citrus, 1, 2 * MM);
    this.disc.fill(C.citrus).accent(C.onInk);
  }

  set(w: CautionWidget, _t: number): boolean {
    const prev = this.record;
    this.record = w;
    const layout = cautionCard(w);
    this.height = layout.height;
    this.place(this.card, { x: 0, y: 0, w: this.width, h: layout.height });
    this.place(this.disc, layout.disc);
    this.placeText(this.body, layout.text);
    return prev !== null && w.updatedT !== prev.updatedT;
  }

  frame(_t: number, opacity: number): void {
    if (!this.record) return;
    this.card.opacity(opacity);
    this.disc.opacity(opacity);
    this.body.setOpacity(opacity);
  }
}
