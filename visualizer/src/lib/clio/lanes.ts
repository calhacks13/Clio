import {
  EPISODE_FEATURE,
  type EpisodeEvent,
  type EpisodeMeta,
  type ObservationStatus,
} from "@clio/protocol";
import {
  clioEvents,
  type DetectionMark,
  detectionsFor,
  stepAt,
} from "@clio-viewer/capture/clio-events";
import {
  GRIP_SOURCE,
  type ObservationMark,
  observationsFor,
} from "@clio-viewer/capture/from-clio";
import {
  type Capture,
  entityAt,
  type EstimateType,
  type HeldSpan,
  heldSpanAt,
  POSITION_VALID,
  type PoseSample,
} from "@clio-viewer/capture/model";
import { type LogKind, logEntry } from "@clio-viewer/event-log";
import { drawnObjects } from "./object-display";
import type {
  Basis,
  BatchIntegrity,
  LaneDetection,
  LaneGap,
  LaneHeldSpan,
  LaneModel,
  LaneTick,
  LoadedRange,
  ObjectLane,
} from "./types";

// What the Clio panels show, worked out from a Capture: the per-object lanes
// on one axis for the whole episode, the inspector rows for one object at the
// viewed time, the event list and the running step. Pure: no React, DOM or
// three.js, so the panels stay thin and these rules are tested directly.
// Styling follows the "Clio episode viewer" section of visualizer/DESIGN.md.
// Lanes come in drawnObjects order (object-display.ts), so a lane's index is
// its object's identity color index in the scene.

/** Whether the episode records location flags, so tracking loss can show. */
export function recordsLocationFlags(
  meta: Pick<EpisodeMeta, "features"> | null | undefined,
): boolean {
  return meta?.features?.includes(EPISODE_FEATURE.objectFlags) ?? false;
}

/** What drew an update, for the tick color: detection, hand or plan. */
export type SourceClass = "detection" | "hand" | "plan";

const SOURCES: Record<string, { label: string; class: SourceClass }> = {
  "clio-layout": { label: "Plan layout", class: "plan" },
  "clio-manual": { label: "Manual", class: "plan" },
  "clio-pinch": { label: "Pinch placement", class: "hand" },
  [GRIP_SOURCE]: { label: "Carried", class: "hand" },
  "clio-detector": { label: "Detector", class: "detection" },
  "clio-marker": { label: "Marker", class: "detection" },
};

export function sourceClass(sourceId: string): SourceClass {
  return SOURCES[sourceId]?.class ?? "plan";
}

