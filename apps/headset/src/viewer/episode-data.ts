import {
  type EpisodeEvent,
  type EpisodeEventOf,
  EpisodeEventSchema,
  type EpisodeMeta,
  type FrameRecord,
  HAND_SAMPLE_LENGTH,
  type ObjectState,
  ObjectTrackRecordSchema,
  type Pose7,
  type Quat,
  type Vec3,
} from '@clio/protocol';

// The viewer's model of one episode: records parsed from NDJSON chunks as they arrive, and the
// lookups the page makes every animation frame (frame at t, objects at t, events up to t). Pure:
// no DOM, fetch or three.js, so it is unit-tested in Node.

/** Splits NDJSON byte (or text) chunks into parsed records. A line cut between chunks waits. */
export class NdjsonDecoder {
  #rest = '';
  readonly #text = new TextDecoder();
  /** Lines that were not valid JSON, skipped. */
  corrupt = 0;

  push(chunk: Uint8Array | string): unknown[] {
    const text =
      this.#rest + (typeof chunk === 'string' ? chunk : this.#text.decode(chunk, { stream: true }));
    const lines = text.split('\n');
    this.#rest = lines.pop() ?? '';
    const records: unknown[] = [];
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        this.corrupt++;
      }
    }
    return records;
  }
}

interface Timed {
  t: number;
}

