/// <reference path="../troika.d.ts" />
/// <reference path="./troika-widgets.d.ts" />
import { MeshBasicMaterial, Object3D } from 'three';
import { Text } from 'troika-three-text';
import { onTopMaterial } from '../on-top';
import { FONT_URL } from './fonts';
import { WIDGET_THEME } from './theme';

// The widgets' text, behind a port: views lay text out themselves (text-layout.ts, generated
// metrics) and hand over pre-broken lines, so troika only rasterises. Tests and Node use fakeText,
// which keeps the string and is ready at once. Text draws on top (on-top.ts); troika's derived
// material inherits that from the base material it is given.

export type FaceId = 'inter400' | 'inter500' | 'inter600' | 'interTight600';

export type TypeRole =
  | 'display'
  | 'figure'
  | 'state'
  | 'title'
  | 'pillValue'
  | 'strong'
  | 'body'
  | 'status'
  | 'label';

export interface TextAnchor {
  x?: 'left' | 'center' | 'right';
  y?: 'top' | 'middle' | 'bottom';
}

export interface TextHandle {
  readonly object: Object3D;
  /** Pre-broken text ('\n' between lines). Syncs only when it changed. */
  set(text: string): void;
  setColor(hex: number): void;
  setOpacity(opacity: number): void;
  setSize(metres: number): void;
  /** troika has finished laying out the current text. */
  readonly ready: boolean;
  dispose(): void;
}

export type TextFactory = (role: TypeRole, anchor?: TextAnchor) => TextHandle;

/** Below this opacity a text is hidden outright, so it costs no draw call. */
const HIDDEN = 0.004;

class TroikaHandle implements TextHandle {
  readonly object: Text;
  ready = true;
  private current = '';
  private color = -1;
  private opacity = 1;
  private readonly base = onTopMaterial(new MeshBasicMaterial());
  /** Syncs asked for and not yet finished: troika finishes a sync queued behind another last. */
  private pending = 0;
  private readonly synced = (): void => {
    this.pending--;
    if (this.pending === 0) this.ready = true;
  };

  constructor(role: TypeRole, anchor: TextAnchor | undefined) {
    const spec = WIDGET_THEME.type[role];
    const t = new Text();
    t.font = FONT_URL[spec.face];
    t.fontSize = spec.size;
    t.lineHeight = spec.lineHeight;
    t.letterSpacing = spec.tracking;
    t.outlineWidth = 0;
    t.maxWidth = Infinity;
    t.anchorX = anchor?.x ?? 'left';
    t.anchorY = anchor?.y ?? 'top';
    t.material = this.base;
    this.object = t;
    this.setColor(WIDGET_THEME.color[spec.color]);
  }

  set(text: string): void {
    if (text === this.current) return;
    this.current = text;
    this.pending++;
    this.ready = text === '';
    this.object.text = text;
    this.object.visible = text !== '' && this.opacity > HIDDEN;
    this.object.sync(this.synced);
  }

  setColor(hex: number): void {
    if (hex === this.color) return;
    this.color = hex;
    this.object.color = hex;
  }

  setOpacity(opacity: number): void {
    if (opacity === this.opacity) return;
    this.opacity = opacity;
    this.object.fillOpacity = opacity;
    this.object.visible = this.current !== '' && opacity > HIDDEN;
  }

  setSize(metres: number): void {
    if (metres === this.object.fontSize) return;
    this.object.fontSize = metres;
    if (this.current !== '') {
      this.pending++;
      this.ready = false;
      this.object.sync(this.synced);
    }
  }

  dispose(): void {
    this.object.dispose();
    this.base.dispose();
  }
}

/** troika SDF text in the role's face, size, line height, tracking and colour; no outline. */
export const troikaText: TextFactory = (role, anchor) => new TroikaHandle(role, anchor);

/** What fakeText puts in the scene graph: the state a test can read back. */
export class FakeTextObject extends Object3D {
  text = '';
  color = 0;
  opacity = 1;
  size = 0;
  /** How many times the text actually changed. */
  syncs = 0;

  constructor(
    readonly role: TypeRole,
    readonly anchor: TextAnchor,
  ) {
    super();
  }
}

class FakeHandle implements TextHandle {
  readonly object: FakeTextObject;
  readonly ready = true;

  constructor(role: TypeRole, anchor: TextAnchor | undefined) {
    this.object = new FakeTextObject(role, anchor ?? {});
    this.object.size = WIDGET_THEME.type[role].size;
    this.object.color = WIDGET_THEME.color[WIDGET_THEME.type[role].color];
  }

  set(text: string): void {
    if (text === this.object.text) return;
    this.object.text = text;
    this.object.syncs++;
  }

  setColor(hex: number): void {
    this.object.color = hex;
  }

  setOpacity(opacity: number): void {
    this.object.opacity = opacity;
  }

  setSize(metres: number): void {
    this.object.size = metres;
  }

  dispose(): void {
    this.object.removeFromParent();
  }
}

/** Tests: an Object3D holding `text`, ready at once. */
export const fakeText: TextFactory = (role, anchor) => new FakeHandle(role, anchor);
