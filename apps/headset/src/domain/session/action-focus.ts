import type {
  FocusAction,
  FocusDetection,
  FocusObject,
  FocusRequest,
  FocusResponse,
  ImagePayload,
  NormalizedBox,
} from '@clio/protocol';
import type { Clock } from '../../core/clock';
import type { LessonView } from '../coach/ports';
import type { AppBus } from '../events';
import type { LessonController } from './lesson-controller';
import type { LiveTracking } from './live-tracking';

// The action focus: Gemini Robotics-ER 2, at minimal thinking, looks at one sharp frame while a
// step is focused (POST /api/vision/focus). It boxes the objects the tracker follows and names the
// one thing the learner should touch next. jev, the tracker's finder, answers quickly but goes by
// words alone and often picks the wrong one of two; ER is slower and sees better. So its boxes go
// to the tracker as anchors that outrank jev's (tracker/TRACK.md), its words for each object
// become what jev is told about it (LiveTracking.refine), and its action item is lit for the rest
// of the step, declared by the lesson first when the plan never named it.
//
// It looks as a step is entered, then every few seconds while the step stays focused, and once
// more soon after the coach highlights something. One look at a time: a look for a step or a
// lesson that is over is dropped. Like the tracker's answers, its answers feed the learner's view
// (focus.answered) and the recording (a focus.answered annotation), never a Gemini coach
// (docs/coach-plan.md, the perception boundary).

/** Port: Robotics-ER 2's action focus (POST /api/vision/focus). */
export interface FocusFinder {
  focus(request: FocusRequest): Promise<FocusResponse>;
}

/** Port: one sharp current camera frame and when it was captured (performance.now ms). */
export interface FocusFrames {
  grab(): Promise<{ image: ImagePayload; t: number } | null>;
}

/** Port: where ER's boxes go: the live tracker, which follows the object from them. */
export interface FocusAnchors {
  anchor(anchor: FocusAnchor): void;
}

export interface FocusAnchor {
  id: string;
  box: NormalizedBox;
  /** Capture time of the frame ER saw (performance.now ms). */
  t: number;
  /** ER's words for the object, for jev from now on. */
  query?: string;
}

export interface ActionFocusOptions {
  /** How often to look while a step stays focused, from one look's start to the next (ms). */
  everyMs?: number;
  /** How soon after a coach highlight to look once more (ms). */
  afterHighlightMs?: number;
  /** The least confidence for a box to anchor the tracker and for its words to reach jev. */
  minConfidence?: number;
  /** After this many failed looks in a row, pause for `pauseMs` (no Gemini key: 503s). */
  maxFailures?: number;
  pauseMs?: number;
}

export interface ActionFocusDeps {
  bus: AppBus;
  clock: Clock;
  finder: FocusFinder;
  frames: FocusFrames;
  anchors: FocusAnchors;
  /** What the tracker follows, lit first (what ER is asked about), and where its words go. */
  tracking: Pick<LiveTracking, 'objects' | 'refine'>;
  /** The lesson's goal, plan and focused step (LessonController.view()). */
  view: LessonView;
  /** Declares an action item the plan lacks. */
  lesson: Pick<LessonController, 'declareObject'>;
  /** Whether to look now (e.g. only while the tracker is connected); always when left out. */
  enabled?: () => boolean;
  options?: ActionFocusOptions;
}

const DEFAULTS: Required<ActionFocusOptions> = {
  everyMs: 5000,
  afterHighlightMs: 500,
  minConfidence: 0.5,
  maxFailures: 3,
  pauseMs: 30_000,
};

/** The request's limits (FocusRequestSchema). */
const MAX_OBJECTS = 8;
const MAX_LABEL = 60;
const MAX_TEXT = 300;
const MAX_STEP_TEXT = 200;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const clip = (text: string, max: number) => text.trim().slice(0, max);
const key = (label: string) => label.trim().toLowerCase();

/** The step a look is for: which entry into it, so a look for a step that is over is dropped. */
interface Focused {
  stepId: string;
  entry: number;
}

export class ActionFocus {
  private readonly o: Required<ActionFocusOptions>;
  private focused: Focused | null = null;
  /** Bumped as a step is entered and as a lesson starts or ends. */
  private entry = 0;
  private looking = false;
  /** The next look may start at this time. */
  private nextT = Number.POSITIVE_INFINITY;
  private failures = 0;
  private pausedUntil = Number.NEGATIVE_INFINITY;
  /** Action items this lesson declared, by label, so one is declared once. */
  private readonly declared = new Map<string, string>();

  constructor(private readonly deps: ActionFocusDeps) {
    this.o = { ...DEFAULTS, ...deps.options };
  }

  attach(): () => void {
    const { bus } = this.deps;
    const offs = [
      bus.on('procedure.started', () => {
        this.declared.clear();
        this.end();
      }),
      bus.on('step.entered', ({ t, stepId }) => {
        this.focused = { stepId, entry: ++this.entry };
        this.nextT = t;
      }),
      // The coach pointed something out, often by words the plan didn't have: look again soon.
      bus.on('overlay.highlight', ({ t, source }) => {
        if (source === 'coach' && this.focused) {
          this.nextT = Math.min(this.nextT, t + this.o.afterHighlightMs);
        }
      }),
      bus.on('procedure.completed', () => this.end()),
      bus.on('procedure.aborted', () => this.end()),
    ];
    return () => {
      for (const off of offs) off();
    };
  }

