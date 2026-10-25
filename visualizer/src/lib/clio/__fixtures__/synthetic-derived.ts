import {
  type CompiledObjectTrack,
  type CompileManifest,
  DERIVED_SCHEMA_ID,
  type EnvironmentDoc,
  type EpisodeQuality,
  type FrameRecord,
  type HandSample,
  type Pose7,
  type RetargetDoc,
  type ShapesDoc,
  type TracksDoc,
  type Vec3,
} from "@clio/protocol";
import {
  SYNTHETIC_TIMES,
  type SyntheticEpisode,
  type SyntheticObjectState,
} from "./synthetic-episode";

// What `clio compile` would write for a synthetic episode
// (synthetic-episode.ts): the manifest, tracks, environment, shapes and one
// retarget document, all valid clio.derived/1. Pure and deterministic, for tests and
// the dev harness pages, so the compiled planes and a retargeted arm show
// without a server or the Python pipeline.
//
// Everything is in the workspace frame W (y up), like the pipeline's output.
// The environment has four detected planes: the floor 75 cm below the tray,
// the table (turned a few degrees from W), a wall ahead of the learner and a
// small shelf that a later snapshot leaves out. The table is placed on the
// detected table plane, as the pipeline does for a plan without a workspace
// size (options.table "plan" gives the plan's tray instead). The made-up arm
// stands right of the tray and follows the right hand's pinch point with a
// two-link elbow; it has no target (null q) while the right hand is untracked.
// Head, wrists and arm targets are null wherever the recorded frames around a
// grid time are more than policy.maxFrameGapMs apart. An object's position is
// null where the governing estimate's location flags say it was not valid (the
// syringe while the headset lost the hand carrying it, with recorded grasps).
// The syringe, the one object a finder followed, has an estimated extent and
// a fused shape: depth samples on its top face, taken after it was put down.
// Cup A has a shape entry with no points, as an object whose every sampled
// frame was dropped leaves.

export interface SyntheticDerivedOptions {
  /** Grid rate, default 30 fps. */
  fps?: number;
  /** Default 2026-10-24T12:01:00.000Z. */
  compiledAt?: string;
  /** Replaces parts of the quality verdict (for a "not usable" episode). */
  quality?: Partial<EpisodeQuality>;
  /**
   * Where the table comes from: "planes" (default) places it on the detected
   * table plane; "plan" is the plan's workspace tray at the calibration corner.
   */
  table?: "planes" | "plan";
  /** The retarget stage failed with this detail: no retarget document is written. */
  retargetFailed?: string;
}

export interface SyntheticDerived {
  manifest: CompileManifest;
  tracks: TracksDoc;
  environment: EnvironmentDoc;
  shapes: ShapesDoc;
  retarget: RetargetDoc[];
  /** Every compiled file by name, manifest.json included, as the server serves them. */
  files: Record<string, unknown>;
}

export const SYNTHETIC_PROFILE = {
  id: "clio-arm-6dof",
  version: 1,
  robot: "Clio example arm",
  robotType: "clio_arm_6dof",
  urdfSha256: "5e".repeat(32),
  example: true,
  orientationMode: "approach_axis",
  tolPosM: 0.005,
  tolRotRad: 0.09,
} as const;

/** The robot base in W: on the table, right of the tray. */
export const SYNTHETIC_ROBOT_BASE: Vec3 = [0.72, 0, -0.2];

/** The pipeline's policy.maxFrameGapMs: no head or wrist across a longer frame gap. */
export const SYNTHETIC_MAX_FRAME_GAP_MS = 100;

/** The calibrations that measure the table height; others only guess where W is. */
const CALIBRATED = new Set([
  "pinch_two_corners",
  "workspace_marker",
  "persisted_anchor",
]);

const SHOULDER_HEIGHT = 0.12;
const UPPER_ARM = 0.34;
const FOREARM = 0.32;
/** The tool hangs this far below the wrist. */
const TOOL_DROP = 0.07;
const OPEN_APERTURE = 0.07;
const CLOSED_APERTURE = 0.008;
const FAKE_SHA = "c0".repeat(32);
/** Thumb and index fingertips in HandSample.joints (HAND_JOINTS order). */
const THUMB_TIP = 4;
const INDEX_TIP = 9;
const STRIDE = 8;

const IDENTITY: [number, number, number, number] = [0, 0, 0, 1];

