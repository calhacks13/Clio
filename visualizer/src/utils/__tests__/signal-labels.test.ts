import { describe, expect, test } from "bun:test";
import {
  jointSignalCategory,
  signalChartTitle,
  signalDisplayName,
} from "../signal-labels";
import { processChartDataGroups } from "../dataProcessing";

describe("signal categories", () => {
  test("names body parts and fingers from named joints, including schema aliases", () => {
    expect(jointSignalCategory("kRightShoulderYaw")).toBe("Right shoulder");
    expect(jointSignalCategory("action | kRightElbow.q")).toBe("Right elbow");
    expect(jointSignalCategory("right_wrist_roll_joint")).toBe("Right wrist");
    expect(jointSignalCategory("kLeftHandThumb0")).toBe("Left thumb");
    expect(jointSignalCategory("kRightHandMiddle1.q")).toBe(
      "Right middle finger",
    );
    expect(jointSignalCategory("kWaistYaw")).toBe("Waist");
  });

  test("does not invent body parts for numeric or unfamiliar channels", () => {
    for (const name of [
      "observation.state | 3",
      "force",
      "task_progress",
      "kRightShoulderTemperature",
    ]) {
      expect(jointSignalCategory(name)).toBeUndefined();
      expect(signalDisplayName(name)).toBe(name);
    }
  });

  test("uses readable joint labels while retaining feature prefixes", () => {
    expect(signalDisplayName("kRightShoulderYaw")).toBe("Right shoulder yaw");
    expect(signalDisplayName("left_wrist_roll_joint")).toBe("Left wrist roll");
    expect(signalDisplayName("action | kLeftHandThumb0.q")).toBe(
      "action | Left hand thumb 0",
    );
    expect(signalChartTitle(["kRightShoulderPitch", "kRightShoulderYaw"])).toBe(
      "Right shoulder",
    );
    expect(signalChartTitle(["kRightElbow", "kRightWristRoll"])).toBe(
      "Right elbow, Right wrist",
    );
  });

  test("keeps measured and action values together by body part across old chart boundaries", () => {
    const joints = [
      "kLeftShoulderPitch",
      "kLeftElbow",
      "kLeftShoulderYaw",
      "kRightWristRoll",
      "kRightWristYaw",
      "kLeftHandThumb0",
    ];
    const keys = joints.flatMap((joint) => [
      `observation.state | ${joint}`,
      `action | ${joint}`,
    ]);
    const rows = [0, 1, 2].map(
      (timestamp) =>
        Object.fromEntries([
          ["timestamp", timestamp],
          ...keys.map((key, i) => [key, (i + 1) * (timestamp + 1)]),
        ]) as Record<string, number>,
    );
    const original = JSON.stringify(rows);
    const groups = processChartDataGroups(["timestamp", ...keys], rows);
    expect(groups.map((group) => signalChartTitle(group))).toEqual([
      "Left shoulder",
      "Left elbow",
      "Right wrist",
      "Left thumb",
    ]);
    expect(groups[0]).toEqual(keys.filter((key) => key.includes("Shoulder")));
    expect(groups.flat().sort()).toEqual([...keys].sort());
    expect(JSON.stringify(rows)).toBe(original);
  });

  test("preserves unrelated channels and the existing chart size limit", () => {
    const keys = ["observation.state", "action", "velocity"].flatMap((prefix) =>
      ["Pitch", "Roll", "Yaw"].map(
        (axis) => `${prefix} | kLeftShoulder${axis}`,
      ),
    );
    keys.push("force | 0", "task_progress");
    const rows = [0, 1].map(
      (timestamp) =>
        Object.fromEntries([
          ["timestamp", timestamp],
          ...keys.map((key, i) => [key, i + timestamp]),
        ]) as Record<string, number>,
    );
    const groups = processChartDataGroups(["timestamp", ...keys], rows);
    expect(groups.flat().sort()).toEqual([...keys].sort());
    expect(groups.every((group) => group.length <= 6)).toBe(true);
    expect(
      groups
        .filter((group) => jointSignalCategory(group[0]))
        .every((group) =>
          group.every((key) => jointSignalCategory(key) === "Left shoulder"),
        ),
    ).toBe(true);
  });
});
