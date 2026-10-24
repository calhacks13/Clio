import type { CoachKind, CoachToolName } from '@clio/protocol';
import type { Emitter } from '../../core/emitter';

// Port: a realtime conversational agent. Implemented by GeminiLiveAgent (adapters/gemini) and by
// ScriptedAgent (adapters/scripted, offline). The rest of the app only sees this interface.

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * How the model should take a result that arrives while it is talking (long-running tools such as
 * start_lesson): interrupt itself, wait until idle, or absorb it silently.
 */
export type ToolTiming = 'interrupt' | 'when_idle' | 'silent';

export interface ToolResult {
  id: string;
  name: string;
  ok: boolean;
  result: unknown;
  timing?: ToolTiming;
}

/** An app-side fact for the model, e.g. "[app] Step 2/5 …". `reply` asks the model to speak. */
export interface Narration {
  kind: string;
  text: string;
  reply: boolean;
  /** Structured fields, for agents that don't read prose (the scripted coach). */
  data?: Record<string, string>;
}

export type AgentState = 'connecting' | 'ready' | 'reconnecting' | 'closed' | 'error';

export interface AgentEvents {
  status: { state: AgentState; detail?: string };
  /** Model speech as PCM16 mono. */
  audio: { pcm: Int16Array; sampleRate: number };
  /** Model speech as text, for agents without audio output (spoken via TTS). */
  say: { text: string };
  /** The user barged in: stop playback now. */
  interrupted: Record<string, never>;
  transcript: { role: 'user' | 'coach'; text: string; final: boolean };
  toolCalls: { calls: ToolCall[] };
  cancelledTools: { ids: string[] };
  turnComplete: Record<string, never>;
}

export interface AgentSetup {
  systemInstruction: string;
  tools: readonly CoachToolName[];
  voice?: string;
}

export interface RealtimeAgent {
  readonly kind: CoachKind;
  readonly model?: string;
  readonly events: Emitter<AgentEvents>;
  connect(setup: AgentSetup): Promise<void>;
  /** Microphone audio: PCM16 mono at 16 kHz. */
  pushAudio(pcm16k: Int16Array): void;
  /** A camera frame, base64 JPEG. */
  pushImage(jpegBase64: string): void;
  narrate(narration: Narration): void;
  respond(results: ToolResult[]): void;
  close(): Promise<void>;
}
