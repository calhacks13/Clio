import { z } from 'zod';
import {
  NormalizedBoxSchema,
  NormalizedPointSchema,
  NormalizedPolygonSchema,
  Pose7Schema,
  QuatSchema,
  Vec3Schema,
} from './geometry';
import { HAND_JOINTS, HandednessSchema, HandSampleSchema, JOINT_FIELDS } from './hand';
import { ProcedureSchema } from './procedure';

// An episode is one lesson run in one workspace frame. See docs/data-format.md for the on-disk
// layout (meta.json, frames.ndjson, events.ndjson, objects.ndjson) and the meaning of every field.

export const EPISODE_SCHEMA_ID = 'clio.episode/1';

export const EpisodeModeSchema = z.enum(['learn', 'record_demo', 'free']);
export const CalibrationMethodSchema = z.enum([
  'pinch_two_corners',
  'workspace_marker',
  'persisted_anchor',
  'default_in_front',
  'none',
]);
/** How an object's position was obtained. */
export const PlacementMethodSchema = z.enum(['layout', 'pinch', 'marker', 'detector', 'manual']);
export const CoachKindSchema = z.enum(['gemini', 'scripted', 'none']);
export const GripKindSchema = z.enum(['pinch', 'fist']);
export const ReleaseReasonSchema = z.enum(['opened', 'hand_lost', 'plan_changed']);

/**
 * Optional recording features, listed in `meta.features` by episodes that use them. Older episodes
 * list none; readers then derive what they need (see docs/data-format.md).
 */
export const EPISODE_FEATURE = {
  /** Object states carry `locationFlags` and `heldBy`, and `observedT` when it differs from `t`. */
  objectFlags: 'object.flags',
  /** Grasps and releases are recorded as `object.grasped` and `object.released` events. */
  objectGrasp: 'object.grasp',
} as const;

export const PlacedObjectSchema = z.object({
  id: z.string(),
  label: z.string(),
  position: Vec3Schema,
  radius: z.number().positive(),
  method: PlacementMethodSchema,
});

export const EpisodeMetaSchema = z.object({
  schema: z.literal(EPISODE_SCHEMA_ID),
  episodeId: z.string(),
  createdAt: z.iso.datetime(),
  mode: EpisodeModeSchema,
  procedure: z.object({ id: z.string(), version: z.number().int(), title: z.string() }).nullable(),
  plan: ProcedureSchema.optional().describe(
    'Full snapshot of the procedure used; AI-generated plans exist nowhere else',
  ),
  operator: z.object({
    role: z.enum(['learner', 'expert', 'collector']),
    id: z.string().optional(),
  }),
  clock: z.object({
    timeline: z.literal('performance.now'),
    startEpochMs: z.number().describe('Wall-clock ms at t = 0'),
  }),
  space: z.object({
    frame: z.literal('workspace'),
    units: z.literal('m'),
    upAxis: z.literal('+y'),
    worldFromWorkspace: Pose7Schema.describe('Workspace pose in WebXR local-floor space'),
    calibration: CalibrationMethodSchema,
    anchored: z.boolean().describe('Workspace pose tracked by a WebXR anchor'),
  }),
  hands: z.object({
    joints: z.array(z.string()).describe('Joint order used by HandSample.joints'),
    jointFields: z.array(z.string()).describe('Values per joint'),
  }),
  objects: z.array(PlacedObjectSchema).describe('Object placements when the episode started'),
  coach: z.object({
    kind: CoachKindSchema,
    model: z.string().optional(),
    transport: z.enum(['relay', 'direct']).optional(),
  }),
  device: z.object({
    userAgent: z.string(),
    emulated: z.boolean(),
    xrFeatures: z.array(z.string()),
  }),
  app: z.object({ version: z.string() }),
  features: z
    .array(z.string())
    .optional()
    .describe('Optional recording features used, e.g. "object.flags" and "object.grasp"'),
});

/** What the headset sends; the server assigns `episodeId` and `createdAt`. */
export const EpisodeCreateSchema = EpisodeMetaSchema.omit({ episodeId: true, createdAt: true });

/** Self-describing hand layout to embed in EpisodeMeta.hands. */
export const HAND_LAYOUT = { joints: [...HAND_JOINTS], jointFields: [...JOINT_FIELDS] };

export const FrameRecordSchema = z.object({
  t: z.number().nonnegative().describe('ms since episode start'),
  head: Pose7Schema.describe('Viewer pose, workspace frame'),
  left: HandSampleSchema.nullable(),
  right: HandSampleSchema.nullable(),
});

