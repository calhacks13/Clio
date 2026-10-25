import type { Widget } from '../../../../domain/widgets/types';
import { onTopGroup } from '../layering';
import { cardLayout } from '../layout';
import { easeInCubic, easeInOutCubic, lerp, NumberTween, progress, pulse, tween } from '../motion';
import type { TextFactory } from '../text-port';
import { WIDGET_THEME } from '../theme';
import { CautionCard } from './caution';
import { ChecklistCard } from './checklist';
import { ChoicesCard } from './choices';
import { DOCK_ORDERS, type Face, type TouchLook, type TouchRect } from './face';
import { PillFace } from './pill';
import { ProgressCard } from './progress';
import { TimerCard } from './timer';
import { ValueCard } from './value';

// One widget in the dock: its expanded card and its collapsed pill (each built the first time it
// shows), and the calm motion around them. It enters by fading in and rising 6 mm once its text is
// laid out (or after 300 ms), exits by fading and shrinking slightly, glides to a new slot,
// cross-fades between card and pill, and pulses once on a coach update or when it is done.

const M = WIDGET_THEME.motion;
const W = WIDGET_THEME.size.dockWidth;

/** A widget's expanded card face. */
export function createCard(w: Widget, text: TextFactory): Face {
  switch (w.kind) {
    case 'timer':
      return new TimerCard(text) as Face;
    case 'progress':
      return new ProgressCard(text) as Face;
    case 'checklist':
      return new ChecklistCard(text) as Face;
    case 'choices':
      return new ChoicesCard(text) as Face;
    case 'value':
      return new ValueCard(text) as Face;
    case 'caution':
      return new CautionCard(text) as Face;
  }
}

export class WidgetView {
  /** In the column: x 0 is the column's centre line, y 0 its top. */
  readonly object = onTopGroup();
  /** The face's centre, for pulse and exit scaling. */
  private readonly pivot = onTopGroup();
  private card: Face | null = null;
  private pill: Face | null = null;
  private record: Widget;
  /** The expanded card's height (m), from the layout. */
  height: number;
  private readonly builtAt: number;
  private enterAt: number | null = null;
  private exitAt: number | null = null;
  private pulseAt = Number.NEGATIVE_INFINITY;
  private readonly top = new NumberTween(0, easeInOutCubic);
  private placed = false;
  private collapsed = false;
  private collapseAt = Number.NEGATIVE_INFINITY;
  private bias = 0;
  /** The dock's reconcile pass that last saw this widget in a snapshot. */
  seen = 0;

  constructor(
    widget: Widget,
    private readonly text: TextFactory,
    t: number,
  ) {
    this.record = widget;
    this.height = cardLayout(widget).height;
    this.builtAt = t;
    this.object.add(this.pivot);
    this.object.visible = false;
  }

  get widget(): Widget {
    return this.record;
  }

  get seq(): number {
    return this.record.seq;
  }

  get id(): string {
    return this.record.id;
  }

  get isCollapsed(): boolean {
    return this.collapsed;
  }

  get exiting(): boolean {
    return this.exitAt !== null;
  }

  /** The face showing now has its text laid out. */
  get ready(): boolean {
    const face = this.collapsed ? this.pill : this.card;
    return face?.ready ?? false;
  }

  /** A new record for this widget (only when it changed). */
  set(w: Widget, t: number): void {
    this.record = w;
    this.height = cardLayout(w).height;
    let pulse = false;
    if (this.card) pulse = this.card.set(w, t) || pulse;
    if (this.pill) pulse = this.pill.set(w, t) || pulse;
    if (pulse) this.pulseAt = t;
  }

  /**
   * Its slot: glides there (snaps the first time, or with `snap` while nobody sees the column), and
   * cross-fades to the pill or the card.
   */
  place(top: number, collapsed: boolean, t: number, bias: number, snap = false): void {
    if (!this.placed || snap) {
      this.placed = true;
      this.top.snap(top);
    } else {
      this.top.set(top, t, M.reflowMs);
    }
    if (collapsed !== this.collapsed) {
      this.collapsed = collapsed;
      this.collapseAt = this.enterAt === null || snap ? Number.NEGATIVE_INFINITY : t;
    }
    this.bias = bias;
    const face = collapsed ? this.pillFace(t) : this.cardFace(t);
    face.setOrders(DOCK_ORDERS, bias);
    const other = collapsed ? this.card : this.pill;
    other?.setOrders(DOCK_ORDERS, bias);
  }

