import { COACH_TOOL_NAMES } from '@clio/protocol';
import type { Clock } from '../../core/clock';
import type { AppBus } from '../events';
import { needsConfirmation } from '../procedure/checks';
import type { RealtimeAgent } from './agent';
import { Narrator } from './narrator';
import type { CoachFrameSource, LessonView, MicSource, VoiceOutput } from './ports';
import { buildSystemInstruction } from './prompt';
import type { CoachToolbox } from './toolbox';

// Wires a RealtimeAgent to the rest of the app: mic in, speech out, tool calls to the toolbox,
// lesson events to the model through the Narrator, transcripts and status onto the bus, and camera
// frames at a cadence that depends on what the current step needs.

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
}

/** Frame intervals: a slow ambient rate, and a faster one while a visual check is pending. */
const AMBIENT_MS = 4000;
const WATCHING_MS = 1000;

export class CoachSession {
  private readonly narrator: Narrator;
  private offs: (() => void)[] = [];
  private frameInterval = AMBIENT_MS;
  private lastFrameT: number;
  private snapshotInFlight = false;

  constructor(private readonly deps: CoachSessionDeps) {
    this.lastFrameT = deps.clock.now();
    this.narrator = new Narrator(deps.bus, deps.view, (n) => deps.agent.narrate(n));
  }

  async start(): Promise<void> {
    const { agent, bus, clock, toolbox, voice, mic } = this.deps;
    const events = agent.events;
    this.offs = [
      events.on('toolCalls', ({ calls }) => {
        for (const call of calls)
          void toolbox.handle(call).then((result) => agent.respond([result]));
      }),
      events.on('audio', ({ pcm, sampleRate }) => voice.play(pcm, sampleRate)),
      events.on('say', ({ text }) => voice.say(text)),
      events.on('interrupted', () => voice.stop()),
      events.on('transcript', ({ role, text, final }) => {
        const t = clock.now();
        bus.emit('coach.caption', { t, role, text, final });
        if (final && text.trim())
          bus.emit('transcript', { t, role, text: text.trim(), final: true });
      }),
      events.on('status', ({ state, detail }) => {
        bus.emit('coach.status', { t: clock.now(), state, ...(detail ? { detail } : {}) });
      }),
      bus.on('step.entered', ({ t, index }) => {
        const step = this.deps.view.procedure()?.steps[index];
        this.frameInterval = step && needsConfirmation(step.success) ? WATCHING_MS : AMBIENT_MS;
        this.lastFrameT = t;
      }),
      bus.on('procedure.completed', ({ t }) => {
        this.frameInterval = AMBIENT_MS;
        this.lastFrameT = t;
      }),
    ];
    this.offs.push(this.narrator.attach());

    const persona = this.deps.persona;
    await agent.connect({
      systemInstruction: buildSystemInstruction(persona ? { persona } : {}),
      tools: COACH_TOOL_NAMES,
    });
    await mic?.start((pcm) => agent.pushAudio(pcm));
  }

  /** Call once per frame; sends a camera frame when one is due. */
  tick(t: number): void {
    const camera = this.deps.camera;
    if (!camera || this.snapshotInFlight || t - this.lastFrameT < this.frameInterval) return;
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
    this.deps.mic?.stop();
    this.deps.voice.stop();
    await this.deps.agent.close();
  }
}
