import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  DEFAULT_FRAME_WIDTH,
  type EncodedJpeg,
  type FrameImage,
  FrameStream,
  type FrameStreamOptions,
  fit,
  frameSize,
  MAX_FPS,
  RecentSamples,
  type StreamedFrame,
} from '../../src/primary/frame-stream';

/** An encoding the test finishes (or fails) by hand. */
interface Encoding {
  image: FrameImage;
  width: number;
  height: number;
  resolve(jpeg: EncodedJpeg): void;
  reject(err: unknown): void;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(
  { options = {}, ready = true } = {} as { options?: FrameStreamOptions; ready?: boolean },
) {
  let now = 0;
  let connected = ready;
  let grabs = 0;
  const encodings: Encoding[] = [];
  const sent: (StreamedFrame & { sentT: number })[] = [];
  const failures: unknown[] = [];
  let timers: { fn: () => void; at: number }[] = [];
  const stream = new FrameStream({
    now: () => now,
    ready: () => connected,
    grab: () => {
      grabs++;
      return { source: {} as CanvasImageSource, width: 1280, height: 960, t: now - 20 };
    },
    send: (frame) => {
      if (!connected) return false;
      sent.push({ ...frame, sentT: now });
      return true;
    },
    encode: (image, width, height) =>
      new Promise((resolve, reject) => encodings.push({ image, width, height, resolve, reject })),
    failed: (err) => failures.push(err),
    setTimeout: (fn, ms) => {
      const timer = { fn, at: now + ms };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      timers = timers.filter((t) => t !== handle);
    },
    options,
  });
  /** Move the clock to t, running the timers due by then. */
  const advance = (t: number) => {
    for (;;) {
      const due = timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((x) => x !== due);
      now = Math.max(now, due.at);
      due.fn();
    }
    now = t;
  };
  /** An XR frame at time t (and the work it deferred). */
  const at = (t: number) => {
    advance(t);
    stream.tick();
    advance(t);
  };
  /** Finish encoding `i` at time t, and let the stream act on it. */
  const encoded = async (i: number, t: number) => {
    advance(t);
    encodings[i]?.resolve({ bytes: new Uint8Array([0xff, 0xd8, i]), base64: '' });
    await flush();
    advance(t);
  };
  /** The tracker answers frame `seq` at time t. */
  const answer = (seq: number, t: number) => {
    advance(t);
    stream.received(seq);
    advance(t);
  };
  const connect = (open: boolean) => {
    connected = open;
  };
  return {
    stream,
    encodings,
    sent,
    failures,
    at,
    advance,
    encoded,
    answer,
    connect,
    grabs: () => grabs,
  };
}

describe('FrameStream', () => {
  it('shrinks frames to the default 480x360, stamped with their capture time and a rising seq', async () => {
    const { stream, encodings, sent, at, encoded, answer } = setup();
    stream.start();
    at(100);
    expect(encodings[0]).toMatchObject({ width: 480, height: 360 });
    await encoded(0, 110);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ seq: 1, t: 80, width: 480, height: 360 });
    answer(1, 150);
    at(200);
    await encoded(1, 210);
    expect(sent.map((f) => f.seq)).toEqual([1, 2]);
  });

  it('takes its frame size from the options', () => {
    const { stream, encodings, at } = setup({ options: frameSize('640') });
    stream.start();
    at(0);
    expect(encodings[0]).toMatchObject({ width: 640, height: 480 });
  });

  it('never encodes a second frame while one is encoding', () => {
    const { stream, encodings, at } = setup();
    stream.start();
    for (let t = 0; t < 2000; t += 10) at(t);
    expect(encodings).toHaveLength(1);
  });

  it('encodes the next frame while one is out, and sends it the moment the answer arrives', async () => {
    const { stream, encodings, sent, at, advance, encoded, answer } = setup();
    stream.start();
    at(0);
    await encoded(0, 5);
    // The next frame is encoded while frame 1 is out, in time for the cap (5 + 33 ms)...
    at(14);
    at(28);
    expect(encodings).toHaveLength(1);
    advance(34);
    expect(encodings).toHaveLength(2);
    await encoded(1, 38);
    // ...but never sent before frame 1's answer: only the newest frame is tracked.
    for (let t = 42; t < 60; t += 14) at(t);
    expect(sent.map((f) => f.seq)).toEqual([1]);
    answer(1, 60);
    expect(sent.map((f) => [f.seq, f.sentT])).toEqual([
      [1, 5],
      [2, 60],
    ]);
    expect(stream.stats.aheadShare).toBe(0.5);
  });

