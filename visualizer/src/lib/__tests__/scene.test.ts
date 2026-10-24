import { describe, expect, test } from "bun:test";
import { Vector3, Quaternion } from "three";
import {
  EMPTY_SCENE,
  IDENTITY_POSE,
  frameMatrix,
  parseScene,
  objectMatrix,
  robotDisplayMatrix,
  type SceneDocument,
  type SceneObject,
} from "../scene";

function fixture(): SceneDocument {
  return structuredClone(EMPTY_SCENE);
}
const box: SceneObject = {
  id: "box",
  name: "Box",
  frame: "base_link",
  ...IDENTITY_POSE,
  translation: [0.1, 0, 0],
  scale: [1, 1, 1],
  geometry: { type: "box", size: [0.1, 0.2, 0.3], color: "#ff9900" },
};
describe("scene coordinate contract", () => {
  test("nested frames compose parent rotation and translation", () => {
    const doc = fixture();
    const q = new Quaternion().setFromAxisAngle(
      new Vector3(0, 0, 1),
      Math.PI / 2,
    );
    doc.frames[0] = {
      id: "base_link",
      parent: "world",
      translation: [1, 2, 3],
      rotation: [q.x, q.y, q.z, q.w],
    };
    doc.frames.push({
      id: "table",
      parent: "base_link",
      translation: [1, 0, 0],
      rotation: [0, 0, 0, 1],
    });
    const p = new Vector3().applyMatrix4(frameMatrix(doc, "table"));
    expect(p.x).toBeCloseTo(1);
    expect(p.y).toBeCloseTo(3);
    expect(p.z).toBeCloseTo(3);
  });
  test("robot and objects agree after renderer rotation and display scale", () => {
    const doc = fixture();
    doc.frames[0].translation = [1, 2, 3];
    doc.objects = [box];
    const robotPose = robotDisplayMatrix(doc, 10);
    const robotBase = new Vector3().applyMatrix4(robotPose);
    expect(robotBase.x).toBeCloseTo(10);
    expect(robotBase.y).toBeCloseTo(30);
    expect(robotBase.z).toBeCloseTo(-20);
    const objectWorld = new Vector3().applyMatrix4(objectMatrix(doc, box));
    expect(objectWorld.toArray()).toEqual([1.1, 2, 3]);
    const tip = new Vector3(0.1, 0, 0).applyMatrix4(robotPose);
    expect(tip.x).toBeCloseTo(11);
    expect(tip.y).toBeCloseTo(30);
    expect(tip.z).toBeCloseTo(-20);
  });
  test("rejects cycles, missing parents, duplicate frames, and bad quaternions", () => {
    const cycle = fixture();
    cycle.frames[0].parent = "base_link";
    expect(() => parseScene(cycle)).toThrow("cycle");
    const missing = fixture();
    missing.frames[0].parent = "missing";
    expect(() => parseScene(missing)).toThrow("Unknown frame");
    const duplicate = fixture();
    duplicate.frames.push(duplicate.frames[0]);
    expect(() => parseScene(duplicate)).toThrow("Duplicate frame");
    const bad = fixture();
    bad.frames[0].rotation = [0, 0, 0, 0];
    expect(() => parseScene(bad)).toThrow("unit quaternion");
  });
  test("rejects unsupported conventions and invalid object dimensions", () => {
    expect(() => parseScene({ ...fixture(), units: "millimeters" })).toThrow(
      "meters",
    );
    expect(() =>
      parseScene({ ...fixture(), objects: [{ ...box, scale: [-1, 1, 1] }] }),
    ).toThrow("positive");
    expect(() =>
      parseScene({
        ...fixture(),
        objects: [{ ...box, translation: [NaN, 0, 0] }],
      }),
    ).toThrow("finite");
    expect(() =>
      parseScene({ ...fixture(), objects: [{ ...box, frame: "unknown" }] }),
    ).toThrow("Unknown object frame");
  });
  test("example scene round trips with all geometry and frame references", async () => {
    const example = await Bun.file(
      new URL("../../../public/examples/workcell.scene.json", import.meta.url),
    ).json();
    const parsed = parseScene(example);
    expect(parsed.objects.length).toBe(7);
    expect(parseScene(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });
});
