import { describe, expect, test } from "bun:test";
import { detectionsFor, headWAt } from "@clio-viewer/capture/clio-events";
import { buildCaptureFromClio, rosFromW } from "@clio-viewer/capture/from-clio";
import { detectionOutline } from "@clio-viewer/detection-outline";
import {
  SYNTHETIC_TIMES,
  syntheticEpisode,
} from "../__fixtures__/synthetic-episode";
import { outlineRos, outlinesAt } from "../detection-geometry";

const ms = (t: number) => Math.round(t * 1000);
const capture = buildCaptureFromClio(syntheticEpisode());

describe("detection outlines", () => {
  test("points are converted to ROS once: rosFromW of the W outline", () => {
    for (const id of ["indicator", "syringe"]) {
      const [mark] = detectionsFor(capture, id);
      expect(mark?.found).toBe(true);
      if (!mark) continue;
      const head = headWAt(capture, mark.observedUs);
      expect(head).not.toBeNull();
      if (!head) continue;
      const w = detectionOutline(mark.detection, head);
      expect(w).not.toBeNull();
      expect(outlineRos(capture, mark)).toEqual(w?.map(rosFromW) ?? null);
    }
  });

  test("each answer's outline is worked out once", () => {
    const [mark] = detectionsFor(capture, "indicator");
    if (!mark) throw new Error("no indicator answer");
    expect(outlineRos(capture, mark)).toBe(outlineRos(capture, mark));
  });

  test("frames behind the answer: no outline from an older head pose, none cached", () => {
    const lagging = buildCaptureFromClio(syntheticEpisode());
    const [mark] = detectionsFor(lagging, "syringe");
    const head = lagging.headset();
    if (!mark || !head) throw new Error("no syringe answer or head");
    const expected = outlineRos(capture, mark);
    expect(expected).not.toBeNull();
    // Only the frames well before the observation have arrived.
    const later = head.samples.splice(
      head.indexAt(mark.observedUs - 500_000) + 1,
    );
    expect(headWAt(lagging, mark.observedUs)).not.toBeNull();
    expect(outlineRos(lagging, mark)).toBeNull();
    for (const sample of later) head.add(sample);
    expect(outlineRos(lagging, mark)).toEqual(expected);
  });

  test("a miss has no outline", () => {
    const [miss] = detectionsFor(capture, "cup_a");
    expect(miss?.found).toBe(false);
    if (miss) expect(outlineRos(capture, miss)).toBeNull();
  });

  test("only answers that had arrived by the viewed time, newest per object", () => {
    const ids = (t: number) =>
      outlinesAt(capture, ms(t)).map((o) => o.objectId);
    expect(ids(SYNTHETIC_TIMES.indicatorDetected - 1)).toEqual([]);
    expect(ids(SYNTHETIC_TIMES.indicatorDetected)).toEqual(["indicator"]);
    expect(ids(SYNTHETIC_TIMES.cupMissed + 10)).toEqual(["indicator"]);
    expect(ids(SYNTHETIC_TIMES.relocated)).toEqual(["indicator", "syringe"]);
    // Back again: the later answer is gone.
    expect(ids(SYNTHETIC_TIMES.relocated - 1)).toEqual(["indicator"]);
    const [indicator] = outlinesAt(capture, ms(11000));
    expect(indicator?.center).toEqual(
      rosFromW(indicator?.mark.detection.position ?? []),
    );
    expect(indicator?.points.length).toBe(4);
  });
});
