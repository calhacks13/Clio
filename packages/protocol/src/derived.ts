import { z } from 'zod';
import {
  EnvironmentMeshSchema,
  EnvironmentPlaneSchema,
  EpisodeOutcomeSchema,
  GripKindSchema,
  ObservationRoleSchema,
  PlacementMethodSchema,
} from './episode';
import { Pose7Schema, QuatSchema, Vec3Schema } from './geometry';
import { HandednessSchema } from './hand';

// What the pipeline compiles from a finished episode (`clio compile`, run by the server when an
// episode finishes). Raw files in data/episodes/<id>/ are never changed; compiled files go to
// data/derived/<id>/ and can be rebuilt at any time. Every spatial value is in the episode's
// workspace frame W, like the raw episode, and every `t` is ms since episode start. See
// docs/data-pipeline.md.
//
//   manifest.json      CompileManifest: inputs (with hashes), stages, artifacts, quality verdict
//   tracks.json        TracksDoc: head, wrists and every object on one fixed-rate grid
//   environment.json   EnvironmentDoc: table, floor and detected planes
//   shapes.json        ShapesDoc: each object's depth samples fused relative to its tracked position
//   room.glb           the Quest room scan in W (environment.json's `room` describes it)
//   retarget-<profile>.json  RetargetDoc: robot joint trajectories solved by inverse kinematics
//   body-g1.json             BodyDoc: a whole Unitree G1 posed from the head and hands (inferred)
//
// Arrays hold one value per grid frame. null marks "no valid value": compiled files never fill a
// gap silently (a frame gap longer than policy.maxFrameGapMs leaves the head and wrists null), and
// never contain NaN.

export const DERIVED_SCHEMA_ID = 'clio.derived/1';

/** File names the server serves from data/derived/<id>/ and the visualizer's proxy allows. */
export const DERIVED_FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,95}\.(json|glb)$/;

export const DerivedKindSchema = z.enum([
  'tracks',
  'environment',
  'shapes',
  'retarget',
  'body',
  'room',
]);

const fraction = () => z.number().min(0).max(1);
const ms = () => z.number();

