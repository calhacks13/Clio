import { actionObjectRefs, type Step } from '@clio/protocol';
import type { HighlightStyle } from '../events';
import { WARNING_MS } from './accents';

// What is lit while a step is focused, so something glows whenever there is something to do: the
// step's show items, most important first; a step that shows nothing lights its targets, then its
// action's objects. The action focus's item (ER's next thing to touch) and the coach's highlights
// add to that. The live tracker's lights (LiveTracking) and the fallback while it is down
// (OverlayModel's rings around Spotlight's outlines) follow these same rules.

/** How long an `attention` hint from the coach lasts (ms). */
export const COACH_HIGHLIGHT_MS = 5000;

/** The objects a focused step lights by itself, most important first, each once. */
export function stepLights(step: Step): string[] {
  const ids =
    step.show.length > 0
      ? step.show.map((item) => item.object)
      : [...step.targets, ...(step.action ? actionObjectRefs(step.action) : [])];
  return [...new Set(ids)];
}

/**
 * When a coach highlight made at `t` ends, or null when it lasts until the step changes: a
 * `target` (the next thing to touch) stays lit for the step unless another `target` replaces it,
 * an `attention` hint lasts a moment, and a `warning` is a pulse, never a steady red.
 */
export function coachHighlightUntil(style: HighlightStyle, t: number): number | null {
  switch (style) {
    case 'target':
      return null;
    case 'attention':
      return t + COACH_HIGHLIGHT_MS;
    case 'warning':
      return t + WARNING_MS;
  }
}
