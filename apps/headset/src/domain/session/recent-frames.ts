import type { ImagePayload } from '@clio/protocol';
import type { Clock } from '../../core/clock';
import type { PlanImageSource } from './lesson-controller';

// Recent planning frames. The planner sees two camera frames taken 0.4 s apart, so they don't show
// the same instant, and taking them fresh holds start_lesson up by that long. While a lesson may be
// about to start, this keeps the last two, one every ~450 ms, so start_lesson can send frames it
// already has. A frame older than ~1 s is not used; when it has too few recent ones it tops them
// up from the camera at once, and with none it takes the camera's own, as before. Only planning
// reads it: the step watcher needs frames from this moment.

export interface RecentFramesOptions {
  /** Keep a new frame this often while warm (ms). */
  everyMs?: number;
  /** Frames older than this are not used (ms). */
  maxAgeMs?: number;
  /** The most frames kept. */
  keep?: number;
}

/**
 * Where a call's frames came from: the buffer (topped up from the camera at once when short), the
 * camera alone, or nowhere (no frames).
 */
export type FramesFrom = 'buffered' | 'fresh' | 'none';

const DEFAULTS: Required<RecentFramesOptions> = { everyMs: 450, maxAgeMs: 1000, keep: 2 };

export class RecentFrames implements PlanImageSource {
  private readonly o: Required<RecentFramesOptions>;
  private frames: { t: number; image: ImagePayload }[] = [];
  private nextT = Number.NEGATIVE_INFINITY;
  private inFlight = false;
  /** Bumped when the buffer goes cold, so a frame asked for before is not kept after. */
  private generation = 0;

  constructor(
    private readonly source: PlanImageSource,
    private readonly clock: Clock,
    options: RecentFramesOptions = {},
  ) {
    this.o = { ...DEFAULTS, ...options };
  }

  /**
   * Call every frame. While warm, keeps a new frame every everyMs; cold, it forgets them. Returns
   * the capture it started, if any.
   */
  tick(t: number, warm: boolean): Promise<void> | null {
    if (!warm) {
      if (this.frames.length > 0) this.frames = [];
      this.generation++;
      this.nextT = Number.NEGATIVE_INFINITY;
      return null;
    }
    if (this.inFlight || t < this.nextT) return null;
    this.inFlight = true;
    return this.keep(this.generation);
  }

  /** Up to `max` frames, newest last, and where they came from. */
  async take(max: number): Promise<{ images: ImagePayload[]; from: FramesFrom }> {
    if (max <= 0) return { images: [], from: 'none' };
    const now = this.clock.now();
    const recent = this.frames
      .filter((f) => now - f.t <= this.o.maxAgeMs)
      .slice(-max)
      .map((f) => f.image);
    if (recent.length === 0) {
      const images = await this.source.snapshots(max);
      return { images, from: images.length > 0 ? 'fresh' : 'none' };
    }
    const more =
      recent.length < max ? await this.source.snapshots(max - recent.length).catch(() => []) : [];
    return { images: [...recent, ...more], from: 'buffered' };
  }

  snapshots(max: number): Promise<ImagePayload[]> {
    return this.take(max).then((r) => r.images);
  }

  private async keep(generation: number): Promise<void> {
    const t = this.clock.now();
    try {
      const [image] = await this.source.snapshots(1);
      if (image && generation === this.generation) {
        this.frames = [...this.frames, { t, image }].slice(-this.o.keep);
      }
    } catch {
      // A missed frame; the next one is due everyMs from now.
    } finally {
      this.inFlight = false;
      if (generation === this.generation) this.nextT = this.clock.now() + this.o.everyMs;
    }
  }
}