/** The syringe's estimated size across the camera: a thin tool seen on its side. */
const SYRINGE_EXTENT = { width: 0.118, height: 0.021, samples: 23 };
/** The fused shape's grid, hit count and the headset's sampling reach (shapes.json policy). */
const SHAPES_POLICY = { voxelM: 0.01, minHits: 2, reachM: 0.3 };
/** The syringe lies turned this far from W's x axis once put down. */
const SYRINGE_YAW = (20 * Math.PI) / 180;
const SYRINGE_LENGTH = 0.11;
const SYRINGE_WIDTH = 0.02;
/** Depth samples came every 500 ms once the detector found the syringe put down. */
const SURFACE_EVERY_MS = 500;
const SURFACE_POINTS_PER_FRAME = 12;
/** Location flag bit: position valid (OpenXR). */
const POSITION_VALID = 2;

const round = (v: number, digits = 4) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};
const roundVec = <T extends number[]>(v: T): T => v.map((x) => round(x)) as T;
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** Grid times in ms: every 1/fps from 0 up to and including the duration. */
function gridTimes(durationMs: number, fps: number): number[] {
  const times: number[] = [];
  for (let i = 0; i * (1000 / fps) <= durationMs + 1e-9; i++) {
    times.push(round(i * (1000 / fps), 3));
  }
  return times;
}

/**
 * The newest frame at or before each grid time, or null where the recorded
 * frames around it are more than `maxGapMs` apart (a lost batch, or the XR
 * loop paused).
 */
function framesOnGrid(
  frames: readonly FrameRecord[],
  times: readonly number[],
  maxGapMs: number,
): (FrameRecord | null)[] {
  const out: (FrameRecord | null)[] = [];
  let i = -1;
  for (const t of times) {
    while (i + 1 < frames.length && frames[i + 1].t <= t) i++;
    const prev = i >= 0 ? frames[i] : undefined;
    const next = i + 1 < frames.length ? frames[i + 1] : undefined;
    const span = prev && (next ? next.t - prev.t : t - prev.t);
    out.push(
      prev && (prev.t === t || (span ?? Infinity) <= maxGapMs) ? prev : null,
    );
  }
  return out;
}

/** The newest of `items` (sorted by t) at or before each grid time. */
function sampleAt<T extends { t: number }>(
  items: readonly T[],
  times: readonly number[],
): (T | null)[] {
  const out: (T | null)[] = [];
  let i = -1;
  for (const t of times) {
    while (i + 1 < items.length && items[i + 1].t <= t) i++;
    out.push(i >= 0 ? items[i] : null);
  }
  return out;
}

const jointAt = (hand: HandSample, j: number): Vec3 => [
  hand.joints[j * STRIDE],
  hand.joints[j * STRIDE + 1],
  hand.joints[j * STRIDE + 2],
];

const wristPose = (hand: HandSample): Pose7 =>
  hand.joints.slice(0, 7) as unknown as Pose7;

const pinchPoint = (hand: HandSample): Vec3 =>
  scale(add(jointAt(hand, THUMB_TIP), jointAt(hand, INDEX_TIP)), 0.5);

/** The arm's joint origins reaching `target`, base to tool, with an elbow raised above the reach. */
function armChain(target: Vec3): { links: Vec3[]; q: number[] } {
  const base = SYNTHETIC_ROBOT_BASE;
  const shoulder = add(base, [0, SHOULDER_HEIGHT, 0]);
  const wrist = add(target, [0, TOOL_DROP, 0]);
  const reach = sub(wrist, shoulder);
  const d = clamp(
    length(reach),
    Math.abs(UPPER_ARM - FOREARM) + 1e-3,
    UPPER_ARM + FOREARM - 1e-3,
  );
  const dir = scale(reach, 1 / length(reach));
  const along = (UPPER_ARM ** 2 - FOREARM ** 2 + d ** 2) / (2 * d);
  const lift = Math.sqrt(Math.max(0, UPPER_ARM ** 2 - along ** 2));
  const up: Vec3 = [0, 1, 0];
  const perp = sub(up, scale(dir, dot(up, dir)));
  const elbow = add(
    add(shoulder, scale(dir, along)),
    scale(perp, lift / (length(perp) || 1)),
  );
  const upper = sub(elbow, shoulder);
  const fore = sub(wrist, elbow);
  const yaw = Math.atan2(-reach[2], -reach[0]);
  const pitch = Math.atan2(upper[1], Math.hypot(upper[0], upper[2]));
  const bend = Math.acos(
    clamp(dot(upper, fore) / (length(upper) * length(fore)), -1, 1),
  );
  const wristPitch = Math.atan2(-fore[1], Math.hypot(fore[0], fore[2]));
  return {
    links: [base, shoulder, elbow, wrist, target].map((p) => roundVec(p)),
    q: [yaw, pitch, bend, wristPitch, 0, 0].map((v) => round(v)),
  };
}

