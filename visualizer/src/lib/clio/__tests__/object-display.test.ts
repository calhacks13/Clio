import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCaptureFromClio } from "@clio-viewer/capture/from-clio";
import {
  Capture,
  type CaptureSpace,
  ORIENTATION_VALID,
  POSITION_VALID,
  type PoseSample,
  type Vec3,
} from "@clio-viewer/capture/model";
import {
  SYNTHETIC_TIMES,
  syntheticEpisode,
} from "../__fixtures__/synthetic-episode";
import {
  calibratedFloor,
  drawnObjects,
  identityColor,
  OBJECT_COLORS,
  objectAt,
  objectsAt,
} from "../object-display";

const ms = (t: number) => Math.round(t * 1000);

const capture = buildCaptureFromClio(syntheticEpisode());
const syringeAt = (tUs: number) => {
  const syringe = objectAt(capture, "syringe", tUs);
  if (!syringe) throw new Error("no syringe");
  return syringe;
};

function poseSample(
  entityId: string,
  tUs: number,
  translation: Vec3,
  rotation: [number, number, number, number] | null,
  sequence: number,
): PoseSample {
  return {
    kind: "pose",
    t_us: tUs,
    sequence,
    source_id: "test",
    estimate_type: "vision_estimate",
    entity_id: entityId,
    location: {
      translation,
      rotation,
      location_flags: POSITION_VALID | (rotation ? ORIENTATION_VALID : 0),
    },
    confidence: 0.5,
  };
}

function objectEntity(target: Capture, id: string): void {
  target.addEntity({
    id,
    name: id,
    role: "object",
    motion: "tracked",
    geometry: { type: "none" },
    pose: null,
    extensions: { radius_m: 0.03 },
  });
}

describe("objectsAt on the synthetic episode", () => {
  test("hidden objects are skipped unless asked for", () => {
    const ids = objectsAt(capture, ms(1000)).map((o) => o.entityId);
    expect(ids).toEqual(["cup_a", "indicator", "syringe"]);
    const all = objectsAt(capture, ms(1000), { includeHidden: true });
    const zone = all.find((o) => o.entityId === "spill_zone");
    expect(zone?.hidden).toBe(true);
    expect(zone?.colorIndex).toBe(-1);
    expect(drawnObjects(capture).map((e) => e.id)).toEqual(ids);
  });

  test("identity colors follow first appearance and cycle after seven", () => {
    expect(objectsAt(capture, 0).map((o) => o.colorIndex)).toEqual([0, 1, 2]);
    expect(objectAt(capture, "syringe", 0)?.colorIndex).toBe(2);
    expect(identityColor(7)).toBe(OBJECT_COLORS[0]);
    expect(identityColor(9)).toBe(OBJECT_COLORS[2]);
  });

  test("a reverse seek returns the earlier state", () => {
    const before = syringeAt(ms(SYNTHETIC_TIMES.grasp - 100));
    const carried = syringeAt(ms(SYNTHETIC_TIMES.release - 500));
    const after = syringeAt(ms(SYNTHETIC_TIMES.relocated + 500));
    const back = syringeAt(ms(SYNTHETIC_TIMES.grasp - 100));
    expect(back).toEqual(before);
    expect(before.held).toBeNull();
    expect(before.sourceId).toBe("clio-layout");
    expect(before.trail).toEqual([]);
    expect(carried.held).not.toBeNull();
    expect(carried.sourceId).toBe("clio-grip");
    expect(carried.position).not.toEqual(before.position);
    expect(after.sourceId).toBe("clio-detector");
    // Seeking back into the carry from the end gives the carry, not the later answer.
    expect(syringeAt(ms(SYNTHETIC_TIMES.release - 500))).toEqual(carried);
  });

  test("trails hold no samples after the viewed time", () => {
    const series = capture.poses.get("syringe");
    if (!series) throw new Error("no syringe series");
    for (const t of [2600, 4000, 6000, 8400, 9000]) {
      const tUs = ms(t);
      const shown = syringeAt(tUs).trail.flat();
      expect(shown.length).toBeGreaterThan(0);
      for (const point of shown) {
        const sample = series.samples.find(
          (s) => s.location.translation === point,
        );
        expect(sample).toBeDefined();
        expect(sample?.t_us).toBeLessThanOrEqual(tUs);
        expect(sample?.t_us).toBeGreaterThan(tUs - 3_000_000);
      }
    }
  });

  test("Clio orientations are unknown; age and confidence are honest", () => {
    const tUs = ms(SYNTHETIC_TIMES.release - 500);
    const syringe = syringeAt(tUs);
    expect(syringe.rotation).toBeNull();
    expect(syringe.orientationKnown).toBe(false);
    expect(syringe.ageUs).toBe(tUs - (syringe.updatedUs ?? Number.NaN));
    expect(syringe.ageUs).toBeGreaterThanOrEqual(0);
    expect(syringe.confidence).toBeNull();
    const cup = objectAt(capture, "cup_a", tUs);
    expect(cup?.estimate).toBe("manual");
    expect(cup?.confidence).toBeNull();
    const found = syringeAt(ms(SYNTHETIC_TIMES.relocated + 100));
    expect(found.confidence).toBe(0.78);
  });

  test("the last detector answer by the viewed time, misses included", () => {
    const cup = (t: number) =>
      objectAt(capture, "cup_a", ms(t))?.detection ?? null;
    expect(cup(SYNTHETIC_TIMES.cupMissed - 1)).toBeNull();
    expect(cup(SYNTHETIC_TIMES.cupMissed)?.found).toBe(false);
    expect(objectAt(capture, "indicator", ms(11000))?.detection?.found).toBe(
      true,
    );
  });
});

