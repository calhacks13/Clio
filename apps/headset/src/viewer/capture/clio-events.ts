import type { EpisodeEvent, EpisodeEventOf, Pose7 } from '@clio/protocol';
import { wFromRos, wQuatFromRos } from './from-clio';
import type { Capture, CaptureEvent } from './model';

// Lookups over the Clio events a Capture keeps (each a `marker` whose details.clio is the original
// event; see from-clio.ts): the step running at a time, the object finder's answers per object, and
// the head pose back in the workspace frame W, where detection-outline.ts lifts outlines. Indexed
// once as events arrive, so a lookup per animation frame stays cheap. Pure: no DOM or three.js.

export type StepEntered = EpisodeEventOf<'step.entered'>;
export type Detection = EpisodeEventOf<'object.detected'>;

/** One object finder answer on the recording's time axis. */
export interface DetectionMark {
  objectId: string;
  /** When the answer arrived: the event's time. */
  availableUs: number;
  /** When its camera frame was captured (availableUs minus the latency); can be below 0. */
  observedUs: number;
  found: boolean;
  confidence: number;
  /** Which finder answered, e.g. "gemini" or "jev". */
  source: string;
  /** The marker event's sequence in the Capture: a stable key, e.g. for caching an outline. */
  eventSequence: number;
  detection: Detection;
}

interface Index {
  /** How many of the Capture's events are indexed, and the last of them. */
  count: number;
  last: CaptureEvent | undefined;
  events: EpisodeEvent[];
  steps: { tUs: number; step: StepEntered }[];
  detections: Map<string, DetectionMark[]>;
}

const indexes = new WeakMap<Capture, Index>();

function clioOf(e: CaptureEvent): EpisodeEvent | null {
  const clio = e.event === 'marker' ? e.details.clio : undefined;
  return typeof clio === 'object' && clio !== null && 'type' in clio
    ? (clio as EpisodeEvent)
    : null;
}

/** The Capture's index, brought up to date with the events added since the last lookup. */
function indexOf(capture: Capture): Index {
  const events = capture.events.samples;
  let index = indexes.get(capture);
  // Events normally arrive in time order. One added before those indexed shifts them: start over.
  if (!index || (index.count > 0 && events[index.count - 1] !== index.last)) {
    index = { count: 0, last: undefined, events: [], steps: [], detections: new Map() };
    indexes.set(capture, index);
  }
  for (; index.count < events.length; index.count++) {
    const marker = events[index.count] as CaptureEvent;
    const e = clioOf(marker);
    if (!e) continue;
    index.events.push(e);
    if (e.type === 'step.entered') index.steps.push({ tUs: marker.t_us, step: e });
    if (e.type === 'object.detected') {
      const mark: DetectionMark = {
        objectId: e.objectId,
        availableUs: marker.t_us,
        observedUs: marker.t_us - Math.round(e.latencyMs * 1000),
        found: e.found,
        confidence: e.confidence,
        source: e.source,
        eventSequence: marker.sequence,
        detection: e,
      };
      const marks = index.detections.get(e.objectId);
      if (marks) marks.push(mark);
      else index.detections.set(e.objectId, [mark]);
    }
  }
  index.last = events[index.count - 1];
  return index;
}

/** Index of the first item later than `t`. */
function upperBound<T>(items: readonly T[], t: number, timeOf: (item: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timeOf(items[mid] as T) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Every Clio event in the Capture, in time order (`t` in ms, as recorded). */
export function clioEvents(capture: Capture): readonly EpisodeEvent[] {
  return indexOf(capture).events;
}

/** The step running at `tUs`: the last step entered at or before it. */
export function stepAt(capture: Capture, tUs: number): StepEntered | null {
  const { steps } = indexOf(capture);
  return steps[upperBound(steps, tUs, (s) => s.tUs) - 1]?.step ?? null;
}

/** Every object finder answer about the object, found or not, by arrival. */
export function detectionsFor(capture: Capture, entityId: string): readonly DetectionMark[] {
  return indexOf(capture).detections.get(entityId) ?? [];
}

/** The newest answer per object that had arrived by `tUs`, oldest first. */
export function detectionsAt(capture: Capture, tUs: number): DetectionMark[] {
  const latest: DetectionMark[] = [];
  for (const marks of indexOf(capture).detections.values()) {
    const mark = marks[upperBound(marks, tUs, (m) => m.availableUs) - 1];
    if (mark) latest.push(mark);
  }
  return latest.sort((a, b) => a.availableUs - b.availableUs);
}

/**
 * The head pose at `tUs` (the newest headset sample at or before it), converted back to the
 * workspace frame W as [px, py, pz, qx, qy, qz, qw]; null before the first frame.
 */
export function headWAt(capture: Capture, tUs: number): Pose7 | null {
  const location = capture.headset()?.at(tUs)?.location;
  if (!location?.translation || !location.rotation) return null;
  return [...wFromRos(location.translation), ...wQuatFromRos(location.rotation)];
}
