import { expect, test } from "bun:test";
import { featureComponentNames, matchG1Joint } from "../humanoid";

test("matches Unitree SDK arms and every Dex3 finger without relying on column order", () => {
  const names = [
    "ShoulderPitch",
    "ShoulderRoll",
    "ShoulderYaw",
    "Elbow",
    "WristRoll",
    "WristPitch",
    "WristYaw",
    "HandThumb0",
    "HandThumb1",
    "HandThumb2",
    "HandMiddle0",
    "HandMiddle1",
    "HandIndex0",
    "HandIndex1",
  ];
  const urdf = [
    "shoulder_pitch",
    "shoulder_roll",
    "shoulder_yaw",
    "elbow",
    "wrist_roll",
    "wrist_pitch",
    "wrist_yaw",
    "hand_thumb_0",
    "hand_thumb_1",
    "hand_thumb_2",
    "hand_middle_0",
    "hand_middle_1",
    "hand_index_0",
    "hand_index_1",
  ];
  for (const side of ["left", "right"]) {
    const suffixes = names
      .map((n) => `k${side === "left" ? "Left" : "Right"}${n}`)
      .reverse();
    for (let i = 0; i < urdf.length; i++) {
      expect(matchG1Joint(`${side}_${urdf[i]}_joint`, suffixes)).toBe(13 - i);
      expect(
        matchG1Joint(
          `${side}_${urdf[i]}_joint`,
          suffixes.map((s) => s + ".q"),
        ),
      ).toBe(13 - i);
    }
  }
  expect(matchG1Joint("left_hip_pitch_joint", ["kLeftShoulderPitch"])).toBe(-1);
});

test("supports legacy and nested feature labels without guessing mismatched widths", () => {
  expect(
    featureComponentNames([["kLeftHandThumb0", "kLeftHandThumb1"]], 2),
  ).toEqual(["kLeftHandThumb0", "kLeftHandThumb1"]);
  expect(featureComponentNames({ motors: ["shoulder", "elbow"] }, 2)).toEqual([
    "shoulder",
    "elbow",
  ]);
  expect(featureComponentNames(["shoulder", "elbow"], 2)).toEqual([
    "shoulder",
    "elbow",
  ]);
  expect(featureComponentNames([["one"]], 28)).toBeUndefined();
});
