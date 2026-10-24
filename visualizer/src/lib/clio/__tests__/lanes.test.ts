import { describe, expect, test } from "bun:test";
import { buildCaptureFromClio } from "@clio-viewer/capture/from-clio";
import {
  Capture,
  POSITION_VALID,
  type PoseSample,
} from "@clio-viewer/capture/model";
import {
  SYNTHETIC_LATENCY,
  SYNTHETIC_TIMES,
  syntheticEpisode,
} from "../__fixtures__/synthetic-episode";
import {
  axisTicks,
  buildLanes,
  currentRowIndex,
  eventRows,
  formatAge,
  formatRange,
  formatTime,
  type InspectorRow,
  inspectObject,
  lostSpans,
  missingBatches,
  recordsLocationFlags,
  sourceClass,
  sourceLabel,
  stepInfoAt,
  tickRuns,
} from "../lanes";
import { drawnObjects } from "../object-display";
import type { LaneTick, ObjectLane } from "../types";

const us = (ms: number) => Math.round(ms * 1000);

const episode = syntheticEpisode();
const capture = buildCaptureFromClio(episode);
const model = buildLanes(capture);
const lane = (id: string) =>
  model.lanes.find((l) => l.entityId === id) as ObjectLane;

describe("buildLanes on the synthetic episode", () => {
  test("lines up every drawn object on one axis for the whole episode", () => {
    expect(model.startUs).toBe(0);
    expect(model.endUs).toBe(capture.endUs);
    expect(model.endUs).toBe(us(episode.finish.durationMs));
    expect(model.lanes.map((l) => l.entityId)).toEqual([
      "cup_a",
      "indicator",
      "syringe",
    ]);
    for (const l of model.lanes) {
      for (const tick of l.ticks) {
        expect(tick.tUs).toBeGreaterThanOrEqual(model.startUs);
        expect(tick.tUs).toBeLessThanOrEqual(model.endUs);
      }
    }
    // Sparse: the bottle only has its plan placement; the syringe is carried.
    expect(lane("indicator").ticks.map((t) => t.sourceId)).toEqual([
      "clio-layout",
    ]);
    expect(lane("syringe").ticks.length).toBeGreaterThan(300);
    expect(model.gaps).toEqual([]);
  });

  test("skips hidden objects", () => {
    expect(capture.entities.get("spill_zone")?.extensions?.hidden).toBe(true);
    expect(drawnObjects(capture).map((e) => e.id)).not.toContain("spill_zone");
  });

  test("detector answers span observation to arrival; misses stand apart", () => {
    const [found] = lane("syringe").detections;
    expect(found?.availableUs).toBe(us(SYNTHETIC_TIMES.relocated));
    expect(found?.observedUs).toBe(
      us(SYNTHETIC_TIMES.relocated - SYNTHETIC_LATENCY.syringe),
    );
    expect(found?.source).toBe("jev");
    expect(lane("syringe").misses).toEqual([]);

    expect(lane("cup_a").detections).toEqual([]);
    const [miss] = lane("cup_a").misses;
    expect(miss?.found).toBe(false);
    expect(miss?.availableUs).toBe(us(SYNTHETIC_TIMES.cupMissed));
    expect(miss?.observedUs).toBe(
      us(SYNTHETIC_TIMES.cupMissed - SYNTHETIC_LATENCY.cup),
    );
  });

  test("held spans keep their origin: inferred from pinches today", () => {
    const held = lane("syringe").held;
    expect(held.length).toBeGreaterThan(0);
    for (const span of held) expect(span.origin).toBe("inferred");
    expect(held[0]?.startUs).toBeGreaterThanOrEqual(us(SYNTHETIC_TIMES.grasp));
    // The carry ticks inside the span are typed as carried.
    const carried = lane("syringe").ticks.filter(
      (t) => t.sourceId === "clio-grip",
    );
    expect(carried.length).toBeGreaterThan(100);
    expect(carried.every((t) => t.estimate === "runtime_estimate")).toBe(true);
  });

  test("a recorded grasp (P3) gives a runtime span, open until the axis end", () => {
    const c = new Capture("held");
    c.addEntity({
      id: "right_hand",
      name: "right hand",
      role: "hand",
      motion: "tracked",
      geometry: { type: "none" },
      pose: null,
    });
    c.addEntity({
      id: "cup",
      name: "cup",
      role: "object",
      motion: "tracked",
      geometry: { type: "none" },
      pose: null,
    });
    c.addEvent({
      kind: "event",
      t_us: 1_000_000,
      sequence: 0,
      source_id: "clio",
      event: "grasp",
      entity_ids: ["right_hand", "cup"],
      origin: "runtime",
      details: { grip: "fist" },
    });
    const [span] = buildLanes(c, { endUs: 5_000_000 }).lanes[0]?.held ?? [];
    expect(span).toEqual({
      startUs: 1_000_000,
      endUs: 5_000_000,
      open: true,
      hand: "right",
      grip: "fist",
      origin: "runtime",
    });
  });
});

