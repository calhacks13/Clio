import { describe, expect, test } from "bun:test";
import {
  createReplayTimeLink,
  replayFrameAtTime,
  videoTimeAtReplayTime,
  clampComparisonSplit,
  comparisonSplitAt,
  comparisonSplitBounds,
} from "../replay-comparison";

describe("comparison timeline", () => {
  test("clamps chart seeks and uses the current episode’s frame count", () => {
    expect(replayFrameAtTime(-2, 30, 300)).toBe(0);
    expect(replayFrameAtTime(4.5, 30, 300)).toBe(135);
    expect(replayFrameAtTime(4.5, 30, 60)).toBe(59);
    expect(replayFrameAtTime(NaN, 30, 300)).toBe(0);
    expect(replayFrameAtTime(4, 30, 0)).toBe(0);
  });
  test("each segmented camera uses its own file offset", () => {
    const a = {
      filename: "left",
      url: "left.mp4",
      isSegmented: true,
      segmentStart: 120,
      segmentEnd: 160,
    };
    const b = { ...a, filename: "right", segmentStart: 240, segmentEnd: 280 };
    expect(videoTimeAtReplayTime(a, 13)).toBe(133);
    expect(videoTimeAtReplayTime(b, 13)).toBe(253);
    expect(videoTimeAtReplayTime(a, 2)).toBe(122);
  });
  test("seeking to the end stays inside the episode instead of triggering a video loop", () => {
    const info = {
      filename: "camera",
      url: "camera.mp4",
      isSegmented: true,
      segmentStart: 10,
      segmentEnd: 20,
    };
    expect(videoTimeAtReplayTime(info, 30)).toBeCloseTo(19.999);
    expect(videoTimeAtReplayTime(info, -1)).toBe(10);
    expect(
      videoTimeAtReplayTime({ ...info, isSegmented: false }, 30, 12),
    ).toBeCloseTo(11.999);
  });
  test("shared clock reports cannot seek the robot back through their own echo", () => {
    const received: number[] = [];
    const published: number[] = [];
    const link = createReplayTimeLink(
      (time) => {
        published.push(time);
        link.receive(time);
      },
      (time) => received.push(time),
    );
    link.publish(13);
    link.receive(2);
    link.publish(2);
    expect(published).toEqual([13, 2]);
    expect(received).toEqual([2]);
  });
  test("a failed publication does not block later external seeks", () => {
    const received: number[] = [];
    const link = createReplayTimeLink(
      () => {
        throw new Error("disconnected");
      },
      (time) => received.push(time),
    );
    expect(() => link.publish(10)).toThrow("disconnected");
    link.receive(3);
    expect(received).toEqual([3]);
  });
});

describe("comparison divider", () => {
  test("converts the divider center to an even split in either axis", () => {
    expect(comparisonSplitAt(405, 100, 610)).toBeCloseTo(50);
    expect(comparisonSplitAt(350, 50, 600)).toBeCloseTo(50);
  });
  test("dragging outside the workspace preserves usable panes", () => {
    const bounds = comparisonSplitBounds(610);
    expect(comparisonSplitAt(-100, 0, 610)).toBe(bounds.min);
    expect(comparisonSplitAt(2000, 0, 610)).toBe(bounds.max);
    expect(((610 - 14) * bounds.min) / 100).toBeCloseTo(180);
    expect(clampComparisonSplit(75, 1440)).toBe(75);
  });
  test("resizing a large split into a narrow workspace clamps without locking it", () => {
    expect(clampComparisonSplit(80, 610)).toBeCloseTo(69.7986577);
    expect(comparisonSplitBounds(300)).toEqual({ min: 40, max: 60 });
    expect(clampComparisonSplit(NaN, 0)).toBe(50);
  });
});
