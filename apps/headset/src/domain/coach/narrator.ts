import type { CoachToolName, Procedure, StepCheckCriterion } from '@clio/protocol';
import type { AppBus, AppEvents } from '../events';
import { briefStep, recitePlan } from '../plan/recital';
import type { Narration } from './agent';
import type { LessonView } from './ports';

// Turns lesson events into short "[app]" messages for the model: the plan when it arrives, a
// briefing whenever a step takes focus, completions, the step watcher's suggestions, calls for
// help, and what happened on the learner's widgets (a timer ran out, they touched an answer or
// ticked an item). Briefings and questions ask it to speak (`reply: true`); context only updates
// it. The session records what actually reaches the model.
//
// A wait on a widget timer is not being stuck: a stuck nudge that comes while one runs is held,
// and tick() gives it a while after the last timer ends if the learner is still on that step.
//
// Perception decides what else it hears. A Gemini coach judges from the camera ('trusted'), so it
// hears nothing the tracker or the object finder produced: no pinches, no missing or registered
// objects. The scripted coach can't see, so it hears those too ('all').

export interface NarratorOptions {
  /** At most one pinch note per window. */
  pinchThrottleMs?: number;
  /** 'trusted' leaves out tracker and object-finder facts. Default 'all'. */
  perception?: 'all' | 'trusted';
  /** A widget timer is running: the learner is waiting on purpose, so a stuck nudge waits. */
  waiting?: () => boolean;
}

/** A stuck nudge held for a widget timer goes out this long after the last timer ends. */
const STUCK_AFTER_WAIT_MS = 20_000;

/** A step.stuck that came while a widget timer ran. */
interface HeldStuck {
  t: number;
  stepId: string;
  elapsedMs: number;
}

type CompletedBy = AppEvents['step.completed']['by'];

const DONE_BY: Record<CompletedBy, string> = {
  coach: 'you completed it',
  user: 'they pressed Done',
  check: 'measured by the app',
  skip: 'skipped',
};

/** Tools whose results carry the plan and, when the focus moved, its briefing ('now'). */
const BRIEFING_TOOLS: ReadonlySet<string> = new Set<CoachToolName>([
  'add_step',
  'update_step',
  'complete_step',
  'add_material',
]);

export class Narrator {
  private pendingDone: string | null = null;
  /** The app completed the last step (the step watcher saw it): its news is urgent. */
  private appDone = false;
  private lastPinchT = Number.NEGATIVE_INFINITY;
  /** Ids of the briefing tool calls running now. */
  private readonly briefingCalls = new Set<string>();
  private heldStuck: HeldStuck | null = null;
  /** When the held nudge's wait ended (no timer running), or null while a timer runs. */
  private waitEndedT: number | null = null;
  private offs: (() => void)[] = [];

  constructor(
    private readonly bus: AppBus,
    private readonly view: LessonView,
    private readonly sink: (n: Narration, t: number) => void,
    private readonly options: NarratorOptions = {},
  ) {}

