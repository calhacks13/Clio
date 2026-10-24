import { GEMINI_RELAY_PATH, isNonBlockingTool } from '@clio/protocol';
import {
  FunctionResponseScheduling,
  GoogleGenAI,
  type LiveConnectConfig,
  type LiveServerMessage,
  MediaResolution,
  Modality,
  type Session,
} from '@google/genai';
import { Emitter } from '../../core/emitter';
import { createLogger } from '../../core/log';
import type {
  AgentEvents,
  AgentSetup,
  Narration,
  RealtimeAgent,
  ToolResult,
} from '../../domain/coach/agent';
import { base64ToInt16, int16ToBase64 } from '../audio/pcm';
import { toGeminiTools } from './declarations';
import { interpretServerMessage, TranscriptAggregator } from './messages';

// RealtimeAgent over the Gemini Live API (@google/genai 2.31, model gemini-3.8-live).
//
// Transports: "relay" (default) points the SDK at the laptop server, which proxies the WebSocket
// and injects the API key, so the headset holds no key and needs no internet of its own. "direct"
// connects to Google with an ephemeral token minted by the server.
//
// Robustness: audio+video sessions end after ~2 minutes without context-window compression, so it
// is always on; connections are recycled about every 10 minutes (goAway) and can drop, so we keep
// the latest resumption handle and reconnect with backoff. connect() can hang if the socket closes
// before setup completes (js-genai#1257), so it races a timeout and the close event. While there
// is no connection, narrations wait (the newest few) and go out as one turn once it is back,
// together with whatever is narrated on 'ready'; tool answers and media for a dead connection are
// dropped. updateInstruction() changes the system
// instruction the next connection starts with, so a reconnect starts from the current plan.
//
// Tool answers go only to the connection that made the call, and not to a call it cancelled: Live
// matches an answer with an id it never issued to a call still pending, and speaks it twice. A
// non-blocking call's answer (look_closer) is scheduled WHEN_IDLE, so the voice says it once
// neither it nor the learner is talking; INTERRUPT would cut its own filler off mid-word, and
// SILENT would never say it.

const log = createLogger('gemini');

export interface GeminiLiveOptions {
  model: string;
  transport: 'relay' | 'direct';
  /** For relay: origin of the page (the Vite proxy forwards /gemini to the server). */
  origin?: string;
  /** For direct: mint an ephemeral token. */
  token?: () => Promise<string>;
  voice?: string;
  connectTimeoutMs?: number;
}

const MAX_RECONNECTS = 6;
/** Narrations kept while there is no connection. */
const MAX_QUEUED = 10;

export class GeminiLiveAgent implements RealtimeAgent {
  readonly kind = 'gemini' as const;
  readonly events = new Emitter<AgentEvents>();
  private session: Session | null = null;
  private setup: AgentSetup | null = null;
  private resumeHandle: string | null = null;
  private readonly transcripts = new TranscriptAggregator();
  private closing = false;
  private reconnecting = false;
  private queued: Narration[] = [];
  /** Ids of the calls the current connection made and hasn't had answered. */
  private openCalls = new Set<string>();
  /** While 'ready' is announced, narrations join the queue so they go out in one turn. */
  private replaying = false;

  constructor(private readonly options: GeminiLiveOptions) {}

  get model(): string {
    return this.options.model;
  }

  async connect(setup: AgentSetup): Promise<void> {
    this.setup = setup;
    this.closing = false;
    await this.open('connecting');
  }

  pushAudio(pcm16k: Int16Array): void {
    this.session?.sendRealtimeInput({
      audio: { data: int16ToBase64(pcm16k), mimeType: 'audio/pcm;rate=16000' },
    });
  }

  pushImage(jpegBase64: string): void {
    this.session?.sendRealtimeInput({ video: { data: jpegBase64, mimeType: 'image/jpeg' } });
  }

  narrate(n: Narration): void {
    if (this.session && !this.replaying) {
      this.sendTurn(n.text, n.reply);
      return;
    }
    if (this.closing) return;
    this.queued.push(n);
    if (this.queued.length > MAX_QUEUED) this.queued.shift();
  }

  respond(results: ToolResult[]): void {
    const open = results.filter((r) => this.openCalls.delete(r.id));
    if (open.length < results.length) log.info('dropped answers to calls this connection lacks');
    if (open.length === 0) return;
    this.session?.sendToolResponse({
      functionResponses: open.map((r) => ({
        id: r.id,
        name: r.name,
        response: r.ok ? { output: r.result } : { error: r.result },
        ...(isNonBlockingTool(r.name) ? { scheduling: FunctionResponseScheduling.WHEN_IDLE } : {}),
      })),
    });
  }

  updateInstruction(systemInstruction: string): void {
    if (this.setup) this.setup = { ...this.setup, systemInstruction };
  }

