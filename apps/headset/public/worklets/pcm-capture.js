// AudioWorklet: microphone → 16 kHz mono PCM16, posted in ~40 ms chunks (what the Live API wants).
// Plain JS on purpose: worklets are loaded by URL, outside the bundler.
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { targetRate = 16000, chunkMs = 40 } = options.processorOptions ?? {};
    // Input samples per output sample (e.g. 48000 / 16000 = 3).
    this.ratio = sampleRate / targetRate;
    this.chunk = new Int16Array(Math.round((targetRate * chunkMs) / 1000));
    this.filled = 0;
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      // Box-filter decimation: average each output sample's input window (cheap anti-aliasing).
      this.sum += input[i];
      this.count += 1;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.sum / this.count));
        this.sum = 0;
        this.count = 0;
        this.chunk[this.filled++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.filled === this.chunk.length) {
          this.port.postMessage(this.chunk.slice(0));
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
