import type { CoachKind, CoachToolName } from '@clio/protocol';
import type { Emitter } from '../../core/emitter';

// Port: a realtime conversational agent. Implemented by GeminiLiveAgent (adapters/gemini) and by
// ScriptedAgent (adapters/scripted, offline). The rest of the app only sees this interface.

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Every tool answers at once; slow work (planning) reports back later as a narration. */
export interface ToolResult {
  id: string;
  name: string;
  ok: boolean;
  result: unknown;
}

/** An app-side fact for the model, e.g. "[app] Step 2/5 …". `reply` asks the model to speak. */
export interface Narration {
  kind: string;
  text: string;
  reply: boolean;
  /** Structured fields, for agents that don't read prose (the scripted coach). */
  data?: Record<string, string>;
  /**
   * What the app saw that the learner may be waiting on (a step done, something done wrong, a
   * hazard): it doesn't wait for the learner to stop talking.
   */
  urgent?: boolean;
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
  /**
   * The model's turn is over. `working`: it is still reasoning (a thinking Gemini voice), and a
   * tool call or more speech may follow a few seconds later.
   */
  turnComplete: { working?: boolean };
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
  /**
   * Replace the system instruction (it carries the current plan). Agents that reconnect use it from
   * the next connection on, so a resumed session starts from the plan as it is now.
   */
  updateInstruction?(systemInstruction: string): void;
  close(): Promise<void>;
}
