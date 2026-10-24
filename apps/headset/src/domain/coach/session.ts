import { COACH_TOOL_NAMES, type CoachToolName, isNonBlockingTool } from '@clio/protocol';
import type { Clock } from '../../core/clock';
import type { AppBus } from '../events';
import { recitePlan } from '../plan/recital';
import type { TemplateSummary } from '../session/templates';
import type { AgentState, Narration, RealtimeAgent, ToolCall, ToolResult } from './agent';
import { Narrator } from './narrator';
import type { CoachFrameSource, LessonView, MicSource, VoiceOutput } from './ports';
import { buildSystemInstruction } from './prompt';
import type { CoachToolbox } from './toolbox';

// Wires a RealtimeAgent to the rest of the app: mic in, speech out, tool calls to the toolbox,
// lesson events to the model through the Narrator, transcripts and status onto the bus, and a
// camera frame every few seconds.
//
// It also keeps a Gemini coach in sync with the plan the app owns: a fresh system instruction once
// the plan settles and on every reconnect (the next connection starts from it), a recap after a
// reconnect, and a notice when the model cancels a call that had already changed the plan. Every
// message to Gemini interrupts what it is saying, so narrations wait while either side is talking
// or the connection is down, and go out merged. Each narration is recorded when it reaches the
// model.
//
// A non-blocking call (look_closer, which asks the smart model) answers a second or two later, as
// the call's result; the model says it once nobody is talking. If its connection closed meanwhile,
// the new connection never made that call, so the answer goes out as a narration instead.

export interface CoachSessionDeps {
  agent: RealtimeAgent;
  toolbox: CoachToolbox;
  bus: AppBus;
  clock: Clock;
  view: LessonView;
  voice: VoiceOutput;
  mic?: MicSource;
  camera?: CoachFrameSource;
  persona?: string;
  /** Curated lessons the coach may start from, listed in its instructions. */
  templates?: readonly TemplateSummary[];
}

/** One camera frame per interval. */
const FRAME_MS = 4000;
/** Rebuild the system instruction once the plan has been still this long. */
const INSTRUCTION_SETTLE_MS = 1500;
/** Hold narrations until the learner has been quiet this long... */
const LEARNER_QUIET_MS = 1200;
/** ...but never longer than this. */
const MAX_HOLD_MS = 6000;
/** Remember this many tool calls, for cancellations. */
const REMEMBERED_CALLS = 50;

/** Tools that change the plan: cancelling one doesn't undo it. */
const PLAN_TOOLS: ReadonlySet<string> = new Set<CoachToolName>([
  'start_lesson',
  'revise_plan',
  'add_step',
  'update_step',
  'complete_step',
  'add_material',
]);

interface CallRecord {
  name: string;
  /** Unset while the call runs. */
  ok?: boolean;
  /** Cancelled while it ran: report it once it has succeeded. */
  cancelled?: boolean;
  /** A non-blocking call whose connection closed while it ran. */
  orphaned?: boolean;
}

export class CoachSession {
  private readonly narrator: Narrator;
  /** A Gemini coach: perception stays out, and narrations wait for a gap in the conversation. */
  private readonly gemini: boolean;
  private offs: (() => void)[] = [];
  private lastFrameT: number;
  private snapshotInFlight = false;
  private state: AgentState | null = null;
  private speaking = false;
  private lastLearnerT = Number.NEGATIVE_INFINITY;
  private held: Narration[] = [];
  private heldSince = 0;
  private flushQueued = false;
  /** When the plan last changed, while the system instruction lags behind it. */
  private planChangedT: number | null = null;
  private readonly calls = new Map<string, CallRecord>();

  constructor(private readonly deps: CoachSessionDeps) {
    this.lastFrameT = deps.clock.now();
    this.gemini = deps.agent.kind === 'gemini';
    this.narrator = new Narrator(deps.bus, deps.view, (n) => this.send(n), {
      perception: this.gemini ? 'trusted' : 'all',
    });
  }