  it('times the encoding ahead to the answer it expects', async () => {
    const { stream, encodings, at, encoded, answer } = setup({ options: { maxFps: 1000 } });
    stream.start();
    // The tracker takes 60 ms and the encoding 10 ms, twice.
    at(0);
    await encoded(0, 10);
    answer(1, 70);
    await encoded(1, 80);
    answer(2, 140);
    await encoded(2, 150);
    expect(encodings).toHaveLength(3);
    // Frame 3 went at 150: its answer is due at 210, so the next is grabbed from 185 on.
    for (let t = 151; t < 185; t += 7) at(t);
    expect(encodings).toHaveLength(3);
    at(186);
    expect(encodings).toHaveLength(4);
  });

  it('drops a frame encoded ahead that grew stale, for a fresh one', async () => {
    const { stream, encodings, sent, at, advance, encoded, answer } = setup();
    stream.start();
    at(0);
    await encoded(0, 5);
    at(28);
    advance(34);
    await encoded(1, 38);
    // The answer comes late; the frame encoded at 38 has waited more than 50 ms by then, and it
    // is not encoded again and again meanwhile.
    for (let t = 42; t < 120; t += 14) at(t);
    expect(encodings).toHaveLength(2);
    answer(1, 120);
    expect(sent).toHaveLength(1);
    expect(encodings).toHaveLength(3);
    await encoded(2, 125);
    expect(sent.map((f) => [f.seq, f.sentT, f.jpeg.bytes[2]])).toEqual([
      [1, 5, 0],
      [2, 125, 2],
    ]);
  });

  it('sends the next frame after 500 ms without an answer', async () => {
    const { stream, sent, at, encoded } = setup();
    stream.start();
    at(0);
    await encoded(0, 10);
    for (let t = 20; t < 510; t += 14) at(t);
    expect(sent).toHaveLength(1);
    at(510);
    await encoded(1, 512);
    expect(sent.map((f) => f.seq)).toEqual([1, 2]);
  });

  it('ignores a late answer for an older frame', async () => {
    const { stream, sent, at, encoded, answer } = setup();
    stream.start();
    at(0);
    await encoded(0, 10);
    at(600);
    await encoded(1, 610);
    // Frame 1's answer comes after frame 2 went: frame 2 is still out, so nothing more goes...
    answer(1, 620);
    for (let t = 630; t < 700; t += 14) at(t);
    await encoded(2, 700);
    expect(sent.map((f) => f.seq)).toEqual([1, 2]);
    expect(stream.stats.sendToAnswerMs).toBeNull();
    // ...until frame 2's own answer.
    answer(2, 710);
    expect(sent.map((f) => f.seq)).toEqual([1, 2, 3]);
  });

  it('caps the stream at MAX_FPS frames a second however fast answers come back', async () => {
    const { stream, encodings, sent, advance, at, answer } = setup();
    stream.start();
    let answered = 0;
    for (let t = 0; t < 2000; t += 1) {
      at(t);
      const pending = encodings.length;
      // Every encoding takes no time, every answer 2 ms.
      encodings[pending - 1]?.resolve({ bytes: new Uint8Array(), base64: '' });
      for (let i = 0; i < 4; i++) await Promise.resolve();
      advance(t);
      const last = sent.at(-1);
      if (last && last.seq > answered && t - last.sentT >= 2) {
        answered = last.seq;
        answer(last.seq, t);
      }
    }
    expect(sent.length).toBeLessThanOrEqual(2 * MAX_FPS + 1);
    expect(sent.length).toBeGreaterThanOrEqual(2 * MAX_FPS - 1);
    for (let i = 1; i < sent.length; i++) {
      expect((sent[i]?.sentT ?? 0) - (sent[i - 1]?.sentT ?? 0)).toBeGreaterThanOrEqual(
        1000 / MAX_FPS - 1,
      );
    }
  });

  it('holds a frame for the cap on a timer, grabbing it just before it may go', async () => {
    const { stream, encodings, sent, at, encoded, answer, advance } = setup();
    stream.start();
    at(0);
    await encoded(0, 4);
    answer(1, 10);
    // Answered 6 ms after it went; the cap allows the next at 4 + 33.3 = 37.3. With a 4 ms
    // encoding it is grabbed at about 33, from a timer rather than the next XR frame.
    advance(32);
    expect(encodings).toHaveLength(1);
    advance(34);
    expect(encodings).toHaveLength(2);
    await encoded(1, 35);
    expect(sent).toHaveLength(1);
    advance(38);
    expect(sent.map((f) => f.seq)).toEqual([1, 2]);
    expect(sent[1]?.sentT).toBeCloseTo(4 + 1000 / MAX_FPS, 5);
  });

