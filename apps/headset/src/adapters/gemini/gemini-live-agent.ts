import { GEMINI_RELAY_PATH } from '@clio/protocol';
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
  ToolTiming,
} from '../../domain/coach/agent';
import { base64ToInt16, int16ToBase64 } from '../audio/pcm';
import { isNonBlocking, toGeminiTools } from './declarations';
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
// before setup completes (js-genai#1257), so it races a timeout and the close event.

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

const SCHEDULING: Record<ToolTiming, FunctionResponseScheduling> = {
  interrupt: FunctionResponseScheduling.INTERRUPT,
  when_idle: FunctionResponseScheduling.WHEN_IDLE,
  silent: FunctionResponseScheduling.SILENT,
};

const MAX_RECONNECTS = 6;

export class GeminiLiveAgent implements RealtimeAgent {
  readonly kind = 'gemini' as const;
  readonly events = new Emitter<AgentEvents>();
  private session: Session | null = null;
  private setup: AgentSetup | null = null;
  private resumeHandle: string | null = null;
  private readonly transcripts = new TranscriptAggregator();
  private closing = false;
  private reconnecting = false;

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
    // turnComplete defaults to true in the SDK; context-only facts must not trigger a reply.
    this.session?.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: n.text }] }],
      turnComplete: n.reply,
    });
  }

  respond(results: ToolResult[]): void {
    this.session?.sendToolResponse({
      functionResponses: results.map((r) => ({
        id: r.id,
        name: r.name,
        response: r.ok ? { output: r.result } : { error: r.result },
        ...(isNonBlocking(r.name) ? { scheduling: SCHEDULING[r.timing ?? 'when_idle'] } : {}),
      })),
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    this.session?.close();
    this.session = null;
    this.events.emit('status', { state: 'closed' });
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
    this.events.emit('status', { state: 'ready' });
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
          this.events.emit('toolCalls', { calls: ev.calls });
          break;
        case 'toolCancel':
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
