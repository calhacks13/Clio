import inter400 from '@fontsource/inter/files/inter-latin-400-normal.woff?url';
import inter500 from '@fontsource/inter/files/inter-latin-500-normal.woff?url';
import inter600 from '@fontsource/inter/files/inter-latin-600-normal.woff?url';
import interTight600 from '@fontsource/inter-tight/files/inter-tight-latin-600-normal.woff?url';
import { preloadFont } from 'troika-three-text';
import { SHARED_CHARS } from './font-metrics';
import type { FaceId } from './text-port';

// The widget faces, bundled like text.ts's (troika would otherwise fetch a font from its CDN, and
// venue Wi-Fi can't be trusted). Widget text is cleaned to the characters all four faces have
// (FONT_COVERAGE), so troika never falls back to fetching one either.

export const FONT_URL: Readonly<Record<FaceId, string>> = {
  inter400,
  inter500,
  inter600,
  interTight600,
};

let preloaded: Promise<void> | null = null;

/**
 * Parses every face and builds the glyphs widgets draw (troika's worker), once, so the first card
 * shows its text without a wait. Resolves at once where there are no workers (Node, tests).
 */
export function preloadWidgetFonts(): Promise<void> {
  if (preloaded) return preloaded;
  if (typeof Worker === 'undefined') {
    preloaded = Promise.resolve();
    return preloaded;
  }
  const faces = Object.values(FONT_URL);
  preloaded = Promise.all(
    faces.map(
      (font) =>
        new Promise<void>((resolve) => preloadFont({ font, characters: SHARED_CHARS }, resolve)),
    ),
  ).then(() => undefined);
  return preloaded;
}
