import interRegular from '@fontsource/inter/files/inter-latin-400-normal.woff?url';
import interSemibold from '@fontsource/inter/files/inter-latin-600-normal.woff?url';
import { Text } from 'troika-three-text';

// SDF text for the headset. The font is bundled (troika would otherwise fetch one from a CDN, and
// venue Wi-Fi can't be trusted).

export interface TextOptions {
  size: number;
  color?: number;
  maxWidth?: number;
  anchorX?: Text['anchorX'];
  anchorY?: Text['anchorY'];
  bold?: boolean;
}

export function makeText({
  size,
  color = 0xffffff,
  maxWidth = Infinity,
  anchorX = 'left',
  anchorY = 'top',
  bold = false,
}: TextOptions): Text {
  const t = new Text();
  t.font = bold ? interSemibold : interRegular;
  t.fontSize = size;
  t.color = color;
  t.maxWidth = maxWidth;
  t.anchorX = anchorX;
  t.anchorY = anchorY;
  t.outlineWidth = '4%';
  t.outlineColor = 0x000000;
  return t;
}

/** Sets text only when it changed (sync() re-lays out the glyphs, which is not free). */
export function setText(t: Text, value: string): void {
  if (t.text !== value) {
    t.text = value;
    t.sync();
  }
}
