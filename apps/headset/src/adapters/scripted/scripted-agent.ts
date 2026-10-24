import { Emitter } from '../../core/emitter';
import type { AgentEvents, Narration, RealtimeAgent, ToolResult } from '../../domain/coach/agent';

// A deterministic, offline coach: it speaks step instructions and corrections (via the speaker's
// text-to-speech) and asks for a demo when the learner is stuck. Same port and same tools as the
// Gemini coach, so lessons, recordings and tests behave identically without a network. It doesn't
// listen; learners confirm steps with the Done button.

export class ScriptedAgent implements RealtimeAgent {
  readonly kind = 'scripted' as const;
  readonly events = new Emitter<AgentEvents>();
  private calls = 0;

  async connect(): Promise<void> {
    this.events.emit('status', { state: 'ready' });
  }

  pushAudio(): void {}
  pushImage(): void {}
  respond(_results: ToolResult[]): void {}

  narrate(n: Narration): void {
    const d = n.data ?? {};
    switch (n.kind) {
      case 'step':
        if (d.instruction) this.say(d.instruction);
        break;
      case 'mistake':
        if (d.message) this.say(d.message);
        break;
      case 'stuck':
        this.say('Watch this.');
        this.call('show_demo', {});
        break;
      case 'missing':
        if (d.names) this.say(`I can't find the ${d.names}. Pinch it so I know where it is.`);
        break;
      case 'registered':
        this.say('Got it.');
        break;
      case 'complete':
        this.say('Nice work, you did it!');
        break;
      case 'plan_failed':
        this.say("Sorry, I couldn't plan that lesson.");
        break;
    }
  }

  async close(): Promise<void> {
    this.events.emit('status', { state: 'closed' });
  }

  private say(text: string): void {
    this.events.emit('say', { text });
    this.events.emit('transcript', { role: 'coach', text, final: true });
  }

  private call(name: string, args: Record<string, unknown>): void {
    this.events.emit('toolCalls', { calls: [{ id: `scripted-${++this.calls}`, name, args }] });
  }
}