  /**
   * Call every frame. Starts a look when one is due and none is in flight, and returns it so the
   * caller can track it.
   */
  tick(t: number): Promise<void> | null {
    const focused = this.focused;
    if (!focused || this.looking || t < this.nextT || t < this.pausedUntil) return null;
    if (this.deps.enabled && !this.deps.enabled()) return null;
    this.looking = true;
    this.nextT = t + this.o.everyMs;
    return this.look(focused).finally(() => {
      this.looking = false;
    });
  }

  /** No step is focused: no more looks, and the answers in flight are dropped. */
  private end(): void {
    this.focused = null;
    this.entry++;
    this.nextT = Number.POSITIVE_INFINITY;
  }

  private current(focused: Focused): boolean {
    return this.focused?.entry === focused.entry;
  }

  private async look(focused: Focused): Promise<void> {
    const { bus, clock, finder, frames } = this.deps;
    let frame: Awaited<ReturnType<FocusFrames['grab']>>;
    try {
      frame = await frames.grab();
    } catch {
      frame = null;
    }
    // No picture now: the next look is due as usual.
    if (!frame || !this.current(focused)) return;
    const request = this.request(focused.stepId, frame.image);
    if (!request) return;
    let answer: FocusResponse;
    try {
      answer = await finder.focus(request);
    } catch (err) {
      if (++this.failures >= this.o.maxFailures) {
        this.failures = 0;
        this.pausedUntil = clock.now() + this.o.pauseMs;
      }
      if (this.current(focused)) {
        const data = { stepId: focused.stepId, error: errorText(err) };
        bus.emit('annotation', { t: clock.now(), label: 'focus.answered', data });
      }
      return;
    }
    this.failures = 0;
    if (this.current(focused)) this.apply(focused.stepId, frame.t, request.objects, answer);
  }

  /** The goal, the step and what the tracker follows (lit first), or null without a step. */
  private request(stepId: string, image: ImagePayload): FocusRequest | null {
    const { tracking, view } = this.deps;
    const step = view.procedure()?.steps.find((s) => s.id === stepId);
    if (!step) return null;
    const goal = view.plan()?.goal;
    const objects = tracking.objects.slice(0, MAX_OBJECTS).map((o): FocusObject => {
      const label = clip(view.label(o.id), MAX_LABEL) || o.id;
      const phrase = clip(o.phrase, MAX_LABEL);
      return {
        id: o.id,
        label,
        ...(phrase ? { phrase } : {}),
        query: clip(o.query, MAX_TEXT) || label,
      };
    });
    return {
      image,
      ...(goal ? { goal: clip(goal, MAX_TEXT) } : {}),
      step: {
        instruction: clip(step.instruction, MAX_STEP_TEXT),
        ...(step.doneWhen ? { doneWhen: clip(step.doneWhen, MAX_STEP_TEXT) } : {}),
      },
      objects,
    };
  }

  /**
   * ER's sure boxes anchor the tracker and its words for them become jev's; its action item is lit
   * for the step (declared first when the plan lacks it). Then the answer goes out for the
   * displays and the recording.
   */
  private apply(
    stepId: string,
    frameT: number,
    asked: readonly FocusObject[],
    answer: FocusResponse,
  ): void {
    const { anchors, bus, clock, tracking } = this.deps;
    const ids = new Set(asked.map((o) => o.id));
    const anchored = new Set<string>();
    for (const d of answer.detections) {
      if (!ids.has(d.id) || !this.sure(d) || anchored.has(d.id)) continue;
      const query = d.description?.trim() || undefined;
      if (query) tracking.refine(d.id, query);
      if (d.box) {
        anchors.anchor({ id: d.id, box: d.box, t: frameT, ...(query ? { query } : {}) });
        anchored.add(d.id);
      }
    }
    const action = answer.action;
    const actionId = action ? this.actionItem(action, ids) : null;
    // ER boxed the action item but not as one of the objects asked about: a new object, or one
    // it found only as the thing to touch. Its words go to jev as well as to the tracker, or the
    // next set the tracker is sent would take them back.
    if (action && actionId && action.box && this.sure(action) && !anchored.has(actionId)) {
      const query = action.description.trim();
      if (query) tracking.refine(actionId, query);
      anchors.anchor({ id: actionId, box: action.box, t: frameT, ...(query ? { query } : {}) });
    }
    const t = clock.now();
    const { model, latencyMs, detections } = answer;
    bus.emit('focus.answered', {
      t,
      frameT,
      stepId,
      detections,
      action,
      actionId,
      model,
      latencyMs,
    });
    bus.emit('annotation', {
      t,
      label: 'focus.answered',
      data: {
        stepId,
        model,
        latencyMs,
        frameAgeMs: Math.max(0, t - frameT),
        detections,
        action,
        actionId,
      },
    });
  }

  private sure(d: Pick<FocusDetection, 'found' | 'confidence'>): boolean {
    return d.found && d.confidence >= this.o.minConfidence;
  }

  /**
   * The lesson object to light for ER's action: one of the lesson's, or a new one declared from
   * ER's words. A new one must be seen, surely, so a guess never joins the plan; each is declared
   * once a lesson.
   */
  private actionItem(action: FocusAction, asked: ReadonlySet<string>): string | null {
    const { lesson, view } = this.deps;
    const id = action.id;
    if (id !== null && (asked.has(id) || view.procedure()?.objects.some((o) => o.id === id))) {
      return id;
    }
    const label = key(action.label);
    const known = this.declared.get(label);
    if (known) return known;
    if (!this.sure(action)) return null;
    const declared = lesson.declareObject({ label: action.label, look: action.description });
    if (declared) this.declared.set(label, declared);
    return declared;
  }
}