export const DerivedInputSchema = z.object({
  name: z.string().describe('Raw file name inside the episode directory'),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const CompileStageSchema = z.object({
  name: z.string(),
  status: z.enum(['ok', 'skipped', 'failed']),
  detail: z.string().optional().describe('Why it was skipped or how it failed'),
});

export const DerivedArtifactSchema = z.object({
  name: z.string().regex(DERIVED_FILE_NAME),
  kind: DerivedKindSchema,
  bytes: z.number().int().nonnegative(),
});

export const EpisodeQualitySchema = z.object({
  usable: z.boolean().describe('Safe to train on by default: finished, completed, nothing lost'),
  reasons: z
    .array(z.string())
    .describe('Why it is not usable, as short plain sentences the viewer shows; empty when usable'),
  finished: z.boolean(),
  outcome: EpisodeOutcomeSchema.nullable(),
  batches: z
    .object({
      sent: z.number().int().nonnegative().nullable().describe('From finish.json'),
      received: z.number().int().nonnegative(),
      missing: z
        .array(z.number().int().nonnegative())
        .describe('Seqs that never arrived, including any at the end below finish.batches'),
    })
    .nullable()
    .describe('Null when batches.json is missing'),
  durationMs: z.number().nonnegative(),
  frames: z.number().int().nonnegative(),
  frameRateHz: z.number().nonnegative().nullable().describe('Median XR frame rate'),
  maxFrameGapMs: z.number().nonnegative().nullable(),
  hands: z
    .object({ left: fraction(), right: fraction() })
    .describe('Fraction of frames in which each hand was tracked'),
  objects: z.array(
    z.object({
      id: z.string(),
      validFraction: fraction().describe('Grid frames with a usable position'),
      trackedFraction: fraction().describe('Grid frames whose position was measured recently'),
    }),
  ),
  validationIssues: z.number().int().nonnegative(),
});

export const RetargetProfileRefSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  profileSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .describe('Of the profile file'),
  urdfSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const CompileManifestSchema = z.object({
  schema: z.literal(DERIVED_SCHEMA_ID),
  episodeId: z.string(),
  compiledAt: z.iso.datetime(),
  compiler: z.object({ name: z.string(), version: z.string() }),
  fps: z.number().int().positive(),
  inputs: z.array(DerivedInputSchema).describe('Raw files read; a change makes the compile stale'),
  retarget: z
    .array(RetargetProfileRefSchema)
    .describe('Robot profiles compiled; editing one makes the compile stale'),
  stages: z.array(CompileStageSchema),
  artifacts: z.array(DerivedArtifactSchema),
  quality: EpisodeQualitySchema,
});

const docBase = {
  schema: z.literal(DERIVED_SCHEMA_ID),
  episodeId: z.string(),
  frame: z.literal('workspace'),
  fps: z.number().int().positive(),
  t: z.array(ms()).describe('Grid times, ms since episode start, one per frame'),
};

export const HeldSpanSchema = z.object({
  hand: HandednessSchema.nullable().describe('Null when a carry was inferred without a pinch'),
  startT: ms(),
  endT: ms().nullable().describe('Null while still held at the end of the episode'),
  origin: z.enum(['recorded', 'inferred']).describe('recorded: object.grasped/released events'),
  grip: GripKindSchema.nullable(),
});

const count = () => z.number().int().nonnegative();

/**
 * What object finders saw of one object in the camera image (observations.ndjson), summed up. The
 * 2D answers themselves stay in the raw file; this says how many there were, who answered and how
 * each was labelled, so a reader can tell an object a tracker followed from one placed once. It
 * changes nothing on the grid: a predicted answer's 3D state is valid there but never tracked.
 */
export const ObservationSummarySchema = z.object({
  count: count().describe('observations.ndjson lines about this object'),
  statuses: z
    .object({
      measured: count(),
      predicted: count(),
      lost: count(),
      absent: count(),
      unknown: count(),
    })
    .describe('How many had each status; predicted ones were carried forward without being seen'),
  roles: z.array(ObservationRoleSchema).describe('The roles that answered, in first-seen order'),
  sources: z.array(z.string()).describe('The models that answered, in first-seen order'),
  trackIds: z
    .array(z.string())
    .describe("The trackers' own ids, in first-seen order: provenance only"),
  firstObservedT: ms().describe('Capture time of the earliest frame observed; can be negative'),
  lastObservedT: ms().describe('Capture time of the latest frame observed'),
});

/**
 * One object on the grid: the generalized per-object series every source (layout, pinch,
 * detector, a future tracker) compiles into.
 */
export const CompiledObjectTrackSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string().nullable().describe('Plan object kind (item, tool, container, point, region)'),
  radius: z.number().positive().nullable(),
  hidden: z.boolean(),
  partOf: z
    .string()
    .nullable()
    .optional()
    .describe(
      'The declared object this one is a component of (plan partOf); null when none, absent from compilers before 0.5.0',
    ),
  extent: z
    .object({
      width: z.number().positive().describe('Across the camera, m'),
      height: z.number().positive().describe('Up the camera, m'),
      samples: z.number().int().positive().describe('Measured boxes the medians came from'),
    })
    .nullable()
    .optional()
    .describe(
      "Estimated size: the median of each measured observation's box at the object's depth, through the camera intrinsics. Null without a camera model, boxes or depth; absent from compilers before 0.6.0",
    ),
  position: z.array(Vec3Schema.nullable()).describe('Null where no valid estimate'),
  orientation: z.array(QuatSchema.nullable()).describe('Null where the orientation is unknown'),
  tracked: z
    .array(z.boolean())
    .describe('The estimate in force was measured no longer than policy.staleMs ago'),
  interpolated: z
    .array(z.boolean())
    .describe(
      'Bridged across a gap longer than policy.staleMs between two valid estimates; ordinary resampling between close estimates is not flagged',
    ),
  held: z
    .array(z.boolean())
    .describe('Inside a held span, including carries whose hand is unknown'),
  heldBy: z.array(HandednessSchema.nullable()).describe('The holding hand, when known'),
  confidence: z
    .array(z.number().min(0).max(1).nullable())
    .describe('Measured confidence (detector or marker); null for placeholders'),
  source: z.array(PlacementMethodSchema.nullable()),
  heldSpans: z.array(HeldSpanSchema),
  observations: ObservationSummarySchema.optional().describe(
    'Absent when observations.ndjson says nothing about the object (and from compilers before 0.4.0)',
  ),
});

export const CompiledHandTrackSchema = z.object({
  hand: HandednessSchema,
  wrist: z.array(Pose7Schema.nullable()).describe('Wrist joint pose; null while untracked'),
  pinch: z.array(z.number().nonnegative().nullable()).describe('Thumb-to-index distance, m'),
});

export const TracksDocSchema = z.object({
  ...docBase,
  kind: z.literal('tracks'),
  policy: z.object({
    maxInterpolateGapMs: z
      .number()
      .nonnegative()
      .describe('Objects: never interpolated across a longer gap'),
    staleMs: z
      .number()
      .nonnegative()
      .describe('Objects: tracked only this long after a measurement'),
    maxFrameGapMs: z
      .number()
      .nonnegative()
      .describe(
        'Head and wrists: null where the recorded frames around a grid time are further apart',
      ),
  }),
  head: z.array(Pose7Schema.nullable()),
  hands: z.array(CompiledHandTrackSchema),
  objects: z.array(CompiledObjectTrackSchema),
});

