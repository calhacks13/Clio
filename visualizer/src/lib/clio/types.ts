import type {
  EpisodeFinish,
  EpisodeMeta,
  Handedness,
  ObjectSpec,
} from "@clio/protocol";
import type { Capture, EstimateType } from "@clio-viewer/capture/model";

// Shared shapes for the Clio episode viewer (docs/plans/visualizer.md):
// what the source (source.ts) and the clock (live-clock.ts) publish, and what
// the lanes (lanes.ts) draw. Every `…Us` time is integer microseconds since
// the episode started, on the recording's own clock. Laptop arrival times are
// performance.now() milliseconds (`…AtMs`) and only pace the playhead.

/** live: grew in the last 15 s; finished: has finish.json; else stopped. */
export type EpisodeStatus = "live" | "stopped" | "finished";

/** live follows the newest episode (/clio/live); pinned stays on one. */
export type FollowMode = "live" | "pinned";

/** An episode's NDJSON files. */
export type Channel = "frames" | "events" | "objects" | "observations";

/** The order channels are read in and applied to the builder in. */
export const CHANNELS: readonly Channel[] = [
  "frames",
  "events",
  "objects",
  "observations",
];

/** Batch integrity from GET /api/episodes/:id, and what the headset sent. */
export interface BatchIntegrity {
  received: number;
  /** Sequence numbers missing below `lastSeq`. */
  gaps: number[];
  lastSeq: number | null;
  /** finish.batches; null until the episode is finished. */
  sent: number | null;
}

export interface SourceError {
  /** Which read failed. */
  scope: "list" | "detail" | Channel;
  message: string;
  /** The HTTP status when the server answered; null for a network failure. */
  status: number | null;
  /** When the next attempt runs, or null when it will not retry. */
  retryAtMs: number | null;
}

/** The span of frames the capture holds. */
export interface LoadedRange {
  fromUs: number;
  toUs: number;
}

export interface EpisodeSourceState {
  follow: FollowMode;
  /** The episode shown, or null while none is known yet. */
  episodeId: string | null;
  meta: EpisodeMeta | null;
  finish: EpisodeFinish | null;
  capture: Capture | null;
  /** Bumps when new records reach the capture, never on an empty read. */
  revision: number;
  status: EpisodeStatus | null;
  /** Bytes consumed per channel, taken only from `x-next-from`. */
  offsets: Record<Channel, number>;
  /**
   * Frames held in the capture. Before `fromUs` was not loaded (joined at
   * the tail); after `toUs` was not loaded either when `truncated` (the
   * frames size cap stopped the load).
   */
  loaded: LoadedRange | null;
  truncated: boolean;
  /** Hand samples before this were dropped while live; null if all kept. */
  handsKeptFromUs: number | null;
  /** The newest received frame and when its read completed: the live edge. */
  newest: { tUs: number; receivedAtMs: number } | null;
  batches: BatchIntegrity | null;
  /** Builder and decoder counts, for the dev lag readout. */
  counts: { duplicates: number; rejected: number; corrupt: number };
  error: SourceError | null;
}

export type ClockMode = "live" | "replay";

export interface ClockState {
  mode: ClockMode;
  /** The one time every layer, lane and the inspector reads. */
  tUs: number;
  /**
   * Live: the newest received frame time, advanced by laptop time since that
   * read. Replay: the end of the capture.
   */
  edgeUs: number;
  /** Live: tracking the edge at the play delay; false after a seek or pause. */
  following: boolean;
  playing: boolean;
}

/** How a lane item was obtained; the lanes style each differently. */
export type Basis = "measured" | "derived" | "inferred";

export type ObjectKind = ObjectSpec["kind"];

/** One pose update of an object. */
export interface LaneTick {
  tUs: number;
  /** The sample's source_id, e.g. "clio-detector" or "clio-grip". */
  sourceId: string;
  estimate: EstimateType;
  basis: Basis;
  positionValid: boolean;
}

/** A held span placed on the lane axis. */
export interface LaneHeldSpan {
  startUs: number;
  /** The release, or the end of the axis while still held. */
  endUs: number;
  /** Still held at the end of the loaded data. */
  open: boolean;
  hand: Handedness | null;
  grip: "pinch" | "fist" | null;
  /** runtime: recorded by the headset; inferred: from pinches. */
  origin: "inferred" | "runtime";
}

/** A detector answer, from when its camera frame was taken to its arrival. */
export interface LaneDetection {
  observedUs: number;
  availableUs: number;
  found: boolean;
  confidence: number;
  source: string;
  eventSequence: number;
}

export interface ObjectLane {
  entityId: string;
  label: string;
  kind: ObjectKind | null;
  ticks: LaneTick[];
  held: LaneHeldSpan[];
  /** Answers that found the object. */
  detections: LaneDetection[];
  /** Answers that did not (`found: false`), marked on their own. */
  misses: LaneDetection[];
}

/** Episode-wide spans with no data behind them, shaded across every lane. */
export interface LaneGap {
  kind: "not_loaded" | "hands_not_kept";
  startUs: number;
  endUs: number;
}

/** Every lane on one axis for the whole episode. */
export interface LaneModel {
  startUs: number;
  endUs: number;
  lanes: ObjectLane[];
  gaps: LaneGap[];
}