  async close(): Promise<void> {
    this.closing = true;
    this.queued = [];
    this.session?.close();
    this.session = null;
    this.events.emit('status', { state: 'closed' });
  }

  private sendTurn(text: string, reply: boolean): void {
    // turnComplete defaults to true in the SDK; context-only facts must not trigger a reply.
    this.session?.sendClientContent({
      turns: [{ role: 'user', parts: [{ text }] }],
      turnComplete: reply,
    });
  }

  /** What was narrated while there was no connection, as one turn. */
  private sendQueued(): void {
    const queued = this.queued;
    this.queued = [];
    if (queued.length === 0) return;
    this.sendTurn(
      queued.map((n) => n.text).join(' '),
      queued.some((n) => n.reply),
    );
  }

  private async client(): Promise<GoogleGenAI> {
    if (this.options.transport === 'direct') {
      if (!this.options.token) throw new Error('Direct transport needs a token provider');
      return new GoogleGenAI({ apiKey: await this.options.token() });
    }
    const origin = this.options.origin ?? location.origin;
    // The key is a placeholder: the relay replaces it server-side.
    return new GoogleGenAI({
      apiKey: 'relay',
      httpOptions: { baseUrl: `${origin}${GEMINI_RELAY_PATH}` },
    });
  }

  private config(): LiveConnectConfig {
    const setup = this.setup;
    if (!setup) throw new Error('connect() first');
    return {
      responseModalities: [Modality.AUDIO],
      systemInstruction: setup.systemInstruction,
      tools: toGeminiTools(setup.tools),
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: {
        triggerTokens: '25000',
        slidingWindow: { targetTokens: '12000' },
      },
      sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
      ...(this.options.voice
        ? {
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: this.options.voice } },
            },
          }
        : {}),
    };
  }

  private async open(state: 'connecting' | 'reconnecting'): Promise<void> {
    this.events.emit('status', { state });
    this.openCalls.clear();
    const ai = await this.client();
    let rejectClosed: (reason: Error) => void = () => {};
    const closedEarly = new Promise<never>((_, reject) => {
      rejectClosed = reject;
    });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('Gemini Live connect timed out')),
        this.options.connectTimeoutMs ?? 12_000,
      ),
    );
    const connecting = ai.live.connect({
      model: this.options.model,
      config: this.config(),
      callbacks: {
        onmessage: (msg: LiveServerMessage) => this.onMessage(msg),
        onerror: (e: ErrorEvent) => log.warn(`socket error: ${e.message}`),
        onclose: (e: CloseEvent) => {
          rejectClosed(new Error(`closed during setup (${e.code} ${e.reason})`));
          this.onClose(e);
        },
      },
    });
    this.session = await Promise.race([connecting, closedEarly, timeout]);
    // What is said on 'ready' (a recap) follows what was missed in the same turn: a second message
    // would interrupt the reply to the first.
    this.replaying = true;
    this.events.emit('status', { state: 'ready' });
    this.replaying = false;
    this.sendQueued();
  }

  private onMessage(msg: LiveServerMessage): void {
    for (const ev of interpretServerMessage(msg)) {
      switch (ev.kind) {
        case 'audio':
          this.events.emit('audio', { pcm: base64ToInt16(ev.data), sampleRate: ev.sampleRate });
          break;
        case 'transcript':
          this.events.emit('transcript', this.transcripts.add(ev.role, ev.text));
          break;
        case 'interrupted':
          this.events.emit('interrupted', {});
          break;
        case 'turnComplete':
          for (const t of this.transcripts.complete()) this.events.emit('transcript', t);
          this.events.emit('turnComplete', {});
          break;
        case 'toolCalls':
          for (const call of ev.calls) this.openCalls.add(call.id);
          this.events.emit('toolCalls', { calls: ev.calls });
          break;
        case 'toolCancel':
          for (const id of ev.ids) this.openCalls.delete(id);
          this.events.emit('cancelledTools', { ids: ev.ids });
          break;
        case 'goAway':
          log.info(`server recycling the connection (${ev.timeLeft} left)`);
          void this.reconnect();
          break;
        case 'resumption':
          this.resumeHandle = ev.handle;
          break;
        case 'setupComplete':
          break;
      }
    }
  }

  private onClose(e: CloseEvent): void {
    if (this.closing || this.reconnecting) return;
    log.warn(`connection closed (${e.code} ${e.reason}); reconnecting`);
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.closing) return;
    this.reconnecting = true;
    const old = this.session;
    this.session = null;
    old?.close();
    try {
      for (let attempt = 1; attempt <= MAX_RECONNECTS && !this.closing; attempt++) {
        try {
          await this.open('reconnecting');
          return;
        } catch (err) {
          log.warn(`reconnect ${attempt} failed: ${String(err)}`);
          await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt)));
        }
      }
      this.events.emit('status', { state: 'error', detail: 'Lost the connection to Gemini' });
    } finally {
      this.reconnecting = false;
    }
  }
}
