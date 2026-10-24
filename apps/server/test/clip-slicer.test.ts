import { DemoClipSchema } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { sliceClips } from '../src/services/clip-slicer';
import { completed, entered, episodeMeta, frame, framesEvery, hand } from './fixtures';

const meta = episodeMeta({
  episodeId: 'ep-1',
  procedure: { id: 'shirt-fold', version: 3, title: 'Fold a T-shirt' },
});

describe('sliceClips', () => {
  it('cuts the frames between step.entered and step.completed and rebases t to 0', () => {
    const clips = sliceClips(meta, framesEvery(10, 90, 140), [
      entered(100, 'pinch'),
      completed(130, 'pinch'),
    ]);
    expect(clips).toEqual([
      {
        schema: 'clio.clip/1',
        clipId: 'shirt-fold/pinch',
        procedureId: 'shirt-fold',
        procedureVersion: 3,
        stepId: 'pinch',
        source: { episodeId: 'ep-1', startT: 100, endT: 130 },
        durationMs: 30,
        frames: [
          { t: 0, left: hand(100), right: null },
          { t: 10, left: hand(110), right: null },
          { t: 20, left: hand(120), right: null },
          { t: 30, left: hand(130), right: null },
        ],
      },
    ]);
    expect(DemoClipSchema.safeParse(clips[0]).success).toBe(true);
  });

  it('skips forced completions and skipped steps, but keeps unforced coach completions', () => {
    const clips = sliceClips(meta, framesEvery(10, 0, 150), [
      entered(0, 'a'),
      completed(50, 'a', { by: 'coach', forced: true }),
      entered(50, 'b'),
      completed(100, 'b', { by: 'skip' }),
      entered(100, 'c'),
      completed(150, 'c', { by: 'coach' }),
    ]);
    expect(clips.map((c) => [c.stepId, c.durationMs, c.frames.length])).toEqual([['c', 50, 6]]);
  });

  it('skips steps with fewer than two frames', () => {
    expect(sliceClips(meta, [frame(0), frame(10)], [entered(0, 'a'), completed(5, 'a')])).toEqual(
      [],
    );
  });

  it('skips completions that were never entered', () => {
    expect(sliceClips(meta, framesEvery(10, 0, 50), [completed(50, 'a')])).toEqual([]);
  });

  it('uses the last completion and the latest step.entered before it', () => {
    const [clip] = sliceClips(meta, framesEvery(10, 0, 60), [
      entered(0, 'a'),
      completed(20, 'a'),
      entered(40, 'a'),
      completed(60, 'a'),
    ]);
    expect(clip?.source).toEqual({ episodeId: 'ep-1', startT: 40, endT: 60 });
    expect(clip?.frames.map((f) => f.t)).toEqual([0, 10, 20]);
  });

  it('keeps an earlier clean completion when a later one was forced', () => {
    const [clip] = sliceClips(meta, framesEvery(10, 0, 60), [
      entered(0, 'a'),
      completed(20, 'a'),
      entered(30, 'a'),
      completed(50, 'a', { by: 'coach', forced: true }),
    ]);
    expect(clip?.source).toEqual({ episodeId: 'ep-1', startT: 0, endT: 20 });
  });

  it('only slices the requested steps', () => {
    const clips = sliceClips(
      meta,
      framesEvery(10, 0, 100),
      [entered(0, 'a'), completed(50, 'a'), entered(50, 'b'), completed(100, 'b')],
      ['b'],
    );
    expect(clips.map((c) => c.clipId)).toEqual(['shirt-fold/b']);
  });

  it('orders clips by start time and sorts frames that arrived out of order', () => {
    const frames = [frame(120), frame(100), frame(110), ...framesEvery(10, 200, 220)];
    const clips = sliceClips(meta, frames, [
      entered(0, 'a'),
      completed(10, 'a'),
      entered(100, 'b'),
      completed(120, 'b'),
      entered(200, 'a'),
      completed(220, 'a'),
    ]);
    expect(clips.map((c) => c.stepId)).toEqual(['b', 'a']);
    expect(clips[0]?.frames.map((f) => [f.t, f.left?.joints[0]])).toEqual([
      [0, 100],
      [10, 110],
      [20, 120],
    ]);
  });

  it('rounds rebased times to microseconds', () => {
    const [clip] = sliceClips(
      meta,
      [frame(1000.1), frame(1016.8), frame(1033.5)],
      [entered(1000, 'a'), completed(1040, 'a')],
    );
    expect(clip?.frames.map((f) => f.t)).toEqual([0, 16.7, 33.4]);
    expect(clip?.durationMs).toBe(33.4);
    expect(clip?.source).toEqual({ episodeId: 'ep-1', startT: 1000.1, endT: 1033.5 });
  });

  it('refuses episodes recorded without a procedure', () => {
    expect(() => sliceClips(episodeMeta({ procedure: null }), [], [])).toThrow(/no procedure/);
  });
});
