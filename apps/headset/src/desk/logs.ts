// What the side panel lists, kept as plain data so it can be tested without a page: the
// conversation (learner, coach, and the [app] messages the voice was sent), and every coach tool
// call with its arguments and result. Both keep the newest entries only.

export type TranscriptRole = 'user' | 'coach' | 'app';

export interface TranscriptLine {
  t: number;
  role: TranscriptRole;
  text: string;
  /** Still being transcribed (a partial line is replaced as it grows). */
  final: boolean;
  /** Typed into the desk's text box, not spoken. */
  typed?: boolean;
}

/** Lines kept in the transcript. */
export const TRANSCRIPT_MAX = 200;
/** Calls kept in the tool log. */
export const TOOL_LOG_MAX = 100;

/**
 * The conversation. Live transcription arrives as a growing partial line per speaker, then the
 * final line at the end of the turn; a partial line is updated in place, so each turn is one line.
 */
export class Transcript {
  private readonly items: TranscriptLine[] = [];
  /** The partial line still growing, per speaker. */
  private readonly open = new Map<TranscriptRole, TranscriptLine>();

  get lines(): readonly TranscriptLine[] {
    return this.items;
  }

  /** A transcript fragment (the whole turn so far) or the final line. */
  caption(t: number, role: 'user' | 'coach', text: string, final: boolean): void {
    const open = this.open.get(role);
    if (open) {
      open.text = text;
      open.final = final;
      if (final) this.open.delete(role);
      return;
    }
    if (!text.trim()) return;
    const line: TranscriptLine = { t, role, text, final };
    this.push(line);
    if (!final) this.open.set(role, line);
  }

  /** A learner turn typed into the desk's text box. */
  typed(t: number, text: string): void {
    this.push({ t, role: 'user', text, final: true, typed: true });
  }

  /** An [app] message that reached the voice. */
  narration(t: number, text: string): void {
    this.push({ t, role: 'app', text, final: true });
  }

  clear(): void {
    this.items.length = 0;
    this.open.clear();
  }

  private push(line: TranscriptLine): void {
    this.items.push(line);
    while (this.items.length > TRANSCRIPT_MAX) {
      const dropped = this.items.shift();
      for (const [role, open] of this.open) if (open === dropped) this.open.delete(role);
    }
  }
}

export interface ToolCallEntry {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  t: number;
  /** Unset until the call answered. */
  ok?: boolean;
  result?: unknown;
  /** From the call to its result (ms). */
  ms?: number;
}

/** Every coach tool call and, once it answers, its result: how we see what the voice really does. */
export class ToolLog {
  private readonly items: ToolCallEntry[] = [];

  get entries(): readonly ToolCallEntry[] {
    return this.items;
  }

  call(t: number, callId: string, name: string, args: Record<string, unknown>): void {
    this.items.push({ callId, name, args, t });
    if (this.items.length > TOOL_LOG_MAX) this.items.shift();
  }

  result(t: number, callId: string, ok: boolean, result: unknown): void {
    const entry = this.items.findLast((e) => e.callId === callId);
    if (!entry) return;
    entry.ok = ok;
    entry.result = result;
    entry.ms = Math.max(0, t - entry.t);
  }

  /** How many calls of each tool, e.g. to see at a glance whether highlight is ever called. */
  counts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const e of this.items) counts[e.name] = (counts[e.name] ?? 0) + 1;
    return counts;
  }

  clear(): void {
    this.items.length = 0;
  }
}

/** A value as short readable JSON for the log, cut at `max` characters. */
export function brief(value: unknown, max = 400): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