  async start(): Promise<void> {
    const { agent, bus, clock, toolbox, voice, mic } = this.deps;
    const events = agent.events;
    this.offs = [
      events.on('toolCalls', ({ calls }) => {
        // The model's turn goes on after the calls: what they set off waits for it to end.
        this.speaking = true;
        for (const call of calls) {
          this.remember(call);
          void toolbox.handle(call).then((result) => this.onResult(result));
        }
      }),
      events.on('cancelledTools', ({ ids }) => this.onCancelled(ids)),
      events.on('audio', ({ pcm, sampleRate }) => {
        this.speaking = true;
        voice.play(pcm, sampleRate);
      }),
      events.on('say', ({ text }) => voice.say(text)),
      events.on('interrupted', () => {
        this.speaking = false;
        voice.stop();
      }),
      events.on('turnComplete', () => {
        this.speaking = false;
      }),
      events.on('transcript', ({ role, text, final }) => {
        const t = clock.now();
        // Partial transcripts stream while the learner talks; final ones come at the end of a turn.
        if (role === 'user' && !final) this.lastLearnerT = t;
        bus.emit('coach.caption', { t, role, text, final });
        if (final && text.trim())
          bus.emit('transcript', { t, role, text: text.trim(), final: true });
      }),
      events.on('status', ({ state, detail }) => this.onStatus(state, detail)),
      bus.on('plan.changed', () => this.planChanged()),
      bus.on('plan.ready', () => this.planChanged()),
      // A lesson starting, failing or ending changes the plan without a plan event.
      bus.on('lesson.phase', () => this.planChanged()),
      // Before the narrator attaches, so the model gets the frame before the suggestion about it.
      bus.on('step.looks_done', ({ image }) => {
        if (image) agent.pushImage(image);
      }),
      bus.on('step.looks_wrong', ({ image }) => {
        if (image) agent.pushImage(image);
      }),
      bus.on('step.hazard', ({ image }) => {
        if (image) agent.pushImage(image);
      }),
    ];
    this.offs.push(this.narrator.attach());

    await agent.connect({ systemInstruction: this.instruction(), tools: COACH_TOOL_NAMES });
    await mic?.start((pcm) => agent.pushAudio(pcm));
  }

  /** Call once per frame: sends held narrations, a fresh instruction and camera frames when due. */
  tick(t: number): void {
    const overdue = this.state === 'ready' && t - this.heldSince >= MAX_HOLD_MS;
    if (this.held.length > 0 && (!this.gateClosed(t) || overdue)) this.flush();
    if (this.planChangedT !== null && t - this.planChangedT >= INSTRUCTION_SETTLE_MS)
      this.refreshInstruction();

    const camera = this.deps.camera;
    if (!camera || this.snapshotInFlight || t - this.lastFrameT < FRAME_MS) return;
    this.lastFrameT = t;
    this.snapshotInFlight = true;
    void camera
      .snapshot()
      .then((jpeg) => {
        if (jpeg) this.deps.agent.pushImage(jpeg);
      })
      .finally(() => {
        this.snapshotInFlight = false;
      });
  }

  async stop(): Promise<void> {
    for (const off of this.offs) off();
    this.offs = [];
    this.held = [];
    this.deps.mic?.stop();
    this.deps.voice.stop();
    await this.deps.agent.close();
  }

  private instruction(): string {
    const { view, persona, templates } = this.deps;
    const coach = view.procedure()?.coach;
    return buildSystemInstruction({
      persona: coach?.persona ?? persona,
      lessonNotes: coach?.notes,
      templates,
      plan: view.plan(),
    });
  }

  private planChanged(): void {
    this.planChangedT = this.deps.clock.now();
  }

  private refreshInstruction(): void {
    this.planChangedT = null;
    this.deps.agent.updateInstruction?.(this.instruction());
  }

  private onStatus(state: AgentState, detail?: string): void {
    this.deps.bus.emit('coach.status', {
      t: this.deps.clock.now(),
      state,
      ...(detail ? { detail } : {}),
    });
    const previous = this.state;
    this.state = state;
    if (state !== 'ready') {
      // A dropped connection ends the model's turn without a turnComplete.
      this.speaking = false;
      // The next connection never made the calls still running.
      for (const call of this.calls.values()) {
        if (call.ok === undefined && isNonBlockingTool(call.name)) call.orphaned = true;
      }
      // Nothing will carry these to the model any more.
      if (state === 'error' || state === 'closed') this.held = [];
      // The next connection starts from the stored instruction, so bring it up to date first.
      if (state === 'reconnecting') this.refreshInstruction();
      return;
    }
    // Time spent without a connection doesn't count against the hold.
    this.heldSince = this.deps.clock.now();
    if (previous === 'reconnecting') {
      const plan = this.deps.view.plan();
      this.note('reconnected', `Reconnected. ${plan ? recitePlan(plan) : 'No lesson is running.'}`);
    }
  }

