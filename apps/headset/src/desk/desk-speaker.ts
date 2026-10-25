import { SpeakerOutput } from '../adapters/audio/voice-output';
import type { VoiceOutput } from '../domain/coach/ports';

// The coach's voice on the laptop's speakers. The headset's SpeakerOutput opens its AudioContext
// as it is made, which a browser refuses before the page has been clicked; this one makes it on
// the first unlock (the Start button), so the page opens without that complaint. Unlike the
// headset's boot page on a desktop, the desk lab is never muted: hearing the coach is the point.

export class DeskSpeaker implements VoiceOutput {
  private out: SpeakerOutput | null = null;

  /** From a click: open the audio output (once) and let it play. */
  async unlock(): Promise<void> {
    this.out ??= new SpeakerOutput(false);
    await this.out.unlock();
  }

  play(pcm: Int16Array, sampleRate: number): void {
    this.out?.play(pcm, sampleRate);
  }

  say(text: string): void {
    this.out?.say(text);
  }

  stop(): void {
    this.out?.stop();
  }

  playing(): boolean {
    return this.out?.playing() ?? false;
  }
}
