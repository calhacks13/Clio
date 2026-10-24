import {
  type EpisodeCreate,
  type EpisodeEvent,
  EpisodeEventSchema,
  type EpisodeOutcome,
  type FrameRecord,
  type ObjectTrackRecord,
} from '@clio/protocol';
import type { Clock } from '../../core/clock';
import { type AppBus, isRecordable } from '../events';
import type { TrackedFrame } from '../hands/types';
import { qTime, quantizeObject, toFrameRecord } from './quantize';
import type { EpisodeSink } from './sink';
import { EpisodeUploader } from './uploader';

// Records one episode at a time: every XR frame (frames channel), every recordable bus event
// (events channel) and every object-estimate change (objects channel), all rebased onto the
// episode's start time. Batches are cut by size or age and handed to an EpisodeUploader.

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
  private unsubscribe: (() => void)[] = [];

  constructor(private readonly deps: RecorderDeps) {}

  get recording(): boolean {
    return this.uploader !== null;
  }

  get episodeId(): string | null {
    return this.uploader?.episodeId ?? null;
  }

  start(meta: EpisodeCreate, t: number): void {
    if (this.uploader) throw new Error('Already recording an episode');
    const { bus, clock, sink } = this.deps;
    this.startT = t;
    this.lastFlushT = t;
    this.seq = 0;
    this.frames = [];
    this.events = [];
    this.objects = [];
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
      bus.on('objects.updated', ({ t: at, objects }) => {
        if (objects.length > 0) {
          this.objects.push({ t: qTime(at - this.startT), objects: objects.map(quantizeObject) });
        }
      }),
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
    const candidate = { ...payload, type, t: qTime(payload.t - this.startT) };
    const parsed = EpisodeEventSchema.safeParse(candidate);
    if (parsed.success) this.events.push(parsed.data);
    else this.deps.onDrop?.(`event ${type}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }

  private flush(t: number): void {
    this.lastFlushT = t;
    if (!this.uploader) return;
    if (this.frames.length === 0 && this.events.length === 0 && this.objects.length === 0) return;
    this.uploader.push({
      seq: this.seq++,
      frames: this.frames,
      events: this.events,
      objects: this.objects,
    });
    this.frames = [];
    this.events = [];
    this.objects = [];
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
