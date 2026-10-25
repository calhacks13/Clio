import { describe, expect, it } from 'vitest';
import { MutableMic } from '../../src/desk/muted-mic';
import type { MicSource } from '../../src/domain/coach/ports';

describe('MutableMic', () => {
  it('passes the microphone through, and silence of the same length while muted', async () => {
    let feed: (pcm: Int16Array) => void = () => {};
    let stopped = false;
    const inner: MicSource = {
      start: async (onChunk) => {
        feed = onChunk;
      },
      stop: () => {
        stopped = true;
      },
    };
    const heard: Int16Array[] = [];
    const mic = new MutableMic(inner);
    await mic.start((pcm) => heard.push(pcm));
    feed(new Int16Array([5, -5, 7]));
    mic.muted = true;
    feed(new Int16Array([9, 9]));
    mic.muted = false;
    feed(new Int16Array([1]));
    expect(heard.map((pcm) => [...pcm])).toEqual([[5, -5, 7], [0, 0], [1]]);
    mic.stop();
    expect(stopped).toBe(true);
  });
});
