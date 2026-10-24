import { expect, test } from "bun:test";
import { Vector3 } from "three";
import { DEFAULT_HUMANOID_DATASET } from "../humanoid";
import {
  EMPTY_SCENE,
  parseScene,
  robotDisplayMatrix,
  frameMatrix,
} from "../scene";
import {
  defaultSceneForDataset,
  G1_REFERENCE_PELVIS_HEIGHT,
  sceneWithDefaults,
} from "../scene-presets";

test("G1 world origin is on the floor while the URDF pelvis stays a separate elevated frame", () => {
  const doc = defaultSceneForDataset(DEFAULT_HUMANOID_DATASET, "Unitree_G1");
  const display = robotDisplayMatrix(doc, 1);
  const floor = new Vector3(
    -0.0000023261,
    0.118506455,
    -G1_REFERENCE_PELVIS_HEIGHT,
  ).applyMatrix4(display);
  expect(floor.y).toBeCloseTo(0, 8);
  const pelvis = new Vector3().applyMatrix4(display);
  expect(pelvis.y).toBeCloseTo(G1_REFERENCE_PELVIS_HEIGHT);
  expect(frameMatrix(doc, "world").elements).toEqual([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ]);
});

test("G1 demo includes portable GLB models for all observed props, with the table resting on the floor", () => {
  const doc = parseScene(
    defaultSceneForDataset(DEFAULT_HUMANOID_DATASET, "Unitree_G1"),
  );
  expect(doc.objects.map((o) => o.id)).toEqual([
    "white-table",
    "red-block",
    "yellow-block",
    "mint-block",
    "target-marker",
  ]);
  expect(doc.note).toContain("static");
  expect(doc.originDescription).toContain("Floor");
  const tableTop = new Vector3().applyMatrix4(frameMatrix(doc, "tabletop")).z;
  for (const object of doc.objects) {
    expect(object.geometry.type).toBe("glb");
    if (object.geometry.type !== "glb") continue;
    const bytes = Buffer.from(object.geometry.dataUrl.split(",")[1], "base64");
    expect(bytes.subarray(0, 4).toString()).toBe("glTF");
    expect(bytes.readUInt32LE(8)).toBe(bytes.length);
    const gltf = JSON.parse(
      bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString(),
    );
    expect(gltf.buffers.every((b: { uri?: string }) => !b.uri)).toBe(true);
    if (object.id === "white-table") {
      const bottom = Math.min(
        ...gltf.nodes.map(
          (n: { translation: number[]; scale: number[] }) =>
            n.translation[1] - n.scale[1],
        ),
      );
      expect(bottom + tableTop).toBeCloseTo(0, 8);
    }
    if (object.id.endsWith("-block"))
      expect(object.translation[2] - 0.0225).toBeCloseTo(tableTop);
  }
  expect(parseScene(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
});

test("migrates untouched empty scenes but preserves user-authored placements", () => {
  const defaults = defaultSceneForDataset(
    DEFAULT_HUMANOID_DATASET,
    "Unitree_G1",
  );
  expect(sceneWithDefaults(EMPTY_SCENE, defaults)).toEqual(defaults);
  const customized = structuredClone(EMPTY_SCENE);
  customized.frames[0].translation = [1, 2, 3];
  expect(sceneWithDefaults(customized, defaults)).toEqual(customized);
  const emptied = structuredClone(defaults);
  emptied.objects = [];
  expect(sceneWithDefaults(emptied, defaults).objects).toHaveLength(0);
  expect(defaultSceneForDataset("another/g1", "g1").objects).toHaveLength(0);
  expect(defaultSceneForDataset("another/arm", "so101")).toEqual(EMPTY_SCENE);
});
