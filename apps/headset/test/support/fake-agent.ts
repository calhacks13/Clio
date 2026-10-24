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
  readonly kind: CoachKind = 'gemini';
  readonly model = 'fake-live';
  readonly events = new Emitter<AgentEvents>();
  setup: AgentSetup | null = null;
  audio: Int16Array[] = [];
  images: string[] = [];
  narrations: Narration[] = [];
  responses: ToolResult[] = [];
  closed = false;

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
  }
  respond(results: ToolResult[]) {
    this.responses.push(...results);
  }
  async close() {
    this.closed = true;
  }
}
