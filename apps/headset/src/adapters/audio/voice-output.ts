import type { VoiceOutput } from '../../domain/coach/ports';
import { int16ToFloat32 } from './pcm';

/**
 * Speaker: gapless playback of streamed PCM (the Live model's 24 kHz voice), with an instant
 * flush for barge-in, plus speechSynthesis for agents that produce text (the scripted coach).
 */
export class SpeakerOutput implements VoiceOutput {
  private readonly ctx = new AudioContext();
  private readonly sources = new Set<AudioBufferSourceNode>();
  private nextStart = 0;

  /** AudioContexts start suspended until a user gesture; call from a click handler. */
  async unlock(): Promise<void> {
    await this.ctx.resume();
  }

  play(pcm: Int16Array, sampleRate: number): void {
    if (pcm.length === 0) return;
    const buffer = this.ctx.createBuffer(1, pcm.length, sampleRate);
    buffer.copyToChannel(int16ToFloat32(pcm), 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    // Schedule back to back; a small lead absorbs network jitter at the start of a turn.
    this.nextStart = Math.max(this.nextStart, this.ctx.currentTime + 0.03);
    source.start(this.nextStart);
    this.nextStart += buffer.duration;
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }

  say(text: string): void {
    if (!('speechSynthesis' in window)) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    speechSynthesis.speak(utterance);
  }

  stop(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // already stopped
      }
    }
    this.sources.clear();
    this.nextStart = 0;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }
}
