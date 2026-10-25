import type { FaceId, TypeRole } from './text-port';

// Every colour, size, type role and motion constant of the coach's widgets (docs/widgets.md), from
// the Clio design system: white surfaces, ink type, solid light fills for controls and dividers,
// sunken tracks and soft CSS-like shadows for depth, with signal colour only for state (citrus
// live, mint done). Every fill is a solid, opaque colour: no rings, outlines or translucent tints
// (the navy hairlines are precomputed over white). Blue is absent on purpose: blue means AR
// guidance, and widgets are information. Views read only WIDGET_THEME.
// Design sizes are in mm (1 mm subtends 0.088 deg at the card's 0.65 m); the theme stores metres.

export const MM = 0.001;

export interface ShadowLayer {
  /** Offset down (mm), as CSS's y. */
  readonly y: number;
  /** CSS blur radius (mm); the gaussian's sigma is half of it. */
  readonly blur: number;
  readonly spread: number;
  readonly alpha: number;
}

export interface TypeSpec {
  readonly face: FaceId;
  /** Font size (m). */
  readonly size: number;
  /** Line height as a multiple of the size. */
  readonly lineHeight: number;
  /** Letter spacing (em). */
  readonly tracking: number;
  readonly color: ColorToken;
}

export type ColorToken =
  | 'ink'
  | 'inkMuted'
  | 'inkFaint'
  | 'onInk'
  | 'surface'
  | 'sunken'
  | 'sunkenSoft'
  | 'divider'
  | 'control'
  | 'controlHover'
  | 'cautionSurface'
  | 'citrus'
  | 'citrusText'
  | 'mint'
  | 'mintStrong'
  | 'mintText'
  | 'shadow';

export type MotionKey =
  | 'enterMs'
  | 'enterRise'
  | 'enterWaitMs'
  | 'exitMs'
  | 'exitScale'
  | 'reflowMs'
  | 'collapseMs'
  | 'pulseMs'
  | 'pulseScale'
  | 'tweenMs'
  | 'hoverMs'
  | 'pressMs'
  | 'crossFadeMs'
  | 'dotFadeMs'
  | 'checkDelayMs'
  | 'checkDrawMs'
  | 'tickDiscMs'
  | 'segmentGrowMs'
  | 'othersFadeMs'
  | 'pressHoldMs';

export interface WidgetTheme {
  readonly color: Readonly<Record<ColorToken, number>>;
  /** CSS box-shadow layers in mm (y down), sigma = blur / 2. */
  readonly shadow: {
    readonly card: readonly ShadowLayer[];
    readonly xs: readonly ShadowLayer[];
  };
  /** Metres. */
  readonly size: {
    readonly dockWidth: number;
    readonly padX: number;
    readonly padY: number;
    readonly cardRadius: number;
    readonly tileRadius: number;
    readonly pillHeight: number;
    readonly chipHeight: number;
    /** A divider's thickness. */
    readonly hairline: number;
    readonly dot: number;
    readonly gap: number;
    /** No text is drawn smaller than this. */
    readonly floor: number;
  };
  readonly type: Readonly<Record<TypeRole, TypeSpec>>;
  readonly motion: Readonly<Record<MotionKey, number>>;
  /** Glare knob: multiplies surface and sunken fills on the device. 1 = the exact token. */
  readonly surfaceLevel: number;
}