/**
 * One object's measured shape: the depth samples recorded inside its outlines (observations.ndjson
 * `surface`), each frame's taken relative to the object's tracked position at that frame, so the
 * shape rides with the object. Only frames where the object stood still (not held, position
 * valid) count. A yaw-aligned box sums the points up; the points show the side the camera saw.
 */
export const CompiledObjectShapeSchema = z.object({
  id: z.string(),
  points: z
    .array(Vec3Schema)
    .describe(
      "Fused samples as offsets from the object's tracked position, W axes, m; voxel means, at most policy.maxPoints",
    ),
  box: z
    .object({
      center: Vec3Schema.describe('Offset from the tracked position, W axes'),
      rotation: QuatSchema.describe('A yaw about +y (up); the box stands on the table'),
      size: Vec3Schema.describe("Along the box's own x, y (up) and z, m"),
    })
    .nullable()
    .describe('Null with too few points'),
  samples: z.number().int().nonnegative().describe('Raw depth samples before fusing'),
  frames: z.number().int().nonnegative().describe('Observations that contributed'),
  firstT: ms().nullable().describe('Capture time of the first contributing frame'),
  lastT: ms().nullable(),
});

export const ShapesDocSchema = z.object({
  ...docBase,
  kind: z.literal('shapes'),
  policy: z.object({
    voxelM: z.number().positive().describe('Offsets are fused on this grid'),
    minHits: z
      .number()
      .int()
      .positive()
      .describe('A voxel needs this many samples once there are more than 50 voxels'),
    reachM: z
      .number()
      .positive()
      .describe('The headset kept samples within this of the measured center'),
  }),
  objects: z.array(CompiledObjectShapeSchema),
});

/**
 * The Quest room scan (Space Setup, read through WebXR mesh detection) as the compile kept it: the
 * last `environment.meshes` snapshot whose GLB arrived, rewritten to room.glb in W. The headset
 * measured it when the room was set up, not during the episode, so furniture may have moved since.
 */
export const RoomScanSchema = z.object({
  file: z.string().regex(DERIVED_FILE_NAME).describe('The GLB beside environment.json, "room.glb"'),
  source: z.literal('quest-scene').describe('WebXR mesh detection on the headset'),
  media: z.string().describe('The raw snapshot it came from, in media/'),
  snapshotT: ms().describe('When that snapshot was recorded'),
  snapshots: z.number().int().positive().describe('Snapshots the episode recorded'),
  meshes: z.array(
    EnvironmentMeshSchema.extend({
      bounds: z
        .object({ min: Vec3Schema, max: Vec3Schema })
        .nullable()
        .describe('Axis-aligned bounds in W; null for a mesh without vertices'),
    }),
  ),
});

export const EnvironmentDocSchema = z.object({
  schema: z.literal(DERIVED_SCHEMA_ID),
  episodeId: z.string(),
  frame: z.literal('workspace'),
  kind: z.literal('environment'),
  table: z.object({
    pose: Pose7Schema.describe(
      'Table surface, +y up: origin at the calibration corner (calibration, plan) or at a corner of the detected table plane (planes)',
    ),
    size: z
      .tuple([z.number().positive(), z.number().positive()])
      .nullable()
      .describe("[along the pose's +x, along its -z] in m; null when unknown"),
    source: z.enum(['calibration', 'plan', 'planes']),
  }),
  floor: z
    .object({
      pose: Pose7Schema.describe('The local-floor plane in W, +y up'),
      tableHeightM: z
        .number()
        .nullable()
        .describe(
          'Table surface height above the floor: from a calibrated workspace or a detected table plane; null when only guessed',
        ),
    })
    .nullable()
    .describe('The floor of the WebXR local-floor space, from meta.space.worldFromWorkspace'),
  planes: z
    .array(EnvironmentPlaneSchema.extend({ firstSeenT: ms(), lastSeenT: ms() }))
    .describe(
      'Each detected plane as last reported; lastSeenT is when a snapshot first left it out, or the end of the episode',
    ),
  room: RoomScanSchema.nullable()
    .optional()
    .describe(
      'The Quest room scan the compile wrote to room.glb; null without one, absent from compilers before 0.8.0',
    ),
});

export const RetargetArmSchema = z.object({
  hand: HandednessSchema.describe('The human hand that drives this arm'),
  joints: z.array(z.string()).describe('Actuated URDF joint names, in the order of q'),
  q: z
    .array(z.array(z.number()).nullable())
    .describe('Joint values (rad, or m for prismatic joints); null where there was no target'),
  gripper: z
    .array(fraction().nullable())
    .describe(
      '0 open to 1 closed, from the pinch aperture; 1 while the hand holds an object when grasps are recorded',
    ),
  target: z.array(Pose7Schema.nullable()).describe('Tool target, W'),
  achieved: z.array(Pose7Schema.nullable()).describe('Tool pose the solution reaches, W'),
  residualPosM: z.array(z.number().nonnegative().nullable()),
  residualRotRad: z.array(z.number().nonnegative().nullable()),
  reachable: z
    .array(z.boolean())
    .describe('Solved within the profile tolerances; false also where there was no target'),
  links: z
    .array(z.array(Vec3Schema).nullable())
    .describe('The base origin, then every joint origin along the chain to the tool, W'),
});

