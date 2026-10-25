import { describe, expect, test } from "bun:test";
import {
  EnvironmentDocSchema,
  type SceneModel,
  SceneDocSchema,
  type Vec3,
} from "@clio/protocol";
import { rosFromW } from "@clio-viewer/capture/from-clio";
import { syntheticDerived } from "../__fixtures__/synthetic-derived";
import {
  SYNTHETIC_TIMES,
  syntheticEpisode,
} from "../__fixtures__/synthetic-episode";
import {
  rotateVec,
  syntheticRoom,
  syntheticScene,
  withRoom,
} from "../__fixtures__/synthetic-scene";
import { compiledObjectAt } from "../compiled-objects";
import { rotate } from "../object-display";
import {
  formatModelSize,
  modelOriginAt,
  modelPlacement,
  modelPointInRos,
  modelRows,
  W_TO_ROS_QUAT,
} from "../scene-display";

// The rebuilt scene in ROS: the turn from W the room scan and the models sit
// in, a model's placement on its object's compiled position, and the
// inspector's rows for it. Every expected value comes from rosFromW applied to
// the W-frame arithmetic the contract describes (docs/room-scene.md), so a
// second conversion or a missing one shows.

const EPISODE = syntheticEpisode({ recordedGrasps: true });
const COMPILED = syntheticDerived(EPISODE);
const SCENE = syntheticScene(EPISODE, COMPILED.manifest);
const model = (id: string): SceneModel => {
  const found = SCENE.doc.objects.find((m) => m.id === id);
  if (!found) throw new Error(`no model for ${id}`);
  return found;
};

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const expectClose = (
  actual: readonly number[],
  expected: readonly number[],
) => {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 9));
};

/** Points all over, not only on the axes. */
const POINTS: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [0.3, -1.2, 2.5],
  [-0.71, 0.04, -0.33],
];

describe("the synthetic scene", () => {
  test("is a valid clio.scene/1 built from its compile", () => {
    expect(() => SceneDocSchema.parse(SCENE.doc)).not.toThrow();
    expect(SCENE.doc.compiledAt).toBe(COMPILED.manifest.compiledAt);
    expect(Object.keys(SCENE.files).sort()).toEqual([
      "model-cup_a.glb",
      "model-indicator.glb",
      "model-syringe.glb",
      "scene.json",
    ]);
    // Each model is a GLB, every crop has a picture.
    for (const name of Object.keys(SCENE.files)) {
      if (!name.endsWith(".glb")) continue;
      const view = new DataView(SCENE.files[name].buffer);
      expect(view.getUint32(0, true)).toBe(0x46546c67);
    }
    for (const m of SCENE.doc.objects) {
      for (const crop of m.crops) expect(SCENE.crops[crop.file]).toBeDefined();
    }
  });

  test("the room scan is a valid environment.json room", () => {
    const room = syntheticRoom(EPISODE);
    const environment = withRoom(COMPILED.environment, room);
    expect(() => EnvironmentDocSchema.parse(environment)).not.toThrow();
    expect(room.scan.meshes.map((m) => [m.kind, m.label, m.global])).toEqual([
      ["other", "global mesh", true],
      ["table", "table", false],
      ["couch", "couch", false],
      ["other", "shelf", false],
      ["other", "screen", false],
    ]);
    // The table volume stands on the floor, its top at the tray.
    const table = room.scan.meshes[1].bounds;
    expect(table?.max[1]).toBeCloseTo(0, 6);
    expect(table?.min[1]).toBeCloseTo(-0.75, 6);
  });
});

describe("W to ROS as a turn", () => {
  test("W_TO_ROS_QUAT turns a W vector to where rosFromW puts it", () => {
    for (const p of POINTS) expectClose(rotate(W_TO_ROS_QUAT, p), rosFromW(p));
  });

  test("a GLB node's point, placed by its own transform in W, lands at rosFromW of it", () => {
    // A room scan node: its rotation and translation in W, inside the turn.
    const { nodes } = syntheticRoom(EPISODE);
    for (const node of nodes) {
      const t = node.translation ?? [0, 0, 0];
      const q = node.rotation ?? [0, 0, 0, 1];
      for (const p of POINTS) {
        const inW = add(t, rotateVec(q, p));
        expectClose(rotate(W_TO_ROS_QUAT, inW), rosFromW(inW));
      }
    }
  });
});