describe("an axis ending before the data (live edge)", () => {
  test("leaves out later marks and cuts a held span open at the end", () => {
    const endUs = us(5000);
    const m = buildLanes(capture, { endUs });
    const syringe = m.lanes.find((l) => l.entityId === "syringe");
    expect(syringe?.ticks.every((t) => t.tUs <= endUs)).toBe(true);
    expect(syringe?.detections).toEqual([]);
    expect(m.lanes.find((l) => l.entityId === "cup_a")?.misses).toEqual([]);
    const last = syringe?.held.at(-1);
    expect(last?.endUs).toBe(endUs);
    expect(last?.open).toBe(true);
  });
});

describe("missing ranges", () => {
  test('"not loaded" before a tail join and after a truncated load', () => {
    const m = buildLanes(capture, {
      endUs: 12_000_000,
      loaded: { fromUs: 2_000_000, toUs: 10_000_000 },
      truncated: true,
    });
    expect(m.gaps).toEqual([
      { kind: "not_loaded", startUs: 0, endUs: 2_000_000 },
      { kind: "not_loaded", startUs: 10_000_000, endUs: 12_000_000 },
    ]);
  });

  test('"hands not kept" starts where the loaded frames start', () => {
    const m = buildLanes(capture, {
      loaded: { fromUs: 1_000_000, toUs: capture.endUs },
      handsKeptFromUs: 4_000_000,
    });
    expect(m.gaps).toEqual([
      { kind: "not_loaded", startUs: 0, endUs: 1_000_000 },
      { kind: "hands_not_kept", startUs: 1_000_000, endUs: 4_000_000 },
    ]);
  });
});

describe("lost spans", () => {
  const tick = (tUs: number, positionValid: boolean): LaneTick => ({
    tUs,
    sourceId: "clio-grip",
    estimate: "runtime_estimate",
    basis: "measured",
    positionValid,
  });
  const base: ObjectLane = {
    entityId: "x",
    label: "x",
    kind: null,
    ticks: [],
    held: [],
    detections: [],
    misses: [],
  };

  test("run from an invalid update to the next valid one, or the axis end", () => {
    const ticks = [
      tick(0, true),
      tick(10, false),
      tick(20, false),
      tick(30, true),
      tick(40, false),
    ];
    expect(lostSpans({ ...base, ticks }, 100)).toEqual([
      { startUs: 10, endUs: 30 },
      { startUs: 40, endUs: 100 },
    ]);
  });

  test("an episode without flags never marks a loss", () => {
    expect(recordsLocationFlags(episode.meta)).toBe(false);
    expect(lostSpans(lane("syringe"), model.endUs)).toEqual([]);
    const flagged = syntheticEpisode({ recordedGrasps: true });
    expect(recordsLocationFlags(flagged.meta)).toBe(true);
  });
});