/** The label a sample's source_id shows as, e.g. "Carried" for clio-grip. */
export function sourceLabel(sourceId: string): string {
  const known = SOURCES[sourceId];
  if (known) return known.label;
  const name = sourceId.replace(/^clio-/, "").replaceAll(/[-_]/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const ESTIMATES: Record<EstimateType, string> = {
  runtime_estimate: "Runtime estimate",
  vision_estimate: "Vision estimate",
  predicted: "Predicted",
  manual: "Given",
  synthetic: "Synthetic",
};

export function estimateLabel(estimate: EstimateType): string {
  return ESTIMATES[estimate];
}

/** `m:ss.s`, like the headset viewer's formatClock, from microseconds. */
export function formatTime(us: number): string {
  const tenths = Math.max(0, Math.floor(us / 100_000));
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

/** "1:02.3 to 1:03.1". */
export function formatRange(startUs: number, endUs: number): string {
  return `${formatTime(startUs)} to ${formatTime(endUs)}`;
}

/** A duration in seconds with one decimal, e.g. "0.7 s". */
export function formatSeconds(us: number): string {
  return `${(Math.max(0, us) / 1e6).toFixed(1)} s`;
}

/** The derived age of the newest update, named by its basis. */
export function formatAge(ageUs: number): string {
  return `${formatSeconds(ageUs)} since update`;
}

export const HAND_LABEL = { left: "Left hand", right: "Right hand" } as const;

export interface BuildLanesOptions {
  /** The axis end; defaults to the capture's end (pass the live edge). */
  endUs?: number;
  /** Frames the capture holds; time outside them is "not loaded". */
  loaded?: LoadedRange | null;
  /** The frames cap stopped the load at `loaded.toUs`. */
  truncated?: boolean;
  /** Hand samples before this were dropped while live. */
  handsKeptFromUs?: number | null;
}

const tickOf = (sample: PoseSample): LaneTick => ({
  tUs: sample.t_us,
  sourceId: sample.source_id,
  estimate: sample.estimate_type,
  // Every update was written by the headset; how it was made is its source.
  basis: "measured",
  positionValid: (sample.location.location_flags & POSITION_VALID) !== 0,
});

const heldOf = (span: HeldSpan, endUs: number): LaneHeldSpan => ({
  startUs: span.startUs,
  endUs: Math.max(span.startUs, Math.min(span.endUs ?? endUs, endUs)),
  open: span.endUs === null || span.endUs > endUs,
  hand: span.hand,
  grip: span.grip,
  origin: span.origin,
});

const detectionOf = (mark: DetectionMark): LaneDetection => ({
  observedUs: mark.observedUs,
  availableUs: mark.availableUs,
  found: mark.found,
  confidence: mark.confidence,
  source: mark.source,
  eventSequence: mark.eventSequence,
});

/**
 * Every drawn object's lane on one axis from 0 to the end of the episode.
 * Anything after the axis end (a live edge behind the newest data) is left
 * out, and a span still held there is cut at it and marked open.
 */
export function buildLanes(
  capture: Capture,
  options: BuildLanesOptions = {},
): LaneModel {
  const { loaded = null, truncated = false, handsKeptFromUs = null } = options;
  const startUs = 0;
  const endUs = Math.max(startUs, options.endUs ?? capture.endUs);
  const lanes: ObjectLane[] = drawnObjects(capture).map((entity) => {
    const marks = detectionsFor(capture, entity.id).filter(
      (m) => m.availableUs <= endUs,
    );
    const samples = capture.poses.get(entity.id)?.samples ?? [];
    return {
      entityId: entity.id,
      label: entity.name,
      kind: entity.extensions?.kind ?? null,
      ticks: samples.filter((s) => s.t_us <= endUs).map(tickOf),
      held: capture
        .heldSpans(entity.id)
        .filter((span) => span.startUs <= endUs)
        .map((span) => heldOf(span, endUs)),
      detections: marks.filter((m) => m.found).map(detectionOf),
      misses: marks.filter((m) => !m.found).map(detectionOf),
    };
  });
  const gaps: LaneGap[] = [];
  if (loaded && loaded.fromUs > startUs) {
    gaps.push({ kind: "not_loaded", startUs, endUs: loaded.fromUs });
  }
  const keptFrom = loaded ? Math.max(loaded.fromUs, startUs) : startUs;
  if (handsKeptFromUs !== null && handsKeptFromUs > keptFrom) {
    gaps.push({
      kind: "hands_not_kept",
      startUs: keptFrom,
      endUs: Math.min(handsKeptFromUs, endUs),
    });
  }
  if (truncated && loaded && loaded.toUs < endUs) {
    gaps.push({ kind: "not_loaded", startUs: loaded.toUs, endUs });
  }
  return { startUs, endUs, lanes, gaps };
}

export interface TimeSpan {
  startUs: number;
  endUs: number;
}

/**
 * Where the object's position was lost: from an update without a valid
 * position to the next valid one (or the axis end). Only meaningful in
 * episodes that record location flags; others never mark a loss.
 */
export function lostSpans(lane: ObjectLane, endUs: number): TimeSpan[] {
  const spans: TimeSpan[] = [];
  let open: TimeSpan | null = null;
  for (const tick of lane.ticks) {
    if (!tick.positionValid && !open) {
      open = { startUs: tick.tUs, endUs: tick.tUs };
      spans.push(open);
    } else if (tick.positionValid && open) {
      open.endUs = tick.tUs;
      open = null;
    }
  }
  if (open) open.endUs = Math.max(open.startUs, endUs);
  return spans;
}

/** Consecutive updates from one source closer than a pixel or two, as one mark. */
export interface TickRun {
  startUs: number;
  endUs: number;
  sourceId: string;
  source: SourceClass;
  count: number;
  basis: Basis;
}

/**
 * Merges ticks that would overlap on screen: a carry updates at frame rate,
 * so its ticks become one solid run (real data, drawn as such) instead of
 * thousands of marks. `usPerPx` is the axis scale; ticks of one source within
 * `gapPx` pixels join a run.
 */
export function tickRuns(
  ticks: readonly LaneTick[],
  usPerPx: number,
  gapPx = 2,
): TickRun[] {
  const runs: TickRun[] = [];
  const join = usPerPx * gapPx;
  let run: TickRun | null = null;
  for (const tick of ticks) {
    if (
      run &&
      run.sourceId === tick.sourceId &&
      run.basis === tick.basis &&
      tick.tUs - run.endUs <= join
    ) {
      run.endUs = tick.tUs;
      run.count++;
      continue;
    }
    run = {
      startUs: tick.tUs,
      endUs: tick.tUs,
      sourceId: tick.sourceId,
      source: sourceClass(tick.sourceId),
      count: 1,
      basis: tick.basis,
    };
    runs.push(run);
  }
  return runs;
}

/** Labeled times along the axis, about `minSpacingPx` apart at least. */
export function axisTicks(
  startUs: number,
  endUs: number,
  widthPx: number,
  minSpacingPx = 72,
): { tUs: number; label: string }[] {
  if (widthPx <= 0 || endUs <= startUs) return [];
  const STEPS_S = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
  const usPerPx = (endUs - startUs) / widthPx;
  const stepS =
    STEPS_S.find((s) => (s * 1e6) / usPerPx >= minSpacingPx) ??
    (STEPS_S[STEPS_S.length - 1] as number);
  const stepUs = stepS * 1e6;
  const ticks: { tUs: number; label: string }[] = [];
  for (let t = Math.ceil(startUs / stepUs) * stepUs; t <= endUs; t += stepUs) {
    const tUs = Math.round(t);
    const label = formatTime(tUs);
    ticks.push({ tUs, label: stepS < 1 ? label : label.slice(0, -2) });
  }
  return ticks;
}

/** One line of the object inspector. */
export interface InspectorRow {
  /** Null for a full-width note, such as "Orientation unknown". */
  label: string | null;
  value: string;
  basis: Basis;
  /** Extra detail for a tooltip, such as the detector's name. */
  title?: string;
}

export interface ObjectInspection {
  entityId: string;
  label: string;
  rows: InspectorRow[];
}

const formatPosition = (p: readonly number[]) =>
  p.map((v) => (v >= 0 ? " " : "") + v.toFixed(3)).join("  ");

/** What an observation's status says about the camera image. */
const OBSERVED: Record<ObservationStatus, string> = {
  measured: "Seen",
  predicted: "Predicted",
  lost: "Lost",
  absent: "Not in view",
  unknown: "Unknown",
};

/**
 * The newest observation of the object that had arrived by `tUs`. A tracker
 * answers 20 to 30 times a second, so this is a binary search.
 */
function observationAt(
  marks: readonly ObservationMark[],
  tUs: number,
): ObservationMark | null {
  let lo = 0;
  let hi = marks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((marks[mid] as ObservationMark).availableUs <= tUs) lo = mid + 1;
    else hi = mid;
  }
  return marks[lo - 1] ?? null;
}

/** The newest answer about the object that had arrived by `tUs`. */
function answerAt(
  marks: readonly DetectionMark[],
  tUs: number,
): DetectionMark | null {
  let answer: DetectionMark | null = null;
  for (const mark of marks) {
    if (mark.availableUs > tUs) break;
    answer = mark;
  }
  return answer;
}

/**
 * What the inspector says about one object at `tUs`. Confidence appears only
 * when it was measured (detector and marker updates); a null is left out, not
 * shown as 0. Positions are ROS meters (x forward, y left, z up).
 */
export function inspectObject(
  capture: Capture,
  entityId: string,
  tUs: number,
  options: { flagsRecorded?: boolean } = {},
): ObjectInspection | null {
  const entity = capture.entities.get(entityId);
  if (!entity) return null;
  const rows: InspectorRow[] = [];
  const series = capture.poses.get(entityId);
  const at = series ? entityAt(series, tUs) : null;
  const marks = detectionsFor(capture, entityId);
  if (!at) {
    rows.push({ label: null, value: "No update yet", basis: "derived" });
  } else {
    const { sample } = at;
    const finder =
      sample.source_id === "clio-detector"
        ? answerAt(
            marks.filter((m) => m.found),
            sample.t_us,
          )?.source
        : undefined;
    rows.push({
      label: "Source",
      value: sourceLabel(sample.source_id),
      basis: "measured",
      ...(finder && { title: `Finder: ${finder}` }),
    });
    rows.push({
      label: "Estimate",
      value: estimateLabel(sample.estimate_type),
      basis: "measured",
    });
    rows.push({
      label: "Updated",
      value: formatAge(tUs - sample.t_us),
      basis: "derived",
      title: `Last update at ${formatTime(sample.t_us)}`,
    });
    if (sample.confidence !== null) {
      rows.push({
        label: "Confidence",
        value: sample.confidence.toFixed(2),
        basis: "measured",
      });
    }
    if (at.position) {
      rows.push({
        label: "Position",
        value: formatPosition(at.position),
        basis: "measured",
        title: "Meters: x forward, y left, z up from the table corner",
      });
    }
    if (options.flagsRecorded && at.lost) {
      rows.push({ label: null, value: "Position lost", basis: "measured" });
    }
    if (!at.rotation) {
      rows.push({
        label: null,
        value: "Orientation unknown",
        basis: "measured",
      });
    }
  }
  const span = heldSpanAt(capture, entityId, tUs);
  if (span) {
    const by = span.hand ? HAND_LABEL[span.hand] : "Hand unknown";
    rows.push({
      label: "Held",
      value: span.origin === "inferred" ? `${by}, inferred from pinch` : by,
      basis: span.origin === "inferred" ? "inferred" : "measured",
      title: `Since ${formatTime(span.startUs)}`,
    });
  }
  // What a tracker or identifier last said about the camera image. A
  // predicted box was carried forward without being seen.
  const observed = observationAt(observationsFor(capture, entityId), tUs);
  if (observed) {
    const track =
      observed.trackId === null ? "" : `, track ${observed.trackId}`;
    rows.push({
      label: "Camera",
      value: `${OBSERVED[observed.status]} at ${formatTime(observed.availableUs)}`,
      basis: observed.status === "predicted" ? "inferred" : "measured",
      title: `${observed.source}${track}, frame at ${formatTime(observed.observedUs)}`,
    });
  }
  const answer = answerAt(marks, tUs);
  if (answer) {
    rows.push({
      label: "Detector",
      value: `${answer.found ? "Found" : "Not found"} at ${formatTime(answer.availableUs)}`,
      basis: "measured",
      title: `Finder: ${answer.source}`,
    });
    rows.push({
      label: "Latency",
      value: formatSeconds(answer.availableUs - answer.observedUs),
      basis: "derived",
      title: `Camera frame at ${formatTime(answer.observedUs)}`,
    });
    if (answer.found) {
      rows.push({
        label: "Answer confidence",
        value: answer.confidence.toFixed(2),
        basis: "measured",
      });
    }
  }
  return { entityId, label: entity.name, rows };
}

/** One line of the event list. */
export interface EventRow {
  key: string;
  tUs: number;
  kind: LogKind | "held";
  label: string;
  text: string;
  /** The viewer's guess (an inferred held span), not something recorded. */
  inferred: boolean;
}

const usOf = (ms: number) => Math.round(ms * 1000);

/**
 * The event list: the lesson, step, mistake, coach and finder events the
 * headset viewer lists (event-log.ts), with objects named by their display
 * names, plus pick-ups and put-downs from the held spans of drawn objects.
 * In time order.
 */
export function eventRows(capture: Capture): EventRow[] {
  const nameOf = (id: string) => capture.entities.get(id)?.name ?? id;
  const rows: EventRow[] = [];
  clioEvents(capture).forEach((e: EpisodeEvent, i) => {
    const entry = logEntry(e);
    if (!entry) return;
    const text =
      e.type === "object.detected"
        ? `${nameOf(e.objectId)} ${e.found ? "found" : "not found"}`
        : entry.text;
    rows.push({
      key: `e${i}`,
      tUs: usOf(e.t),
      kind: entry.kind,
      label: entry.label,
      text,
      inferred: false,
    });
  });
  for (const entity of drawnObjects(capture)) {
    for (const span of capture.heldSpans(entity.id)) {
      const by = span.hand ? ` by ${HAND_LABEL[span.hand].toLowerCase()}` : "";
      const inferred = span.origin === "inferred";
      const key = `${entity.id}@${span.startUs}`;
      rows.push({
        key: `${key}+`,
        tUs: span.startUs,
        kind: "held",
        label: "Held",
        text: `${entity.name} picked up${by}`,
        inferred,
      });
      if (span.endUs !== null) {
        rows.push({
          key: `${key}-`,
          tUs: span.endUs,
          kind: "held",
          label: "Held",
          text: `${entity.name} put down`,
          inferred,
        });
      }
    }
  }
  // Stable: events at one time keep their recorded order.
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => a.row.tUs - b.row.tUs || a.i - b.i)
    .map(({ row }) => row);
}

/** The index of the last row at or before `tUs`, or -1. */
export function currentRowIndex(
  rows: readonly EventRow[],
  tUs: number,
): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((rows[mid] as EventRow).tUs <= tUs) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** The step running at `tUs`, numbered from 1, with the lesson's step count. */
export interface StepInfo {
  number: number;
  count: number | null;
  instruction: string;
  startUs: number;
}

export function stepInfoAt(capture: Capture, tUs: number): StepInfo | null {
  const step = stepAt(capture, tUs);
  if (!step) return null;
  let count: number | null = null;
  for (const e of clioEvents(capture)) {
    if (e.t > step.t) break;
    if (e.type === "procedure.started") count = e.stepCount;
  }
  return {
    number: step.index + 1,
    count,
    instruction: step.instruction,
    startUs: usOf(step.t),
  };
}

/**
 * Batches the server does not have: what the headset says it sent minus what
 * arrived once finished, else the holes below the newest sequence number.
 */
export function missingBatches(batches: BatchIntegrity | null): number {
  if (!batches) return 0;
  if (batches.sent !== null)
    return Math.max(0, batches.sent - batches.received);
  return batches.gaps.length;
}
