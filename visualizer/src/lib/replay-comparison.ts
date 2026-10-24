import type { VideoInfo } from "@/types/video.types";

export const COMPARISON_DIVIDER_SIZE = 14;

export function comparisonSplitBounds(span: number) {
  const available = Math.max(span - COMPARISON_DIVIDER_SIZE, 1);
  const min = Math.min(40, Math.max(20, (180 / available) * 100));
  return { min, max: 100 - min };
}

export function clampComparisonSplit(percent: number, span: number) {
  const { min, max } = comparisonSplitBounds(span);
  return Math.max(min, Math.min(max, Number.isFinite(percent) ? percent : 50));
}

export function comparisonSplitAt(
  position: number,
  start: number,
  span: number,
) {
  const available = Math.max(span - COMPARISON_DIVIDER_SIZE, 1);
  return clampComparisonSplit(
    ((position - start - COMPARISON_DIVIDER_SIZE / 2) / available) * 100,
    span,
  );
}

export function replayFrameAtTime(time: number, fps: number, count: number) {
  if (!Number.isFinite(time) || count < 1) return 0;
  const rate = fps > 0 && Number.isFinite(fps) ? fps : 30;
  return Math.max(0, Math.min(count - 1, Math.round(time * rate)));
}

/** Replay seconds are relative to the episode, while segmented videos use file time. */
export function videoTimeAtReplayTime(
  info: VideoInfo,
  time: number,
  duration = Infinity,
) {
  const start = info.isSegmented ? (info.segmentStart ?? 0) : 0;
  const end = info.isSegmented ? (info.segmentEnd ?? duration) : duration;
  const target = start + Math.max(0, Number.isFinite(time) ? time : 0);
  return Number.isFinite(end)
    ? Math.min(target, Math.max(start, end - 0.001))
    : target;
}

/** Publishing to the shared clock synchronously notifies subscribers; ignore that echo. */
export function createReplayTimeLink(
  publish: (time: number) => void,
  receive: (time: number) => void,
) {
  let publishing = false;
  return {
    publish(time: number) {
      publishing = true;
      try {
        publish(time);
      } finally {
        publishing = false;
      }
    },
    receive(time: number) {
      if (!publishing) receive(time);
    },
  };
}
