import { FONT_METRICS } from './font-metrics';
import type { TypeRole } from './text-port';
import { MM, WIDGET_THEME } from './theme';

// Pure text layout against the generated font metrics: widths, greedy wrapping and the ellipsis.
// Lines are joined with '\n' and troika gets maxWidth Infinity, so troika's lines are these lines
// and a card knows its height on the first frame. Widths are checked against 97% of the box, which
// leaves room for kerning (left out of the metrics).

/** The share of a box's width text may fill. */
export const FIT = 0.97;
export const ELLIPSIS = '…';
/** An advance for a character no face has (cleanText keeps those out of widgets). */
const MISSING_EM = 0.6;
/** The value's figure steps down through these sizes before it wraps (§6.4). */
export const VALUE_SIZES: readonly number[] = [22 * MM, 20 * MM, 18 * MM];

export interface Wrapped {
  lines: string[];
  /** The widest line (m). */
  width: number;
  /** Lines times the role's line height (m). */
  height: number;
  truncated: boolean;
}

/** The size a role draws at (m), unless overridden. */
export const roleSize = (role: TypeRole): number => WIDGET_THEME.type[role].size;

/** A role's line height at `size` (m). */
export function lineHeight(role: TypeRole, size: number = roleSize(role)): number {
  return WIDGET_THEME.type[role].lineHeight * size;
}

/** One line's width (m) in the role's face and tracking, at `size`. */
export function measure(text: string, role: TypeRole, size: number = roleSize(role)): number {
  const spec = WIDGET_THEME.type[role];
  const advances = FONT_METRICS[spec.face].advances;
  let em = 0;
  let n = 0;
  for (const ch of text) {
    em += advances[ch] ?? MISSING_EM;
    n++;
  }
  return (em + spec.tracking * Math.max(0, n - 1)) * size;
}

/**
 * Greedy wrapping at spaces into at most `maxLines` lines no wider than 97% of `maxWidth`; a word
 * too long for a line breaks between characters. Past the last allowed line the rest is cut and
 * the last line ends in an ellipsis.
 */
export function wrap(
  text: string,
  role: TypeRole,
  maxWidth: number,
  maxLines: number = Number.POSITIVE_INFINITY,
  size: number = roleSize(role),
): Wrapped {
  const limit = maxWidth * FIT;
  const words = text.split(/\s+/).filter((w) => w !== '');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate, role, size) <= limit) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = '';
    let rest = word;
    while (measure(rest, role, size) > limit) {
      const cut = longestPrefix(rest, role, size, limit, '');
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    current = rest;
  }
  if (current) lines.push(current);

  let truncated = false;
  if (lines.length > maxLines) {
    truncated = true;
    const kept = lines.slice(0, Math.max(0, maxLines - 1));
    const tail = lines.slice(kept.length).join(' ');
    kept.push(ellipsize(tail, role, size, limit));
    lines.length = 0;
    lines.push(...kept);
  }
  let width = 0;
  for (const line of lines) width = Math.max(width, measure(line, role, size));
  return { lines, width, height: lines.length * lineHeight(role, size), truncated };
}

/** One line, cut with an ellipsis when it does not fit. */
export function fitLine(
  text: string,
  role: TypeRole,
  maxWidth: number,
  size: number = roleSize(role),
): string {
  const limit = maxWidth * FIT;
  return measure(text, role, size) <= limit ? text : ellipsize(text, role, size, limit);
}

/**
 * The value's figure: 22 mm, else 20, else 18 on one line, else wrapped at 18 mm. A value is never
 * cut: it takes as many lines as it needs (two for anything the tool accepts).
 */
export function fitValue(
  text: string,
  maxWidth: number,
): { size: number; lines: string[]; width: number; height: number } {
  for (const size of VALUE_SIZES) {
    const width = measure(text, 'figure', size);
    if (width <= maxWidth * FIT) {
      return { size, lines: [text], width, height: lineHeight('figure', size) };
    }
  }
  const size = VALUE_SIZES[VALUE_SIZES.length - 1] ?? 18 * MM;
  const { lines, width, height } = wrap(text, 'figure', maxWidth, Number.POSITIVE_INFINITY, size);
  return { size, lines, width, height };
}

/** The text with as many characters as fit before an ellipsis, trailing spaces dropped. */
function ellipsize(text: string, role: TypeRole, size: number, limit: number): string {
  const cut = longestPrefix(text, role, size, limit, ELLIPSIS);
  return `${text.slice(0, cut).trimEnd()}${ELLIPSIS}`;
}

/** The longest prefix (in UTF-16 units, at least one character) that fits with `suffix` after. */
function longestPrefix(
  text: string,
  role: TypeRole,
  size: number,
  limit: number,
  suffix: string,
): number {
  let best = 0;
  let end = 0;
  for (const ch of text) {
    end += ch.length;
    if (measure(text.slice(0, end) + suffix, role, size) > limit) break;
    best = end;
  }
  if (best > 0) return best;
  const first = text.codePointAt(0) ?? 0;
  return first > 0xffff ? 2 : Math.min(1, text.length);
}
