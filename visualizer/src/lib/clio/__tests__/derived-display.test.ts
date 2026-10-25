import { describe, expect, test } from "bun:test";
import type {
  BodyDoc,
  EnvironmentDoc,
  Pose7,
  RetargetDoc,
} from "@clio/protocol";
import { rosFromW } from "@clio-viewer/capture/from-clio";
import type { CaptureSpace, Vec3 } from "@clio-viewer/capture/model";
import {
  SYNTHETIC_ROBOT_BASE,
  syntheticDerived,
} from "../__fixtures__/synthetic-derived";
import {
  SYNTHETIC_TIMES,
  syntheticEpisode,
} from "../__fixtures__/synthetic-episode";
import {
  armBase,
  armsAt,
  bodyAt,
  compiledFloor,
  compiledPlanes,
  compiledTable,
  GRIPPER,
  gridFrameAt,
  gripperLines,
} from "../derived-display";
import { calibratedFloor, rotate } from "../object-display";

// What the scene draws from compiled documents: W points come out in ROS,
// converted exactly once (x = -z_W, y = -x_W, z = y_W), and each arm is shown
// at the grid frame in force at the viewed time, never where it has no
// solution.

const IDENTITY: [number, number, number, number] = [0, 0, 0, 1];
const HALF = Math.SQRT1_2;

function expectVec(actual: readonly number[], expected: readonly number[]) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 9));
}

function environment(overrides: Partial<EnvironmentDoc> = {}): EnvironmentDoc {
  return {
    schema: "clio.derived/1",
    episodeId: "ep-test",
    frame: "workspace",
    kind: "environment",
    table: { pose: [0, 0, 0, ...IDENTITY], size: [0.6, 0.4], source: "plan" },
    floor: { pose: [0, -0.75, 0, ...IDENTITY], tableHeightM: 0.75 },
    planes: [],
    ...overrides,
  };
}

/** The pipeline's floor pose: inverse(worldFromWorkspace), local-floor in W. */
function floorPose(worldFromWorkspace: Pose7): Pose7 {
  const [px, py, pz, qx, qy, qz, qw] = worldFromWorkspace;
  const n = Math.hypot(qx, qy, qz, qw);
  const inverse = [-qx / n, -qy / n, -qz / n, qw / n];
  const p = rotate(inverse, [px, py, pz]);
  return [-p[0], -p[1], -p[2], ...inverse] as Pose7;
}

const space = (worldFromWorkspace: Pose7): CaptureSpace => ({
  worldFromWorkspace,
  calibration: "pinch_two_corners",
  anchored: false,
});

function plane(
  pose: Pose7,
  polygon: [number, number][],
): EnvironmentDoc["planes"][number] {
  return {
    id: "plane-1",
    kind: "wall",
    label: null,
    orientation: "vertical",
    pose,
    polygon,
    firstSeenT: 0,
    lastSeenT: 100,
  };
}

/** A one-arm retarget document on a 10 fps grid. */
function retarget(arm: Partial<RetargetDoc["arms"][number]>): RetargetDoc {
  const frames = 3;
  return {
    schema: "clio.derived/1",
    episodeId: "ep-test",
    frame: "workspace",
    fps: 10,
    t: [0, 100, 200],
    kind: "retarget",
    profile: {
      id: "test-arm",
      version: 1,
      robot: "Test arm",
      robotType: "test",
      urdfSha256: "0".repeat(64),
      example: true,
      orientationMode: "full",
      tolPosM: 0.005,
      tolRotRad: 0.05,
    },
    arms: [
      {
        hand: "right",
        joints: ["a", "b"],
        q: Array.from({ length: frames }, () => [0, 0]),
        gripper: [0, 0.5, 1],
        target: Array.from({ length: frames }, () => null),
        achieved: Array.from({ length: frames }, () => null),
        residualPosM: Array.from({ length: frames }, () => null),
        residualRotRad: Array.from({ length: frames }, () => null),
        reachable: Array.from({ length: frames }, () => true),
        links: [
          [
            [1, 2, 3],
            [1, 2.5, 3],
          ],
          [
            [1, 2, 3],
            [1.5, 2, 3],
          ],
          [
            [1, 2, 3],
            [1, 2, 3.5],
          ],
        ],
        baseInWorkspace: [1, 2, 3, ...IDENTITY],
        ...arm,
      },
    ],
    summary: {
      reachableFraction: 1,
      targetFraction: 1,
      meanResidualPosM: null,
    },
  };
}