export const RetargetDocSchema = z.object({
  ...docBase,
  kind: z.literal('retarget'),
  profile: z.object({
    id: z.string(),
    version: z.number().int().positive(),
    robot: z.string().describe("The profile's display name for the robot"),
    robotType: z.string().describe('LeRobot robot_type'),
    urdfSha256: z.string().regex(/^[0-9a-f]{64}$/),
    example: z.boolean().describe('A made-up robot for trying the pipeline, not real hardware'),
    orientationMode: z
      .enum(['full', 'approach_axis', 'position_only'])
      .describe('What residualRotRad measures: the whole rotation, or the approach axis only'),
    tolPosM: z.number().positive().describe('reachable needs residualPosM within this'),
    tolRotRad: z
      .number()
      .positive()
      .describe('reachable needs residualRotRad within this, except in position_only mode'),
  }),
  arms: z.array(
    RetargetArmSchema.extend({
      baseInWorkspace: Pose7Schema.describe('Robot base pose, W: an assumption from the profile'),
    }),
  ),
  summary: z.object({
    reachableFraction: fraction().describe('Of the frames that had a target'),
    targetFraction: fraction().describe('Frames that had a target (the hand was tracked)'),
    meanResidualPosM: z.number().nonnegative().nullable(),
  }),
});

export const BodyDocSchema = z.object({
  ...docBase,
  kind: z.literal('body'),
  profile: z.object({
    id: z.string(),
    version: z.number().int().positive(),
    robotType: z.string().describe('LeRobot robot_type'),
    urdf: z.string().describe('The URDF, relative to the lerobot robot-urdfs bucket'),
    inferred: z
      .array(z.string())
      .describe(
        'Parts posed by rule, not from a measurement: only the head and hands are measured',
      ),
  }),
  scale: z
    .number()
    .positive()
    .describe(
      "The G1's eye height over the learner's standing head height: the G1 is posed at its own size and drawn at 1 / scale",
    ),
  standingHeadM: z
    .number()
    .positive()
    .describe("The learner's standing head height above the floor"),
  joints: z.array(z.string()).describe('URDF joint names, the order of every q row'),
  root: z
    .array(Pose7Schema.nullable())
    .describe(
      "Pelvis pose, W, of the G1 drawn at the learner's size (1 / scale), so its head and palms land on the measured ones (the G1 is z-up, x forward; before profile version 2, at the G1's size)",
    ),
  q: z.array(z.array(z.number()).nullable()).describe('Joint values, rad'),
  handResidualM: z
    .array(z.array(z.number().nonnegative().nullable()).length(2))
    .describe(
      "How far each palm (left, right) stayed from the measured hand, at the learner's size; null where the hand was not measured",
    ),
  summary: z.object({
    frames: z.number().int().nonnegative(),
    meanHandResidualM: z.number().nonnegative().nullable(),
  }),
});

export type DerivedKind = z.infer<typeof DerivedKindSchema>;
export type BodyDoc = z.infer<typeof BodyDocSchema>;
export type DerivedInput = z.infer<typeof DerivedInputSchema>;
export type CompileStage = z.infer<typeof CompileStageSchema>;
export type DerivedArtifact = z.infer<typeof DerivedArtifactSchema>;
export type EpisodeQuality = z.infer<typeof EpisodeQualitySchema>;
export type RetargetProfileRef = z.infer<typeof RetargetProfileRefSchema>;
export type CompileManifest = z.infer<typeof CompileManifestSchema>;
export type HeldSpanRecord = z.infer<typeof HeldSpanSchema>;
export type ObservationSummary = z.infer<typeof ObservationSummarySchema>;
export type CompiledObjectTrack = z.infer<typeof CompiledObjectTrackSchema>;
export type CompiledHandTrack = z.infer<typeof CompiledHandTrackSchema>;
export type TracksDoc = z.infer<typeof TracksDocSchema>;
export type CompiledObjectShape = z.infer<typeof CompiledObjectShapeSchema>;
export type ShapesDoc = z.infer<typeof ShapesDocSchema>;
export type RoomScan = z.infer<typeof RoomScanSchema>;
export type EnvironmentDoc = z.infer<typeof EnvironmentDocSchema>;
export type RetargetArm = z.infer<typeof RetargetArmSchema>;
export type RetargetDoc = z.infer<typeof RetargetDocSchema>;
