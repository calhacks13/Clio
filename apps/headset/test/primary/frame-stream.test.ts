import { describe, expect, it } from 'vitest';
import {
  type FrameImage,
  FrameStream,
  type FrameStreamOptions,
  fit,
  jpegBase64,
  type StreamedFrame,
} from '../../src/primary/frame-stream';

/** An encoding the test finishes (or fails) by hand. */
interface Encoding {
  image: FrameImage;
  width: number;
  height: number;
  resolve(blob: Blob): void;
  reject(err: unknown): void;
}

function setup(
  { options = {}, ready = true } = {} as { options?: FrameStreamOptions; ready?: boolean },
) {
  let now = 0;
  let connected = ready;
  const encodings: Encoding[] = [];
  const sent: StreamedFrame[] = [];
  const failures: unknown[] = [];
  const stream = new FrameStream({
    now: () => now,
    ready: () => connected,
    grab: () => ({ source: {} as ImageBitmapSource, width: 1280, height: 960, t: now - 20 }),
    send: (frame) => {
      if (!connected) return false;
      sent.push(frame);
      return true;
    },
    encode: (image, width, height) =>
      new Promise((resolve, reject) => encodings.push({ image, width, height, resolve, reject })),
    failed: (err) => failures.push(err),
    options,
  });
  const at = (t: number) => {
    now = t;
    stream.tick();
  };
  /** Finish encoding `i` and let the stream send it, at time t. */
  const encoded = async (i: number, t: number) => {
    now = t;
    encodings[i]?.resolve(new Blob([new Uint8Array([0xff, 0xd8, i])], { type: 'image/jpeg' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const connect = (open: boolean) => {
    connected = open;
  };
  return { stream, encodings, sent, failures, at, encoded, connect };
}

describe('FrameStream', () => {
  it('shrinks frames to 640x480, stamped with their capture time and a rising seq', async () => {
    const { stream, encodings, sent, at, encoded } = setup();
    stream.start();
    at(100);
    expect(encodings[0]).toMatchObject({ width: 640, height: 480 });
    await encoded(0, 110);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ seq: 1, t: 80, width: 640, height: 480 });
    stream.received(1);
    at(200);
    await encoded(1, 210);
    expect(sent.map((f) => f.seq)).toEqual([1, 2]);
  });

  it('never encodes a second frame while one is encoding', () => {
    const { stream, encodings, at } = setup();
    stream.start();
    for (let t = 0; t < 2000; t += 10) at(t);
    expect(encodings).toHaveLength(1);
  });

  it('sends the next frame once the last result is back, or after 500 ms without it', async () => {
    const { stream, encodings, at, encoded } = setup();
    stream.start();
    at(0);
    await encoded(0, 10);
    at(100);
    at(509);
    expect(encodings).toHaveLength(1);
    at(510);
    expect(encodings).toHaveLength(2);
    await encoded(1, 520);

    stream.received(2);
    at(600);
    expect(encodings).toHaveLength(3);
  });

  it('ignores a late result for an older frame', async () => {
    const { stream, encodings, at, encoded } = setup();
    stream.start();
    at(0);
    await encoded(0, 10);
    at(600);
    await encoded(1, 610);
    stream.received(1);
    at(700);
    expect(encodings).toHaveLength(2);
  });

  it('caps the stream at 15 frames a second however fast results come back', async () => {
    const { stream, encodings, sent, at, encoded } = setup();
    stream.start();
    const starts: number[] = [];
    for (let t = 0; t < 2000; t += 5) {
      const before = encodings.length;
      at(t);
      if (encodings.length === before) continue;
      starts.push(t);
      await encoded(before, t);
      stream.received(sent.at(-1)?.seq ?? 0);
    }
    expect(starts.length).toBeLessThanOrEqual(30);
    expect(starts.length).toBeGreaterThanOrEqual(28);
    for (let i = 1; i < starts.length; i++) {
      expect((starts[i] ?? 0) - (starts[i - 1] ?? 0)).toBeGreaterThanOrEqual(1000 / 15);
    }
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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

  it('counts results per second', async () => {
    const { stream, at } = setup();
    stream.start();
    for (let t = 0; t <= 2000; t += 100) {
      at(t);
      stream.received(0);
    }
    expect(stream.fps).toBe(10.5);
  });
});

describe('fit', () => {
  it('keeps the aspect within the size and never upscales', () => {
    expect(fit(1280, 960, 640, 480)).toEqual({ width: 640, height: 480 });
    expect(fit(1920, 1080, 640, 480)).toEqual({ width: 640, height: 360 });
    expect(fit(320, 240, 640, 480)).toEqual({ width: 320, height: 240 });
  });
});

describe('jpegBase64', () => {
  it('encodes the bytes of a blob', async () => {
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])]);
    expect(await jpegBase64(blob)).toBe('/9j/4A==');
  });
});