/**
 * Bits of `ObjectState.locationFlags`, as in OpenXR space locations and Capture v1. A valid value
 * can be used; a tracked value was measured just now rather than carried over.
 */
export const LOCATION_FLAG = {
  orientationValid: 1,
  positionValid: 2,
  orientationTracked: 4,
  positionTracked: 8,
} as const;

const hasFlag = (flags: number, bit: number) => (flags & bit) !== 0;

export const LocationFlagsSchema = z
  .number()
  .int()
  .min(0)
  .max(15)
  .superRefine((flags, ctx) => {
    const pairs = [
      ['orientation', LOCATION_FLAG.orientationTracked, LOCATION_FLAG.orientationValid],
      ['position', LOCATION_FLAG.positionTracked, LOCATION_FLAG.positionValid],
    ] as const;
    for (const [name, tracked, valid] of pairs) {
      if (hasFlag(flags, tracked) && !hasFlag(flags, valid)) {
        ctx.addIssue({ code: 'custom', message: `A tracked ${name} must also be valid` });
      }
    }
  });

export const ObjectStateSchema = z
  .object({
    id: z.string(),
    position: Vec3Schema.describe(
      'Reference point, workspace frame; the last valid estimate while the position is not valid',
    ),
    orientation: QuatSchema.nullable().describe('Known only for marker-tracked objects'),
    confidence: z.number().min(0).max(1),
    source: PlacementMethodSchema,
    locationFlags: LocationFlagsSchema.optional().describe(
      'Bits: 1 orientation valid, 2 position valid, 4 orientation tracked, 8 position tracked. Absent in older episodes: derive them from source',
    ),
    heldBy: HandednessSchema.nullable()
      .optional()
      .describe('The hand carrying it; null when not held'),
    observedT: z
      .number()
      .optional()
      .describe(
        'ms since episode start when the estimate was measured; omitted within 1 ms of t, negative if before the episode started',
      ),
  })
  .superRefine((state, ctx) => {
    if (state.locationFlags === undefined) return;
    const valid = hasFlag(state.locationFlags, LOCATION_FLAG.orientationValid);
    if (valid !== (state.orientation !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['orientation'],
        message: valid
          ? 'A valid orientation needs a value'
          : 'An orientation needs the orientation-valid flag',
      });
    }
  });

export const ObjectTrackRecordSchema = z
  .object({
    t: z.number().nonnegative(),
    objects: z.array(ObjectStateSchema).describe('Every object whose estimate changed'),
  })
  .describe(
    'One tracker update (objects.ndjson line): written when an estimate changes, and every XR frame while an object is held',
  );

const event = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ t: z.number().nonnegative(), type: z.literal(type), ...shape });

const stepRef = { stepId: z.string(), index: z.number().int().nonnegative() };