describe("compiled environment in ROS", () => {
  test("plane corners are placed by their W pose and converted once", () => {
    const [p] = compiledPlanes(
      environment({
        planes: [
          plane(
            [1, 2, 3, ...IDENTITY],
            [
              [0.5, 0],
              [0, 0.5],
              [0, 0],
            ],
          ),
        ],
      }),
    );
    // W (1.5, 2, 3), (1, 2, 3.5), (1, 2, 3).
    expectVec(p.outline[0], [-3, -1.5, 2]);
    expectVec(p.outline[1], [-3.5, -1, 2]);
    expectVec(p.outline[2], [-3, -1, 2]);
    // Converting twice would give (-2, 3, -1.5) for the first corner.
    expectVec(p.center, [-19 / 6, -7 / 6, 2]);
    expect(p.kind).toBe("wall");
  });

  test("a vertical plane turns its local x/z polygon upright", () => {
    // +90 degrees about x: the plane's normal (+y) faces the learner (+z in W).
    const [p] = compiledPlanes(
      environment({
        planes: [plane([0.3, 0.25, -1.1, HALF, 0, 0, HALF], [[0.2, -0.5]])],
      }),
    );
    // Local (0.2, 0, -0.5) turns to (0.2, 0.5, 0); W (0.5, 0.75, -1.1).
    expectVec(p.outline[0], [1.1, -0.5, 0.75]);
  });

  test("the table spans the workspace box from its calibration corner", () => {
    const table = compiledTable(environment());
    expect(table?.source).toBe("plan");
    const corners = table?.corners ?? [];
    expect(corners.length).toBe(4);
    expectVec(corners[0], [0, 0, 0]);
    expectVec(corners[1], [0, -0.6, 0]);
    expectVec(corners[2], [0.4, -0.6, 0]);
    expectVec(corners[3], [0.4, 0, 0]);
    expectVec(table?.center ?? [], [0.2, -0.3, 0]);
  });

  test("a table from a detected plane takes the plane pose's rotation and position", () => {
    // +90 degrees about y: the table's +x runs along W -z, its -z along W -x.
    const table = compiledTable(
      environment({
        table: {
          pose: [0.5, -0.02, -0.32, 0, HALF, 0, HALF],
          size: [0.6, 0.4],
          source: "planes",
        },
      }),
    );
    expect(table?.source).toBe("planes");
    const corners = table?.corners ?? [];
    // W (0.5, -0.02, -0.32), (0.5, -0.02, -0.92), (0.1, -0.02, -0.92), (0.1, -0.02, -0.32).
    expectVec(corners[0], [0.32, -0.5, -0.02]);
    expectVec(corners[1], [0.92, -0.5, -0.02]);
    expectVec(corners[2], [0.92, -0.1, -0.02]);
    expectVec(corners[3], [0.32, -0.1, -0.02]);
    expectVec(table?.center ?? [], [0.62, -0.3, -0.02]);
  });

  test("any table rotation applies, not only a turn about the vertical", () => {
    // +90 degrees about x: local -z turns to W +y.
    const table = compiledTable(
      environment({
        table: {
          pose: [0, 0, 0, HALF, 0, 0, HALF],
          size: [0.6, 0.4],
          source: "planes",
        },
      }),
    );
    expectVec(table?.corners[3] ?? [], [0, 0, 0.4]);
  });

  test("the synthetic table lies on the detected table plane's outline", () => {
    const { environment: env } = syntheticDerived(syntheticEpisode());
    const table = compiledTable(env);
    const outline =
      compiledPlanes(env).find((p) => p.kind === "table")?.outline ?? [];
    expect(table?.source).toBe("planes");
    expect(outline.length).toBe(4);
    // Each table corner is one of the plane's corners (to the 0.1 mm the files round to).
    for (const corner of table?.corners ?? []) {
      const nearest = Math.min(
        ...outline.map((p) => Math.hypot(...p.map((v, i) => v - corner[i]))),
      );
      expect(nearest).toBeLessThan(2e-4);
    }
  });

  test("a table of unknown size is not drawn from the compile", () => {
    const env = environment();
    expect(
      compiledTable({ ...env, table: { ...env.table, size: null } }),
    ).toBeNull();
  });

  test("the floor lies below the table with its normal up", () => {
    const floor = compiledFloor(environment());
    expectVec(floor?.point ?? [], [0, 0, -0.75]);
    expectVec(floor?.normal ?? [], [0, 0, 1]);
    expect(compiledFloor(environment({ floor: null }))).toBeNull();
  });

  test("the floor point is under the table corner, not at the session origin", () => {
    // A session started 0.42 m right and 0.46 m behind the corner, turned
    // a little: the floor pose's own origin is far from the table.
    const worldFromWorkspace: Pose7 = [-0.42, 0.74, -0.46, 0, -0.05, 0, 0.9988];
    const floor = compiledFloor(
      environment({
        floor: { pose: floorPose(worldFromWorkspace), tableHeightM: 0.74 },
      }),
    );
    expectVec(floor?.point ?? [], [0, 0, -0.74]);
    expectVec(floor?.normal ?? [], [0, 0, 1]);
    const calibrated = calibratedFloor(space(worldFromWorkspace));
    expectVec(floor?.point ?? [], calibrated?.point ?? []);
  });

  test("the floor matches calibratedFloor for a tilted workspace too", () => {
    const worldFromWorkspace: Pose7 = [0.3, 0.9, -0.6, 0.1, 0.3, -0.05, 0.95];
    const floor = compiledFloor(
      environment({
        floor: { pose: floorPose(worldFromWorkspace), tableHeightM: null },
      }),
    );
    const calibrated = calibratedFloor(space(worldFromWorkspace));
    expect(calibrated).not.toBeNull();
    expectVec(floor?.point ?? [], calibrated?.point ?? []);
    expectVec(floor?.normal ?? [], calibrated?.normal ?? []);
  });

  test("a floor with an unknown table height is still drawn", () => {
    const floor = compiledFloor(
      environment({
        floor: { pose: [0, -0.75, 0, ...IDENTITY], tableHeightM: null },
      }),
    );
    expectVec(floor?.point ?? [], [0, 0, -0.75]);
  });
});

