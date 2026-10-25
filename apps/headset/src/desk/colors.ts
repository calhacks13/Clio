import { ACCENTS, type Accent } from '../domain/overlay/accents';

// How the desk lab draws one followed object on the webcam image: the colors are the headset's
// (domain/overlay/accents.ts, one accent per object by its role in the step), the strokes are the
// desk's own. A lit object (the step shows it, the coach or ER points at it) gets a soft fill and a
// glow in its accent; an object followed only for the recording gets a thin neutral line. Its box
// and its tag take the same color, so a box always reads as belonging to its outline.

/** The thin line of an object that is followed but not lit. */
export const NEUTRAL = 'rgba(232, 238, 252, 0.62)';
/** Text on a dark tag. */
export const LIGHT_TEXT = '#e8eefc';
/** Text on a tag filled with an accent (all of them are bright). */
export const DARK_TEXT = '#04121a';
/** A tag under a neutral object. */
export const DARK_TAG = 'rgba(7, 11, 20, 0.78)';

/** An accent's 0xRRGGBB as #rrggbb. */
export function hex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** An accent's 0xRRGGBB at an alpha, for canvas strokes and fills. */
export function rgba(color: number, alpha: number): string {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 1000) / 1000;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export interface ObjectStyle {
  /** The outline's line. */
  stroke: string;
  lineWidth: number;
  /** Inside the outline; null leaves it clear. */
  fill: string | null;
  /** The canvas shadow that makes the glow; null for none. */
  glow: string | null;
  /** The bounding box's line. */
  box: string;
  boxWidth: number;
  /** The tag's background and text. */
  tag: string;
  tagText: string;
  /** Dashed while the tracker only predicts where the object is (coasting). */
  dashed: boolean;
}

/**
 * The style of one followed object. `lit` is the headset's isShown (the step shows it, a highlight
 * is on it); `accent` is its role color and strength; `state` the tracker's (tracking, coasting...).
 */
export function objectStyle(lit: boolean, accent: Accent, state: string | null): ObjectStyle {
  const dashed = state === 'coasting';
  if (!lit) {
    return {
      stroke: NEUTRAL,
      lineWidth: 1,
      fill: null,
      glow: null,
      box: NEUTRAL,
      boxWidth: 1,
      tag: DARK_TAG,
      tagText: LIGHT_TEXT,
      dashed,
    };
  }
  const strength = Math.min(1, Math.max(0, accent.opacity));
  return {
    stroke: rgba(accent.color, strength),
    lineWidth: 2.5,
    fill: rgba(accent.color, 0.2 * strength),
    glow: rgba(accent.color, 0.85 * strength),
    box: rgba(accent.color, strength),
    boxWidth: 1.5,
    tag: rgba(accent.color, Math.max(0.75, strength)),
    tagText: DARK_TEXT,
    dashed,
  };
}

/** The neutral line's color and strength, for ER's box on an object that is only followed. */
const NEUTRAL_RGB = 0xe8eefc;
const NEUTRAL_ALPHA = 0.62;

/**
 * The color of a box Robotics-ER drew, at `opacity` (it fades): a lit object's own accent, so it
 * sits on that object's glow; the neutral line on an object followed only for the data; the act
 * color on an action item the lesson does not follow (yet).
 */
export function erStroke(object: { accent: Accent; lit: boolean } | null, opacity: number): string {
  if (!object) return rgba(ACCENTS.act, opacity);
  if (!object.lit) return rgba(NEUTRAL_RGB, NEUTRAL_ALPHA * opacity);
  return rgba(object.accent.color, opacity);
}
