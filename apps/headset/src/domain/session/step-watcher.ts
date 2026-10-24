import type {
  ImagePayload,
  ObjectSpec,
  Step,
  StepCheckObject,
  StepCheckRequest,
  StepCheckResponse,
} from '@clio/protocol';
import type { Clock } from '../../core/clock';
import type { AppBus } from '../events';
import { findWords } from '../world/find-words';

// The coach's second pair of eyes. Gemini Live only takes a turn when the learner speaks, so a
// step finished in silence would go unnoticed. While a step waits and nobody is talking, the
// watcher keeps showing fresh camera frames to a vision model, the next look starting a moment
// after the last answer. It sends the frame from when the step gained focus too, so the model
// compares the start with now, and it says what the step's objects look like and which mistakes
// look like success, so a look-alike (the milk for the yogurt drink) doesn't pass.
//
// When the step looks done, or the learner seems to have done something else, a few answers in a
// row, the coach is told and decides; the watcher never completes a step. It sees only the
// camera, never the tracker. Every answer is recorded as a `step.watch` annotation.

/** Port: judges one step from camera views (the server's /api/plans/check). */
export interface StepChecker {
  check(request: StepCheckRequest): Promise<StepCheckResponse>;
}

/** Port: fresh camera views, newest last. */
export interface WatchFrameSource {
  snapshots(max: number): Promise<ImagePayload[]>;
}

export interface WatchTarget {
  /** Which lesson, so an answer never lands in the next one (steps can share ids). */
  lesson: number;
  goal: string;
  step: StepCheckRequest['step'];
  /** What the step's objects look like (at most 6). */
  objects?: StepCheckObject[];
  /** Mistakes that look like success (at most 4). */
  confusions?: string[];
}

export interface StepWatcherOptions {
  /** The least time from one answer to the next look, and from a step's start to its first (ms). */
  gapMs?: number;
  /** Look only after this long with no speech from either side (ms). */
  quietMs?: number;
  /** Frames from when the step gained focus, sent with every look at it (0 sends none). */
  beforeFrames?: number;
  /** Answers in a row that must say "done" (or "did something else") before the coach hears it. */
  confirmations?: number;
  /** Don't tell the coach the same thing about a step again for this long (ms). */
  repeatMs?: number;
  /**
   * Answers in a row that must name a hazard. One: Robotics-ER names a hazard on only some looks
   * and invented none in our tests, and the coach sees the frame and warns only if it agrees.
   */
  hazardConfirmations?: number;
  /** Don't tell the coach about a hazard again for this long, whatever the step (ms). */
  hazardRepeatMs?: number;
  /** After this many failures in a row, pause for `pauseMs`. */
  maxFailures?: number;
  pauseMs?: number;
}

export interface StepWatcherDeps {
  bus: AppBus;
  clock: Clock;
  checker: StepChecker;
  frames: WatchFrameSource;
  /** The step to look at now, or null to stay idle. */
  target: () => WatchTarget | null;
  /** Whether a coach that can see is in charge (otherwise the watcher stays idle). */
  enabled: () => boolean;
  options?: StepWatcherOptions;
}

