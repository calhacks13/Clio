import type { CoachKind } from '@clio/protocol';
import { Emitter } from '../../src/core/emitter';
import type {
  AgentEvents,
  AgentSetup,
  Narration,
  RealtimeAgent,
  ToolResult,
} from '../../src/domain/coach/agent';

/** Records everything the session pushes; tests drive it by emitting agent events. */
export class FakeAgent implements RealtimeAgent {
  readonly model = 'fake-live';
  readonly events = new Emitter<AgentEvents>();
  setup: AgentSetup | null = null;
  audio: Int16Array[] = [];
  images: string[] = [];
  narrations: Narration[] = [];
  responses: ToolResult[] = [];
  /** Every system instruction passed to updateInstruction, oldest first. */
  instructions: string[] = [];
  /** Narrations and tool answers in the order they reached the model. */
  log: string[] = [];
  closed = false;

  constructor(readonly kind: CoachKind = 'gemini') {}

  async connect(setup: AgentSetup) {
    this.setup = setup;
    this.events.emit('status', { state: 'ready' });
  }
  pushAudio(pcm: Int16Array) {
    this.audio.push(pcm);
  }
  pushImage(jpegBase64: string) {
    this.images.push(jpegBase64);
  }
  narrate(n: Narration) {
    this.narrations.push(n);
    this.log.push(`narrate:${n.kind}`);
  }
  respond(results: ToolResult[]) {
    this.responses.push(...results);
    for (const r of results) this.log.push(`respond:${r.id}`);
  }
  updateInstruction(systemInstruction: string) {
    this.instructions.push(systemInstruction);
  }
  async close() {
    this.closed = true;
  }
}
