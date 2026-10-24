// Minimal typings for troika-three-text (the package ships none).
declare module 'troika-three-text' {
  import type { Color, Material, Mesh } from 'three';

  export class Text extends Mesh {
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
    sync(callback?: () => void): void;
    dispose(): void;
  }
}