export const LIGHT: WidgetTheme = {
  color: {
    ink: 0x0f1117,
    inkMuted: 0x5b6472,
    inkFaint: 0x8a94a4,
    onInk: 0xffffff,
    surface: 0xffffff,
    sunken: 0xf1f3f7,
    sunkenSoft: 0xf4f6fa,
    // The design system's navy hairline (#0E2A52) precomputed over white: 10% for dividers and a
    // control at rest (answers, open checklist circles), 22% under a fingertip.
    divider: 0xe7eaee,
    control: 0xe7eaee,
    controlHover: 0xcad0d9,
    // The launch page's warning surface.
    cautionSurface: 0xfff0e4,
    citrus: 0xff7b3d,
    // Reserved: citrus as text on light; no widget text is citrus yet.
    citrusText: 0xb94a00,
    mint: 0x6fd3a0,
    mintStrong: 0x2ac48a,
    mintText: 0x007d4d,
    shadow: 0x0f1117,
  },
  // Shadows are the one translucent thing: offset, blurred depth under a card, never a tint.
  shadow: {
    card: [
      { y: 2, blur: 3, spread: 0, alpha: 0.08 },
      { y: 18, blur: 20, spread: -4, alpha: 0.075 },
    ],
    xs: [{ y: 1, blur: 2, spread: 0, alpha: 0.06 }],
  },
  size: {
    dockWidth: 180 * MM,
    padX: 16 * MM,
    padY: 14 * MM,
    cardRadius: 18 * MM,
    tileRadius: 8 * MM,
    pillHeight: 34 * MM,
    chipHeight: 30 * MM,
    hairline: 1 * MM,
    dot: 6 * MM,
    gap: 8 * MM,
    floor: 12 * MM,
  },
  type: {
    // The step card's 23 mm instruction is the one loud thing in view: a timer's digits and a
    // value's figure beside it stay at or under its size.
    display: { face: 'interTight600', size: 24 * MM, lineHeight: 1, tracking: 0, color: 'ink' },
    figure: {
      face: 'interTight600',
      size: 22 * MM,
      lineHeight: 1.1,
      tracking: -0.02,
      color: 'ink',
    },
    state: {
      face: 'interTight600',
      size: 20 * MM,
      lineHeight: 1.1,
      tracking: -0.01,
      color: 'mintText',
    },
    title: {
      face: 'interTight600',
      size: 16 * MM,
      lineHeight: 1.25,
      tracking: -0.01,
      color: 'ink',
    },
    pillValue: { face: 'interTight600', size: 16 * MM, lineHeight: 1, tracking: 0, color: 'ink' },
    strong: { face: 'inter500', size: 14 * MM, lineHeight: 1.3, tracking: -0.005, color: 'ink' },
    body: { face: 'inter400', size: 14 * MM, lineHeight: 1.35, tracking: -0.005, color: 'ink' },
    status: { face: 'inter600', size: 14 * MM, lineHeight: 1.3, tracking: 0, color: 'ink' },
    label: { face: 'inter500', size: 13 * MM, lineHeight: 1.3, tracking: 0, color: 'inkMuted' },
  },
  motion: {
    enterMs: 200,
    enterRise: 6 * MM,
    /** An entering card waits for its text this long at most, so a blank card never flashes. */
    enterWaitMs: 300,
    exitMs: 160,
    exitScale: 0.98,
    reflowMs: 200,
    collapseMs: 160,
    pulseMs: 280,
    pulseScale: 1.03,
    tweenMs: 300,
    hoverMs: 100,
    pressMs: 80,
    crossFadeMs: 160,
    dotFadeMs: 160,
    checkDelayMs: 60,
    checkDrawMs: 160,
    tickDiscMs: 180,
    segmentGrowMs: 200,
    othersFadeMs: 200,
    /** An optimistic press shows this long at most if the board never answers it. */
    pressHoldMs: 600,
  },
  surfaceLevel: 1,
};

/** The one line a night variant changes: `export const WIDGET_THEME = NIGHT;`. */
export const WIDGET_THEME: WidgetTheme = LIGHT;

/** Fills the glare knob dims: the white surfaces and the light fills drawn on them. */
const LEVELLED: readonly ColorToken[] = [
  'surface',
  'sunken',
  'sunkenSoft',
  'divider',
  'control',
  'controlHover',
  'cautionSurface',
];

/** A token's colour as drawn: surface and light fills scaled by `surfaceLevel`. */
export function tokenColor(token: ColorToken, theme: WidgetTheme = WIDGET_THEME): number {
  const hex = theme.color[token];
  return theme.surfaceLevel === 1 || !LEVELLED.includes(token)
    ? hex
    : scaleHex(hex, theme.surfaceLevel);
}

/** Each channel of an sRGB hex colour times k, clamped. */
function scaleHex(hex: number, k: number): number {
  const r = Math.min(255, Math.round(((hex >> 16) & 0xff) * k));
  const g = Math.min(255, Math.round(((hex >> 8) & 0xff) * k));
  const b = Math.min(255, Math.round((hex & 0xff) * k));
  return (r << 16) | (g << 8) | b;
}

/** a to b in sRGB, as CSS transitions mix colours (k 0..1). */
export function mixHex(a: number, b: number, k: number): number {
  if (k <= 0) return a;
  if (k >= 1) return b;
  const r = Math.round(((a >> 16) & 0xff) + (((b >> 16) & 0xff) - ((a >> 16) & 0xff)) * k);
  const g = Math.round(((a >> 8) & 0xff) + (((b >> 8) & 0xff) - ((a >> 8) & 0xff)) * k);
  const bl = Math.round((a & 0xff) + ((b & 0xff) - (a & 0xff)) * k);
  return (r << 16) | (g << 8) | bl;
}