  /** Starts the exit; finished() says when it can be disposed. */
  exit(t: number): void {
    if (this.exitAt === null) this.exitAt = t;
  }

  finished(t: number): boolean {
    return this.exitAt !== null && t - this.exitAt >= M.exitMs;
  }

  /**
   * Whether a fingertip can do anything here: an expanded card that is not exiting, and whose step
   * has not lost focus (a widget leaving after a step change takes no touch, so nothing on it
   * lights up or flips only to flip back).
   */
  get touchable(): boolean {
    return !this.collapsed && this.exitAt === null && !this.record.leaving;
  }

  /** The expanded card's touch targets (card coordinates), or none while it is not touchable. */
  touchRects(): readonly TouchRect[] {
    if (!this.touchable || !this.card) return NONE;
    return this.card.touchRects();
  }

  /** The slot's top it is gliding to. */
  get slotTop(): number {
    return this.top.target;
  }

  /** A fingertip's look on item `index`; a hover or press on a card that is not touchable is dropped. */
  setTouch(index: number, look: TouchLook, t: number): void {
    if (look !== 'none' && !this.touchable) return;
    if (!this.collapsed) this.card?.setTouch(index, look, t);
  }

  /** Draws the view at t; `columnOpacity` fades the whole column (the dock changing sides). */
  frame(t: number, columnOpacity = 1): void {
    if (this.enterAt === null && (this.ready || t >= this.builtAt + M.enterWaitMs)) {
      this.enterAt = Math.min(t, this.builtAt + M.enterWaitMs);
      if (this.collapseAt > Number.NEGATIVE_INFINITY) this.collapseAt = Number.NEGATIVE_INFINITY;
    }
    const enter = this.enterAt === null ? 0 : tween(t, this.enterAt, M.enterMs);
    const exit = this.exitAt === null ? 0 : tween(t, this.exitAt, M.exitMs, easeInCubic);
    const opacity = enter * (1 - exit) * columnOpacity;
    this.object.visible = opacity > 0.002;
    if (!this.object.visible) return;

    const c = progress(t, this.collapseAt, M.collapseMs);
    const pillAlpha = this.collapsed ? c : 1 - c;
    const cardAlpha = 1 - pillAlpha;
    const shownH = this.collapsed ? WIDGET_THEME.size.pillHeight : this.height;
    this.object.position.y = -this.top.value(t) - (1 - enter) * M.enterRise;
    this.pivot.position.y = -shownH / 2;
    this.pivot.scale.setScalar(
      pulse(t, this.pulseAt, M.pulseMs, M.pulseScale) * lerp(1, M.exitScale, exit),
    );
    this.frameFace(this.card, t, opacity * cardAlpha, shownH);
    this.frameFace(this.pill, t, opacity * pillAlpha, shownH);
  }

  dispose(): void {
    this.card?.dispose();
    this.pill?.dispose();
    this.object.removeFromParent();
  }

  private frameFace(face: Face | null, t: number, opacity: number, shownH: number): void {
    if (!face) return;
    face.object.visible = opacity > 0.002;
    if (!face.object.visible) return;
    face.object.position.set(-W / 2, shownH / 2, 0);
    face.frame(t, opacity);
  }

  private cardFace(t: number): Face {
    if (!this.card) {
      this.card = createCard(this.record, this.text);
      this.card.set(this.record, t);
      this.card.setOrders(DOCK_ORDERS, this.bias);
      this.pivot.add(this.card.object);
    }
    return this.card;
  }

  private pillFace(t: number): Face {
    if (!this.pill) {
      this.pill = new PillFace(this.text, this.record.kind);
      this.pill.set(this.record, t);
      this.pill.setOrders(DOCK_ORDERS, this.bias);
      this.pivot.add(this.pill.object);
    }
    return this.pill;
  }
}

const NONE: readonly TouchRect[] = Object.freeze([]);
