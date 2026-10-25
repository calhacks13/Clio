// What the widgets use of troika-three-text beyond ../troika.d.ts (the package ships no typings).
// Both declare the same ambient module, so they merge.
declare module 'troika-three-text' {
  interface Text {
    /** Extra space after each glyph, in em. */
    letterSpacing: number;
  }

  /** Parses a font and builds the SDF glyphs for `characters` ahead of the first text using them. */
  export function preloadFont(
    options: { font: string; characters?: string | string[]; sdfGlyphSize?: number },
    callback?: () => void,
  ): void;
}