describe("grid frames", () => {
  const t = [0, 33.333, 66.667, 100];

  test("the newest frame at or before the time", () => {
    expect(gridFrameAt(t, 30, 0)).toBe(0);
    expect(gridFrameAt(t, 30, 33_332)).toBe(0);
    expect(gridFrameAt(t, 30, 33_333)).toBe(1);
    expect(gridFrameAt(t, 30, 50_000)).toBe(1);
    expect(gridFrameAt(t, 30, 66_667)).toBe(2);
  });

  test("none before the first frame or past the last by more than a frame", () => {
    expect(gridFrameAt(t, 30, -1)).toBe(-1);
    expect(gridFrameAt([10, 20], 100, 9_999)).toBe(-1);
    expect(gridFrameAt(t, 30, 100_000 + 33_333)).toBe(3);
    expect(gridFrameAt(t, 30, 100_000 + 33_334)).toBe(-1);
    expect(gridFrameAt([], 30, 0)).toBe(-1);
  });
});

describe("retargeted arms", () => {
  test("links come from the frame in force, converted once", () => {
    const doc = retarget({});
    const [at150] = armsAt(doc, 150_000);
    // Frame 1: W (1, 2, 3) and (1.5, 2, 3).
    expectVec(at150?.links[0] ?? [], [-3, -1, 2]);
    expectVec(at150?.links[1] ?? [], [-3, -1.5, 2]);
    expect(at150?.gripper).toBe(0.5);
    expect(at150?.hand).toBe("right");
    const [at99] = armsAt(doc, 99_999);
    expectVec(at99?.links[1] ?? [], [-3, -1, 2.5]);
    expectVec(armBase(doc.arms[0]), [-3, -1, 2]);
  });

  test("an arm without a solution is hidden", () => {
    const doc = retarget({ q: [[0, 0], null, [0, 0]] });
    expect(armsAt(doc, 0)[0]).not.toBeNull();
    expect(armsAt(doc, 100_000)[0]).toBeNull();
    expect(armsAt(doc, 150_000)[0]).toBeNull();
    expect(armsAt(doc, 200_000)[0]).not.toBeNull();
  });

  test("hidden without joint positions, or outside the grid", () => {
    expect(armsAt(retarget({ links: [null, null, null] }), 0)[0]).toBeNull();
    expect(armsAt(retarget({}), -1)[0]).toBeNull();
    expect(armsAt(retarget({}), 300_001)[0]).toBeNull();
  });

  test("the synthetic arm stands at its base and drops out with the right hand", () => {
    const episode = syntheticEpisode();
    const [doc] = syntheticDerived(episode).retarget;
    const [carrying] = armsAt(doc, (SYNTHETIC_TIMES.grasp + 500) * 1000);
    expectVec(carrying?.links[0] ?? [], rosFromW(SYNTHETIC_ROBOT_BASE));
    expectVec(carrying?.links[0] ?? [], [0.2, -0.72, 0]);
    const { start, end } = SYNTHETIC_TIMES.dropout;
    const [lost] = armsAt(doc, Math.round(((start + end) / 2) * 1000));
    expect(lost).toBeNull();
  });
});

