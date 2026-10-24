import type {
  ImagePayload,
  ObjectSpec,
  Step,
  StepCheckCriterion,
  StepCheckObject,
  StepCheckRequest,
  StepCheckResponse,
  StepCriteriaRequest,
  StepCriteriaResponse,
} from '@clio/protocol';
import type { Clock } from '../../core/clock';
import type { AppBus } from '../events';

// The coach's second pair of eyes. Gemini Live only takes a turn when the learner speaks, so a
// step finished in silence would go unnoticed. While a step waits and nobody is talking, the
// watcher keeps showing fresh camera frames to a vision model, the next look starting a moment
// after the last answer. It sends the frame from when the step gained focus too, so the model
// compares the start with now, and it says what the step's objects look like and which mistakes
// look like success, so a look-alike (the milk for the yogurt drink) doesn't pass.
//
// When the step gains focus the watcher also asks, once, for the step's criteria: its done-when
// state split into things a camera can confirm ("cup B is blue-green", "cup C is still purple").
// Every look then judges each one, a done needs all of them, and the coach hears which are met.
//
// While the step looks far from done, one quick look at a time is enough: the model thinks less
// and answers sooner, only to notice a change. Once an answer says the step is close (its
// progress) or looks done or wrong, looks turn careful and a second one starts before the first
// answers, so a fresh answer arrives about every second instead of every two and a half. A look
// that finds something starts the next one at once, and only a careful answer can confirm it.
// Answers count in the order their looks started.
//
// When the step looks done, or the learner seems to have done something else, a few answers in a
// row, the coach is told and decides; the watcher never completes a step. It sees only the
// camera, never the tracker. Every answer is recorded as a `step.watch` annotation, and the
// criteria as `step.criteria`.

/** Port: judges one step from camera views (the server's /api/plans/check). */
export interface StepChecker {
  check(request: StepCheckRequest): Promise<StepCheckResponse>;
  /** The step's done-when as criteria (/api/plans/criteria); without it, looks go without. */
  criteria?(request: StepCriteriaRequest): Promise<StepCriteriaResponse>;
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
  /** Looks at once while the step is close to done (1 keeps them one after another). */
  parallel?: number;
  /** Quick looks while the step is far from done (careful ones otherwise). */
  quickLooks?: boolean;
  /** The least time between the starts of two looks in flight together (ms). */
  staggerMs?: number;
  /** An answer with at least this progress (or a done or wrong) means the step is close. */
  nearProgress?: number;
  /** Ask for the step's criteria when it gains focus (if the checker can). */
  criteria?: boolean;
  /** Looks wait for the criteria at most this long after the step gains focus (ms). */
  criteriaWaitMs?: number;
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
  parallel: 2,
  quickLooks: true,
  staggerMs: 1000,
  nearProgress: 50,
  criteria: true,
  criteriaWaitMs: 4000,
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
  /** When the step gained focus. */
  since: number;
  /** Frames from when the step gained focus; filled in shortly after. */
  before: ImagePayload[];
  /** The step's criteria, once asked; empty without them. */
  criteria: string[];
  /** The frames and the criteria have been asked for (whatever came of it). */
  started: boolean;
  /** Looks started on this step, and the latest one whose answer counted. */
  looks: number;
  counted: number;
  /** The last answer said the step is close to done: keep a second look in flight. */
  near: boolean;
  /** The last finding and how many answers in a row have had it. */
  finding: Finding;
  streak: number;
  /** When the coach was last told each finding about this step. */
  told: Partial<Record<'done' | 'wrong', number>>;
}