function retargetDoc(
  episode: SyntheticEpisode,
  t: number[],
  frames: (FrameRecord | null)[],
  fps: number,
): RetargetDoc {
  const arm = {
    hand: "right" as const,
    joints: [
      "base_yaw",
      "shoulder_pitch",
      "elbow_pitch",
      "wrist_pitch",
      "wrist_roll",
      "tool_yaw",
    ],
    q: [] as (number[] | null)[],
    gripper: [] as (number | null)[],
    target: [] as (Pose7 | null)[],
    achieved: [] as (Pose7 | null)[],
    residualPosM: [] as (number | null)[],
    residualRotRad: [] as (number | null)[],
    reachable: [] as boolean[],
    links: [] as (Vec3[] | null)[],
    baseInWorkspace: [...SYNTHETIC_ROBOT_BASE, ...IDENTITY] as Pose7,
  };
  let targets = 0;
  for (const frame of frames) {
    const hand = frame?.right ?? null;
    if (!hand) {
      arm.q.push(null);
      arm.gripper.push(null);
      arm.target.push(null);
      arm.achieved.push(null);
      arm.residualPosM.push(null);
      arm.residualRotRad.push(null);
      arm.reachable.push(false);
      arm.links.push(null);
      continue;
    }
    targets++;
    const target = roundVec(pinchPoint(hand));
    const { links, q } = armChain(target);
    const closed =
      (OPEN_APERTURE - hand.pinch) / (OPEN_APERTURE - CLOSED_APERTURE);
    arm.q.push(q);
    arm.gripper.push(round(clamp(closed, 0, 1), 3));
    arm.target.push([...target, ...IDENTITY]);
    arm.achieved.push([...target, ...IDENTITY]);
    arm.residualPosM.push(0.0015);
    arm.residualRotRad.push(0.01);
    arm.reachable.push(true);
    arm.links.push(links);
  }
  return {
    schema: DERIVED_SCHEMA_ID,
    episodeId: episode.meta.episodeId,
    frame: "workspace",
    fps,
    t,
    kind: "retarget",
    profile: { ...SYNTHETIC_PROFILE },
    arms: [arm],
    summary: {
      reachableFraction: 1,
      targetFraction: round(targets / Math.max(1, t.length)),
      meanResidualPosM: targets > 0 ? 0.0015 : null,
    },
  };
}

/** `local`, given in `pose`'s own frame, in W. */
function inPose(pose: Pose7, local: Vec3): Vec3 {
  const [px, py, pz, x, y, z, w] = pose;
  // v + 2w(q x v) + 2 q x (q x v), q normalized
  const n = Math.hypot(x, y, z, w);
  const [qx, qy, qz, qw] = [x / n, y / n, z / n, w / n];
  const cx = qy * local[2] - qz * local[1];
  const cy = qz * local[0] - qx * local[2];
  const cz = qx * local[1] - qy * local[0];
  return [
    px + local[0] + 2 * (qw * cx + qy * cz - qz * cy),
    py + local[1] + 2 * (qw * cy + qz * cx - qx * cz),
    pz + local[2] + 2 * (qw * cz + qx * cy - qy * cx),
  ];
}

