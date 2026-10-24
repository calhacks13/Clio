import type { ToolCall } from '../../domain/coach/agent';

// Pure interpretation of Gemini Live server messages (field paths verified against
// @google/genai 2.31.0), kept separate from the WebSocket plumbing so it can be unit tested.

export interface ServerMessageLike {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] };
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    interrupted?: boolean;
    turnComplete?: boolean;
  };
  toolCall?: { functionCalls?: { id?: string; name?: string; args?: Record<string, unknown> }[] };
  toolCallCancellation?: { ids?: string[] };
  goAway?: { timeLeft?: string };
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
}

export type Interpreted =
  | { kind: 'setupComplete' }
  | { kind: 'audio'; data: string; sampleRate: number }
  | { kind: 'transcript'; role: 'user' | 'coach'; text: string }
  | { kind: 'interrupted' }
  | { kind: 'turnComplete' }
  | { kind: 'toolCalls'; calls: ToolCall[] }
  | { kind: 'toolCancel'; ids: string[] }
  | { kind: 'goAway'; timeLeft: string }
  | { kind: 'resumption'; handle: string };

const rateOf = (mimeType: string | undefined) =>
  Number(/rate=(\d+)/.exec(mimeType ?? '')?.[1] ?? 24000);

export function interpretServerMessage(msg: ServerMessageLike): Interpreted[] {
  const out: Interpreted[] = [];
  if (msg.setupComplete) out.push({ kind: 'setupComplete' });
  const content = msg.serverContent;
  if (content) {
    for (const part of content.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data;
      if (data && (part.inlineData?.mimeType ?? '').startsWith('audio/')) {
        out.push({ kind: 'audio', data, sampleRate: rateOf(part.inlineData?.mimeType) });
      }
    }
    if (content.inputTranscription?.text) {
      out.push({ kind: 'transcript', role: 'user', text: content.inputTranscription.text });
    }
    if (content.outputTranscription?.text) {
      out.push({ kind: 'transcript', role: 'coach', text: content.outputTranscription.text });
    }
    if (content.interrupted) out.push({ kind: 'interrupted' });
    if (content.turnComplete) out.push({ kind: 'turnComplete' });
  }
  const calls = msg.toolCall?.functionCalls ?? [];
  if (calls.length > 0) {
    out.push({
      kind: 'toolCalls',
      calls: calls.map((c, i) => ({
        id: c.id ?? `call-${i}`,
        name: c.name ?? '',
        args: c.args ?? {},
      })),
    });
  }
  if (msg.toolCallCancellation?.ids?.length) {
    out.push({ kind: 'toolCancel', ids: msg.toolCallCancellation.ids });
  }
  if (msg.goAway) out.push({ kind: 'goAway', timeLeft: msg.goAway.timeLeft ?? '' });
  const resumption = msg.sessionResumptionUpdate;
  if (resumption?.resumable && resumption.newHandle) {
    out.push({ kind: 'resumption', handle: resumption.newHandle });
  }
  return out;
}

type Role = 'user' | 'coach';

/** Live transcription arrives in fragments; this assembles them per turn. */
export class TranscriptAggregator {
  private readonly text: Record<Role, string> = { user: '', coach: '' };

  add(role: Role, fragment: string): { role: Role; text: string; final: false } {
    this.text[role] += fragment;
    return { role, text: this.text[role], final: false };
  }

  complete(): { role: Role; text: string; final: true }[] {
    const roles: Role[] = ['user', 'coach'];
    const out = roles
      .filter((role) => this.text[role].trim())
      .map((role) => ({ role, text: this.text[role].trim(), final: true as const }));
    this.text.user = '';
    this.text.coach = '';
    return out;
  }
}