  private remember(call: ToolCall): void {
    this.calls.set(call.id, { name: call.name });
    if (this.calls.size <= REMEMBERED_CALLS) return;
    const oldest = this.calls.keys().next().value;
    if (oldest !== undefined) this.calls.delete(oldest);
  }

  private onResult(result: ToolResult): void {
    const { id, ok } = result;
    const call = this.calls.get(id);
    if (call && isNonBlockingTool(call.name) && (call.orphaned || call.cancelled)) {
      this.calls.delete(id);
      this.lateAnswer(result);
      return;
    }
    this.deps.agent.respond([result]);
    if (!call) return;
    call.ok = ok;
    if (!call.cancelled) return;
    this.calls.delete(id);
    if (ok) this.applied([call.name]);
  }

  /** A non-blocking answer for a call the model no longer has: told as a narration. */
  private lateAnswer({ name, ok, result }: ToolResult): void {
    const body = JSON.stringify(result);
    this.send({
      kind: 'late_answer',
      text: `[app] Your ${name} call ${ok ? 'answered' : 'failed'}: ${body}`,
      reply: true,
    });
  }

  /** The model dropped calls it had made (the learner barged in), but plan changes stick. */
  private onCancelled(ids: readonly string[]): void {
    const { bus, clock } = this.deps;
    const names: string[] = [];
    for (const callId of ids) {
      const call = this.calls.get(callId);
      // A non-blocking answer still to come is told as a narration.
      if (call && call.ok === undefined && isNonBlockingTool(call.name)) {
        call.cancelled = true;
        continue;
      }
      if (!call || !PLAN_TOOLS.has(call.name)) continue;
      bus.emit('annotation', {
        t: clock.now(),
        label: 'coach.tool_cancelled',
        data: { callId, name: call.name },
      });
      if (call.ok === undefined) {
        call.cancelled = true;
        continue;
      }
      this.calls.delete(callId);
      if (call.ok) names.push(call.name);
    }
    this.applied(names);
  }

  private applied(names: readonly string[]): void {
    if (names.length === 0) return;
    const calls = names.length === 1 ? `${names[0]} call was` : `${names.join(', ')} calls were`;
    const plan = this.deps.view.plan();
    this.note('cancelled', `Your ${calls} already applied.${plan ? ` ${recitePlan(plan)}` : ''}`);
  }

  /** A narration of the session's own. Context only. */
  private note(kind: string, body: string): void {
    this.send({ kind, text: `[app] ${body}`, reply: false });
  }

  private gateClosed(t: number): boolean {
    return this.state !== 'ready' || this.speaking || t - this.lastLearnerT < LEARNER_QUIET_MS;
  }

  private send(narration: Narration): void {
    if (!this.gemini) {
      this.record(narration);
      this.deps.agent.narrate(narration);
      return;
    }
    if (this.state === 'error' || this.state === 'closed') return;
    const t = this.deps.clock.now();
    if (this.held.length === 0) this.heldSince = t;
    this.held.push(narration);
    // Whatever else the same events produce goes out with it.
    if (!this.gateClosed(t)) this.flushSoon();
  }

  private flushSoon(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      if (!this.gateClosed(this.deps.clock.now())) this.flush();
    });
  }

  /** Everything held, as one narration: one interruption instead of several. */
  private flush(): void {
    // A briefing for a step that has lost focus since would send the coach back to it, and a
    // revised plan's recital already says what to do now.
    const focus = this.deps.view.plan()?.focusId;
    const held = this.held.filter((n) => n.kind === 'plan_revised');
    const revised = held.length > 0;
    for (const n of this.held) {
      if (n.kind === 'plan_revised') continue;
      if (n.kind === 'step' && (revised || n.data?.stepId !== focus)) this.dropped(n);
      else held.push(n);
    }
    this.held = [];
    for (const n of held) this.record(n);
    const last = held.at(-1);
    if (!last) return;
    if (held.length === 1) {
      this.deps.agent.narrate(last);
      return;
    }
    this.deps.agent.narrate({
      kind: last.kind,
      text: held.map((n) => n.text).join(' '),
      reply: held.some((n) => n.reply),
      ...(last.data ? { data: last.data } : {}),
    });
  }

  /** A briefing that never reaches the model. */
  private dropped({ kind, data }: Narration): void {
    this.deps.bus.emit('annotation', {
      t: this.deps.clock.now(),
      label: 'coach.narration_dropped',
      data: { kind, stepId: data?.stepId },
    });
  }

  private record({ kind, text }: Narration): void {
    this.deps.bus.emit('coach.narration', { t: this.deps.clock.now(), kind, text });
  }
}
