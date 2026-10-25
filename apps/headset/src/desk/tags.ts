import type { Rect, Size } from './fit';

// The tag at a box's top-left corner: the object's label, and for the desk's eyes its tracking
// state, the finder that last placed it (jev or Robotics-ER) and the tracker's score. Tags sit just
// above their box, inside it when the box touches the top of the picture, never past the canvas's
// sides, and step down past a tag already drawn rather than cover it.

export interface TagFacts {
  label: string;
  /** tracking, coasting, lost, unknown; null before the tracker said. */
  state: string | null;
  /** Who last placed the object: "jev", "er", or null before either (or from an older tracker). */
  source: string | null;
  /** The tracker's score, 0..1; null when it gave none. */
  score: number | null;
}

/** "washer cap · tracking · er 0.91": what is known, in that order, nothing for what isn't. */
export function tagText({ label, state, source, score }: TagFacts): string {
  const parts = [label];
  if (state) parts.push(state);
  const finder = [source, score === null ? null : score.toFixed(2)].filter(Boolean).join(' ');
  if (finder) parts.push(finder);
  return parts.join(' · ');
}

/** Space between a tag and its box, and between stacked tags (px). */
const GAP = 2;
/** At most this many steps down past tags already drawn. */
const MAX_STEPS = 6;

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Where a tag of `size` goes for `box` on a `canvas`, clear of the tags in `taken` when it can be:
 * above the box's top-left corner, or just inside the box when there is no room above.
 */
export function placeTag(box: Rect, size: Size, canvas: Size, taken: readonly Rect[]): Rect {
  const x = Math.max(0, Math.min(box.x, canvas.width - size.width));
  const above = box.y - size.height - GAP;
  let y = above >= 0 ? above : Math.max(0, box.y + GAP);
  for (let step = 0; step < MAX_STEPS; step++) {
    const rect = { x, y, width: size.width, height: size.height };
    const blocking = taken.find((t) => overlaps(rect, t));
    if (!blocking) return rect;
    y = blocking.y + blocking.height + GAP;
  }
  return { x, y: Math.min(y, Math.max(0, canvas.height - size.height)), ...size };
}