  attach(): () => void {
    const b = this.bus;
    this.offs = [
      b.on('coach.tool_call', ({ callId, name }) => {
        if (BRIEFING_TOOLS.has(name)) this.briefingCalls.add(callId);
      }),
      b.on('coach.tool_result', ({ callId }) => {
        this.briefingCalls.delete(callId);
      }),
      b.on('plan.ready', ({ t, procedure, warnings, revision, stage }) => {
        const recital = this.recital(procedure);
        const caveats = warnings.length ? `\nCaveats: ${warnings.join(' ')}` : '';
        if (stage === 'rest') {
          // The learner is busy with a step that didn't change: nothing to say out loud.
          this.say(
            t,
            'plan_refined',
            `Plan refined: the later steps are written in full now. ${recital}${caveats}`,
            false,
          );
        } else if (revision) {
          this.say(
            t,
            'plan_revised',
            `Plan revised. ${recital}${caveats}\nTell them in one sentence what changed, then what to do now.`,
            true,
          );
        } else {
          const outline =
            stage === 'first'
              ? '\nThe steps after the first are an outline; the full plan follows as "Plan refined".'
              : '';
          this.say(t, 'plan', `Plan ready. ${recital}${caveats}${outline}`, false);
        }
      }),
      b.on('plan.failed', ({ t, error, revision }) => {
        if (revision) {
          this.say(
            t,
            'revise_failed',
            `Re-planning failed (${error}). The plan is unchanged; adjust it with add_step or update_step.`,
            true,
            { error },
          );
          return;
        }
        const next =
          this.options.perception === 'trusted'
            ? 'Write the plan yourself: call add_step once per step, in order, starting with the first thing to do, each with a done_when you will be able to see.'
            : 'Apologize briefly and ask them to describe the task or their setup again.';
        this.say(t, 'plan_failed', `Planning failed (${error}). ${next}`, true, { error });
      }),
      b.on('plan.slow', ({ t, elapsedMs }) => {
        this.say(
          t,
          'plan_slow',
          `Planning is taking longer than usual (${Math.round(elapsedMs / 1000)} s). Keep them company in one short sentence; the plan will arrive as an [app] message.`,
          true,
        );
      }),
      b.on('step.completed', ({ stepId, by }) => {
        // A tool call's result already says what it completed.
        this.pendingDone = this.briefingCalls.size > 0 ? null : `Done: ${stepId} (${DONE_BY[by]}).`;
        this.appDone = by === 'check';
      }),
      b.on('step.entered', ({ t, stepId, instruction }) => {
        const done = this.pendingDone ? `${this.pendingDone} ` : '';
        const urgent = this.appDone;
        this.pendingDone = null;
        this.appDone = false;
        // Entering a step, even the same one again, restarts the runner's stuck count.
        this.heldStuck = null;
        // The coach moved the focus itself: the tool result carries the briefing.
        if (this.briefingCalls.size > 0) return;
        const plan = this.view.plan();
        const brief = plan ? briefStep(plan, stepId) : `Now: "${instruction}"`;
        this.say(
          t,
          'step',
          `${done}${brief} Tell them what to do in under 15 words.`,
          true,
          { instruction, stepId },
          urgent,
        );
      }),
      b.on('step.looks_wrong', ({ t, stepId, wrong, observation, criteria }) => {
        const unmet = criteria?.filter((c) => c.met === 'no') ?? [];
        const why = unmet.length ? `. Not met: ${unmetList(unmet)}.` : ` (${observation}).`;
        this.say(
          t,
          'looks_wrong',
          `Step watcher: on "${this.instructionOf(stepId)}" they seem to have done something else: ${wrong}${why} If you see it too, tell them in a few words what to do instead; if not, carry on without mentioning it.`,
          true,
          { stepId },
          true,
        );
      }),
      b.on('step.hazard', ({ t, stepId, hazard }) => {
        this.say(
          t,
          'hazard',
          `Step watcher: a possible hazard near their hands: ${hazard}. If you see it too, warn them in a few words; if not, carry on without mentioning it.`,
          true,
          { stepId },
          true,
        );
      }),
      b.on('step.stuck', ({ t, stepId, elapsedMs }) => {
        if (this.options.waiting?.()) {
          this.heldStuck = { t, stepId, elapsedMs };
          this.waitEndedT = null;
          return;
        }
        this.heldStuck = null;
        this.stuck(t, stepId, elapsedMs);
      }),
      b.on('procedure.aborted', () => {
        this.heldStuck = null;
      }),
      b.on('plan.requested', ({ revision }) => {
        if (!revision) this.heldStuck = null;
      }),
      b.on('procedure.completed', ({ t, durationMs }) => {
        const urgent = this.appDone;
        this.pendingDone = null;
        this.heldStuck = null;
        this.appDone = false;
        this.say(
          t,
          'complete',
          `Lesson complete in ${Math.round(durationMs / 1000)} s. Congratulate them in one short sentence and ask what they want to learn next.`,
          true,
          undefined,
          urgent,
        );
      }),
      b.on('mistake.detected', ({ t, kind, message, source }) => {
        if (source !== 'rule') return;
        // Rules that ran under local authority judged from positions a Gemini coach must not hear.
        if (this.options.perception === 'trusted' && this.view.authority?.() !== 'coach') return;
        this.say(
          t,
          'mistake',
          `Mistake "${kind}": ${message} Correct them now in a few words.`,
          true,
          { message },
        );
      }),
      // What the learner sees and does on the widgets, so a trusted coach hears it too.
      b.on('widget.timer_done', ({ t, widgetId, label, duration }) => {
        this.say(
          t,
          'timer_done',
          `Timer "${label}" is up (${duration}). Tell them in a few words, then carry on.`,
          true,
          { widgetId, label },
        );
      }),
      b.on('widget.chosen', ({ t, widgetId, question, option, via }) => {
        // An answer said out loud: the coach heard it.
        if (via !== 'touch') return;
        this.say(
          t,
          'choice',
          `They touched "${option}" for your question "${question}". Reply as if they had said it.`,
          true,
          { widgetId, option },
        );
      }),
      b.on('widget.ticked', ({ t, widgetId, title, item, done, doneCount, total }) => {
        if (done && doneCount === total) {
          this.say(
            t,
            'checklist',
            `They ticked everything on "${title}". Acknowledge it in a few words and go on.`,
            true,
            { widgetId, title },
          );
          return;
        }
        this.say(
          t,
          'checklist',
          `They ${done ? 'ticked' : 'unticked'} "${item}" on "${title}" (${doneCount} of ${total}).`,
          false,
          { widgetId, item },
        );
      }),
      ...(this.options.perception === 'trusted' ? [] : this.perception()),
    ];
    return () => this.detach();
  }

