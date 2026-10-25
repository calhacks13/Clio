import { describe, expect, test } from "bun:test";
import {
  type CompiledObjectShape,
  type CompiledObjectTrack,
  DERIVED_SCHEMA_ID,
  ShapesDocSchema,
  type TracksDoc,
  TracksDocSchema,
} from "@clio/protocol";
import { rosFromW, rosQuatFromW } from "@clio-viewer/capture/from-clio";
import type { Quat, Vec3 } from "@clio-viewer/capture/model";
import { syntheticDerived } from "../__fixtures__/synthetic-derived";
import {
  SYNTHETIC_TIMES,
  syntheticEpisode,
} from "../__fixtures__/synthetic-episode";
import {
  compiledObjectAt,
  extentSize,
  formatExtent,
  formatShape,
  heldOriginAt,
  shapeInRos,
} from "../compiled-objects";

// The compiled object series (tracks.json) and shapes (shapes.json) as the
// scene and the inspector read them: the grid frame in force at a viewed time,
// the estimated extent and the fused shape, all brought from W into ROS once.

const YAW = Math.PI / 4;
/** A quarter-turn about W's vertical (+y). */
const TURNED: Quat = [0, Math.sin(YAW / 2), 0, Math.cos(YAW / 2)];

const CUP_W: Vec3[] = [
  [0.1, 0.02, -0.3],
  [0.11, 0.02, -0.3],
];

function object(
  id: string,
  over: Partial<CompiledObjectTrack>,
): CompiledObjectTrack {
  return {
    id,
    label: id,
    kind: "container",
    radius: 0.04,
    hidden: false,
    position: [],
    orientation: [],
    tracked: [],
    interpolated: [],
    held: [],
    heldBy: [],
    confidence: [],
    source: [],
    heldSpans: [],
    ...over,
  };
}

/** Three grid frames at 10 fps: 0, 100 and 200 ms. */
const DOC: TracksDoc = TracksDocSchema.parse({
  schema: DERIVED_SCHEMA_ID,
  episodeId: "ep-test",
  frame: "workspace",
  fps: 10,
  t: [0, 100, 200],
  kind: "tracks",
  policy: { maxInterpolateGapMs: 250, staleMs: 500, maxFrameGapMs: 100 },
  head: [null, null, null],
  hands: [],
  objects: [
    object("cup", {
      extent: { width: 0.12, height: 0.07, samples: 5 },
      position: [CUP_W[0], CUP_W[1], null],
      orientation: [TURNED, null, null],
      tracked: [true, false, false],
      interpolated: [false, true, false],
      held: [false, true, false],
      heldBy: [null, "right", null],
      confidence: [0.9, null, null],
      source: ["detector", "pinch", null],
      heldSpans: [
        {
          hand: "right",
          startT: 100,
          endT: 200,
          origin: "inferred",
          grip: "pinch",
        },
      ],
    }),
    object("bottle", {
      extent: null,
      position: [
        [0.3, 0, -0.1],
        [0.3, 0, -0.1],
        [0.3, 0, -0.1],
      ],
      orientation: [null, null, null],
      tracked: [true, true, true],
      interpolated: [false, false, false],
      held: [false, false, true],
      heldBy: [null, null, null],
      confidence: [null, null, null],
      source: ["layout", "layout", "layout"],
      heldSpans: [
        { hand: null, startT: 200, endT: null, origin: "recorded", grip: null },
      ],
    }),
  ],
} satisfies TracksDoc);

const cup = DOC.objects[0];
const bottle = DOC.objects[1];

