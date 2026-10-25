import {
  type EpisodeCreate,
  type EpisodeEvent,
  EpisodeEventSchema,
  type EpisodeOutcome,
  type FrameRecord,
  type ObjectObservation,
  ObjectObservationSchema,
  type ObjectState,
  ObjectStateSchema,
  type ObjectTrackRecord,
} from '@clio/protocol';
import type { Clock } from '../../core/clock';
import { type AppBus, isRecordable } from '../events';
import type { TrackedFrame } from '../hands/types';
import {
  qTime,
  quantizeEvent,
  quantizeObject,
  quantizeObservation,
  toFrameRecord,
} from './quantize';
import type { EpisodeSink } from './sink';
import { EpisodeUploader } from './uploader';

// Records one episode at a time: every XR frame (frames channel), every recordable bus event
// (events channel), every object-estimate change (objects channel) and every 2D object observation
// (observations channel), all rebased onto the episode's start time. Batches are cut by size or
// age and handed to an EpisodeUploader, and so are the media files attached to the episode (the
// room scan's GLBs, the keyframes' JPEGs), in the order they come.

export interface RecorderDeps {
  bus: AppBus;
  clock: Clock;
  sink: EpisodeSink;
  /** Frames per batch (default 90, about one second). */
  batchFrames?: number;
  /** Maximum batch age in ms (default 1000). */
  batchIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onDrop?: (why: string) => void;
}

export interface EpisodeTotals {
  stepsCompleted: number;
  stepsTotal: number;
}

export class EpisodeRecorder {
  private uploader: EpisodeUploader | null = null;
  private startT = 0;
  private lastFlushT = 0;
  private seq = 0;
  private frames: FrameRecord[] = [];
  private events: EpisodeEvent[] = [];
  private objects: ObjectTrackRecord[] = [];
  private observations: ObjectObservation[] = [];
  private unsubscribe: (() => void)[] = [];

  constructor(private readonly deps: RecorderDeps) {}

  get recording(): boolean {
    return this.uploader !== null;
  }

  get episodeId(): string | null {
    return this.uploader?.episodeId ?? null;
  }

  start(meta: Omit<EpisodeCreate, 'clock'>, t: number): void {
    if (this.uploader) throw new Error('Already recording an episode');
    const { bus, clock, sink } = this.deps;
    this.startT = t;
    this.lastFlushT = t;
    this.seq = 0;
    this.frames = [];
    this.events = [];
    this.objects = [];
    this.observations = [];
    const options = {
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
      ...(this.deps.onDrop ? { onDrop: this.deps.onDrop } : {}),
    };
    this.uploader = new EpisodeUploader(
      sink,
      { ...meta, clock: { timeline: 'performance.now', startEpochMs: clock.epochMs(t) } },
      options,
    );
    this.unsubscribe = [
      bus.onAny((type, payload) => {
        if (isRecordable(type)) this.recordEvent(type, payload as { t: number });
      }),
      bus.on('objects.updated', ({ t: at, objects }) => this.recordObjects(at, objects)),
      bus.on('objects.observed', ({ observation }) => this.recordObservation(observation)),
    ];
    this.status(t);
  }

  recordFrame(frame: TrackedFrame): void {
    if (!this.uploader) return;
    this.frames.push(toFrameRecord(frame, this.startT));
    const maxFrames = this.deps.batchFrames ?? 90;
    const maxAge = this.deps.batchIntervalMs ?? 1000;
    if (this.frames.length >= maxFrames || frame.t - this.lastFlushT >= maxAge) this.flush(frame.t);
  }

  /**
   * Uploads a file to the episode's media/<name>, after what was handed over before it. Nothing
   * happens while not recording. The event that names the file is recorded on the bus as usual.
   */
  attachMedia(name: string, body: Blob): void {
    this.uploader?.media(name, body);
  }

  async stop(outcome: EpisodeOutcome, totals: EpisodeTotals, t: number): Promise<void> {
    const uploader = this.uploader;
    if (!uploader) return;
    this.flush(t);
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.uploader = null;
    const done = uploader.finish({
      durationMs: qTime(t - this.startT),
      outcome,
      stepsCompleted: totals.stepsCompleted,
      stepsTotal: totals.stepsTotal,
      batches: this.seq,
    });
    this.status(t);
    await done;
  }

  private recordEvent(type: EpisodeEvent['type'], payload: { t: number }): void {
    const parsed = EpisodeEventSchema.safeParse(quantizeEvent(type, payload, this.startT));
    if (parsed.success) this.events.push(parsed.data);
    else this.deps.onDrop?.(`event ${type}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }

  /** Each state validated like an event, so one malformed state cannot get a batch rejected. */
  private recordObjects(at: number, objects: readonly ObjectState[]): void {
    const valid: ObjectState[] = [];
    for (const o of objects) {
      const parsed = ObjectStateSchema.safeParse(quantizeObject(o, this.startT, at));
      if (parsed.success) valid.push(parsed.data);
      else this.deps.onDrop?.(`object ${o.id}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    }
    if (valid.length > 0) this.objects.push({ t: qTime(at - this.startT), objects: valid });
  }

  /** Validated like an event, so one malformed observation cannot get a whole batch rejected. */
  private recordObservation(observation: ObjectObservation): void {
    const parsed = ObjectObservationSchema.safeParse(quantizeObservation(observation, this.startT));
    if (parsed.success) this.observations.push(parsed.data);
    else {
      const why = parsed.error.issues[0]?.message ?? 'invalid';
      this.deps.onDrop?.(`observation ${observation.objectId}: ${why}`);
    }
  }

  private flush(t: number): void {
    this.lastFlushT = t;
    if (!this.uploader) return;
    if (
      this.frames.length === 0 &&
      this.events.length === 0 &&
      this.objects.length === 0 &&
      this.observations.length === 0
    )
      return;
    this.uploader.push({
      seq: this.seq++,
      frames: this.frames,
      events: this.events,
      objects: this.objects,
      observations: this.observations,
    });
    this.frames = [];
    this.events = [];
    this.objects = [];
    this.observations = [];
  }

  private status(t: number): void {
    this.deps.bus.emit('recorder.status', {
      t,
      recording: this.recording,
      episodeId: this.episodeId,
      queued: this.uploader?.queued ?? 0,
    });
  }
}
