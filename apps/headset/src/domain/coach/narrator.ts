import type { CoachToolName, Procedure } from '@clio/protocol';
import type { AppBus, AppEvents } from '../events';
import { briefStep, recitePlan } from '../plan/recital';
import type { Narration } from './agent';
import type { LessonView } from './ports';

// Turns lesson events into short "[app]" messages for the model: the plan when it arrives, a
// briefing whenever a step takes focus, completions, the step watcher's suggestions and calls for
// help. Briefings and questions ask it to speak (`reply: true`); context only updates it. The
// session records what actually reaches the model.
//
// Perception decides what else it hears. A Gemini coach judges from the camera ('trusted'), so it
// hears nothing the tracker or the object finder produced: no pinches, no missing or registered
// objects. The scripted coach can't see, so it hears those too ('all').

export interface NarratorOptions {
  /** At most one pinch note per window. */
  pinchThrottleMs?: number;
  /** 'trusted' leaves out tracker and object-finder facts. Default 'all'. */
  perception?: 'all' | 'trusted';
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
  private lastPinchT = Number.NEGATIVE_INFINITY;
  /** Ids of the briefing tool calls running now. */
  private readonly briefingCalls = new Set<string>();
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
      b.on('plan.ready', ({ t, procedure, warnings, revision }) => {
        const recital = this.recital(procedure);
        const caveats = warnings.length ? `\nCaveats: ${warnings.join(' ')}` : '';
        if (revision) {
          this.say(
            t,
            'plan_revised',
            `Plan revised. ${recital}${caveats}\nTell them in one sentence what changed, then what to do now.`,
            true,
          );
        } else {
          this.say(t, 'plan', `Plan ready. ${recital}${caveats}`, false);
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
      }),
      b.on('step.entered', ({ t, stepId, instruction }) => {
        const done = this.pendingDone ? `${this.pendingDone} ` : '';
        this.pendingDone = null;
        // The coach moved the focus itself: the tool result carries the briefing.
        if (this.briefingCalls.size > 0) return;
        const plan = this.view.plan();
        const brief = plan ? briefStep(plan, stepId) : `Now: "${instruction}"`;
        this.say(t, 'step', `${done}${brief} Tell them what to do in under 15 words.`, true, {
          instruction,
          stepId,
        });
      }),
      b.on('step.looks_done', ({ t, stepId, observation }) => {
        this.say(
          t,
          'looks_done',
          `Step watcher: "${this.instructionOf(stepId)}" looks done (${observation}). If you agree from what you see, call complete_step with step_id "${stepId}" and evidence "seen"; if not, carry on without mentioning it.`,
          true,
          { stepId },
        );
      }),
      b.on('step.looks_wrong', ({ t, stepId, wrong, observation }) => {
        this.say(
          t,
          'looks_wrong',
          `Step watcher: on "${this.instructionOf(stepId)}" they seem to have done something else: ${wrong} (${observation}). If you see it too, tell them in a few words what to do instead; if not, carry on without mentioning it.`,
          true,
          { stepId },
        );
      }),
      b.on('step.hazard', ({ t, stepId, hazard }) => {
        this.say(
          t,
          'hazard',
          `Step watcher: a possible hazard near their hands: ${hazard}. If you see it too, warn them in a few words; if not, carry on without mentioning it.`,
          true,
          { stepId },
        );
      }),
      b.on('step.stuck', ({ t, stepId, elapsedMs }) => {
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
      }),
      b.on('procedure.completed', ({ t, durationMs }) => {
        this.pendingDone = null;
        this.say(
          t,
          'complete',
          `Lesson complete in ${Math.round(durationMs / 1000)} s. Congratulate them in one short sentence and ask what they want to learn next.`,
          true,
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
      ...(this.options.perception === 'trusted' ? [] : this.perception()),
    ];
    return () => this.detach();
  }

  detach(): void {
    for (const off of this.offs) off();
    this.offs = [];
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
  ): void {
    this.sink({ kind, text: `[app] ${body}`, reply, ...(data ? { data } : {}) }, t);
  }
}