export class StepWatcher {
  private readonly o: Required<StepWatcherOptions>;
  private watch: Watch | null = null;
  /** The next look may start at this time when none is in flight. */
  private nextLookT = 0;
  private lastStartT = Number.NEGATIVE_INFINITY;
  private lastTalkT = Number.NEGATIVE_INFINITY;
  private inFlight = 0;
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
   * Call every frame. Returns the work it started (the step's start, or a look), if any, so the
   * caller can track it. Starts at most one look per call.
   */
  tick(t: number): Promise<void> | null {
    const target = this.deps.enabled() ? this.deps.target() : null;
    if (!target) {
      this.watch = null;
      return null;
    }
    const key = `${target.lesson}:${target.step.id}`;
    if (key !== this.watch?.key) {
      const watch: Watch = {
        key,
        since: t,
        before: [],
        criteria: [],
        started: false,
        looks: 0,
        counted: 0,
        near: false,
        finding: null,
        streak: 0,
        told: {},
      };
      this.watch = watch;
      this.nextLookT = t + this.o.gapMs;
      return this.startStep(target, watch);
    }
    const watch = this.watch;
    if (!this.mayLook(t, watch)) return null;
    this.inFlight++;
    this.lastStartT = t;
    const quick = this.o.quickLooks && !watch.near;
    return this.look(target, watch, ++watch.looks, quick).finally(() => {
      this.inFlight--;
    });
  }

  stop(): void {
    this.off();
  }

  private mayLook(t: number, watch: Watch): boolean {
    if (t < this.pausedUntil || t - this.lastTalkT < this.o.quietMs) return false;
    if (!watch.started && t - watch.since < this.o.criteriaWaitMs) return false;
    const told = watch.told.done;
    if (told !== undefined && t - told < this.o.repeatMs) return false;
    if (this.inFlight === 0) return t >= this.nextLookT;
    // A second look in flight only while the step is close, a little after the first started.
    return (
      watch.near &&
      this.inFlight < Math.max(1, this.o.parallel) &&
      t - this.lastStartT >= this.o.staggerMs
    );
  }

  /**
   * The step just gained focus: keep how it looks now, to compare with later, then ask once for
   * its criteria with that view.
   */
  private async startStep(target: WatchTarget, watch: Watch): Promise<void> {
    try {
      if (this.o.beforeFrames > 0) {
        try {
          watch.before = await this.deps.frames.snapshots(this.o.beforeFrames);
        } catch {
          // Looks still go ahead, judged on the frames from now alone.
        }
      }
      if (this.o.criteria && this.deps.checker.criteria) await this.askCriteria(target, watch);
    } finally {
      watch.started = true;
    }
  }

  private async askCriteria(target: WatchTarget, watch: Watch): Promise<void> {
    const { bus, clock, checker } = this.deps;
    const { goal, step, objects, confusions } = target;
    let answer: StepCriteriaResponse;
    try {
      answer = await (checker.criteria as NonNullable<StepChecker['criteria']>)({
        goal,
        step,
        ...(objects?.length ? { objects } : {}),
        ...(confusions?.length ? { confusions } : {}),
        ...(watch.before.length ? { images: watch.before } : {}),
      });
    } catch (err) {
      // Looks go ahead without criteria, judged on the done-when alone.
      if (this.deps.target()?.lesson === target.lesson) {
        const data = { stepId: step.id, error: errorText(err) };
        bus.emit('annotation', { t: clock.now(), label: 'step.criteria', data });
      }
      return;
    }
    if (this.deps.target()?.lesson !== target.lesson) return;
    watch.criteria = answer.criteria;
    bus.emit('annotation', {
      t: clock.now(),
      label: 'step.criteria',
      data: {
        stepId: step.id,
        criteria: answer.criteria,
        model: answer.model,
        latencyMs: answer.latencyMs,
      },
    });
  }

  private async look(target: WatchTarget, watch: Watch, n: number, quick: boolean): Promise<void> {
    const { bus, clock, checker, frames } = this.deps;
    let images: ImagePayload[];
    try {
      images = await frames.snapshots(1);
    } catch {
      images = [];
    }
    if (images.length === 0) {
      this.after(watch, clock.now());
      return;
    }
    let answer: StepCheckResponse;
    try {
      answer = await checker.check({
        ...this.request(target, watch, images),
        ...(quick ? { quick } : {}),
      });
    } catch (err) {
      this.after(watch, clock.now());
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
    const t = clock.now();
    // That lesson is over: its recording has stopped and the answer belongs to no step now.
    if (now?.lesson !== target.lesson) return;
    const data = { ...watchData(target, answer), ...(quick ? { quick } : {}) };
    bus.emit('annotation', { t, label: 'step.watch', data });
    this.noteHazard(t, target, answer, images);
    // The step may have finished or changed while the model looked.
    if (now.step.id !== target.step.id || this.watch !== watch) return;
    // A look that started before one already counted answered late: its frame is older.
    if (n < watch.counted) return;
    watch.counted = n;
    const finding = findingOf(answer);
    watch.near = finding !== null || (answer.progress ?? 0) >= this.o.nearProgress;
    // Something found: the look that could confirm it starts at once, not a gap later.
    this.nextLookT = finding === null ? t + this.o.gapMs : t;
    watch.streak = finding !== null && finding === watch.finding ? watch.streak + 1 : 1;
    watch.finding = finding;
    // A quick answer notices; the careful look it starts at once is the one that can confirm.
    if (finding === null || watch.streak < this.o.confirmations || quick) return;
    const told = watch.told[finding];
    if (told !== undefined && t - told < this.o.repeatMs) return;
    watch.told[finding] = t;
    watch.streak = 0;
    watch.near = false;
    const image = images.at(-1)?.data ?? null;
    const { observation, criteria } = answer;
    const judged = criteria?.length ? { criteria } : {};
    if (finding === 'done') {
      bus.emit('step.looks_done', { t, stepId: target.step.id, observation, image, ...judged });
    } else {
      const wrong = answer.wrong ?? '';
      bus.emit('step.looks_wrong', {
        t,
        stepId: target.step.id,
        wrong,
        observation,
        image,
        ...judged,
      });
    }
  }

  /** A look at the step being watched has ended without an answer: the next one waits a gap. */
  private after(watch: Watch, t: number): void {
    if (this.watch === watch) this.nextLookT = t + this.o.gapMs;
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
      ...(watch.criteria.length ? { criteria: watch.criteria } : {}),
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
    if (spec && !looks.has(id)) looks.set(id, spec.tracking?.query ?? spec.label);
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
  const { verdict, observation, model, latencyMs, progress, wrong, evidence, hazard, criteria } =
    answer;
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
    ...(criteria?.length ? { criteria: criteria.map(judgedCriterion) } : {}),
  };
}

const judgedCriterion = ({ text, met, seen }: StepCheckCriterion) => ({
  text,
  met,
  ...(seen ? { seen } : {}),
});
