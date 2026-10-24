import type { Detection, NormalizedBox, PrimaryResponse } from '@clio/protocol';

// What the demo makes of one server answer: the main object and where it is in the frame, or
// nothing to outline (no object stood out, it was named but not found, or the finder was unsure).

export type PrimaryAnswer =
  | { found: true; name: string; detection: Detection & { box: NormalizedBox } }
  | { found: false; name: string | null };

/** Below this the finder is guessing; the lesson's grounding ignores the same. */
export const MIN_CONFIDENCE = 0.3;

function bounds(polygon: readonly (readonly [number, number])[]): NormalizedBox {
  const xs = polygon.map(([x]) => x);
  const ys = polygon.map(([, y]) => y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function readAnswer(
  response: PrimaryResponse,
  minConfidence = MIN_CONFIDENCE,
): PrimaryAnswer {
  const { name, detection } = response;
  if (!name || !detection?.found || detection.confidence < minConfidence) {
    return { found: false, name };
  }
  // Depth comes from the bottom of the box, so an outline-only answer gets its bounds.
  const box = detection.box ?? (detection.outline && bounds(detection.outline));
  return box ? { found: true, name, detection: { ...detection, box } } : { found: false, name };
}
