import type { ImagePayload } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/clock';
import { RecentFrames } from '../../src/domain/session/recent-frames';

/** A camera whose frames are numbered in the order they were taken. */
function setup(options?: { everyMs?: number; maxAgeMs?: number; keep?: number }) {
  const clock = new ManualClock(1000);
  const calls: number[] = [];
  let taken = 0;
  const camera = {
    snapshots: async (max: number): Promise<ImagePayload[]> => {
      calls.push(max);
      return Array.from({ length: max }, () => ({
        mimeType: 'image/jpeg' as const,
        data: `f${++taken}`,
      }));
    },
  };
  const frames = new RecentFrames(camera, clock, options);
  /** One frame tick, waiting for the capture it started. */
  const tick = async (warm = true) => {
    await frames.tick(clock.now(), warm);
  };
  const data = (images: ImagePayload[]) => images.map((i) => i.data);
  return { clock, calls, frames, tick, data };
}

describe('RecentFrames', () => {
  it('hands over the frames it kept, newest last, without asking the camera', async () => {
    const { clock, calls, frames, tick, data } = setup();
    await tick();
    clock.advance(450);
    await tick();
    expect(calls).toEqual([1, 1]);
    const { images, from } = await frames.take(2);
    expect(data(images)).toEqual(['f1', 'f2']);
    expect(from).toBe('buffered');
    expect(calls).toEqual([1, 1]);
  });

  it('keeps a frame every everyMs while warm, one capture at a time, and only the last few', async () => {
    const { clock, calls, frames, tick, data } = setup({ everyMs: 450, keep: 2 });
    const first = frames.tick(clock.now(), true);
    expect(frames.tick(clock.now(), true)).toBeNull();
    await first;
    expect(frames.tick(clock.advance(449), true)).toBeNull();
    await tick();
    expect(calls).toEqual([1]);
    clock.advance(1);
    await tick();
    clock.advance(450);
    await tick();
    expect(calls).toEqual([1, 1, 1]);
    expect(data(await frames.snapshots(3))).toEqual(['f2', 'f3', 'f4']);
  });

  it('tops up from the camera at once when it has fewer recent frames than asked', async () => {
    const { calls, frames, tick, data } = setup();
    await tick();
    const { images, from } = await frames.take(2);
    expect(calls).toEqual([1, 1]);
    expect(data(images)).toEqual(['f1', 'f2']);
    expect(from).toBe('buffered');
  });

  it("takes the camera's own frames when what it kept is too old", async () => {
    const { clock, calls, frames, tick, data } = setup({ maxAgeMs: 1000 });
    await tick();
    clock.advance(1001);
    const { images, from } = await frames.take(2);
    expect(calls).toEqual([1, 2]);
    expect(data(images)).toEqual(['f2', 'f3']);
    expect(from).toBe('fresh');
  });

  it('forgets its frames when cold, including one still being taken', async () => {
    const { clock, calls, frames, tick } = setup();
    await tick();
    const late = frames.tick(clock.advance(450), true);
    await tick(false);
    await late;
    expect(calls).toEqual([1, 1]);
    expect((await frames.take(2)).from).toBe('fresh');
    // Warm again, it keeps a frame at once.
    await tick();
    expect(calls).toEqual([1, 1, 2, 1]);
  });

  it('says when there are no frames at all', async () => {
    const { frames } = setup();
    const none = new RecentFrames({ snapshots: async () => [] }, new ManualClock(0));
    expect((await none.take(2)).from).toBe('none');
    expect(await frames.take(0)).toEqual({ images: [], from: 'none' });
  });
});
