import type { HighlightRole, ObjectSpec } from '@clio/protocol';
import type { HighlightStyle } from '../events';

// The highlight color scheme (apps/headset/DESIGN.md, "Highlight colors"): one accent per object,
// chosen by its role in the current step, never by its position in the show list. The coach names
// a style, never a color; styles map onto the same table here.

/** Solid, saturated emitters: the only accents the glow may take. */
export const ACCENTS = {
  act: 0x24d4ed,
  destination: 0xffd23f,
  level: 0x3ddc84,
  stop: 0xff5a5a,
  hint: 0xf2f6fa,
} as const;

/** A coach hint is a softer glow than a step color. */
export const HINT_OPACITY = 0.6;
/** Red is never steady: a warning pulses this long, then fades. */
export const WARNING_MS = 600;

/** What the glow draws for one object: its accent and how strongly. */
export interface Accent {
  color: number;
  opacity: number;
}

/**
 * A show item's role when the plan did not say: containers and regions are where things go, the
 * first other item is what to act on, and anything after that is a destination too.
 */
export function inferRole(rank: number, kind: ObjectSpec['kind'] | undefined): HighlightRole {
  if (kind === 'container' || kind === 'region') return 'destination';
  return rank === 0 ? 'act' : 'destination';
}

/**
 * The accent for a role. A part takes the accent of the object holding it, which the plan lists
 * right before it; `previous` is that item's accent (null for a part listed first, which then
 * reads as the thing to act on).
 */
export function roleAccent(role: HighlightRole, previous: number | null): number {
  switch (role) {
    case 'act':
      return ACCENTS.act;
    case 'destination':
      return ACCENTS.destination;
    case 'level':
      return ACCENTS.level;
    case 'part':
      return previous ?? ACCENTS.act;
  }
}

/**
 * How a highlight style changes an object's accent while it lasts: `target` keeps the step color,
 * `attention` is the white hint at reduced energy, `warning` is the red pulse. A hint never
 * replaces a step color for good; it ends with the highlight.
 */
export function styledAccent(base: number, style: HighlightStyle | null): Accent {
  switch (style) {
    case 'attention':
      return { color: ACCENTS.hint, opacity: HINT_OPACITY };
    case 'warning':
      return { color: ACCENTS.stop, opacity: 1 };
    default:
      return { color: base, opacity: 1 };
  }
}