export const EpisodeEventSchema = z.discriminatedUnion('type', [
  event('procedure.started', {
    procedureId: z.string(),
    version: z.number().int(),
    stepCount: z.number().int(),
  }),
  event('step.entered', { ...stepRef, instruction: z.string(), targets: z.array(z.string()) }),
  event('step.completed', {
    ...stepRef,
    by: z.enum(['check', 'coach', 'user', 'skip']),
    forced: z.boolean().describe('Advanced before its success check passed'),
    durationMs: z.number().nonnegative(),
  }),
  event('procedure.completed', { durationMs: z.number().nonnegative() }),
  event('procedure.aborted', { reason: z.string() }),
  event('mistake.detected', {
    stepId: z.string(),
    kind: z.string(),
    message: z.string(),
    source: z.enum(['rule', 'coach']),
  }),
  event('hand.pinch', {
    hand: HandednessSchema,
    phase: z.enum(['start', 'end']),
    point: Vec3Schema,
    nearest: z.object({ objectId: z.string(), distance: z.number() }).nullable(),
  }),
  event('object.detected', {
    objectId: z.string(),
    stepId: z.string().nullable(),
    phrase: z.string().nullable(),
    description: z.string().describe('The text the object finder was given'),
    found: z.boolean(),
    point: NormalizedPointSchema.nullable(),
    box: NormalizedBoxSchema.nullable(),
    outline: NormalizedPolygonSchema.nullable(),
    confidence: z.number().min(0).max(1),
    position: Vec3Schema.nullable().describe('Lifted 3D position, workspace frame'),
    source: z.string().describe('Which object finder answered, e.g. "gemini" or "jev"'),
    latencyMs: z
      .number()
      .nonnegative()
      .describe('From camera frame capture to this answer: the frame was taken at t - latencyMs'),
  }),
  event('object.registered', {
    objectId: z.string(),
    position: Vec3Schema,
    method: PlacementMethodSchema,
  }),
  event('object.grasped', {
    objectId: z.string(),
    hand: HandednessSchema,
    grip: GripKindSchema,
    position: Vec3Schema.describe('Object reference point when grasped, workspace frame'),
  }),
  event('object.released', {
    objectId: z.string(),
    hand: HandednessSchema,
    reason: ReleaseReasonSchema.describe(
      'opened: the hand let go; hand_lost: hand tracking dropped out; plan_changed: a new plan was loaded',
    ),
    position: Vec3Schema.describe('Object reference point when released, workspace frame'),
  }),
  event('coach.status', {
    state: z.enum(['connecting', 'ready', 'reconnecting', 'closed', 'error']),
    detail: z.string().optional(),
  }),
  event('coach.narration', { kind: z.string(), text: z.string() }),
  event('coach.tool_call', {
    callId: z.string(),
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
  event('coach.tool_result', {
    callId: z.string(),
    name: z.string(),
    ok: z.boolean(),
    result: z.unknown(),
  }),
  event('transcript', {
    role: z.enum(['user', 'coach']),
    text: z.string(),
    final: z.boolean(),
  }),
  event('demo.playback', {
    stepId: z.string(),
    clipId: z.string(),
    phase: z.enum(['start', 'end']),
  }),
  event('media.started', { name: z.string(), mimeType: z.string() }),
  event('annotation', { label: z.string(), data: z.unknown().optional() }),
]);

/** Every recordable event type, derived from the union so it can't drift. */
export const EPISODE_EVENT_TYPES = EpisodeEventSchema.options.map(
  (option) => option.shape.type.value,
) as EpisodeEvent['type'][];

export const EpisodeBatchSchema = z.object({
  seq: z.number().int().nonnegative().describe('Monotonic per episode; duplicates are ignored'),
  frames: z.array(FrameRecordSchema),
  events: z.array(EpisodeEventSchema),
  objects: z.array(ObjectTrackRecordSchema).default([]),
});

export const EpisodeOutcomeSchema = z.enum(['completed', 'aborted', 'interrupted']);

export const EpisodeFinishSchema = z.object({
  durationMs: z.number().nonnegative(),
  outcome: EpisodeOutcomeSchema,
  stepsCompleted: z.number().int().nonnegative(),
  stepsTotal: z.number().int().nonnegative(),
  batches: z.number().int().nonnegative().describe('Batches the client sent, for integrity checks'),
});

export type EpisodeMode = z.infer<typeof EpisodeModeSchema>;
export type CalibrationMethod = z.infer<typeof CalibrationMethodSchema>;
export type PlacementMethod = z.infer<typeof PlacementMethodSchema>;
export type CoachKind = z.infer<typeof CoachKindSchema>;
export type GripKind = z.infer<typeof GripKindSchema>;
export type ReleaseReason = z.infer<typeof ReleaseReasonSchema>;
export type EpisodeFeature = (typeof EPISODE_FEATURE)[keyof typeof EPISODE_FEATURE];
export type PlacedObject = z.infer<typeof PlacedObjectSchema>;
export type EpisodeMeta = z.infer<typeof EpisodeMetaSchema>;
export type EpisodeCreate = z.infer<typeof EpisodeCreateSchema>;
export type FrameRecord = z.infer<typeof FrameRecordSchema>;
export type ObjectState = z.infer<typeof ObjectStateSchema>;
export type ObjectTrackRecord = z.infer<typeof ObjectTrackRecordSchema>;
export type EpisodeEvent = z.infer<typeof EpisodeEventSchema>;
export type EpisodeEventType = EpisodeEvent['type'];
export type EpisodeEventOf<T extends EpisodeEventType> = Extract<EpisodeEvent, { type: T }>;
/** An event payload as emitted on the headset bus: the recorder adds `t` relative to the episode. */
export type EpisodeEventPayload<T extends EpisodeEventType> = Omit<EpisodeEventOf<T>, 't' | 'type'>;
export type EpisodeBatch = z.output<typeof EpisodeBatchSchema>;
export type EpisodeBatchInput = z.input<typeof EpisodeBatchSchema>;
export type EpisodeOutcome = z.infer<typeof EpisodeOutcomeSchema>;
export type EpisodeFinish = z.infer<typeof EpisodeFinishSchema>;