describe("compiledObjectAt", () => {
  test("picks the grid frame at or before tUs", () => {
    const between = compiledObjectAt(DOC, "cup", 150_000);
    expect(between).toEqual({
      position: rosFromW(CUP_W[1]),
      rotation: null,
      tracked: false,
      interpolated: true,
      held: true,
      heldBy: "right",
    });
    // Exactly on a grid time is that frame.
    expect(compiledObjectAt(DOC, "cup", 100_000)).toEqual(between);
    expect(compiledObjectAt(DOC, "cup", 99_999)?.tracked).toBe(true);
  });

  test("brings the position and rotation into ROS", () => {
    const at = compiledObjectAt(DOC, "cup", 0);
    if (!at) throw new Error("the cup stands at frame 0");
    // W (x right, y up, z toward the learner) to ROS (x forward, y left, z up).
    expect(at.position).toEqual([0.3, -0.1, 0.02]);
    expect(at.position).toEqual(rosFromW(CUP_W[0]));
    expect(at.rotation).toEqual(rosQuatFromW(TURNED));
    // A yaw about W's up is a yaw about ROS's up.
    expect(at.rotation?.[2]).toBeCloseTo(Math.sin(YAW / 2), 9);
    expect(at.rotation?.[3]).toBeCloseTo(Math.cos(YAW / 2), 9);
  });

  test("is null before the first frame", () => {
    expect(compiledObjectAt(DOC, "bottle", -1)).toBeNull();
    expect(compiledObjectAt(DOC, "bottle", 0)).not.toBeNull();
  });

  test("is null more than one grid step after the last frame", () => {
    expect(compiledObjectAt(DOC, "bottle", 300_000)).not.toBeNull();
    expect(compiledObjectAt(DOC, "bottle", 300_001)).toBeNull();
  });

  test("is null for an object the compile does not have", () => {
    expect(compiledObjectAt(DOC, "spoon", 100_000)).toBeNull();
  });

  test("is null where the compiled position is null", () => {
    expect(compiledObjectAt(DOC, "cup", 200_000)).toBeNull();
    expect(compiledObjectAt(DOC, "cup", 250_000)).toBeNull();
  });
});

describe("heldOriginAt", () => {
  test("names the origin of the held span covering tUs", () => {
    expect(heldOriginAt(cup, 150_000)).toBe("inferred");
    expect(heldOriginAt(cup, 100_000)).toBe("inferred");
    expect(heldOriginAt(cup, 50_000)).toBeNull();
    // endT is exclusive.
    expect(heldOriginAt(cup, 200_000)).toBeNull();
  });

  test("an open span (still held at the end) covers everything after its start", () => {
    expect(heldOriginAt(bottle, 199_999)).toBeNull();
    expect(heldOriginAt(bottle, 200_000)).toBe("recorded");
    expect(heldOriginAt(bottle, 9_000_000)).toBe("recorded");
  });
});

describe("extentSize", () => {
  test("is a ROS box [width, width, height] with z up", () => {
    expect(extentSize(cup)).toEqual([0.12, 0.12, 0.07]);
  });

  test("is null without an extent, null or absent", () => {
    expect(extentSize(bottle)).toBeNull();
    // A compiler before 0.6.0 wrote no extent key at all.
    const older = { ...cup };
    delete older.extent;
    expect(extentSize(older)).toBeNull();
  });
});

describe("shapeInRos", () => {
  const shape: CompiledObjectShape = {
    id: "cup",
    points: [
      [0.01, 0.02, 0.03],
      [0, 0, 0],
    ],
    box: {
      center: [0.01, 0.02, 0.03],
      rotation: TURNED,
      size: [0.1, 0.02, 0.05],
    },
    samples: 40,
    frames: 4,
    firstT: 1000,
    lastT: 2500,
  };

  test("converts the offsets as vectors", () => {
    const ros = shapeInRos(shape);
    expect(ros.points).toEqual([
      [-0.03, -0.01, 0.02],
      [-0, -0, 0],
    ]);
    expect(ros.points[0]).toEqual(rosFromW([0.01, 0.02, 0.03]));
  });

  test("converts the box: center as a vector, size as positive lengths, rotation as a quaternion", () => {
    const ros = shapeInRos(shape);
    if (!ros.box) throw new Error("the shape has a box");
    expect(ros.box.center).toEqual(rosFromW([0.01, 0.02, 0.03]));
    // The box's own x, y (up), z become ROS -y, z, -x: lengths stay positive.
    expect(ros.box.size).toEqual([0.05, 0.1, 0.02]);
    expect(ros.box.rotation).toEqual(rosQuatFromW(TURNED));
  });

  test("keeps a missing box and no points", () => {
    expect(
      shapeInRos({
        ...shape,
        points: [],
        box: null,
        samples: 0,
        frames: 0,
        firstT: null,
        lastT: null,
      }),
    ).toEqual({ points: [], box: null });
  });
});

