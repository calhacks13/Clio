import type { MicSource } from '../domain/coach/ports';

// The desk's mute switch for the learner's microphone. While muted the voice hears silence, not
// nothing: the same chunks, zeroed, so its turn detection sees the learner stop talking (a mic
// that just went quiet mid-sentence would leave the turn open).

export class MutableMic implements MicSource {
  muted = false;

  constructor(private readonly inner: MicSource) {}

  start(onChunk: (pcm16k: Int16Array) => void): Promise<void> {
    return this.inner.start((pcm) => onChunk(this.muted ? new Int16Array(pcm.length) : pcm));
  }

  stop(): void {
    this.inner.stop();
  }
}