describe("tick runs", () => {
  test("merge frame-rate updates of one source and keep sparse ones apart", () => {
    const runs = tickRuns(lane("syringe").ticks, 10_000);
    const carried = runs.filter((r) => r.sourceId === "clio-grip");
    expect(carried.length).toBeLessThan(5);
    expect(carried.reduce((n, r) => n + r.count, 0)).toBe(
      lane("syringe").ticks.filter((t) => t.sourceId === "clio-grip").length,
    );
    expect(runs[0]).toMatchObject({
      sourceId: "clio-layout",
      source: "plan",
      count: 1,
    });
    expect(runs.at(-1)).toMatchObject({ source: "detection", count: 1 });
  });
});

describe("labels", () => {
  test("source labels and classes follow DESIGN.md", () => {
    expect(sourceLabel("clio-layout")).toBe("Plan layout");
    expect(sourceLabel("clio-pinch")).toBe("Pinch placement");
    expect(sourceLabel("clio-grip")).toBe("Carried");
    expect(sourceLabel("clio-detector")).toBe("Detector");
    expect(sourceLabel("clio-some_new")).toBe("Some new");
    expect(sourceClass("clio-grip")).toBe("hand");
    expect(sourceClass("clio-marker")).toBe("detection");
    expect(sourceClass("clio-manual")).toBe("plan");
  });

  test("times are m:ss.s and ranges use words", () => {
    expect(formatTime(0)).toBe("0:00.0");
    expect(formatTime(62_349_000)).toBe("1:02.3");
    expect(formatRange(62_300_000, 63_100_000)).toBe("1:02.3 to 1:03.1");
    expect(formatAge(4_230_000)).toBe("4.2 s since update");
  });

  test("axis ticks are spaced and whole seconds drop the tenths", () => {
    const ticks = axisTicks(0, 12_000_000, 800);
    expect(ticks[0]).toEqual({ tUs: 0, label: "0:00" });
    expect(ticks[1]?.label).toBe("0:02");
    expect(axisTicks(0, 1_000_000, 800)[1]?.label).toBe("0:00.1");
  });

  test("missing batches use finish.batches once known, else the gaps", () => {
    expect(missingBatches(null)).toBe(0);
    const live = { received: 5, gaps: [2], lastSeq: 5, sent: null };
    expect(missingBatches(live)).toBe(1);
    expect(missingBatches({ ...live, sent: 12, received: 9 })).toBe(3);
    expect(missingBatches({ ...live, sent: 12, received: 12 })).toBe(0);
  });
});

