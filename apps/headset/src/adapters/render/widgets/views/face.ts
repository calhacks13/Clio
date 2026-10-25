import type { Group, Object3D } from 'three';
import type { Widget } from '../../../../domain/widgets/types';
import { onTopGroup } from '../layering';
import type { Rect, TextBlock } from '../layout';
import { TabularText } from '../tabular';
import type { TextAnchor, TextFactory, TextHandle, TypeRole } from '../text-port';
import { tokenColor, WIDGET_THEME } from '../theme';
import { UiQuad, type UiQuadOptions } from '../ui-quad';

// What every widget face shares: a group whose origin is the face's top-left corner (x right, y
// up, so card y runs negative), its quads and texts in layers drawn back to front, and the helpers
// that put a layout's rectangles and text blocks on them. A face is built once; set() lays out a
// new record and frame() only writes uniforms and opacities. Faces draw on top (layering.ts), so
// with no depth test their layers' render orders alone decide what covers what.

/** Back to front: the card, tiles under its content, inner shapes, marks on them, text. */
export type Layer = 'card' | 'under' | 'inner' | 'mark' | 'text';

/**
 * Render orders of each layer, inside the on-top group order the step card shares (its own layers
 * are 0 to 4): the dock after the card, chips before it, so the card covers a chip it meets.
 */
export interface FaceOrders {
  card: number;
  inner: number;
  text: number;
}

export const DOCK_ORDERS: FaceOrders = { card: 40, inner: 41, text: 42 };
export const CHIP_ORDERS: FaceOrders = { card: -12, inner: -11, text: -10 };

/** How the learner's fingertip is on a touch target. */
export type TouchLook = 'none' | 'hover' | 'pressed';

/** A touch target in card coordinates (from the top-left, y down), for item `index`. */
export interface TouchRect {
  index: number;
  rect: Rect;
}

/** Layers sit this far in front of the card plane (m), so ties never z-fight. */
const LAYER_Z: Readonly<Record<Layer, number>> = {
  card: 0,
  under: 0.0001,
  inner: 0.0002,
  mark: 0.0003,
  text: 0.0004,
};
/** Where the in-between layers draw relative to the card and inner orders. */
const LAYER_ORDER: Readonly<Record<Layer, (o: FaceOrders) => number>> = {
  card: (o) => o.card,
  under: (o) => o.card + 0.5,
  inner: (o) => o.inner,
  mark: (o) => o.inner + 0.5,
  text: (o) => o.text,
};

export abstract class Face<W extends Widget = Widget> {
  readonly object = onTopGroup();
  width = WIDGET_THEME.size.dockWidth;
  height = 0;
  protected record: W | null = null;
  private readonly layered: { object: Object3D; layer: Layer }[] = [];
  private readonly quads: UiQuad[] = [];
  private readonly texts: TextHandle[] = [];
  private readonly tabulars: TabularText[] = [];

  constructor(protected readonly text: TextFactory) {}

  /** Lays out a new record; true when the change deserves a pulse (a coach update, done). */
  abstract set(w: W, t: number): boolean;

  /** Draws the face at t with an overall opacity. Allocates nothing. */
  abstract frame(t: number, opacity: number): void;

  /** Where the learner can touch, for the current record. */
  touchRects(): readonly TouchRect[] {
    return NO_TOUCH;
  }

  /** The fingertip's state on item `index` (hover, an optimistic press, or none). */
  setTouch(_index: number, _look: TouchLook, _t: number): void {}

  /** Every text has finished its layout. */
  get ready(): boolean {
    for (const text of this.texts) if (!text.ready) return false;
    for (const tabular of this.tabulars) if (!tabular.ready) return false;
    return true;
  }

  /**
   * Render orders by layer, plus `bias` (a dock slot's, so lower cards draw over upper shadows).
   * A group (a tabular clock's) keeps the on-top group order; what is under it takes the layer's.
   */
  setOrders(orders: FaceOrders, bias: number): void {
    for (const { object, layer } of this.layered) {
      const order = LAYER_ORDER[layer](orders) + bias;
      object.traverse((child) => {
        if (!(child as Group).isGroup) child.renderOrder = order;
      });
    }
  }

  dispose(): void {
    for (const quad of this.quads) quad.dispose();
    for (const text of this.texts) text.dispose();
    for (const tabular of this.tabulars) tabular.dispose();
    this.object.removeFromParent();
  }

  protected quad(options: UiQuadOptions, layer: Layer = 'inner'): UiQuad {
    const quad = new UiQuad(options);
    quad.mesh.position.z = LAYER_Z[layer];
    this.quads.push(quad);
    this.layered.push({ object: quad.mesh, layer });
    this.object.add(quad.mesh);
    return quad;
  }

  /** The card's own quad: a solid surface and the card shadow under it, no ring. */
  protected cardQuad(height: number, radius = WIDGET_THEME.size.cardRadius): UiQuad {
    return this.quad(
      {
        mode: 'box',
        width: this.width,
        height,
        radius,
        shadow: WIDGET_THEME.shadow.card,
      },
      'card',
    ).fill(tokenColor('surface'));
  }

  protected label(role: TypeRole, anchor?: TextAnchor): TextHandle {
    const handle = this.text(role, { x: anchor?.x ?? 'left', y: anchor?.y ?? 'top' });
    handle.object.position.z = LAYER_Z.text;
    this.texts.push(handle);
    this.layered.push({ object: handle.object, layer: 'text' });
    this.object.add(handle.object);
    return handle;
  }

  protected tabular(role: TypeRole, cells: number, size?: number): TabularText {
    const tabular = new TabularText(this.text, role, cells, size);
    tabular.object.position.z = LAYER_Z.text;
    this.tabulars.push(tabular);
    this.layered.push({ object: tabular.object, layer: 'text' });
    this.object.add(tabular.object);
    return tabular;
  }

  /** Puts a quad's shape on a rectangle (card coordinates). */
  protected place(quad: UiQuad, r: Rect, radius?: number): void {
    quad.mesh.position.x = r.x + r.w / 2;
    quad.mesh.position.y = -(r.y + r.h / 2);
    quad.resize(r.w, r.h, radius);
  }

  /** Puts a centred shape (a ring, a disc, a check) at a point (card coordinates). */
  protected placeAt(quad: UiQuad, cx: number, cy: number): void {
    quad.mesh.position.x = cx;
    quad.mesh.position.y = -cy;
  }

  /** Puts a text block in its box, anchored as the handle was made (left, center or right). */
  protected placeText(handle: TextHandle, b: TextBlock, text: string = b.text): void {
    handle.set(text);
    handle.setSize(b.size);
    handle.object.position.x =
      b.align === 'left' ? b.x : b.align === 'center' ? b.x + b.w / 2 : b.x + b.w;
    handle.object.position.y = -b.y;
  }

  /** Puts a tabular clock's top-left at a point (card coordinates). */
  protected placeTabular(tabular: TabularText, x: number, y: number): void {
    tabular.object.position.x = x;
    tabular.object.position.y = -y;
  }
}

const NO_TOUCH: readonly TouchRect[] = Object.freeze([]);