describe("orientation", () => {
  test("a null rotation means orientationKnown false, also seeking back", () => {
    const target = new Capture("orientation");
    objectEntity(target, "box");
    target.addPose(poseSample("box", 0, [0, 0, 0], null, 0));
    target.addPose(
      poseSample("box", 1_000_000, [0.1, 0, 0], [0, 0, 0.6, 0.8], 1),
    );
    target.addPose(poseSample("box", 2_000_000, [0.2, 0, 0], null, 2));
    const at = (tUs: number) => objectAt(target, "box", tUs);
    expect(at(1_500_000)?.orientationKnown).toBe(true);
    expect(at(1_500_000)?.rotation).toEqual([0, 0, 0.6, 0.8]);
    expect(at(2_500_000)?.orientationKnown).toBe(false);
    expect(at(2_500_000)?.rotation).toBeNull();
    expect(at(500_000)?.orientationKnown).toBe(false);
    expect(at(500_000)?.rotation).toBeNull();
    expect(at(-1)?.position).toBeNull();
  });
});

describe("calibratedFloor", () => {
  const space = (pose: CaptureSpace["worldFromWorkspace"]): CaptureSpace => ({
    worldFromWorkspace: pose,
    calibration: "test",
    anchored: false,
  });

  test("a workspace 0.75 m up with no rotation puts the floor at ROS z = -0.75", () => {
    const floor = calibratedFloor(space([-0.3, 0.75, -0.45, 0, 0, 0, 1]));
    expect(floor?.point[2]).toBeCloseTo(-0.75, 9);
    expect(floor?.point[0]).toBeCloseTo(0, 9);
    expect(floor?.point[1]).toBeCloseTo(0, 9);
    expect(floor?.normal[0]).toBeCloseTo(0, 9);
    expect(floor?.normal[1]).toBeCloseTo(0, 9);
    expect(floor?.normal[2]).toBeCloseTo(1, 9);
  });

  test("the synthetic episode's calibration", () => {
    expect(calibratedFloor(capture.space)?.point[2]).toBeCloseTo(-0.75, 9);
  });

  test("a yaw about local-floor's vertical leaves the floor level", () => {
    const s = Math.sin(Math.PI / 6);
    const c = Math.cos(Math.PI / 6);
    const floor = calibratedFloor(space([0.2, 0.9, 0.1, 0, s, 0, c]));
    expect(floor?.point[2]).toBeCloseTo(-0.9, 9);
    expect(floor?.normal[2]).toBeCloseTo(1, 9);
  });

  test("no space, no floor", () => {
    expect(calibratedFloor(null)).toBeNull();
  });
});

describe("cost", () => {
  test("1000 random seeks over 20 objects on a 10-minute capture average under 1 ms", () => {
    const target = new Capture("cost");
    const durationUs = 600_000_000;
    const stepUs = Math.round(1e6 / 30);
    for (let o = 0; o < 20; o++) {
      const id = `object_${o}`;
      objectEntity(target, id);
      let sequence = 0;
      for (let t = 0; t <= durationUs; t += stepUs) {
        const a = t / 1e6 + o;
        target.addPose(
          poseSample(id, t, [Math.cos(a), Math.sin(a), 0.01], null, sequence++),
        );
      }
    }
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    objectsAt(target, durationUs / 2);
    const start = performance.now();
    let points = 0;
    for (let i = 0; i < 1000; i++) {
      for (const o of objectsAt(target, Math.floor(random() * durationUs))) {
        points += o.trail.length;
      }
    }
    const average = (performance.now() - start) / 1000;
    expect(points).toBeGreaterThan(0);
    expect(average).toBeLessThan(1);
  });
});

describe("scene frame", () => {
  const components = join(import.meta.dir, "../../../components/clio");
  const scene = readFileSync(join(components, "clio-scene.tsx"), "utf8");
  const layers = readdirSync(join(components, "layers")).map((name) =>
    readFileSync(join(components, "layers", name), "utf8"),
  );

  test("exactly one ROS_TO_RENDER group, at scale 1", () => {
    const groups = [...scene.matchAll(/<group\b[^>]*>/g)].map((m) => m[0]);
    const ros = groups.filter((g) => g.includes("ROS_TO_RENDER"));
    expect(ros).toEqual(["<group quaternion={ROS_TO_RENDER}>"]);
    expect(scene.match(/ROS_TO_RENDER/g)?.length).toBe(2); // import and group
    for (const source of layers) {
      expect(source).not.toContain("ROS_TO_RENDER");
      expect(source).not.toContain("rosFromW");
      expect(source).not.toMatch(/\bscale=/);
    }
  });
});