describe("inspectObject", () => {
  const row = (rows: readonly InspectorRow[], label: string) =>
    rows.find((r) => r.label === label);

  test("hides confidence when it is null (a plan placement)", () => {
    const i = inspectObject(capture, "indicator", us(1000));
    expect(i?.label).toBe("indicator bottle");
    expect(row(i?.rows ?? [], "Source")?.value).toBe("Plan layout");
    expect(row(i?.rows ?? [], "Confidence")).toBeUndefined();
    expect(i?.rows.some((r) => r.value === "Orientation unknown")).toBe(true);
  });

  test("labels staleness as derived and names its basis", () => {
    const i = inspectObject(capture, "indicator", us(4200));
    expect(row(i?.rows ?? [], "Updated")).toMatchObject({
      value: "4.2 s since update",
      basis: "derived",
    });
  });

  test("shows measured confidence on a detector update, and the finder", () => {
    const i = inspectObject(capture, "syringe", us(11_000));
    expect(row(i?.rows ?? [], "Source")).toMatchObject({
      value: "Detector",
      title: "Finder: jev",
    });
    expect(row(i?.rows ?? [], "Confidence")).toMatchObject({
      value: "0.78",
      basis: "measured",
    });
    expect(row(i?.rows ?? [], "Latency")).toMatchObject({
      value: "0.7 s",
      basis: "derived",
    });
  });

  test("says what the camera last saw, a predicted box as inferred", () => {
    const observed = syntheticEpisode();
    const at = (t: number, status: string, trackId: string | null = "7") => ({
      t,
      observedT: t - 60,
      objectId: "syringe",
      status,
      role: "tracker",
      source: "yoloe-26l-seg",
      box: null,
      outline: null,
      point: null,
      contact: null,
      score: null,
      frame: null,
      trackId,
    });
    const c = buildCaptureFromClio({
      ...observed,
      observations: [at(2000, "measured"), at(2050, "predicted", null)],
    });
    expect(
      row(inspectObject(c, "syringe", us(1000))?.rows ?? [], "Camera"),
    ).toBeUndefined();
    expect(
      row(inspectObject(c, "syringe", us(2020))?.rows ?? [], "Camera"),
    ).toEqual({
      label: "Camera",
      value: "Seen at 0:02.0",
      basis: "measured",
      title: "yoloe-26l-seg, track 7, frame at 0:01.9",
    });
    expect(
      row(inspectObject(c, "syringe", us(3000))?.rows ?? [], "Camera"),
    ).toMatchObject({
      value: "Predicted at 0:02.0",
      basis: "inferred",
      title: "yoloe-26l-seg, frame at 0:01.9",
    });
  });

  test("an inferred carry says so", () => {
    const i = inspectObject(capture, "syringe", us(5000));
    expect(row(i?.rows ?? [], "Held")).toMatchObject({
      basis: "inferred",
    });
    expect(row(i?.rows ?? [], "Held")?.value).toContain("inferred from pinch");
    expect(row(i?.rows ?? [], "Source")?.value).toBe("Carried");
    expect(row(i?.rows ?? [], "Confidence")).toBeUndefined();
  });

  test("reports a lost position only for episodes with flags", () => {
    const c = new Capture("lost");
    c.addEntity({
      id: "cup",
      name: "cup",
      role: "object",
      motion: "tracked",
      geometry: { type: "none" },
      pose: null,
    });
    const sample = (t_us: number, flags: number): PoseSample => ({
      kind: "pose",
      t_us,
      sequence: t_us,
      source_id: "clio-grip",
      estimate_type: "runtime_estimate",
      entity_id: "cup",
      location: {
        translation: [0.1, 0.2, 0],
        rotation: null,
        location_flags: flags,
      },
      confidence: null,
    });
    c.addPose(sample(0, POSITION_VALID));
    c.addPose(sample(1000, 0));
    const lost = (flagsRecorded: boolean) =>
      inspectObject(c, "cup", 2000, { flagsRecorded })?.rows.some(
        (r) => r.value === "Position lost",
      );
    expect(lost(true)).toBe(true);
    expect(lost(false)).toBe(false);
    expect(lostSpans(buildLanes(c).lanes[0] as ObjectLane, 2000)).toEqual([
      { startUs: 1000, endUs: 2000 },
    ]);
  });
});

describe("eventRows and stepInfoAt", () => {
  const rows = eventRows(capture);

  test("names objects by display name and marks inferred pick-ups", () => {
    const texts = rows.map((r) => r.text);
    expect(texts).toContain("cup A not found");
    expect(texts.some((t) => t.includes("cup_a"))).toBe(false);
    const pickUp = rows.find((r) => r.text.startsWith("syringe picked up"));
    expect(pickUp?.inferred).toBe(true);
    expect(rows.find((r) => r.kind === "step")?.inferred).toBe(false);
  });

  test("rows are in time order and the current row follows the time", () => {
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]?.tUs).toBeGreaterThanOrEqual(rows[i - 1]?.tUs ?? 0);
    }
    expect(currentRowIndex(rows, -1)).toBe(-1);
    expect(currentRowIndex(rows, model.endUs)).toBe(rows.length - 1);
  });

  test("the step running at a time, numbered from 1 of the lesson's count", () => {
    const first = stepInfoAt(capture, us(SYNTHETIC_TIMES.step2 - 100));
    expect(first).toMatchObject({ number: 1, count: 2 });
    expect(first?.instruction).toContain("Fill the syringe");
    const second = stepInfoAt(capture, us(SYNTHETIC_TIMES.step2 + 100));
    expect(second).toMatchObject({ number: 2, count: 2 });
  });
});
