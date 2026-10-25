import type { ChoicesWidget } from '../../../../domain/widgets/types';
import { type ChoiceOptionLayout, choicesCard } from '../layout';
import { ColorTween, NumberTween, tween } from '../motion';
import type { TextFactory, TextHandle } from '../text-port';
import { MM, tokenColor, WIDGET_THEME } from '../theme';
import type { UiQuad } from '../ui-quad';
import { Face, type TouchLook, type TouchRect } from './face';

// The choices card: the coach's question and two or three answers as stacked pills (two columns
// only for two short answers). At rest an answer is the site's secondary button; a fingertip over
// it rings it in ink on a soft sunken fill; a press turns it into the primary ink button at once.
// The chosen answer stays ink with a white check while the others fade; no signal colour until an
// answer. It never collapses, and the board closes it 1.5 s after the answer.

const C = WIDGET_THEME.color;
const M = WIDGET_THEME.motion;
const LINE = WIDGET_THEME.line;
const MAX_OPTIONS = 3;
const PILL_RADIUS = 19 * MM;

class OptionLook {
  readonly fill = new ColorTween(tokenColor('surface'));
  readonly ring = new ColorTween(LINE.hairlineStrong.color);
  readonly ringAlpha = new NumberTween(LINE.hairlineStrong.alpha);
  readonly ringWidth = new NumberTween(WIDGET_THEME.size.hairline);
  readonly text = new ColorTween(C.ink);
  readonly alpha = new NumberTween(1);
  touch: TouchLook = 'none';
  pressedAt = Number.NEGATIVE_INFINITY;

  /**
   * Eases to a look: rest, hover (ink ring, sunken fill) or ink (pressed or chosen). A null t
   * jumps there.
   */
  to(look: 'rest' | 'hover' | 'ink', alpha: number, t: number | null): void {
    const fill =
      look === 'ink' ? C.ink : look === 'hover' ? tokenColor('sunkenSoft') : tokenColor('surface');
    const ring = look === 'rest' ? LINE.hairlineStrong.color : C.ink;
    const ringAlpha = look === 'rest' ? LINE.hairlineStrong.alpha : 1;
    const ringWidth = look === 'hover' ? WIDGET_THEME.size.ring : WIDGET_THEME.size.hairline;
    const text = look === 'ink' ? C.onInk : C.ink;
    if (t === null) {
      this.fill.snap(fill);
      this.ring.snap(ring);
      this.ringAlpha.snap(ringAlpha);
      this.ringWidth.snap(ringWidth);
      this.text.snap(text);
      this.alpha.snap(alpha);
      return;
    }
    const ms = look === 'ink' ? M.pressMs : M.hoverMs;
    this.fill.set(fill, t, ms);
    this.ring.set(ring, t, ms);
    this.ringAlpha.set(ringAlpha, t, ms);
    this.ringWidth.set(ringWidth, t, ms);
    this.text.set(text, t, ms);
    this.alpha.set(alpha, t, M.othersFadeMs);
  }
}

export class ChoicesCard extends Face<ChoicesWidget> {
  private readonly card = this.cardQuad(120 * MM);
  private readonly question = this.label('title');
  private readonly pills: UiQuad[] = [];
  private readonly labels: TextHandle[] = [];
  private readonly looks: OptionLook[] = [];
  private readonly check = this.quad(
    { mode: 'check', width: 10 * MM, height: 10 * MM, radius: 5 * MM },
    'mark',
  );
  private options: ChoiceOptionLayout[] = [];
  private chosenAt: number | null = null;
  private touches: TouchRect[] = [];

  constructor(text: TextFactory) {
    super(text);
    for (let i = 0; i < MAX_OPTIONS; i++) {
      this.pills.push(
        this.quad({
          mode: 'box',
          width: 148 * MM,
          height: 38 * MM,
          radius: PILL_RADIUS,
          shadow: WIDGET_THEME.shadow.xs,
        }),
      );
      this.labels.push(this.label('strong', { x: 'center' }));
      this.looks.push(new OptionLook());
    }
    this.check
      .fill(0, 0)
      .stroke(0, 0, 0)
      .accent(C.onInk)
      .param(0, 2 * MM, 10 * MM, 0);
  }

