import { z } from 'zod';
import {
  EnvironmentPlaneSchema,
  EpisodeOutcomeSchema,
  GripKindSchema,
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
//   retarget-<profile>.json  RetargetDoc: robot joint trajectories solved by inverse kinematics
//
// Arrays hold one value per grid frame. null marks "no valid value": compiled files never fill a
// gap silently (a frame gap longer than policy.maxFrameGapMs leaves the head and wrists null), and
// never contain NaN.

export const DERIVED_SCHEMA_ID = 'clio.derived/1';

/** File names the server serves from data/derived/<id>/ and the visualizer's proxy allows. */
export const DERIVED_FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,95}\.json$/;

export const DerivedKindSchema = z.enum(['tracks', 'environment', 'retarget']);

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

export type DerivedKind = z.infer<typeof DerivedKindSchema>;
export type DerivedInput = z.infer<typeof DerivedInputSchema>;
export type CompileStage = z.infer<typeof CompileStageSchema>;
export type DerivedArtifact = z.infer<typeof DerivedArtifactSchema>;
export type EpisodeQuality = z.infer<typeof EpisodeQualitySchema>;
export type RetargetProfileRef = z.infer<typeof RetargetProfileRefSchema>;
export type CompileManifest = z.infer<typeof CompileManifestSchema>;
export type HeldSpanRecord = z.infer<typeof HeldSpanSchema>;
export type CompiledObjectTrack = z.infer<typeof CompiledObjectTrackSchema>;
export type CompiledHandTrack = z.infer<typeof CompiledHandTrackSchema>;
export type TracksDoc = z.infer<typeof TracksDocSchema>;
export type EnvironmentDoc = z.infer<typeof EnvironmentDocSchema>;
export type RetargetArm = z.infer<typeof RetargetArmSchema>;
export type RetargetDoc = z.infer<typeof RetargetDocSchema>;