describe("inspector lines", () => {
  test("the estimated size in whole centimeters", () => {
    expect(formatExtent({ width: 0.12, height: 0.07 })).toBe("12 x 7 cm");
    expect(formatExtent({ width: 0.1249, height: 0.0051 })).toBe("12 x 1 cm");
  });

  test("the measured shape's points and frames", () => {
    const points = Array.from({ length: 1240 }, (): Vec3 => [0, 0, 0]);
    expect(formatShape({ points, frames: 38 })).toBe("1,240 points, 38 frames");
    expect(formatShape({ points: [[0, 0, 0]], frames: 1 })).toBe(
      "1 point, 1 frame",
    );
  });
});

describe("the synthetic compile", () => {
  const episode = syntheticEpisode({ recordedGrasps: true });
  const compiled = syntheticDerived(episode);
  const syringe = compiled.tracks.objects.find((o) => o.id === "syringe");
  const cupA = compiled.tracks.objects.find((o) => o.id === "cup_a");

  test("has one object with an estimated extent", () => {
    expect(syringe?.extent).toEqual({
      width: expect.any(Number),
      height: expect.any(Number),
      samples: expect.any(Number),
    });
    expect(cupA?.extent).toBeNull();
    expect(extentSize(syringe as CompiledObjectTrack)).not.toBeNull();
  });

  test("leaves the syringe's position null while the headset had lost it", () => {
    const { start, end } = SYNTHETIC_TIMES.dropout;
    const lost = compiled.tracks.t.flatMap((t, i) =>
      t >= start && t < end ? [i] : [],
    );
    expect(lost.length).toBeGreaterThan(0);
    for (const i of lost) {
      expect(syringe?.position[i]).toBeNull();
      expect(syringe?.tracked[i]).toBe(false);
    }
    const midUs = Math.round(((start + end) / 2) * 1000);
    expect(compiledObjectAt(compiled.tracks, "syringe", midUs)).toBeNull();
    // Before the loss it is carried, after it is carried again.
    const before = compiledObjectAt(
      compiled.tracks,
      "syringe",
      start * 1000 - 1,
    );
    expect(before?.held).toBe(true);
    expect(before?.heldBy).toBe("right");
  });

  test("a layout position is valid but never tracked", () => {
    const at = compiledObjectAt(compiled.tracks, "cup_a", 0);
    expect(at).not.toBeNull();
    expect(at?.tracked).toBe(false);
    expect(at?.rotation).toBeNull();
  });

  test("writes a shapes document with a fused shape and an empty one", () => {
    expect(() => ShapesDocSchema.parse(compiled.shapes)).not.toThrow();
    expect(compiled.shapes.episodeId).toBe(episode.meta.episodeId);
    const measured = compiled.shapes.objects.find((o) => o.id === "syringe");
    const empty = compiled.shapes.objects.find((o) => o.id === "cup_a");
    if (!measured) throw new Error("the syringe has a shape");
    expect(measured.points.length).toBeGreaterThanOrEqual(12);
    expect(measured.box).not.toBeNull();
    expect(measured.frames).toBeGreaterThan(0);
    expect(empty).toEqual({
      id: "cup_a",
      points: [],
      box: null,
      samples: 0,
      frames: 0,
      firstT: null,
      lastT: null,
    });
    const ros = shapeInRos(measured);
    expect(ros.points.length).toBe(measured.points.length);
    expect(ros.box?.size.every((s) => s > 0)).toBe(true);
  });

  test("lists shapes.json in the manifest and the served files", () => {
    expect(compiled.manifest.artifacts).toContainEqual({
      name: "shapes.json",
      kind: "shapes",
      bytes: expect.any(Number),
    });
    expect(compiled.manifest.stages).toContainEqual({
      name: "shapes",
      status: "ok",
    });
    expect(compiled.files["shapes.json"]).toBe(compiled.shapes);
  });
});