  set(w: ChoicesWidget, t: number): boolean {
    const prev = this.record;
    this.record = w;
    const layout = choicesCard(w);
    this.height = layout.height;
    this.options = layout.options;
    this.place(this.card, { x: 0, y: 0, w: this.width, h: layout.height });
    this.placeText(this.question, layout.question);
    const open = w.status === 'active' && w.chosen === null;
    this.touches = [];
    for (let i = 0; i < MAX_OPTIONS; i++) {
      const option = layout.options[i];
      const pill = this.pills[i] as UiQuad;
      const label = this.labels[i] as TextHandle;
      pill.mesh.visible = option !== undefined;
      label.object.visible = option !== undefined;
      if (!option) {
        label.set('');
        continue;
      }
      if (open) this.touches.push({ index: i, rect: option.pill });
      this.place(pill, option.pill, PILL_RADIUS);
      this.placeText(label, w.chosen === i ? option.chosenLabel : option.label);
    }

    const chosen = w.chosen;
    const option = chosen === null ? undefined : layout.options[chosen];
    if (option && this.chosenAt === null) this.chosenAt = t;
    if (!option) this.chosenAt = null;
    if (option) this.place(this.check, option.check, option.check.w / 2);
    // A first look is drawn at once; later changes ease.
    for (let i = 0; i < MAX_OPTIONS; i++) this.restyle(i, prev === null ? null : t);
    const touched = prev !== null && this.recentlyPressed(t);
    return (
      (prev !== null && w.updatedT !== prev.updatedT && !touched) ||
      (prev?.chosen === null && chosen !== null)
    );
  }

  override touchRects(): readonly TouchRect[] {
    return this.touches;
  }

  override setTouch(index: number, touch: TouchLook, t: number): void {
    const look = this.looks[index];
    if (!look || !this.options[index]) return;
    if (touch === 'pressed') look.pressedAt = t;
    else look.touch = touch;
    this.restyle(index, t);
  }

  frame(t: number, opacity: number): void {
    if (!this.record) return;
    this.card.opacity(opacity);
    this.question.setOpacity(opacity);
    const n = Math.min(this.options.length, MAX_OPTIONS);
    for (let i = 0; i < n; i++) {
      const look = this.looks[i] as OptionLook;
      if (look.pressedAt > Number.NEGATIVE_INFINITY && t - look.pressedAt > M.pressHoldMs) {
        look.pressedAt = Number.NEGATIVE_INFINITY;
        this.restyle(i, t);
      }
      const alpha = opacity * look.alpha.value(t);
      const pill = this.pills[i] as UiQuad;
      pill.fill(look.fill.value(t));
      pill.stroke(look.ring.value(t), look.ringAlpha.value(t), look.ringWidth.value(t));
      pill.opacity(alpha);
      const label = this.labels[i] as TextHandle;
      label.setColor(look.text.value(t));
      label.setOpacity(alpha);
    }
    if (this.chosenAt === null) {
      this.check.opacity(0);
    } else {
      this.check.paramAt(0, tween(t, this.chosenAt + M.checkDelayMs, M.checkDrawMs));
      this.check.opacity(opacity);
    }
  }

  private restyle(i: number, t: number | null): void {
    const w = this.record;
    const look = this.looks[i];
    if (!w || !look) return;
    if (w.chosen !== null) {
      look.to(w.chosen === i ? 'ink' : 'rest', w.chosen === i ? 1 : M.othersAlpha, t);
      return;
    }
    const pressed = look.pressedAt > Number.NEGATIVE_INFINITY;
    look.to(pressed ? 'ink' : look.touch === 'hover' ? 'hover' : 'rest', 1, t);
  }

  private recentlyPressed(t: number): boolean {
    for (const look of this.looks) if (t - look.pressedAt < M.pressHoldMs) return true;
    return false;
  }
}