describe("gripper", () => {
  const links: Vec3[] = [
    [0, 0, 0.3],
    [0, 0, 0.1],
  ];
  const width = (lines: Vec3[] | null) =>
    lines ? Math.hypot(...lines[0].map((v, i) => v - lines[1][i])) : NaN;

  test("its fingers point along the last link from a bar at the tool", () => {
    const lines = gripperLines(links, 0) ?? [];
    expect(lines.length).toBe(6);
    expectVec(lines[3], [
      lines[2][0],
      lines[2][1],
      lines[2][2] - GRIPPER.finger,
    ]);
    expect(lines[0][2]).toBeCloseTo(0.1, 9);
  });

  test("it closes from open to closed", () => {
    expect(width(gripperLines(links, 0))).toBeCloseTo(2 * GRIPPER.openHalf, 9);
    expect(width(gripperLines(links, 1))).toBeCloseTo(
      2 * GRIPPER.closedHalf,
      9,
    );
    expect(width(gripperLines(links, 0.5))).toBeLessThan(
      width(gripperLines(links, 0)),
    );
  });

  test("none without two links", () => {
    expect(gripperLines([[0, 0, 0]], 0)).toBeNull();
  });
});

describe("the inferred G1 body", () => {
  const body: BodyDoc = {
    schema: "clio.derived/1",
    episodeId: "ep-body",
    frame: "workspace",
    fps: 10,
    t: [0, 100, 200],
    kind: "body",
    profile: {
      id: "unitree-g1-body",
      version: 1,
      robotType: "unitree_g1",
      urdf: "g1/g1_body29_hand14.urdf",
      inferred: ["pelvis", "legs", "waist", "fingers"],
    },
    scale: 0.8,
    standingHeadM: 1.6,
    joints: ["left_knee_joint", "right_knee_joint"],
    root: [null, [0.1, 0.05, 0.4, 0, 0, 0, 1], [0.2, 0.05, 0.4, 0, 0, 0, 1]],
    q: [null, [0.3, 0.4], [0.5, 0.6]],
    handResidualM: [
      [null, null],
      [0.01, 0.02],
      [0.01, 0.02],
    ],
    summary: { frames: 2, meanHandResidualM: 0.015 },
  };

  test("is placed at a grid frame, its pelvis converted to ROS once", () => {
    const pose = bodyAt(body, 100_000);
    expect(pose?.position).toEqual(rosFromW([0.1, 0.05, 0.4]));
    expect(pose?.rotation).toEqual(IDENTITY);
    expect(pose?.joints).toEqual([0.3, 0.4]);
  });

  test("is blended between two grid frames with a pose", () => {
    const pose = bodyAt(body, 150_000);
    const position = rosFromW([0.15, 0.05, 0.4]);
    pose?.position.forEach((v, i) => expect(v).toBeCloseTo(position[i], 9));
    expect(pose?.joints[0]).toBeCloseTo(0.4, 9);
    expect(pose?.joints[1]).toBeCloseTo(0.5, 9);
  });

  test("holds the last frame after it, and is hidden where it has no pose", () => {
    expect(bodyAt(body, 250_000)?.joints).toEqual([0.5, 0.6]);
    expect(bodyAt(body, 50_000)).toBeNull();
  });

  test("is drawn at the learner's size from profile version 2", () => {
    expect(bodyAt(body, 100_000)?.size).toBe(1);
    const v2 = { ...body, profile: { ...body.profile, version: 2 } };
    expect(bodyAt(v2, 100_000)?.size).toBeCloseTo(1 / 0.8, 9);
  });
});