  detach(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.heldStuck = null;
  }

  /**
   * Once per frame (CoachSession.tick): a held stuck nudge goes out once no timer has run for
   * STUCK_AFTER_WAIT_MS, if its step is still focused; a timer starting meanwhile restarts the
   * wait. A step change, the lesson ending or another starting drops it.
   */
  tick(t: number): void {
    const held = this.heldStuck;
    if (!held) return;
    if (this.options.waiting?.()) {
      this.waitEndedT = null;
      return;
    }
    this.waitEndedT ??= t;
    if (t - this.waitEndedT < STUCK_AFTER_WAIT_MS) return;
    this.heldStuck = null;
    if (this.view.plan()?.focusId !== held.stepId) return;
    // How long they have been on the step by now.
    this.stuck(t, held.stepId, held.elapsedMs + (t - held.t));
  }

  /** Tracker and object-finder facts, for a coach that can't see for itself. */
  private perception(): (() => void)[] {
    const b = this.bus;
    return [
      b.on('object.missing', ({ t, objectIds }) => {
        const names = objectIds.map((id) => this.view.label(id)).join(', ');
        this.say(
          t,
          'missing',
          `I can't see: ${names}. Ask them to look at it, or to pinch it so I can register it. If it isn't there, call revise_plan.`,
          true,
          { names },
        );
      }),
      b.on('object.registered', ({ t, objectId, method }) => {
        if (method !== 'pinch') return;
        this.say(
          t,
          'registered',
          `Registered the ${this.view.label(objectId)} where they pinched.`,
          true,
          { name: this.view.label(objectId) },
        );
      }),
      b.on('hand.pinch', ({ t, hand, phase, nearest }) => {
        const window = this.options.pinchThrottleMs ?? 2000;
        if (phase !== 'start' || !nearest || t - this.lastPinchT < window) return;
        this.lastPinchT = t;
        const cm = Math.round(nearest.distance * 100);
        this.say(
          t,
          'pinch',
          `${hand} hand pinched near ${this.view.label(nearest.objectId)} (${cm} cm).`,
          false,
        );
      }),
    ];
  }

  private stuck(t: number, stepId: string, elapsedMs: number): void {
    const step = this.view.plan()?.steps.find((s) => s.id === stepId);
    const help = step?.demo
      ? 'Offer help: call show_demo, then give one tip.'
      : 'Offer one tip, or ask what is unclear.';
    this.say(
      t,
      'stuck',
      `They have been on this step for ${Math.round(elapsedMs / 1000)} s. ${help}`,
      true,
    );
  }

  /** The plan in a few lines, or the procedure's steps when there is no plan view yet. */
  private recital(procedure: Procedure): string {
    const plan = this.view.plan();
    if (plan) return recitePlan(plan);
    return `"${procedure.title}": ${procedure.steps.map((s) => s.instruction).join(' ')}`;
  }

  private instructionOf(stepId: string): string {
    return (
      this.view.plan()?.steps.find((s) => s.id === stepId)?.instruction ??
      this.view.procedure()?.steps.find((s) => s.id === stepId)?.instruction ??
      stepId
    );
  }

  private say(
    t: number,
    kind: string,
    body: string,
    reply: boolean,
    data?: Record<string, string>,
    urgent = false,
  ): void {
    this.sink(
      {
        kind,
        text: `[app] ${body}`,
        reply,
        ...(data ? { data } : {}),
        ...(urgent ? { urgent } : {}),
      },
      t,
    );
  }
}

/** The watcher's criteria are short sentences; in a narration they read as one list. */
const clause = (text: string) => text.trim().replace(/[.;]+$/, '');

/** What is not met and what the watcher saw instead, at most three. */
function unmetList(criteria: readonly StepCheckCriterion[]): string {
  return criteria
    .slice(0, 3)
    .map((c) => `${clause(c.text)}${c.seen ? ` (saw: ${clause(c.seen)})` : ''}`)
    .join('; ');
}
