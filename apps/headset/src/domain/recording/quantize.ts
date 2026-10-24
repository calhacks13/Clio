import type {
  FrameRecord,
  HandSample,
  NormalizedPoint,
  ObjectObservation,
  ObjectState,
  Pose7,
} from '@clio/protocol';
import type { Pose } from '../../core/math';
import type { TrackedFrame } from '../hands/types';

// Storage precision: 0.1 mm for positions, 1e-4 for quaternion components, 0.01 ms for time.
// Far below tracking noise, and it keeps NDJSON compact.

const round = (v: number, scale: number) => {
  const r = Math.round(v * scale) / scale;
  return r === 0 ? 0 : r; // never write -0
};
export const q4 = (v: number) => round(v, 1e4);
export const qTime = (v: number) => round(v, 1e2);

const pose7 = (p: Pose): Pose7 => [
  q4(p.p[0]),
  q4(p.p[1]),
  q4(p.p[2]),
  q4(p.q[0]),
  q4(p.q[1]),
  q4(p.q[2]),
  q4(p.q[3]),
];

const hand = (h: HandSample | null): HandSample | null =>
  h && { joints: h.joints.map(q4), pinch: q4(h.pinch) };

export function toFrameRecord(frame: TrackedFrame, startT: number): FrameRecord {
  return {
    t: qTime(frame.t - startT),
    head: pose7(frame.head),
    left: hand(frame.left),
    right: hand(frame.right),
  };
}

/** Rounds every number in an event payload to storage precision (1e-4), recursively. */
export function quantizeDeep<T>(value: T): T {
  if (typeof value === 'number') return (Number.isInteger(value) ? value : q4(value)) as T;
  if (Array.isArray(value)) return value.map(quantizeDeep) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, quantizeDeep(v)])) as T;
  }
  return value;
}

/**
 * One object state for objects.ndjson, recorded at `t` (performance.now ms). `observedT` arrives in
 * performance.now ms too: it is rebased onto `startT`, and left out when within 1 ms of `t`.
 */
export function quantizeObject(o: ObjectState, startT: number, t: number): ObjectState {
  return {
    id: o.id,
    position: [q4(o.position[0]), q4(o.position[1]), q4(o.position[2])],
    orientation: o.orientation && [
      q4(o.orientation[0]),
      q4(o.orientation[1]),
      q4(o.orientation[2]),
      q4(o.orientation[3]),
    ],
    confidence: q4(o.confidence),
    source: o.source,
    ...(o.locationFlags === undefined ? {} : { locationFlags: o.locationFlags }),
    ...(o.heldBy === undefined ? {} : { heldBy: o.heldBy }),
    ...(o.observedT === undefined || Math.abs(o.observedT - t) < 1
      ? {}
      : { observedT: qTime(o.observedT - startT) }),
  };
}

const point = (p: NormalizedPoint | null): NormalizedPoint | null => p && [q4(p[0]), q4(p[1])];

/**
 * One observation for observations.ndjson. Its `t` and `observedT` arrive in performance.now ms and
 * are rebased onto `startT`; normalized image coordinates and the score keep 1e-4.
 */
export function quantizeObservation(o: ObjectObservation, startT: number): ObjectObservation {
  return {
    t: qTime(o.t - startT),
    observedT: qTime(o.observedT - startT),
    objectId: o.objectId,
    status: o.status,
    role: o.role,
    source: o.source,
    box: o.box && [q4(o.box[0]), q4(o.box[1]), q4(o.box[2]), q4(o.box[3])],
    outline: o.outline === null ? null : o.outline.map(([x, y]) => [q4(x), q4(y)]),
    point: point(o.point),
    contact: point(o.contact),
    score: o.score === null ? null : q4(o.score),
    frame: o.frame && { seq: o.frame.seq, width: o.frame.width, height: o.frame.height },
    trackId: o.trackId,
  };
}