  it('grabs a frame just in time for the cap while one is out, when answers come sooner', async () => {
    const { stream, encodings, sent, at, advance, encoded, answer } = setup();
    stream.start();
    // Encoding takes 12 ms and the tracker answers in 20, inside the cap's 33.
    at(0);
    await encoded(0, 12);
    answer(1, 32);
    advance(34);
    expect(encodings).toHaveLength(2);
    await encoded(1, 12 + 1000 / MAX_FPS);
    const sentT = sent[1]?.sentT ?? 0;
    // Frame 2 is out, its answer due 20 ms on; the cap holds the next until 33 ms on, so it is
    // grabbed 12 ms before that, from a timer, and not on an earlier XR frame.
    for (let t = sentT + 1; t < sentT + 20; t += 7) at(t);
    expect(encodings).toHaveLength(2);
    answer(2, sentT + 20);
    advance(sentT + 1000 / MAX_FPS - 12.5);
    expect(encodings).toHaveLength(2);
    advance(sentT + 1000 / MAX_FPS - 11.5);
    expect(encodings).toHaveLength(3);
    expect((encodings[2]?.image.t ?? 0) + 20).toBeCloseTo(sentT + 1000 / MAX_FPS - 12, 0);
  });

  it('encodes nothing until the tracker is connected', async () => {
    const { stream, encodings, sent, at, encoded, connect } = setup({ ready: false });
    stream.start();
    at(0);
    at(1000);
    expect(encodings).toHaveLength(0);
    connect(true);
    at(1100);
    await encoded(0, 1110);
    expect(sent[0]?.seq).toBe(1);
  });

  it('stops streaming, and drops a frame that finishes encoding after the stop', async () => {
    const { stream, encodings, sent, at, encoded } = setup();
    stream.start();
    at(0);
    stream.stop();
    await encoded(0, 10);
    expect(sent).toEqual([]);
    at(1000);
    expect(encodings).toHaveLength(1);
    expect(stream.latest(10_000)).toBeNull();
  });

  it('grabs nothing when stopped before a deferred encoding starts', () => {
    const { stream, encodings, advance, grabs } = setup();
    stream.start();
    stream.tick();
    stream.stop();
    advance(10);
    expect(grabs()).toBe(0);
    expect(encodings).toHaveLength(0);
  });

  it('waits for an encoding still running from before a restart', async () => {
    const { stream, encodings, sent, at, encoded } = setup();
    stream.start();
    at(0);
    stream.stop();
    stream.start();
    at(1000);
    expect(encodings).toHaveLength(1);
    await encoded(0, 1010);
    expect(sent).toEqual([]);
    at(1100);
    expect(encodings).toHaveLength(2);
  });

  it('carries on after a failed encoding', async () => {
    const { stream, encodings, failures, at } = setup();
    stream.start();
    at(0);
    encodings[0]?.reject(new Error('no bitmap'));
    await flush();
    expect(failures).toHaveLength(1);
    at(100);
    expect(encodings).toHaveLength(2);
  });

  it('keeps the last frame sent for a look, while it is recent', async () => {
    const { stream, at, encoded } = setup();
    stream.start();
    at(0);
    await encoded(0, 10);
    expect(stream.latest(1000)?.seq).toBe(1);
    at(1011);
    expect(stream.latest(1000)).toBeNull();
  });

  it('counts results per second and times the round trip', async () => {
    const { stream, at, encoded, answer } = setup();
    stream.start();
    at(0);
    await encoded(0, 10);
    answer(1, 40);
    expect(stream.stats).toMatchObject({ sendToAnswerMs: 30, encodeMs: 10 });
    for (let t = 100; t <= 2000; t += 100) answer(0, t);
    expect(stream.fps).toBe(10.5);
  });
});

describe('frameSize', () => {
  it('takes a known width at 4:3, else the default', () => {
    expect(frameSize('640')).toEqual({ maxWidth: 640, maxHeight: 480 });
    expect(frameSize('512')).toEqual({ maxWidth: 512, maxHeight: 384 });
    expect(frameSize('320')).toEqual({ maxWidth: 320, maxHeight: 240 });
    const fallback = { maxWidth: DEFAULT_FRAME_WIDTH, maxHeight: (DEFAULT_FRAME_WIDTH * 3) / 4 };
    expect(frameSize(null)).toEqual(fallback);
    expect(frameSize('1000')).toEqual(fallback);
    expect(frameSize('wide')).toEqual(fallback);
  });
});

describe('fit', () => {
  it('keeps the aspect within the size and never upscales', () => {
    expect(fit(1280, 960, 640, 480)).toEqual({ width: 640, height: 480 });
    expect(fit(1920, 1080, 640, 480)).toEqual({ width: 640, height: 360 });
    expect(fit(320, 240, 640, 480)).toEqual({ width: 320, height: 240 });
  });
});

describe('RecentSamples', () => {
  it('keeps the median and mean of the last values', () => {
    const samples = new RecentSamples(3);
    expect(samples.p50).toBeNull();
    for (const v of [100, 1, 2, 3]) samples.add(v);
    expect(samples.p50).toBe(2);
    expect(samples.mean).toBe(2);
    samples.clear();
    expect(samples.mean).toBeNull();
  });
});

describe('base64', () => {
  it('round-trips JPEG bytes', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    expect(bytesToBase64(bytes)).toBe('/9j/4A==');
    expect([...base64ToBytes('/9j/4A==')]).toEqual([...bytes]);
  });
});
