import type {
  NormalizedBox,
  NormalizedPoint,
  NormalizedPolygon,
  ObservationRole,
  ObservationStatus,
} from '@clio/protocol';
import type { Quat, Vec3 } from '../../core/math';

// One shape for everything an object source says about an object in one camera frame, so the
// recorder (and later the lesson) never cares which tracker produced it. Today's sources map onto
// it like this; none of them is wired to it yet:
//
//   /track mask (YOLOE-26 + ByteTrack, role tracker): state tracking, coasting, lost, absent,
//     unknown and idle become measured, predicted, lost, absent, unknown and unknown
//     (TRACK_STATE_STATUS); outline, box, point and contact are the image geometry, `score` and
//     `model` as reported, the mask's `t` is observedT, and position is the contact point lifted
//     into 3D, when it was.
//   session /locate detection (role tracker for a tracking finder, else detector): found gives
//     measured, not found absent; `confidence` is the score; observedT is the frame's capture time.
//   object.detected answer (jev: role identifier; Gemini: detector): found ? measured : absent,
//     point, box and outline as the image geometry, the lifted position, observedT = t - latencyMs.

/** Where the object was seen in the camera image, normalized 0..1 (x right, y down). */
export interface TrackedObjectImage {
  box: NormalizedBox | null;
  outline: NormalizedPolygon | null;
  point: NormalizedPoint | null;
  /** Middle of the mask's lowest edge, where the object meets the surface. */
  contact: NormalizedPoint | null;
  /** The camera frame, when the transport identifies it. */
  frame: { seq: number; width: number; height: number } | null;
}

/** What one object source said about one object in one camera frame. */
export interface TrackedObjectSample {
  objectId: string;
  /** When the camera frame was captured (performance.now ms). */
  observedT: number;
  status: ObservationStatus;
  role: ObservationRole;
  /** The model as reported, e.g. "yoloe-26l-seg". */
  source: string;
  /**
   * Score as reported; not a calibrated probability. It becomes a 3D state's confidence, which is
   * never invented: a sample without one records its 2D observation but no 3D state. So a source
   * that reports 3D must report a score (a marker tracker can report its own decode quality).
   */
  score: number | null;
  /** The tracker's own id: provenance only, it can change while following one object. */
  trackId: string | null;
  /**
   * Null when the answer says nothing about the image (absent, or a source that only measures 3D).
   * A lost answer can keep its frame with every geometry null.
   */
  image: TrackedObjectImage | null;
  /** World (local-floor) frame: lifted or measured. Null when there is no 3D estimate. */
  position: Vec3 | null;
  /**
   * False when `position` was not measured on this frame (a reused depth, or a guess from a surface
   * or the workspace plane). Absent means measured.
   */
  positionMeasured?: boolean;
  /** World frame, only when measured (a marker, a 6DoF tracker); never guessed. */
  orientation: Quat | null;
}

/** Port: anything that reports objects frame by frame. Returns a function that stops it. */
export interface TrackedObjectSource {
  start(onSample: (sample: TrackedObjectSample) => void): () => void;
}

/**
 * A /track mask's `state` as an observation status. A coasting box is predicted, never measured;
 * absent means the identifier said the target is not in view.
 */
export const TRACK_STATE_STATUS: Readonly<Record<string, ObservationStatus>> = {
  tracking: 'measured',
  coasting: 'predicted',
  lost: 'lost',
  absent: 'absent',
  unknown: 'unknown',
  idle: 'unknown',
};