const DEFAULTS: Required<StepWatcherOptions> = {
  gapMs: 1000,
  quietMs: 1000,
  beforeFrames: 1,
  confirmations: 2,
  repeatMs: 20_000,
  hazardConfirmations: 1,
  hazardRepeatMs: 60_000,
  maxFailures: 3,
  pauseMs: 30_000,
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What an answer suggests, for counting answers in a row. */
type Finding = 'done' | 'wrong' | null;

function findingOf({ verdict, wrong }: StepCheckResponse): Finding {
  if (verdict === 'done') return 'done';
  return verdict === 'not_done' && wrong ? 'wrong' : null;
}

/** The step being watched. A new step (or lesson) starts a new one. */
interface Watch {
  key: string;
  /** Frames from when the step gained focus; filled in shortly after. */
  before: ImagePayload[];
  /** The last finding and how many answers in a row have had it. */
  finding: Finding;
  streak: number;
  /** When the coach was last told each finding about this step. */
  told: Partial<Record<'done' | 'wrong', number>>;
}

export class StepWatcher {
  private readonly o: Required<StepWatcherOptions>;
  private watch: Watch | null = null;
  /** The next look may start at this time. */
  private nextLookT = 0;
  private lastTalkT = Number.NEGATIVE_INFINITY;
  private inFlight = false;
  private failures = 0;
  private pausedUntil = Number.NEGATIVE_INFINITY;
  /** Answers in a row that named a hazard, and when the coach was last told of one. */
  private hazardStreak = 0;
  private hazardToldT = Number.NEGATIVE_INFINITY;
  private readonly off: () => void;

  constructor(private readonly deps: StepWatcherDeps) {
    this.o = { ...DEFAULTS, ...deps.options };
    this.off = deps.bus.on('coach.caption', ({ t }) => {
      this.lastTalkT = t;
    });
  }

  /**
   * Call every frame. Returns the work it started (the frames at a step's start, or a look), if
   * any, so the caller can track it.
   */
  tick(t: number): Promise<void> | null {
    const target = this.deps.enabled() ? this.deps.target() : null;
    if (!target) {
      this.watch = null;
      return null;
    }
    const key = `${target.lesson}:${target.step.id}`;
    if (key !== this.watch?.key) {
      const watch: Watch = { key, before: [], finding: null, streak: 0, told: {} };
      this.watch = watch;
      this.nextLookT = t + this.o.gapMs;
      return this.o.beforeFrames > 0 ? this.captureStart(watch) : null;
    }
    if (this.inFlight || t < this.pausedUntil || t < this.nextLookT) return null;
    if (t - this.lastTalkT < this.o.quietMs) return null;
    const told = this.watch.told.done;
    if (told !== undefined && t - told < this.o.repeatMs) return null;
    this.inFlight = true;
    const watch = this.watch;
    return this.look(target, watch).finally(() => {
      this.inFlight = false;
      this.nextLookT = this.deps.clock.now() + this.o.gapMs;
    });
  }

  stop(): void {
    this.off();
  }

  /** The step just gained focus: keep how it looks now, to compare with later. */
  private async captureStart(watch: Watch): Promise<void> {
    try {
      watch.before = await this.deps.frames.snapshots(this.o.beforeFrames);
    } catch {
      // Looks still go ahead, judged on the frames from now alone.
    }
  }

  private async look(target: WatchTarget, watch: Watch): Promise<void> {
    const { bus, clock, checker, frames } = this.deps;
    let images: ImagePayload[];
    try {
      images = await frames.snapshots(1);
    } catch {
      images = [];
    }
    if (images.length === 0) return;
    let answer: StepCheckResponse;
    try {
      answer = await checker.check(this.request(target, watch, images));
    } catch (err) {
      if (this.deps.target()?.lesson !== target.lesson) return;
      if (++this.failures >= this.o.maxFailures) {
        this.failures = 0;
        this.pausedUntil = clock.now() + this.o.pauseMs;
      }
      bus.emit('annotation', {
        t: clock.now(),
        label: 'step.watch',
        data: { stepId: target.step.id, error: errorText(err) },
      });
      return;
    }
    this.failures = 0;
    const now = this.deps.target();
    // That lesson is over: its recording has stopped and the answer belongs to no step now.
    if (now?.lesson !== target.lesson) return;
    const t = clock.now();
    bus.emit('annotation', { t, label: 'step.watch', data: watchData(target, answer) });
    this.noteHazard(t, target, answer, images);
    // The step may have finished or changed while the model looked.
    if (now.step.id !== target.step.id || this.watch !== watch) return;
    const finding = findingOf(answer);
    watch.streak = finding !== null && finding === watch.finding ? watch.streak + 1 : 1;
    watch.finding = finding;
    if (finding === null || watch.streak < this.o.confirmations) return;
    const told = watch.told[finding];
    if (told !== undefined && t - told < this.o.repeatMs) return;
    watch.told[finding] = t;
    watch.streak = 0;
    const image = images.at(-1)?.data ?? null;
    const { observation } = answer;
    if (finding === 'done') {
      bus.emit('step.looks_done', { t, stepId: target.step.id, observation, image });
    } else {
      const wrong = answer.wrong ?? '';
      bus.emit('step.looks_wrong', { t, stepId: target.step.id, wrong, observation, image });
    }
  }

  /**
   * A hazard in view, named by enough answers in a row, goes to the coach whatever the step,
   * then not again for `hazardRepeatMs`: a warning, not a nag.
   */
  private noteHazard(
    t: number,
    target: WatchTarget,
    answer: StepCheckResponse,
    images: ImagePayload[],
  ): void {
    if (!answer.hazard) {
      this.hazardStreak = 0;
      return;
    }
    if (++this.hazardStreak < this.o.hazardConfirmations) return;
    if (t - this.hazardToldT < this.o.hazardRepeatMs) return;
    this.hazardToldT = t;
    this.hazardStreak = 0;
    const image = images.at(-1)?.data ?? null;
    this.deps.bus.emit('step.hazard', { t, stepId: target.step.id, hazard: answer.hazard, image });
  }

  private request(target: WatchTarget, watch: Watch, images: ImagePayload[]): StepCheckRequest {
    const { goal, step, objects, confusions } = target;
    return {
      goal,
      step,
      images,
      ...(watch.before.length ? { before: watch.before } : {}),
      ...(objects?.length ? { objects } : {}),
      ...(confusions?.length ? { confusions } : {}),
    };
  }
}

/** The step check takes at most this many objects and mistakes (StepCheckRequestSchema). */
const MAX_OBJECTS = 6;
const MAX_CONFUSIONS = 4;

/**
 * What the watcher says about a step besides its text: what its objects look like (what it
 * shows first, then its other targets, each by its outline description, else its detector
 * query, else its name) and its mistake rules' messages, as mix-ups that look like success.
 */
export function stepLooks(
  step: Step,
  objects: readonly ObjectSpec[],
): Pick<WatchTarget, 'objects' | 'confusions'> {
  const specs = new Map(objects.map((o) => [o.id, o]));
  const looks = new Map<string, string>();
  for (const item of step.show) {
    if (!looks.has(item.object)) looks.set(item.object, item.description);
  }
  for (const id of step.targets) {
    const spec = specs.get(id);
    if (spec && !looks.has(id)) looks.set(id, findWords(spec));
  }
  const described: StepCheckObject[] = [...looks]
    .filter(([id]) => specs.get(id)?.hidden !== true)
    .slice(0, MAX_OBJECTS)
    .map(([id, look]) => ({ id, label: specs.get(id)?.label ?? id, look: look.slice(0, 300) }));
  const confusions = step.mistakes
    .map((m) => m.message.trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, MAX_CONFUSIONS);
  return {
    ...(described.length ? { objects: described } : {}),
    ...(confusions.length ? { confusions } : {}),
  };
}

/** What the annotation records of one answer: never the frames. */
function watchData(target: WatchTarget, answer: StepCheckResponse): Record<string, unknown> {
  const { verdict, observation, model, latencyMs, progress, wrong, evidence, hazard } = answer;
  return {
    stepId: target.step.id,
    verdict,
    observation,
    model,
    latencyMs,
    ...(progress === undefined ? {} : { progress }),
    ...(wrong ? { wrong } : {}),
    ...(evidence ? { evidence } : {}),
    ...(hazard ? { hazard } : {}),
  };
}
