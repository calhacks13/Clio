import { createLogger } from '../../core/log';
import type { MicSource } from '../../domain/coach/ports';

const log = createLogger('mic');

/** Microphone → 16 kHz PCM16 chunks via an AudioWorklet (public/worklets/pcm-capture.js). */
export class MicCapture implements MicSource {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;

  /** Ask for microphone permission up front (prompts would interrupt an XR session). */
  static async requestPermission(): Promise<boolean> {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const t of s.getTracks()) t.stop();
      return true;
    } catch (err) {
      log.warn(`microphone unavailable: ${String(err)}`);
      return false;
    }
  }

  async start(onChunk: (pcm16k: Int16Array) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const ctx = new AudioContext();
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}worklets/pcm-capture.js`);
    const source = ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(ctx, 'pcm-capture', {
      processorOptions: { targetRate: 16000, chunkMs: 40 },
    });
    node.port.onmessage = (e: MessageEvent<Int16Array>) => onChunk(e.data);
    // Keep the worklet pulled by the graph without playing the mic back.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node).connect(mute).connect(ctx.destination);
    await ctx.resume();
    log.info(`capturing at ${ctx.sampleRate} Hz → 16 kHz`);
  }

  stop(): void {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    void this.ctx?.close();
    this.stream = null;
    this.ctx = null;
  }
}
