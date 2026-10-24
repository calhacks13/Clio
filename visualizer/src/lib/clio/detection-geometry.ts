import {
  type DetectionMark,
  detectionsAt,
  headWAt,
} from "@clio-viewer/capture/clio-events";
import { rosFromW } from "@clio-viewer/capture/from-clio";
import type { Capture, Vec3 } from "@clio-viewer/capture/model";
import { detectionOutline } from "@clio-viewer/detection-outline";

// Object finder outlines in the Capture's ROS frame. detection-outline.ts lifts a 2D outline into
// the workspace W from where the head was when the camera frame was captured (the answer's
// observation time); here the result moves to ROS once, with rosFromW, and is cached per answer.
// The outline assumes the default Quest camera model (episodes record no calibration), so it is
// drawn as approximate. Pure: no DOM or three.js.

export interface DetectionOutline {
  objectId: string;
  /** The answer's marker sequence: a stable key for the outline. */
  eventSequence: number;
  mark: DetectionMark;
  /** The closed loop in ROS (first point not repeated). */
  points: Vec3[];
  /** Where the finder placed the object, in ROS. */
  center: Vec3;
}

/** Per capture, each answer's ROS outline (or null when it can't be placed). */
const cache = new WeakMap<Capture, Map<number, Vec3[] | null>>();

/**
 * The answer's outline as a closed loop in ROS, or null when it has none: a miss, no outline or
 * box, or no head pose at its observation time. It is cached only once the head samples reach the
 * observation time, so it never comes from an older pose while frames lag behind events.
 */
export function outlineRos(
  capture: Capture,
  mark: DetectionMark,
): Vec3[] | null {
  let outlines = cache.get(capture);
  if (!outlines) {
    outlines = new Map();
    cache.set(capture, outlines);
  }
  const cached = outlines.get(mark.eventSequence);
  if (cached !== undefined) return cached;
  if (!mark.found) {
    outlines.set(mark.eventSequence, null);
    return null;
  }
  // The frames up to the observation may not be loaded yet (joining a live episode, a failed frames
  // read, a replay stopped by the frames cap): try again later.
  const lastHead = capture.headset()?.samples.at(-1);
  if (!lastHead || lastHead.t_us < mark.observedUs) return null;
  const head = headWAt(capture, mark.observedUs);
  if (!head) return null;
  const points = detectionOutline(mark.detection, head)?.map(rosFromW) ?? null;
  outlines.set(mark.eventSequence, points);
  return points;
}

/** The newest outline per object among the answers that had arrived by `tUs`, oldest first. */
export function outlinesAt(capture: Capture, tUs: number): DetectionOutline[] {
  const out: DetectionOutline[] = [];
  for (const mark of detectionsAt(capture, tUs)) {
    const position = mark.detection.position;
    if (!mark.found || !position) continue;
    const points = outlineRos(capture, mark);
    if (!points) continue;
    out.push({
      objectId: mark.objectId,
      eventSequence: mark.eventSequence,
      mark,
      points,
      center: rosFromW(position),
    });
  }
  return out;
}
