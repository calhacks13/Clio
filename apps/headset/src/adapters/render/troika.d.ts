// Minimal typings for troika-three-text (the package ships none).
declare module 'troika-three-text' {
  import type { BufferGeometry, Color, Material, Mesh, Object3DEventMap } from 'three';

  export interface TextEventMap extends Object3DEventMap {
    syncstart: object;
    /** The new text is laid out; textRenderInfo and the drawn glyphs now match it. */
    synccomplete: object;
  }

  export interface TextRenderInfo {
    /** [minX, minY, maxX, maxY] of the whole block, each line's full height included. */
    blockBounds: [number, number, number, number];
  }

  export class Text extends Mesh<BufferGeometry, Material, TextEventMap> {
    text: string;
    font: string | null;
    fontSize: number;
    color: Color | string | number;
    maxWidth: number;
    lineHeight: number | 'normal';
    anchorX: number | 'left' | 'center' | 'right';
    anchorY: number | 'top' | 'top-baseline' | 'middle' | 'bottom-baseline' | 'bottom';
    textAlign: 'left' | 'right' | 'center' | 'justify';
    fillOpacity: number;
    outlineWidth: number | string;
    outlineColor: Color | string | number;
    depthOffset: number;
    material: Material;
    /** The last completed layout (sync is asynchronous), or null before the first. */
    readonly textRenderInfo: TextRenderInfo | null;
    sync(callback?: () => void): void;
    dispose(): void;
  }
}