describe("a model's placement", () => {
  // Turned and moved off its tracked point, as no fixture model is.
  const placed: SceneModel = {
    ...model("syringe"),
    placement: {
      offset: [0.02, -0.035, 0.01],
      rotation: [0, Math.sin(0.6), 0, Math.cos(0.6)],
      rotationSource: "shape",
    },
  };

  test("offset and rotation reach ROS once", () => {
    const { offset, rotation } = modelPlacement(placed);
    expectClose(offset, rosFromW(placed.placement.offset));
    // The rotation turns ROS vectors as the W rotation turns W vectors.
    for (const p of POINTS) {
      expectClose(
        rotate(rotation, rosFromW(p)),
        rosFromW(rotateVec(placed.placement.rotation, p)),
      );
    }
  });

  test("a point of the model's GLB lands where rosFromW puts the W arithmetic", () => {
    const positionW: Vec3 = [0.41, 0.012, -0.18];
    const placement = modelPlacement(placed);
    for (const local of POINTS) {
      const inW = add(
        add(positionW, placed.placement.offset),
        rotateVec(placed.placement.rotation, local),
      );
      expectClose(
        modelPointInRos(rosFromW(positionW), placement, local),
        rosFromW(inW),
      );
    }
  });

  test("an unnormalized rotation still turns without scaling", () => {
    const scaled = {
      ...placed,
      placement: {
        ...placed.placement,
        rotation: placed.placement.rotation.map(
          (v) => v * 3,
        ) as SceneModel["placement"]["rotation"],
      },
    };
    expectClose(
      modelPointInRos([0, 0, 0], modelPlacement(scaled), [1, 0, 0]),
      modelPointInRos([0, 0, 0], modelPlacement(placed), [1, 0, 0]),
    );
  });

  test("the origin rides on the compiled position at the frame in force", () => {
    const cup = model("cup_a");
    const tUs = 6_000_000;
    const at = compiledObjectAt(COMPILED.tracks, "cup_a", tUs);
    if (!at) throw new Error("cup A is compiled");
    expectClose(
      modelOriginAt(COMPILED.tracks, cup, tUs) ?? [],
      add(at.position, rosFromW(cup.placement.offset)),
    );
    // Its bottom on the table: the plan's height above it, taken off.
    expect(modelOriginAt(COMPILED.tracks, cup, tUs)?.[2]).toBeCloseTo(0, 9);
  });

  test("no origin where the compiled position is null", () => {
    const { start, end } = SYNTHETIC_TIMES.dropout;
    const lostUs = Math.round(((start + end) / 2) * 1000);
    expect(compiledObjectAt(COMPILED.tracks, "syringe", lostUs)).toBeNull();
    expect(modelOriginAt(COMPILED.tracks, model("syringe"), lostUs)).toBeNull();
    // Past the grid's end, as for the object itself.
    expect(
      modelOriginAt(COMPILED.tracks, model("syringe"), 60_000_000),
    ).toBeNull();
  });
});

describe("the inspector's model rows", () => {
  test("a CAD model: backend and generator, what sized and turned it", () => {
    expect(modelRows(model("syringe"))).toEqual([
      {
        label: "Model (generated)",
        value: "Gemini CAD, gemini-pro-latest",
        basis: "generated",
        title: "Gemini CAD model made by gemini-pro-latest",
      },
      {
        label: "Sized by",
        value: "Measured shape",
        basis: "measured",
        title:
          "Scaled to the box around the fused depth samples: 12 x 2 x 3 cm",
      },
      {
        label: "Turned by",
        value: "Measured shape",
        basis: "measured",
        title: "Turned to the yaw of the fused shape's box",
      },
    ]);
  });

  test("a primitive standing in for a failed backend keeps its note", () => {
    const rows = modelRows(model("indicator"));
    expect(rows[0]).toMatchObject({
      label: "Model (generated)",
      value: "Primitive",
      basis: "generated",
    });
    expect(rows[1]).toMatchObject({
      label: "Sized by",
      value: "Plan radius",
    });
    // Facing the camera is a guess.
    expect(rows[2]).toMatchObject({
      label: "Turned by",
      value: "Facing the camera",
      basis: "inferred",
    });
    expect(rows[3]).toEqual({
      label: null,
      value: "Gemini CAD answered no parts; a primitive stands in",
      basis: "generated",
    });
  });

  test("an unturned model, and one that could not be made", () => {
    expect(modelRows(model("cup_a"))[2]).toMatchObject({
      label: "Turned by",
      value: "Not turned",
      basis: "generated",
    });
    expect(
      modelRows({
        ...model("cup_a"),
        model: null,
        note: "Never in a keyframe",
      }),
    ).toEqual([
      {
        label: "Model (generated)",
        value: "None",
        basis: "generated",
        title: "No model could be made",
      },
      { label: null, value: "Never in a keyframe", basis: "generated" },
    ]);
  });

  test("sizes in whole centimeters", () => {
    expect(formatModelSize([0.118, 0.0195, 0.28])).toBe("12 x 2 x 28 cm");
  });
});
