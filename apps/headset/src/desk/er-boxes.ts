import type { FocusAction, FocusDetection, NormalizedBox, NormalizedPoint } from '@clio/protocol';

// Robotics-ER's boxes on the desk's picture. Each action-focus answer boxes the step's objects and
// names the one thing to touch next; its boxes are drawn dashed over the tracker's for 1.5 s,
// fading, so you can see where ER put each object against where the tracker follows it, and the
// action item is marked. The boxes are about the frame ER saw, a second or two before they arrive.

/** How long an answer's boxes stay on the picture (ms), fading all the way. */
export const ER_FADE_MS = 1500;

/** How strongly an answer that arrived at `answeredT` is drawn at `now`: 1 at once, 0 after the fade. */
export function erOpacity(answeredT: number, now: number, fadeMs = ER_FADE_MS): number {
  const age = now - answeredT;
  if (age < 0) return 1;
  return age >= fadeMs ? 0 : 1 - age / fadeMs;
}

export interface ErBox {
  /** The lesson's object id; null for an action item the request did not name. */
  id: string | null;
  label: string;
  box: NormalizedBox;
  point: NormalizedPoint | null;
  confidence: number;
  /** The thing to touch next. */
  action: boolean;
}

/**
 * The boxes one answer draws: every object it found with a box, and the action item, marked; an
 * action item on a requested object marks that object's box rather than drawing a second one.
 * `actionId` is the lesson object lit for the action (focus.answered), which for an item the plan
 * lacked is the one the lesson declared from ER's words.
 */
export function erBoxes(
  detections: readonly FocusDetection[],
  action: FocusAction | null,
  label: (id: string) => string,
  actionId: string | null = action?.id ?? null,
): ErBox[] {
  const marked = action?.found ? actionId : null;
  const boxes: ErBox[] = [];
  for (const d of detections) {
    if (!d.found || !d.box) continue;
    boxes.push({
      id: d.id,
      label: label(d.id),
      box: d.box,
      point: d.point,
      confidence: d.confidence,
      action: marked !== null && d.id === marked,
    });
  }
  if (action?.found && action.box && !boxes.some((b) => b.action)) {
    boxes.push({
      id: actionId,
      label: action.label,
      box: action.box,
      point: action.point,
      confidence: action.confidence,
      action: true,
    });
  }
  return boxes;
}