function environmentDoc(
  episode: SyntheticEpisode,
  tableFrom: "planes" | "plan",
): EnvironmentDoc {
  const [w, d] = episode.meta.plan?.workspace.size ?? [0.6, 0.4];
  const space = episode.meta.space;
  const floorY = -(space?.worldFromWorkspace[1] ?? 0.75);
  const lastT = episode.finish.durationMs;
  // A vertical plane: its local +y (the normal) turned to W +z, toward the learner.
  const facingLearner = roundVec([Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
  // The table plane is turned 6 degrees about W's vertical.
  const yaw = (6 * Math.PI) / 180;
  const tableTurn = roundVec([0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
  const rect = (hx: number, hz: number): [number, number][] => [
    [-hx, -hz],
    [hx, -hz],
    [hx, hz],
    [-hx, hz],
  ];
  const tablePlane: EnvironmentDoc["planes"][number] = {
    id: "plane-2",
    kind: "table",
    label: "table",
    orientation: "horizontal",
    pose: [0.36, -0.002, -0.24, ...tableTurn] as Pose7,
    polygon: rect(0.52, 0.36),
    firstSeenT: 0,
    lastSeenT: lastT,
  };
  // On the plane: its corner at local (-x, +z), so +x and -z span the polygon.
  const table: EnvironmentDoc["table"] =
    tableFrom === "planes"
      ? {
          pose: [
            ...roundVec(inPose(tablePlane.pose, [-0.52, 0, 0.36])),
            ...tableTurn,
          ] as Pose7,
          size: [1.04, 0.72],
          source: "planes",
        }
      : { pose: [0, 0, 0, ...IDENTITY], size: [w, d], source: "plan" };
  // Measured by a calibration, else the detected table plane above the floor
  // (null when neither, which this fixture always has).
  const tableHeightM =
    space && CALIBRATED.has(space.calibration)
      ? round(-floorY)
      : round(tablePlane.pose[1] - floorY);
  // Planes present to the end were last seen at the end; the shelf was left
  // out by a later snapshot.
  const shelfGoneT = Math.min(9600, lastT);
  return {
    schema: DERIVED_SCHEMA_ID,
    episodeId: episode.meta.episodeId,
    frame: "workspace",
    kind: "environment",
    table,
    floor:
      space?.calibration === "none"
        ? null
        : { pose: [0, floorY, 0, ...IDENTITY], tableHeightM },
    planes: [
      {
        id: "plane-1",
        kind: "floor",
        label: "floor",
        orientation: "horizontal",
        pose: [0.3, floorY, -0.4, ...IDENTITY],
        polygon: rect(1.2, 1),
        firstSeenT: 0,
        lastSeenT: lastT,
      },
      tablePlane,
      {
        id: "plane-3",
        kind: "wall",
        label: "wall",
        orientation: "vertical",
        pose: [0.3, round(floorY + 1), -1.1, ...facingLearner] as Pose7,
        polygon: rect(1.2, 1),
        firstSeenT: 400,
        lastSeenT: lastT,
      },
      {
        id: "plane-4",
        kind: "other",
        label: null,
        orientation: "horizontal",
        pose: [1.05, 0.3, -0.55, ...IDENTITY],
        polygon: [
          [-0.18, -0.12],
          [0.18, -0.12],
          [0.2, 0.1],
          [-0.16, 0.12],
        ],
        firstSeenT: 2200,
        lastSeenT: shelfGoneT,
      },
    ],
  };
}

function tracksDoc(
  episode: SyntheticEpisode,
  t: number[],
  frames: (FrameRecord | null)[],
  fps: number,
  staleMs: number,
): TracksDoc {
  const { meta } = episode;
  const plan = meta.plan;
  // Every object state in time order, with the line time it arrived at.
  const states = episode.objects.flatMap((record) =>
    record.objects.map((state) => ({ t: record.t, state })),
  );
  const objects: CompiledObjectTrack[] = meta.objects.map((placed) => {
    const spec = plan?.objects.find((o) => o.id === placed.id);
    const mine = sampleAt(
      states.filter((s) => s.state.id === placed.id),
      t,
    );
    const at = (i: number): { t: number; state: SyntheticObjectState } | null =>
      mine[i];
    // The flags, when recorded, say whether the position was valid at all.
    const valid = (i: number) => {
      const flags = at(i)?.state.locationFlags;
      return flags === undefined || (flags & POSITION_VALID) !== 0;
    };
    const measured = (i: number) => {
      const s = at(i);
      return (
        s !== null &&
        valid(i) &&
        s.state.source !== "layout" &&
        s.state.source !== "manual" &&
        t[i] - s.t <= staleMs
      );
    };
    const grasp = SYNTHETIC_TIMES.grasp;
    const release = SYNTHETIC_TIMES.release;
    const carried = placed.id === "syringe";
    return {
      id: placed.id,
      label: placed.label,
      kind: spec?.kind ?? null,
      radius: placed.radius,
      hidden: spec?.hidden ?? false,
      partOf: null,
      extent: carried ? { ...SYRINGE_EXTENT } : null,
      position: t.map((_, i) =>
        valid(i) ? (at(i)?.state.position ?? placed.position) : null,
      ),
      orientation: t.map(() => null),
      tracked: t.map((_, i) => measured(i)),
      interpolated: t.map(() => false),
      held: t.map((ti) => carried && ti >= grasp && ti < release),
      heldBy: t.map((ti) =>
        carried && ti >= grasp && ti < release ? "right" : null,
      ),
      confidence: t.map((_, i) => {
        const s = at(i)?.state;
        return s && (s.source === "detector" || s.source === "marker")
          ? s.confidence
          : null;
      }),
      source: t.map((_, i) => at(i)?.state.source ?? placed.method),
      heldSpans: carried
        ? [
            {
              hand: "right",
              startT: grasp,
              endT: release,
              origin: meta.features?.includes("object.grasp")
                ? "recorded"
                : "inferred",
              grip: "pinch",
            },
          ]
        : [],
    };
  });
  return {
    schema: DERIVED_SCHEMA_ID,
    episodeId: meta.episodeId,
    frame: "workspace",
    fps,
    t,
    kind: "tracks",
    policy: {
      maxInterpolateGapMs: 250,
      staleMs,
      maxFrameGapMs: SYNTHETIC_MAX_FRAME_GAP_MS,
    },
    head: frames.map((f) => f?.head ?? null),
    hands: (["left", "right"] as const).map((side) => ({
      hand: side,
      wrist: frames.map((f) => (f?.[side] ? wristPose(f[side]) : null)),
      pinch: frames.map((f) => f?.[side]?.pinch ?? null),
    })),
    objects,
  };
}

/**
 * The syringe's fused shape as offsets from its tracked position, W axes: a
 * dozen voxel means on its top face, along its length and turned by its yaw,
 * with the box the pipeline fits around them.
 */
function syringeShape(episode: SyntheticEpisode): ShapesDoc["objects"][number] {
  const c = Math.cos(SYRINGE_YAW);
  const s = Math.sin(SYRINGE_YAW);
  const points: Vec3[] = [];
  for (let i = 0; i < SURFACE_POINTS_PER_FRAME; i++) {
    const along =
      -SYRINGE_LENGTH / 2 +
      (i / (SURFACE_POINTS_PER_FRAME - 1)) * SYRINGE_LENGTH;
    const across = (i % 2 === 0 ? -1 : 1) * (SYRINGE_WIDTH / 2 - 0.004);
    const up = SYRINGE_WIDTH / 2 + 0.002 * (i % 3);
    // The box frame turned by the yaw about W's up (+y).
    points.push(
      roundVec([along * c + across * s, up, -along * s + across * c]),
    );
  }
  // Sampled once the detector found it put down, until the episode ended.
  const firstT = SYNTHETIC_TIMES.relocated;
  const lastT = episode.finish.durationMs;
  const frames = Math.max(
    1,
    Math.floor((lastT - firstT) / SURFACE_EVERY_MS) + 1,
  );
  return {
    id: "syringe",
    points,
    box: {
      center: [0, round(SYRINGE_WIDTH / 2), 0],
      rotation: roundVec([
        0,
        Math.sin(SYRINGE_YAW / 2),
        0,
        Math.cos(SYRINGE_YAW / 2),
      ]),
      size: [SYRINGE_LENGTH, SYRINGE_WIDTH, SYRINGE_WIDTH],
    },
    samples: frames * SURFACE_POINTS_PER_FRAME,
    frames,
    firstT,
    lastT: firstT + (frames - 1) * SURFACE_EVERY_MS,
  };
}

function shapesDoc(
  episode: SyntheticEpisode,
  t: number[],
  fps: number,
): ShapesDoc {
  return {
    schema: DERIVED_SCHEMA_ID,
    episodeId: episode.meta.episodeId,
    frame: "workspace",
    fps,
    t,
    kind: "shapes",
    policy: { ...SHAPES_POLICY },
    objects: [
      syringeShape(episode),
      // Sampled while held: every frame dropped, nothing fused.
      {
        id: "cup_a",
        points: [],
        box: null,
        samples: 0,
        frames: 0,
        firstT: null,
        lastT: null,
      },
    ],
  };
}

/** The compiled files `clio compile` would write for `episode`. */
export function syntheticDerived(
  episode: SyntheticEpisode,
  options: SyntheticDerivedOptions = {},
): SyntheticDerived {
  const fps = options.fps ?? 30;
  const staleMs = 500;
  const { meta, finish } = episode;
  const t = gridTimes(finish.durationMs, fps);
  const frames = framesOnGrid(episode.frames, t, SYNTHETIC_MAX_FRAME_GAP_MS);
  const tracks = tracksDoc(episode, t, frames, fps, staleMs);
  const environment = environmentDoc(episode, options.table ?? "planes");
  const shapes = shapesDoc(episode, t, fps);
  const retargetStage = `retarget-${SYNTHETIC_PROFILE.id}`;
  const retarget =
    options.retargetFailed === undefined
      ? [retargetDoc(episode, t, frames, fps)]
      : [];

  const names = {
    tracks: "tracks.json",
    environment: "environment.json",
    shapes: "shapes.json",
    retarget: `retarget-${SYNTHETIC_PROFILE.id}.json`,
  };
  const bytes = (doc: unknown) => JSON.stringify(doc).length;
  const raw: [string, unknown][] = [
    ["meta.json", meta],
    ["frames.ndjson", episode.frames],
    ["events.ndjson", episode.events],
    ["objects.ndjson", episode.objects],
    ["finish.json", finish],
  ];
  const rightTracked =
    episode.frames.filter((f) => f.right !== null).length /
    Math.max(1, episode.frames.length);
  const quality: EpisodeQuality = {
    usable: finish.outcome === "completed",
    reasons:
      finish.outcome === "completed" ? [] : [`Outcome ${finish.outcome}`],
    finished: true,
    outcome: finish.outcome,
    batches: {
      sent: finish.batches,
      received: finish.batches,
      missing: [],
    },
    durationMs: finish.durationMs,
    frames: episode.frames.length,
    frameRateHz: round(1000 / (episode.frames[1]?.t ?? 1000 / 72), 2),
    maxFrameGapMs: round(
      episode.frames.reduce(
        (gap, f, i) =>
          i === 0 ? gap : Math.max(gap, f.t - episode.frames[i - 1].t),
        0,
      ),
      2,
    ),
    hands: { left: 1, right: round(rightTracked) },
    objects: tracks.objects.map((o) => ({
      id: o.id,
      validFraction: 1,
      trackedFraction: round(
        o.tracked.filter(Boolean).length / Math.max(1, o.tracked.length),
      ),
    })),
    validationIssues: 0,
    ...options.quality,
  };
  const manifest: CompileManifest = {
    schema: DERIVED_SCHEMA_ID,
    episodeId: meta.episodeId,
    compiledAt: options.compiledAt ?? "2026-10-24T12:01:00.000Z",
    compiler: { name: "clio-pipeline", version: "synthetic" },
    fps,
    inputs: raw.map(([name, content]) => ({
      name,
      bytes: bytes(content),
      sha256: FAKE_SHA,
    })),
    retarget: [
      {
        id: SYNTHETIC_PROFILE.id,
        version: SYNTHETIC_PROFILE.version,
        profileSha256: FAKE_SHA,
        urdfSha256: SYNTHETIC_PROFILE.urdfSha256,
      },
    ],
    // The pipeline's stage names (compile.py).
    stages: [
      { name: "tracks", status: "ok" },
      { name: "environment", status: "ok" },
      { name: "shapes", status: "ok" },
      options.retargetFailed === undefined
        ? {
            name: retargetStage,
            status: "ok",
            detail: `version ${SYNTHETIC_PROFILE.version}`,
          }
        : {
            name: retargetStage,
            status: "failed",
            detail: options.retargetFailed,
          },
      { name: "quality", status: "ok" },
    ],
    artifacts: [
      { name: names.tracks, kind: "tracks", bytes: bytes(tracks) },
      {
        name: names.environment,
        kind: "environment",
        bytes: bytes(environment),
      },
      { name: names.shapes, kind: "shapes", bytes: bytes(shapes) },
      ...retarget.map((doc) => ({
        name: names.retarget,
        kind: "retarget" as const,
        bytes: bytes(doc),
      })),
    ],
    quality,
  };
  return {
    manifest,
    tracks,
    environment,
    shapes,
    retarget,
    files: {
      "manifest.json": manifest,
      [names.tracks]: tracks,
      [names.environment]: environment,
      [names.shapes]: shapes,
      ...(retarget[0] && { [names.retarget]: retarget[0] }),
    },
  };
}
