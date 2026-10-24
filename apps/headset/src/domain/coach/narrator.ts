import type { Step } from '@clio/protocol';
import type { AppBus } from '../events';
import { needsConfirmation } from '../procedure/checks';
import type { Narration } from './agent';
import type { LessonView } from './ports';

// Turns sensor and lesson events into short "[app]" facts for the model. The model never sees
// hands; it learns what happened from these. Briefings ask it to speak (`reply: true`); background
// facts (pinches) only update its context.

export interface NarratorOptions {
  /** At most one pinch note per window. */
  pinchThrottleMs?: number;
}

export class Narrator {
  private pendingDone: string | null = null;
  private lastPinchT = Number.NEGATIVE_INFINITY;
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
      b.on('plan.ready', ({ t, procedure, warnings }) => {
        const steps = procedure.steps.map((s, i) => `${i + 1}) ${s.instruction}`).join(' ');
        const caveats = warnings.length ? ` Caveats: ${warnings.join(' ')}` : '';
        this.say(
          t,
          'plan',
          `Plan ready: "${procedure.title}", ${procedure.steps.length} steps. ${steps}${caveats}`,
          false,
        );
      }),
      b.on('plan.failed', ({ t, error }) => {
        this.say(
          t,
          'plan_failed',
          `Planning failed (${error}). Apologize briefly and ask them to describe the task or their setup again.`,
          true,
        );
      }),
      b.on('step.completed', ({ index, by, forced }) => {
        this.pendingDone = `Step ${index + 1} done (${by === 'check' ? 'detected' : `${by} confirmed`}${forced ? ', not verified' : ''}).`;
      }),
      b.on('step.entered', ({ t, index }) => {
        const procedure = this.view.procedure();
        const step = procedure?.steps[index];
        if (!procedure || !step) return;
        const done = this.pendingDone ? `${this.pendingDone} ` : '';
        this.pendingDone = null;
        this.say(t, 'step', done + this.briefing(step, index, procedure.steps.length), true);
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
        this.say(
          t,
          'mistake',
          `Mistake "${kind}": ${message} Correct them now in a few words.`,
          true,
        );
      }),
      b.on('step.stuck', ({ t, elapsedMs }) => {
        this.say(
          t,
          'stuck',
          `They have been on this step for ${Math.round(elapsedMs / 1000)} s. Offer help: call show_demo, then give one tip.`,
          true,
        );
      }),
      b.on('object.missing', ({ t, objectIds }) => {
        const names = objectIds.map((id) => this.view.label(id)).join(', ');
        this.say(
          t,
          'missing',
          `I can't see: ${names}. Ask them to look at it, or to pinch it so I can register it. If it isn't there, call revise_plan.`,
          true,
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
    return () => this.detach();
  }

  detach(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  private briefing(step: Step, index: number, total: number): string {
    const targets = step.targets.length
      ? ` Targets: ${step.targets.map((id) => this.view.label(id)).join(', ')}.`
      : '';
    const notes = step.coachNotes ? ` Notes: ${step.coachNotes}` : '';
    const confirm = needsConfirmation(step.success)
      ? ' This step needs your judgment: call advance_step with the reason when you see it done.'
      : '';
    return `Step ${index + 1}/${total}: "${step.instruction}"${targets}${notes}${confirm} Tell them what to do in under 15 words.`;
  }

  private say(t: number, kind: string, body: string, reply: boolean): void {
    const narration: Narration = { kind, text: `[app] ${body}`, reply };
    this.bus.emit('coach.narration', { t, kind, text: narration.text });
    this.sink(narration, t);
  }
}
