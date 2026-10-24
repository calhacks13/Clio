import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  EpisodeEventSchema,
  EpisodeFinishSchema,
  EpisodeMetaSchema,
  FrameRecordSchema,
  ObjectTrackRecordSchema,
} from "@clio/protocol";
import {
  buildCaptureFromClio,
  ClioCaptureBuilder,
} from "@clio-viewer/capture/from-clio";
import type { Capture, Handedness } from "@clio-viewer/capture/model";
import {
  cutBatches,
  SYNTHETIC_LATENCY,
  SYNTHETIC_TIMES,
  syntheticEpisode,
  syntheticFrames,
  toNdjson,
} from "../__fixtures__/synthetic-episode";

// The shared headset viewer modules load in the visualizer through the
// @clio-viewer/* and @clio/protocol aliases, and the synthetic fixture is a
// valid Clio episode.

const SHIRT_FOLD = path.resolve(
  import.meta.dir,
  "../../../../../fixtures/episodes/synthetic-shirt-fold",
);

const readJson = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(SHIRT_FOLD, name), "utf8"));

const readNdjson = (name: string): unknown[] =>
  readFileSync(path.join(SHIRT_FOLD, name), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** Median ROS y of a hand's wrist (OpenXR joint 1) over its tracked samples. */
const wristY = (capture: Capture, side: Handedness) =>
  median(
    capture.hands[side].samples
      .filter((s) => s.active)
      .map((s) => s.positions[1 * 3 + 1]),
  );

describe("shared viewer modules on the shirt-fold episode", () => {
  const meta = EpisodeMetaSchema.parse(readJson("meta.json"));
  const capture = buildCaptureFromClio({
    meta,
    frames: readNdjson("frames.ndjson"),
    events: readNdjson("events.ndjson"),
    objects: readNdjson("objects.ndjson"),
    finish: EpisodeFinishSchema.parse(readJson("finish.json")),
  });

  test("builds a Capture with the headset, both hands and every object", () => {
    expect(capture.headset()?.samples.length).toBe(337);
    for (const side of ["left", "right"] as const) {
      expect(capture.hands[side].samples.some((s) => s.active)).toBe(true);
    }
    expect(meta.objects).toHaveLength(4);
    for (const placed of meta.objects) {
      expect(capture.entities.has(placed.id)).toBe(true);
    }
  });

  test("hands are not mirrored: the right wrist has the lower ROS y", () => {
    expect(wristY(capture, "right")).toBeLessThan(wristY(capture, "left"));
  });
});

describe("synthetic episode fixture", () => {
  const episode = syntheticEpisode();

  test("every record parses as clio.episode/1", () => {
    EpisodeMetaSchema.parse(episode.meta);
    for (const frame of episode.frames) FrameRecordSchema.parse(frame);
    for (const event of episode.events) EpisodeEventSchema.parse(event);
    for (const record of episode.objects) ObjectTrackRecordSchema.parse(record);
    EpisodeFinishSchema.parse(episode.finish);
  });

  test("the builder accepts every record", () => {
    const builder = new ClioCaptureBuilder(episode.meta);
    builder.addFrames(episode.frames);
    builder.addEvents(episode.events);
    builder.addObjects(episode.objects);
    expect(builder.rejected).toBe(0);
    const { capture } = builder;
    expect(capture.headset()?.samples.length).toBe(episode.frames.length);
    for (const spec of episode.meta.plan?.objects ?? []) {
      expect(capture.entities.has(spec.id)).toBe(true);
    }
    expect(wristY(capture, "right")).toBeLessThan(wristY(capture, "left"));
  });

  test("records are in time order", () => {
    for (const records of [episode.frames, episode.events, episode.objects]) {
      const times = records.map((r) => r.t);
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
  });

  test("has two steps, a hidden region and the detector cases", () => {
    const entered = episode.events.filter((e) => e.type === "step.entered");
    expect(entered).toHaveLength(2);
    const hidden = episode.meta.plan?.objects.filter((o) => o.hidden);
    expect(hidden?.map((o) => o.kind)).toEqual(["region"]);
    const detections = episode.events.filter(
      (e) => e.type === "object.detected",
    );
    expect(detections.filter((d) => !d.found)).toHaveLength(1);
    expect(detections.every((d) => d.latencyMs > 0)).toBe(true);
    expect(detections.find((d) => d.objectId === "syringe")?.latencyMs).toBe(
      SYNTHETIC_LATENCY.syringe,
    );
  });

  test("carries the syringe frame by frame, with a short right-hand dropout", () => {
    const { start, end } = SYNTHETIC_TIMES.dropout;
    const lost = episode.frames.filter((f) => f.right === null);
    expect(lost.length).toBeGreaterThan(1);
    expect(lost.every((f) => f.t >= start && f.t < end)).toBe(true);
    expect(episode.frames.every((f) => f.left !== null)).toBe(true);

    const carried = episode.objects.filter((r) =>
      r.objects.some((o) => o.id === "syringe" && o.source === "pinch"),
    );
    const grasp = episode.events.find(
      (e) => e.type === "hand.pinch" && e.phase === "start",
    );
    expect(grasp?.t).toBe(carried[0]?.t);
    // One line per tracked frame from the grasp to the release.
    const tracked = episode.frames.filter(
      (f) =>
        f.right !== null &&
        f.t >= (carried[0]?.t ?? 0) &&
        f.t <= (carried.at(-1)?.t ?? 0),
    );
    expect(carried.map((r) => r.t)).toEqual(tracked.map((f) => f.t));
    expect(episode.objects.some((r) => r.t > start && r.t < end)).toBe(false);
  });

  test("the recorded-grasp extension adds features, flags and grasp events", () => {
    const recorded = syntheticEpisode({ recordedGrasps: true });
    expect(recorded.meta.features).toEqual(["object.flags", "object.grasp"]);
    expect(recorded.events.map((e) => e.type)).toContain("object.grasped");
    expect(recorded.events.map((e) => e.type)).toContain("object.released");
    const states = recorded.objects.flatMap((r) => r.objects);
    expect(states.every((s) => s.locationFlags !== undefined)).toBe(true);
    expect(states.some((s) => s.locationFlags === 0)).toBe(true);
    expect(syntheticEpisode().meta.features).toBeUndefined();
  });

  test("streams the same frames, and cuts batches like the recorder", () => {
    expect([...syntheticFrames()]).toEqual(episode.frames);
    const batches = cutBatches(episode);
    expect(batches).toHaveLength(episode.finish.batches);
    expect(batches.map((b) => b.seq)).toEqual(batches.map((_, i) => i));
    expect(batches.flatMap((b) => b.frames)).toEqual(episode.frames);
    expect(batches.flatMap((b) => b.events)).toEqual(episode.events);
    expect(batches.flatMap((b) => b.objects)).toEqual(episode.objects);
    expect(batches.every((b) => b.frames.length <= 90)).toBe(true);
    expect(toNdjson(episode.events).split("\n")).toHaveLength(
      episode.events.length + 1,
    );
  });

  test("a short duration drops the records after it", () => {
    const short = syntheticEpisode({ durationMs: 3000, hz: 30 });
    expect(short.frames.at(-1)?.t).toBe(3000);
    expect(short.events.every((e) => e.t <= 3000)).toBe(true);
    expect(short.finish.outcome).toBe("interrupted");
    expect(short.finish.stepsCompleted).toBe(0);
  });
});