/** Index of the first item with `t` greater than `t` (items sorted by t). */
export function upperBound(items: readonly Timed[], t: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((items[mid] as Timed).t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The last item at or before `t`, or null when every item is later. */
export function atOrBefore<T extends Timed>(items: readonly T[], t: number): T | null {
  return items[upperBound(items, t) - 1] ?? null;
}

/** Inserts in t order, after equal times. In-order data (the normal case) is a plain push. */
export function insertByTime<T extends Timed>(items: T[], item: T): void {
  const last = items.at(-1);
  if (!last || last.t <= item.t) items.push(item);
  else items.splice(upperBound(items, item.t), 0, item);
}

/** One object as it stood at some time: its placement, plus the newest tracker estimate. */
export interface ObjectView {
  id: string;
  label: string;
  radius: number;
  position: Vec3;
  /** Unknown (null) unless a marker tracker measured it; never filled with identity. */
  orientation: Quat | null;
  confidence: number;
  source: ObjectState['source'];
  /** When the estimate shown was recorded, or null for the placement at episode start. */
  updatedT: number | null;
}

export type StepEntered = EpisodeEventOf<'step.entered'>;
export type Detection = EpisodeEventOf<'object.detected'>;

interface Estimate {
  t: number;
  state: ObjectState;
}

const DEFAULT_RADIUS = 0.03;

/** A frame line is validated at ingest; a full parse of every hand sample is too slow here. */
function isFrame(value: unknown): value is FrameRecord {
  const f = value as Partial<FrameRecord> | null;
  const hand = (h: unknown) =>
    h === null ||
    (Array.isArray((h as { joints?: unknown }).joints) &&
      (h as { joints: unknown[] }).joints.length === HAND_SAMPLE_LENGTH);
  return (
    typeof f?.t === 'number' &&
    Array.isArray(f.head) &&
    f.head.length === 7 &&
    hand(f.left) &&
    hand(f.right)
  );
}

export class EpisodeData {
  readonly frames: FrameRecord[] = [];
  readonly events: EpisodeEvent[] = [];
  readonly #estimates = new Map<string, Estimate[]>();
  readonly #labels = new Map<string, { label: string; radius: number }>();
  #objectsEndT = 0;
  /** Lines that did not match the protocol, skipped. */
  rejected = 0;

  constructor(readonly meta: EpisodeMeta) {
    for (const o of meta.plan?.objects ?? []) {
      this.#labels.set(o.id, { label: o.label, radius: o.radius ?? DEFAULT_RADIUS });
    }
    for (const o of meta.objects) this.#labels.set(o.id, { label: o.label, radius: o.radius });
  }

  addFrames(records: readonly unknown[]): void {
    for (const r of records) {
      if (isFrame(r)) insertByTime(this.frames, r);
      else this.rejected++;
    }
  }

  addEvents(records: readonly unknown[]): void {
    for (const r of records) {
      const parsed = EpisodeEventSchema.safeParse(r);
      if (parsed.success) insertByTime(this.events, parsed.data);
      else this.rejected++;
    }
  }

  addObjects(records: readonly unknown[]): void {
    for (const r of records) {
      const parsed = ObjectTrackRecordSchema.safeParse(r);
      if (!parsed.success) {
        this.rejected++;
        continue;
      }
      const { t, objects } = parsed.data;
      this.#objectsEndT = Math.max(this.#objectsEndT, t);
      for (const state of objects) {
        const history = this.#estimates.get(state.id) ?? [];
        if (history.length === 0) this.#estimates.set(state.id, history);
        insertByTime(history, { t, state });
      }
    }
  }

  /** The newest recorded time across every channel, in ms since the episode started. */
  get endT(): number {
    return Math.max(this.frames.at(-1)?.t ?? 0, this.events.at(-1)?.t ?? 0, this.#objectsEndT);
  }

  get lastFrameT(): number | null {
    return this.frames.at(-1)?.t ?? null;
  }

  frameAt(t: number): FrameRecord | null {
    return atOrBefore(this.frames, t);
  }

  /** Every event at or before `t`, in time order. */
  eventsUntil(t: number): EpisodeEvent[] {
    return this.events.slice(0, upperBound(this.events, t));
  }

  /** The step running at `t`: the last step entered at or before it. */
  stepAt(t: number): StepEntered | null {
    for (let i = upperBound(this.events, t) - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e?.type === 'step.entered') return e;
    }
    return null;
  }

  /**
   * Placements from meta.objects, each replaced by its newest tracker estimate at or before t.
   * Rebuilt from the start on every call, so seeking backward never keeps a later pose.
   */
  objectsAt(t: number): ObjectView[] {
    const views = new Map<string, ObjectView>();
    for (const o of this.meta.objects) {
      views.set(o.id, {
        id: o.id,
        label: o.label,
        radius: o.radius,
        position: [...o.position],
        orientation: null,
        confidence: 1,
        source: o.method,
        updatedT: null,
      });
    }
    for (const [id, history] of this.#estimates) {
      const estimate = atOrBefore(history, t);
      if (!estimate) continue;
      const known = this.#labels.get(id);
      views.set(id, {
        id,
        label: known?.label ?? id,
        radius: known?.radius ?? DEFAULT_RADIUS,
        position: [...estimate.state.position],
        orientation: estimate.state.orientation ? [...estimate.state.orientation] : null,
        confidence: estimate.state.confidence,
        source: estimate.state.source,
        updatedT: estimate.t,
      });
    }
    return [...views.values()];
  }

  /** The newest object-finder answer per object at or before `t`, oldest first. */
  detectionsAt(t: number): Detection[] {
    const latest = new Map<string, Detection>();
    for (const e of this.eventsUntil(t))
      if (e.type === 'object.detected') latest.set(e.objectId, e);
    return [...latest.values()];
  }

  /** Head positions over the `windowMs` before `t`, thinned to at most `maxPoints`. */
  headTrail(t: number, windowMs: number, maxPoints = 120): Vec3[] {
    const end = upperBound(this.frames, t);
    const start = upperBound(this.frames, t - windowMs);
    const stride = Math.max(1, Math.ceil((end - start) / maxPoints));
    const points: Vec3[] = [];
    for (let i = start; i < end; i += stride) {
      const head = (this.frames[i] as FrameRecord).head;
      points.push([head[0], head[1], head[2]]);
    }
    const last = this.frames[end - 1];
    if (last && (end - 1 - start) % stride !== 0) {
      points.push([last.head[0], last.head[1], last.head[2]]);
    }
    return points;
  }

  /** Where the head was when a detection's camera frame was captured. */
  headAtCapture(detection: Detection): Pose7 | null {
    return this.frameAt(detection.t - detection.latencyMs)?.head ?? null;
  }
}

/** The span the timeline covers: up to the finish when there is one, else the newest record. */
export function episodeDuration(data: EpisodeData, finishedMs: number | null): number {
  return Math.max(data.endT, finishedMs ?? 0);
}

/**
 * Whether an unfinished episode is still being recorded: its newest record is recent by the wall
 * clock (`startEpochMs` is the headset's clock at t = 0; a few seconds of skew are fine).
 */
export function isRecording(meta: EpisodeMeta, endT: number, nowMs: number, freshMs = 15_000) {
  return nowMs - (meta.clock.startEpochMs + endT) < freshMs;
}

/** `m:ss.s` for a time in ms. */
export function formatClock(ms: number): string {
  const tenths = Math.max(0, Math.floor(ms / 100));
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}
